#!/usr/bin/env node
// planboard: the review loop between one person and one coding agent over one plan.
// Zero dependencies. Node 18+. macOS and Linux.
// Run `node planboard.mjs help` for commands.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '1.5.0';
const SELF = fileURLToPath(import.meta.url);
const SKILL_DIR = path.resolve(path.dirname(SELF), '..');
const ASSETS = path.join(SKILL_DIR, 'assets');
const HOME = process.env.PLANBOARD_HOME || path.join(os.homedir(), '.planboard');
const BASE_PORT = Number(process.env.PLANBOARD_PORT) || 4517;
const HOST = '127.0.0.1';
const IDLE_MS = (Number(process.env.PLANBOARD_IDLE_MINUTES) || 180) * 60_000;
const WAIT_DEFAULT_S = 540;      // foreground: fits inside Claude Code's 10-minute Bash limit
const WAIT_BACKGROUND_S = 86400; // --background: a background command can listen for a day
const LENSES = ['feature', 'new-project', 'refactor', 'non-code', 'generic'];
const ITEM_KINDS = new Set(['answer', 'assumption', 'decision', 'comment', 'message', 'approve-section', 'approve', 'end', 'custom']);
const OUTPUTS = {
  continue: 'continue here (start building in this session)',
  'plan-md': 'plan.md',
  'handoff-md': 'handoff.md',
  both: 'plan.md + handoff.md',
  agent: 'agent decides (recommend one, then do it)',
};

// ---------- small utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => crypto.randomBytes(5).toString('hex');
const sessionId = (dir) => crypto.createHash('sha1').update(dir).digest('hex').slice(0, 10);
function shq(s) { return /^[\w@%+=:,./~-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`; }
function tildify(p) { const h = os.homedir(); return p.startsWith(h + path.sep) && !/\s/.test(p) ? '~' + p.slice(h.length) : p; }
const CMD = `node ${shq(tildify(SELF))}`;
// The plan folder as a command argument: absolute (with ~), so a copied command works from any directory.
function planArg(dir) { return shq(tildify(dir)); }
function rel(p) {
  const r = path.relative(process.cwd(), p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p;
}
function print(s) { process.stdout.write(String(s).replace(/\s+$/, '') + '\n'); }
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
function fail(msg, code = 1) { process.stderr.write(`planboard: ${msg}\n`); process.exit(code); }
function readJSON(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
// State files (review conversation, sessions, ports, secrets) are private to this user: 0600 files in 0700 folders.
function writeJSON(p, v, mode = 0o600) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const t = `${p}.${process.pid}.${rid()}.tmp`;
  fs.writeFileSync(t, JSON.stringify(v, null, 2), { mode });
  fs.renameSync(t, p);
}
function escHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'plan';
}
function oneLine(s, max = 140) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
function localDate(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function indent(s, n = 4) { const pad = ' '.repeat(n); return String(s).split('\n').map((l) => pad + l).join('\n'); }

function parseArgs(argv) {
  const BOOL = new Set(['no-open', 'reopen', 'json', 'handoff', 'html', 'force', 'help', 'with-conversation', 'skip-check', 'update', 'background']);
  const VALUE = new Set(['lens', 'root', 'timeout', 'file', 'out', 'port']);
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a === '-h') { out.help = true; continue; }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (!BOOL.has(k) && !VALUE.has(k)) fail(`unknown option --${k}. Run "${CMD} help". (To pass text that starts with "--", put "--" before it.)`);
      if (eq > 0) { out[k] = a.slice(eq + 1); continue; }
      if (BOOL.has(k)) out[k] = true;
      else { if (i + 1 >= argv.length) fail(`--${k} needs a value`); out[k] = argv[++i]; }
    } else out._.push(a);
  }
  return out;
}

// ---------- plan directory + state files ----------
const stPath = (dir, f) => path.join(dir, '.planboard', f);
function meta(dir) { return { round: 1, ended: false, endedBy: null, createdAt: Date.now(), ...readJSON(stPath(dir, 'meta.json'), {}) }; }
function setMeta(dir, m) { writeJSON(stPath(dir, 'meta.json'), m); }
const transcriptOf = (dir) => readJSON(stPath(dir, 'transcript.json'), []);
const queueOf = (dir) => readJSON(stPath(dir, 'queue.json'), []);

function resolvePlanDir(arg) {
  if (arg) {
    let p = path.resolve(arg.replace(/^~(?=\/)/, os.homedir()));
    if (fs.existsSync(p) && fs.statSync(p).isFile()) p = path.dirname(p);
    if (!fs.existsSync(path.join(p, 'plan.json'))) fail(/[\\/]\.plans[\\/]/.test(p) || /^\.plans[\\/]/.test(arg)
      ? `No plan.json in ${p}. A relative path is resolved from ${process.cwd()}; pass the plan folder's full path (planboard's own output prints it).`
      : `No plan.json in ${p}. Create a plan with: ${CMD} new "<title>"`);
    return fs.realpathSync(p);
  }
  // No argument: newest plan in the nearest .plans/ (this directory or a parent)
  let root = null;
  for (let d = process.cwd(); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.plans'))) { root = path.join(d, '.plans'); break; }
    if (path.dirname(d) === d) break;
  }
  let best = null;
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, 'plan.json');
      if (fs.existsSync(f)) {
        const t = fs.statSync(f).mtimeMs;
        if (!best || t > best.t) best = { d: path.join(root, d), t };
      }
    }
  } catch { }
  if (!best) fail(`No plan given and none found in a .plans/ folder here or above. Pass the plan folder, e.g. ${CMD} open .plans/<name>`);
  return fs.realpathSync(best.d);
}

function parseJSONWithPos(text, file) {
  try { return { value: JSON.parse(text), error: null }; } catch (e) {
    let msg = e.message;
    const m = /position (\d+)/.exec(msg);
    if (m && !/line \d+/.test(msg)) {
      const pos = Number(m[1]);
      const before = text.slice(0, pos);
      const line = before.split('\n').length;
      const col = pos - before.lastIndexOf('\n');
      msg += ` (line ${line}, column ${col})`;
    }
    return { value: null, error: `${file}: invalid JSON: ${msg}` };
  }
}
function loadPlan(dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'); } catch { return { plan: null, error: 'plan.json not found' }; }
  const r = parseJSONWithPos(text.replace(/^\uFEFF/, ''), 'plan.json');
  return { plan: r.value, error: r.error };
}

// ---------- lint / check ----------
const VAGUE = [
  [/(?<![\/\w.-])etc\b(?!\/)\.?/i, 'etc.'], [/\band so on\b/i, 'and so on'], [/\bas (?:needed|necessary|appropriate|required)\b/i, 'as needed'],
  [/\b(?:if|when|where) (?:needed|necessary|appropriate)\b/i, 'if needed'], [/\bappropriate(?:ly)?\b/i, 'appropriate'],
  [/\bproperly\b/i, 'properly'], [/\bsomehow\b/i, 'somehow'], [/\bmaybe\b/i, 'maybe'], [/\bprobably\b/i, 'probably'],
  [/\bshould (?:just )?work\b/i, 'should work'], [/\bvarious\b/i, 'various'], [/\bsome (?:kind|sort) of\b/i, 'some kind of'],
  [/\bTBD\b/, 'TBD'], [/\bTODO\b/, 'TODO'], [/\bwhatever\b/i, 'whatever'], [/\baccordingly\b/i, 'accordingly'],
  [/\b(?:necessary|required|relevant) (?:changes|updates|files|places|parts|logic)\b/i, 'unnamed "necessary changes"'],
  [/\bhandle (?:it|this|that|errors|edge cases)\b(?![^.;:\n]{0,60}\b(?:by|with|via|using)\b)/i, 'handle … (say how)'],
  // "clean up" with nothing concrete after it ("clean up.", "clean up the code", "clean up everything")
  [/\bclean(?: |-)?up\b(?=\s*(?:$|[.,;:!)]|(?:it|this|that|things|stuff|everything|code|the code|(?:the )?mess|afterwards?|as needed)\b))/im, 'clean up (say what)'],
  [/(?:\.\.\.|…)[ \t]*$/m, 'trailing …'],
  [/\bstuff\b/i, 'stuff'], [/\bnice to have\b/i, 'nice to have (in or out?)'],
];
function vagueIn(text) {
  const t = String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  return VAGUE.filter(([re]) => re.test(t)).map(([, label]) => label);
}
const strArr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const BUILTIN_BLOCKS = ['overview', 'decisions', 'questions', 'assumptions', 'steps', 'files', 'risks', 'verification', 'sections'];
const KEYS = {
  plan: ['schema', 'title', 'lens', 'status', 'summary', 'goal', 'non_goals', 'context', 'assumptions', 'questions', 'decisions', 'steps', 'risks', 'verification', 'sections', 'output_hint'],
  assumption: ['id', 'text', 'basis', 'status', 'note'],
  question: ['id', 'text', 'why', 'options', 'recommended', 'allow_other', 'multi', 'status', 'answer'],
  qoption: ['id', 'label', 'detail'],
  decision: ['id', 'title', 'context', 'options', 'recommended', 'chosen', 'status', 'why'],
  doption: ['id', 'label', 'detail', 'pros', 'cons'],
  step: ['id', 'title', 'detail', 'files', 'commands', 'done_when', 'depends_on', 'size', 'status', 'notes', 'phase'],
  file: ['path', 'change', 'to', 'what'],
  risk: ['id', 'text', 'likelihood', 'impact', 'mitigation'],
  section: ['id', 'title', 'body', 'items'],
  output_hint: ['recommend', 'why'],
};
const LEVELS = ['low', 'med', 'medium', 'high'];
// Fields that must be text (a string) for each kind of object; list fields are checked separately.
const TEXT = {
  plan: ['title', 'summary', 'goal'], assumption: ['id', 'text', 'basis', 'note'], question: ['id', 'text', 'why', 'answer', 'recommended'],
  qoption: ['id', 'label', 'detail'], decision: ['id', 'title', 'context', 'why', 'recommended', 'chosen'], doption: ['id', 'label', 'detail'],
  step: ['id', 'title', 'detail', 'notes', 'phase'], file: ['path', 'to', 'what'], risk: ['id', 'text', 'mitigation'], section: ['id', 'title', 'body'], output_hint: ['why'],
};
const DIAGRAM_CLASSES = ['new', 'changed', 'removed', 'external', 'focus', 'needs', 'risk'];
// The page's elements as { tag, attrs } (attribute values may contain ">"); script and style bodies are skipped.
function htmlTags(html) {
  const out = [];
  const body = String(html || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>[\s\S]*?<\/\1>/gi, '<$1$2></$1>');
  for (const m of body.matchAll(/<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const attrs = {};
    for (const a of m[2].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    out.push({ tag: m[1].toLowerCase(), attrs, start: m.index, end: m.index + m[0].length });
  }
  return { tags: out, body };
}
// The diagram parsers live in assets/shell.js; load them in a sandbox so `check` validates diagrams the same way the page renders them.
let PARSERS;
function diagramParsers() {
  if (PARSERS !== undefined) return PARSERS;
  try { const ctx = {}; vm.runInNewContext(fs.readFileSync(path.join(ASSETS, 'shell.js'), 'utf8'), ctx); PARSERS = ctx.PB_PARSE || null; } catch { PARSERS = null; }
  return PARSERS;
}
const decodeEntities = (s) => s.replace(/&(lt|gt|quot|#39|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' }[e]));

// Sequence diagrams and left-to-right flowcharts placed inside a pb-split or pb-grid (by element nesting).
function diagramsBesideEachOther(html) {
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const body = String(html || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>[\s\S]*?<\/\1>/gi, '');
  const stack = []; const out = []; let n = 0;
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g; let m;
  while ((m = re.exec(body))) {
    const [, close, tag0, attrs] = m; const tag = tag0.toLowerCase();
    if (close) { const i = stack.map((x) => x.tag).lastIndexOf(tag); if (i >= 0) stack.length = i; continue; }
    const cm = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/.exec(attrs); const cls = cm ? cm[1] ?? cm[2] ?? cm[3] : '';
    if (tag === 'pre' && /\bpb-diagram\b/.test(cls)) {
      n++;
      const end = body.indexOf('</pre>', re.lastIndex);
      const srcm = /data-src\s*=\s*"([^"]*)"/.exec(attrs);
      const src = decodeEntities(srcm ? srcm[1] : body.slice(re.lastIndex, end < 0 ? undefined : end));
      const first = (src.split('\n').find((l) => l.trim() && !l.trim().startsWith('%%')) || '').trim();
      // wide enough to matter: a sequence diagram with 3+ participants, or a left-to-right flowchart with 4+ nodes
      const P = diagramParsers(); let wide = false;
      try {
        if (/^sequenceDiagram/i.test(first)) wide = !P || P.parseSeq(src.trim()).P.length >= 3;
        else if (/^(?:flowchart|graph)\s+(?:LR|RL)\b/i.test(first)) wide = !P || P.parseFlow(src.trim()).nodes.size >= 4;
      } catch { wide = false; } // a broken diagram is reported elsewhere
      if (wide && stack.some((x) => /(?:^|\s)(?:pb-split|pb-grid)(?:\s|$|--)/.test(x.cls))) { const id = /data-pb-id\s*=\s*["']([^"']+)["']/.exec(attrs); out.push(id ? `"${id[1]}"` : `#${n}`); }
      if (end >= 0) re.lastIndex = end + 6;
      continue;
    }
    if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) stack.push({ tag, cls });
  }
  return out;
}
function lintPlan(plan, htmlText = '') {
  const E = [], W = [];
  const err = (where, msg) => E.push(`${where}: ${msg}`);
  const warn = (where, msg) => W.push(`${where}: ${msg}`);
  const vague = (where, text) => { const v = vagueIn(text); if (v.length) warn(where, `vague wording ${v.map((x) => `"${x}"`).join(', ')} — say exactly what, where, or when`); };
  const vagueAll = (where, list) => strArr(list).forEach((t, j) => vague(`${where}[${j}]`, t));
  const list = (v, where) => { if (v == null) return []; if (Array.isArray(v)) return v; err(where, `must be a list ([ … ]), got ${typeof v}`); return []; };
  const keys = (obj, kind, where) => {
    if (!obj || typeof obj !== 'object') return;
    const norm = (k) => k.toLowerCase().replace(/[-_\s]/g, '');
    for (const k of Object.keys(obj)) if (!KEYS[kind].includes(k)) {
      const near = KEYS[kind].find((x) => norm(x) === norm(k));
      warn(where, `unknown field "${k}"${near ? ` — did you mean "${near}"?` : ' (ignored)'}`);
    }
    for (const k of TEXT[kind] || []) if (obj[k] != null && typeof obj[k] !== 'string') err(`${where}.${k}`, `must be text (a string), got ${Array.isArray(obj[k]) ? 'a list' : typeof obj[k]}`);
  };
  // A list of strings. A bare string is reported (wrap it in [ ]) but still used, so one slip doesn't hide the rest.
  const strList = (v, where) => {
    if (v == null) return [];
    if (typeof v === 'string') { err(where, 'must be a list of strings — wrap it in [ ]'); return [v]; }
    if (!Array.isArray(v)) { err(where, `must be a list of strings, got ${typeof v}`); return []; }
    v.forEach((x, j) => { if (typeof x !== 'string') err(`${where}[${j}]`, `must be a string, got ${Array.isArray(x) ? 'a list' : typeof x}`); });
    return v.filter((x) => typeof x === 'string');
  };
  const oneOf = (v, allowed, where, field) => { if (v != null && !allowed.includes(v)) err(where, `${field} must be ${allowed.join(' | ')}`); };
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { errors: ['plan.json: must be a JSON object { … }'], warnings: [], open: {} };
  keys(plan, 'plan', 'plan.json');
  if (plan.schema !== 1) warn('schema', 'set "schema": 1');
  if (!String(plan.title || '').trim()) err('title', 'missing');
  if (!String(plan.goal || '').trim()) err('goal', 'missing — one or two sentences on the outcome');
  if (!String(plan.summary || '').trim()) warn('summary', 'missing — a short paragraph a newcomer can read first');
  if (plan.lens && !LENSES.includes(plan.lens)) err('lens', `must be one of ${LENSES.join(', ')}`);
  oneOf(plan.status, ['draft', 'in-review', 'approved'], 'status', 'status');
  if (!strList(plan.non_goals, 'non_goals').length) warn('non_goals', 'empty — name at least one thing this plan will not do');
  strList(plan.context, 'context');
  vague('title', plan.title); vague('summary', plan.summary); vague('goal', plan.goal);
  vagueAll('non_goals', plan.non_goals); vagueAll('context', plan.context);
  const lens = plan.lens || 'generic';
  if (plan.output_hint != null) {
    if (typeof plan.output_hint !== 'object') err('output_hint', 'must be { "recommend": …, "why": … } or null');
    else { keys(plan.output_hint, 'output_hint', 'output_hint'); oneOf(plan.output_hint.recommend, Object.keys(OUTPUTS), 'output_hint', 'recommend'); vague('output_hint.why', plan.output_hint.why); }
  }

  const ids = new Map();
  const seeId = (kind, item, i, keyKind) => {
    const where = `${kind}[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) { err(where, 'must be an object { … }'); return null; }
    if (!item.id || typeof item.id !== 'string') { err(where, 'needs a short string "id"'); return null; }
    const w = `${kind}[${item.id}]`;
    if (ids.has(item.id)) err(w, `duplicate id (also used in ${ids.get(item.id)})`);
    ids.set(item.id, kind);
    keys(item, keyKind, w);
    return w;
  };
  const options = (item, w, keyKind) => {
    const opts = list(item.options, `${w}.options`);
    const oids = new Set();
    opts.forEach((o, j) => {
      if (!o || typeof o !== 'object' || !o.id || !o.label) { err(`${w}.options[${j}]`, 'each option needs "id" and "label"'); return; }
      if (oids.has(o.id)) err(`${w}.options[${o.id}]`, 'duplicate option id'); else oids.add(o.id);
      const ow = `${w}.options[${o.id}]`;
      keys(o, keyKind, ow);
      vague(`${ow}.label`, o.label); vague(`${ow}.detail`, o.detail);
      if (keyKind === 'doption') { vagueAll(`${ow}.pros`, strList(o.pros, `${ow}.pros`)); vagueAll(`${ow}.cons`, strList(o.cons, `${ow}.cons`)); }
    });
    return { opts, oids };
  };

  const open = { questions: 0, assumptions: 0, decisions: 0 };
  list(plan.assumptions, 'assumptions').forEach((a, i) => {
    const w = seeId('assumptions', a, i, 'assumption'); if (!w) return;
    if (!String(a.text || '').trim()) err(w, 'missing "text"');
    oneOf(a.status, ['open', 'confirmed', 'rejected'], w, 'status');
    if (!a.status || a.status === 'open') open.assumptions++;
    if (!a.basis) warn(w, 'no "basis" — say what you saw that makes you believe this (file, doc, command output)');
    vague(`${w}.text`, a.text); vague(`${w}.basis`, a.basis); vague(`${w}.note`, a.note);
  });
  list(plan.questions, 'questions').forEach((q, i) => {
    const w = seeId('questions', q, i, 'question'); if (!w) return;
    if (!String(q.text || '').trim()) err(w, 'missing "text"');
    const { opts, oids } = options(q, w, 'qoption');
    if (q.recommended && !oids.has(q.recommended)) err(w, `recommended "${q.recommended}" is not an option id`);
    oneOf(q.status, ['open', 'answered'], w, 'status');
    if (q.status === 'answered' && !q.answer) err(w, 'answered but no "answer" recorded');
    if (!q.status || q.status === 'open') open.questions++;
    if (!q.why) warn(w, 'no "why" — say what the answer changes in the plan');
    if (!opts.length && q.allow_other === false) err(w, 'no options and allow_other is false: nothing to answer with');
    vague(`${w}.text`, q.text); vague(`${w}.why`, q.why); vague(`${w}.answer`, q.answer);
  });
  list(plan.decisions, 'decisions').forEach((d, i) => {
    const w = seeId('decisions', d, i, 'decision'); if (!w) return;
    if (!String(d.title || '').trim()) err(w, 'missing "title"');
    const { opts, oids } = options(d, w, 'doption');
    if (opts.length < 2) warn(w, 'fewer than 2 options — if there is no real choice, make it a step or assumption');
    if (d.recommended && !oids.has(d.recommended)) err(w, `recommended "${d.recommended}" is not an option id`);
    if (d.chosen && !oids.has(d.chosen)) err(w, `chosen "${d.chosen}" is not an option id`);
    oneOf(d.status, ['open', 'decided'], w, 'status');
    if (d.status === 'decided' && !d.chosen) err(w, 'status "decided" but no "chosen"');
    if (d.chosen && !d.why) warn(w, 'chosen but no "why" — record the reason so nobody reopens it');
    if (d.status !== 'decided' && !d.chosen) open.decisions++;
    if (!d.recommended && !d.chosen) warn(w, 'no "recommended" option — give the user your pick');
    vague(`${w}.title`, d.title); vague(`${w}.context`, d.context); vague(`${w}.why`, d.why);
  });

  const steps = list(plan.steps, 'steps');
  if (!steps.length) err('steps', 'empty — a plan needs ordered steps');
  const stepIndex = new Map(steps.map((s, i) => [s && s.id, i]));
  const codeLens = ['feature', 'refactor', 'new-project'].includes(lens);
  steps.forEach((s, i) => {
    const w = seeId('steps', s, i, 'step'); if (!w) return;
    if (!String(s.title || '').trim()) err(w, 'missing "title"');
    vague(`${w}.title`, s.title);
    vague(`${w}.detail`, s.detail);
    vague(`${w}.notes`, s.notes);
    const dw = strList(s.done_when, `${w}.done_when`);
    if (!dw.length) err(w, 'no "done_when" — list observable checks that prove this step is finished');
    dw.forEach((d, j) => vague(`${w}.done_when[${j}]`, d));
    strList(s.commands, `${w}.commands`);
    strList(s.depends_on, `${w}.depends_on`).forEach((dep) => {
      if (!stepIndex.has(dep)) err(w, `depends_on "${dep}" is not a step id`);
      else if (stepIndex.get(dep) >= i) err(w, `depends_on "${dep}" ${dep === s.id ? 'is the step itself' : 'comes later in the list'} — steps run in order, so move it before this one`);
    });
    oneOf(s.status, ['todo', 'doing', 'done', 'skipped'], w, 'status');
    oneOf(s.size, ['S', 'M', 'L'], w, 'size');
    list(s.files, `${w}.files`).forEach((f, j) => {
      if (!f || typeof f !== 'object' || !f.path) { err(`${w}.files[${j}]`, 'needs "path" (each file is { "path", "change", "what" })'); return; }
      keys(f, 'file', `${w}.files[${f.path}]`);
      oneOf(f.change, ['new', 'edit', 'delete', 'move'], `${w}.files[${f.path}]`, 'change');
      vague(`${w}.files[${f.path}].what`, f.what);
      if (f.change === 'move' && !f.to) err(`${w}.files[${f.path}]`, 'change "move" needs "to"');
    });
    if (codeLens && !(Array.isArray(s.files) && s.files.length) && !strArr(s.commands).length) warn(w, 'names no files or commands — which exact files does this touch?');
    if (String(s.detail || '').length > 1800) warn(w, 'detail is very long — split into smaller steps');
  });
  const phased = steps.filter((x) => x && typeof x.phase === 'string' && x.phase.trim());
  if (steps.length > 15 && phased.length < steps.length) warn('steps', `${steps.length} steps — give every step a "phase" (the page and plan.md group them under it) or split the plan`);
  else if (phased.length && phased.length < steps.length) warn('steps', `${steps.length - phased.length} step(s) have no "phase" while others do — give every step one, or none`);
  { const seen = new Set(); let prev = null;
    for (const x of steps) { const ph = x && x.phase; if (ph && ph !== prev && seen.has(ph)) warn(`steps[${x.id}]`, `phase "${ph}" appears again after another phase — keep each phase's steps together`); if (ph) seen.add(ph); prev = ph || null; } }

  list(plan.risks, 'risks').forEach((r, i) => {
    const w = seeId('risks', r, i, 'risk'); if (!w) return;
    if (!r.text) err(w, 'missing "text"');
    if (!r.mitigation) warn(w, 'no "mitigation"');
    oneOf(r.likelihood, LEVELS, w, 'likelihood'); oneOf(r.impact, LEVELS, w, 'impact');
    vague(`${w}.text`, r.text); vague(`${w}.mitigation`, r.mitigation);
  });
  const ver = strList(plan.verification, 'verification');
  if (!ver.length) warn('verification', 'empty — how will we prove the whole thing works end to end?');
  ver.forEach((v, j) => vague(`verification[${j}]`, v));

  // sections: plan.json and plan.html share one id space with the built-in blocks
  const html = String(htmlText || '').replace(/<!--[\s\S]*?-->/g, '');
  const secSeen = new Map();
  const seeSection = (id, where) => {
    const k = String(id).toLowerCase();
    if (BUILTIN_BLOCKS.includes(k)) err(where, `section id "${id}" is a built-in block id — pick another`);
    else if (secSeen.has(k)) err(where, `duplicate section id "${id}" (also in ${secSeen.get(k)})`);
    secSeen.set(k, where);
  };
  list(plan.sections, 'sections').forEach((s, i) => {
    if (!s || typeof s !== 'object' || !s.id || !s.title) { err(`sections[${i}]`, 'needs "id" and "title"'); return; }
    keys(s, 'section', `sections[${s.id}]`);
    seeSection(s.id, `sections[${s.id}]`);
    vague(`sections[${s.id}].title`, s.title); vague(`sections[${s.id}].body`, s.body); vagueAll(`sections[${s.id}].items`, strList(s.items, `sections[${s.id}].items`));
  });
  const { tags } = htmlTags(htmlText);
  for (const t of tags) if (t.attrs['data-pb-section']) seeSection(t.attrs['data-pb-section'], `plan.html data-pb-section`);
  const pbIds = new Map();
  for (const t of tags) if (t.attrs['data-pb-id']) pbIds.set(t.attrs['data-pb-id'], (pbIds.get(t.attrs['data-pb-id']) || 0) + 1);
  for (const [id, n] of pbIds) if (n > 1) warn('plan.html', `data-pb-id="${id}" is used ${n} times — ids must be unique so comments and Δ marks land on the right element`);
  // placeholders
  const byKind = { question: plan.questions, decision: plan.decisions, assumption: plan.assumptions, step: plan.steps, risk: plan.risks, section: plan.sections };
  for (const t of tags.filter((x) => x.attrs['data-pb'] != null)) {
    const v = t.attrs['data-pb'].trim(); const km = /^(question|decision|assumption|step|risk|section):(.+)$/.exec(v);
    if (km) { if (!(Array.isArray(byKind[km[1]]) ? byKind[km[1]] : []).some((x) => x && x.id === km[2].trim())) err('plan.html', `data-pb="${v}" — no ${km[1]} with id "${km[2].trim()}" in plan.json`); }
    else if (!BUILTIN_BLOCKS.includes(v)) err('plan.html', `data-pb="${v}" is not a block; use one of ${BUILTIN_BLOCKS.join(', ')} or kind:id (e.g. question:q1)`);
  }
  // diagrams
  const P = diagramParsers(); let dn = 0;
  if (P) for (const m of html.matchAll(/<pre\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/pre>/gi)) {
    const attrs = m[1];
    if (!/\bclass\s*=\s*["'][^"']*\bpb-diagram\b/.test(attrs)) continue;
    dn++; const idm = /data-pb-id\s*=\s*["']([^"']+)["']/.exec(attrs); const srcm = /data-src\s*=\s*"([^"]*)"/.exec(attrs);
    const src = decodeEntities(srcm ? srcm[1] : m[2].replace(/<br\s*\/?>/gi, '<br>')).replace(/^\s*\n/, '').replace(/\s+$/, '');
    const first = src.split('\n').find((l) => l.trim() && !l.trim().startsWith('%%')) || '';
    const dname = `plan.html diagram ${idm ? `"${idm[1]}"` : `#${dn}`}`;
    try {
      const used = /^\s*sequenceDiagram/i.test(first) ? P.parseSeq(src).P.flatMap((x) => x.cls) : [...P.parseFlow(src).nodes.values()].flatMap((x) => x.cls);
      const bad = [...new Set(used)].filter((c) => !DIAGRAM_CLASSES.includes(c));
      if (bad.length) warn(dname, `unknown class ${bad.map((c) => `":::${c}"`).join(', ')} — it gets no colour; use ${DIAGRAM_CLASSES.join(', ')}`);
    } catch (e) { err(dname, e.message); }
    if (!idm) warn(`plan.html diagram #${dn}`, 'no data-pb-id — give it a stable id so comments on its nodes survive edits');
  }

  // wide diagrams squeezed into a side-by-side layout
  for (const name of diagramsBesideEachOther(htmlText)) warn(`plan.html diagram ${name}`, 'is inside a side-by-side layout (pb-split / pb-grid), where it gets half the width — stack the diagrams one above the other (design.md, "Wide diagrams")');

  // lens expectations
  const sectionIds = new Set(secSeen.keys());
  const has = (re) => [...sectionIds].some((s) => re.test(s));
  if (lens === 'refactor') {
    if (!has(/rollback/)) warn('lens refactor', 'no rollback section — how do we undo this if it goes wrong?');
    if (!has(/before|after|current|target/)) warn('lens refactor', 'no before/after section in plan.html — show current vs target shape');
  }
  if (lens === 'new-project' && !has(/architecture|stack|structure/)) warn('lens new-project', 'no architecture/stack section');
  if (lens === 'non-code' && !has(/deliverable/)) warn('lens non-code', 'no deliverables section');
  if (/Replace this with the one picture/i.test(html)) warn('plan.html', 'the "How it works" section is still the template placeholder — draw the plan\'s main picture there or delete the section');
  if (plan.status === 'approved' && open.questions + open.decisions > 0) warn('status', 'approved but questions/decisions are still open');
  const isRemote = (v) => /^\s*(?:https?:)?\/\//i.test(v);
  const remote = tags.some((t) => (t.tag !== 'a' && ['src', 'href', 'xlink:href', 'data', 'poster'].some((k) => t.attrs[k] != null && isRemote(t.attrs[k])))
    || (t.attrs.srcset != null && t.attrs.srcset.split(',').some((x) => isRemote(x.trim()))))
    || /(?:url\(\s*["']?|@import\s+["'])(?:https?:)?\/\//i.test(html);
  if (remote) warn('plan.html', 'loads something from the internet (script, stylesheet, font or image) — the page must work offline; use the built-in pb-diagram, inline SVG, and local files');
  return { errors: E, warnings: W, open };
}
function lintDir(dir) {
  const { plan, error } = loadPlan(dir);
  if (error) return { errors: [error], warnings: [], open: {} };
  let html = '';
  try { html = fs.readFileSync(path.join(dir, 'plan.html'), 'utf8'); } catch { }
  const r = lintPlan(plan, html);
  if (!html) r.warnings.push('plan.html: missing — the page will show only the built-in blocks');
  return r;
}
function lintSummary(r) {
  const o = r.open || {};
  const openParts = [o.questions && `${o.questions} question${o.questions > 1 ? 's' : ''}`, o.decisions && `${o.decisions} decision${o.decisions > 1 ? 's' : ''}`, o.assumptions && `${o.assumptions} assumption${o.assumptions > 1 ? 's' : ''}`].filter(Boolean);
  return `${r.errors.length} error${r.errors.length === 1 ? '' : 's'}, ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}${openParts.length ? ` · open for the user: ${openParts.join(', ')}` : ''}`;
}
const HANDOFF_HEADINGS = ['Mission', 'Current state', 'Decisions', 'Remaining steps', 'Commands', 'How to verify', 'Gotchas', 'First action'];
// Parts only the session can fill. Each must exist and hold real text (not just a comment).
const HANDOFF_BLANKS = [['###', 'Where things stand'], ['###', 'Setup from a clean checkout'], ['##', 'Gotchas'], ['##', 'First action']];
// Headings the handoff skeleton itself writes at "###" level; a "###" blank ends at one of these (or at any "##"),
// so the agent may use its own "###" subheadings inside a blank.
const HANDOFF_SKELETON_H3 = ['Where things stand', 'Step status', 'Background', 'Settled with the user', 'Still open', 'Setup from a clean checkout', 'Commands used by the steps', 'Risks to watch'];
// The lines that are headings, skipping fenced code the way Markdown does: a fence closes only with the same
// character, at least as long, and nothing else on the line.
function mdHeadings(lines) {
  const heads = []; let fence = null; let comment = false;
  lines.forEach((l, k) => {
    if (!fence) {
      // HTML comments, possibly spanning lines: nothing inside one is a heading
      const startedInComment = comment; let rest = l;
      for (;;) {
        if (comment) { const e = rest.indexOf('-->'); if (e < 0) break; comment = false; rest = rest.slice(e + 3); continue; }
        const b = rest.indexOf('<!--'); if (b < 0) break; comment = true; rest = rest.slice(b + 4);
      }
      if (startedInComment) return;
    }
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null; return; }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) { fence = f[1]; return; }
    const m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l); if (m) heads.push({ k, level: m[1].length, text: m[2] });
  });
  return heads;
}
// Find one of the blanks in a handoff: its heading line and where its body ends.
function handoffBlank(lines, lvl, name) {
  const heads = mdHeadings(lines); const want = lvl.length;
  const named = (x, n) => new RegExp(`^(?:\\d+\\.\\s*)?${n}\\b`, 'i').test(x.text);
  const start = heads.find((x) => x.level === want && named(x, name));
  if (!start) return null;
  const next = heads.find((x) => x.k > start.k && (x.level < 3 || (want === 3 && x.level === 3 && HANDOFF_SKELETON_H3.some((n) => named(x, n)))));
  const j = next ? next.k : lines.length;
  return { i: start.k, j, body: lines.slice(start.k + 1, j).join('\n').trim() };
}
function lintHandoff(text) {
  const E = [], W = [];
  const todos = text.match(/TODO\(agent\)/g);
  if (todos) E.push(`${todos.length} TODO(agent) placeholder${todos.length > 1 ? 's' : ''} left — fill them in and delete the comments`);
  for (const h of HANDOFF_HEADINGS) if (!new RegExp(`^##\\s+(?:\\d+\\.\\s*)?${h}`, 'mi').test(text)) E.push(`missing section "## ${h}"`);
  const lines = text.split('\n');
  for (const [lvl, name] of HANDOFF_BLANKS) {
    const b = handoffBlank(lines, lvl, name);
    if (!b) { if (lvl === '###') E.push(`missing "${lvl} ${name}" — say ${name === 'Where things stand' ? 'what is done, the branch, and unfinished work' : 'how to install, run and test from a clean checkout'}`); continue; }
    if (!b.body.replace(/<!--[\s\S]*?-->/g, '').trim()) E.push(`"${name}" is empty — write it${name === 'Gotchas' ? ' ("None found" if there are none)' : ''}`);
  }
  lines.forEach((line, i) => {
    if (/^\s*<!--/.test(line)) return;
    const v = vagueIn(line.replace(/TODO\(agent\)/g, ''));
    if (v.length) W.push(`line ${i + 1}: vague wording ${v.map((x) => `"${x}"`).join(', ')} — ${oneLine(line, 80)}`);
  });
  if (text.length < 600) W.push('very short — a cold-start agent needs exact files, commands and checks');
  return { errors: E, warnings: W };
}

// ---------- markdown export ----------
const CHANGE_WORD = { new: 'new', edit: 'edit', delete: 'delete', move: 'move' };
const arrOf = (v) => (Array.isArray(v) ? v : []);
const mdCell = (s) => String(s).replace(/\|/g, '\\|');
function fence(lines) { const run = Math.max(0, ...lines.map((l) => Math.max(0, ...(String(l).match(/`+/g) || ['']).map((m) => m.length)))); return '`'.repeat(Math.max(3, run + 1)); }
// Steps in order, with a "Phase: …" line whenever the phase changes.
function mdSteps(steps, nums) {
  const L = []; let phase = null;
  for (const s of steps) {
    if (s.phase && s.phase !== phase) L.push(`**Phase: ${oneLine(s.phase, 200)}**`, '');
    else if (!s.phase && phase) L.push('**Steps without a phase**', '');
    phase = s.phase || null;
    L.push(mdStep(s, nums.get(s.id), nums));
  }
  return L;
}
function stepNumberMap(plan) { const m = new Map(); arrOf(plan.steps).forEach((s, i) => s && m.set(s.id, i + 1)); return m; }
function mdStep(s, n, nums) {
  const L = [];
  const tags = [`id \`${s.id}\``, s.size && `size ${s.size}`, s.status && s.status !== 'todo' && s.status].filter(Boolean);
  L.push(`### Step ${n}. ${oneLine(s.title, 300)}`, '');
  L.push(tags.join(' · '), '');
  const deps = strArr(s.depends_on);
  if (deps.length) L.push(`**After:** ${deps.map((d) => `Step ${nums.get(d) ?? d}`).join(', ')}`, '');
  if (s.detail) L.push(String(s.detail).trim(), '');
  const files = arrOf(s.files).filter((f) => f && f.path);
  if (files.length) {
    L.push('**Files:**', '');
    for (const f of files) L.push(`- \`${f.path}\`${f.change === 'move' && f.to ? ` → \`${f.to}\`` : ''} — **${CHANGE_WORD[f.change] || 'edit'}**${f.what ? `: ${f.what}` : ''}`);
    L.push('');
  }
  const cmds = strArr(s.commands);
  if (cmds.length) { const f = fence(cmds); L.push('**Run:**', '', f + 'sh', ...cmds, f, ''); }
  const dw = strArr(s.done_when);
  if (dw.length) { L.push('**Done when:**', ''); for (const d of dw) L.push(`- [${s.status === 'done' ? 'x' : ' '}] ${d}`); L.push(''); }
  if (s.notes) L.push(`> ${String(s.notes).replace(/\n/g, '\n> ')}`, '');
  return L.join('\n');
}
function fileIndex(plan) {
  const idx = new Map();
  const nums = stepNumberMap(plan);
  for (const s of arrOf(plan.steps)) for (const f of arrOf(s && s.files)) {
    if (!f || !f.path) continue;
    const k = f.path;
    if (!idx.has(k)) idx.set(k, { path: k, changes: new Set(), steps: [], to: f.to });
    const e = idx.get(k); e.changes.add(f.change || 'edit'); e.steps.push(nums.get(s.id));
  }
  return [...idx.values()].sort((a, b) => a.path.localeCompare(b.path));
}
function mdDecision(d) {
  const opts = arrOf(d.options);
  const label = (id) => opts.find((o) => o.id === id)?.label || id;
  if (d.chosen) {
    const rejected = opts.filter((o) => o.id !== d.chosen).map((o) => o.label);
    return `- \`${d.id}\` ${oneLine(d.title, 300)}\n  **Chosen:** ${label(d.chosen)}.${d.why ? ` ${d.why}` : ''}${rejected.length ? `\n  _Not chosen:_ ${rejected.join('; ')}` : ''}`;
  }
  return `- \`${d.id}\` ${oneLine(d.title, 300)}\n  **NOT DECIDED.** Options: ${opts.map((o) => `${o.label}${o.id === d.recommended ? ' (recommended)' : ''}`).join('; ')}`;
}
function mdQuestion(q) {
  const opt = (id) => arrOf(q.options).find((o) => o.id === id)?.label || id;
  if (q.status === 'answered') return `- \`${q.id}\` ${q.text}\n  **Answer:** ${q.answer}`;
  return `- \`${q.id}\` **OPEN:** ${q.text}${q.recommended ? ` (agent suggests: ${opt(q.recommended)})` : ''}`;
}
function mdAssumption(a) {
  if (a.status === 'confirmed') return `- [x] \`${a.id}\` ${a.text}${a.note ? ` — ${a.note}` : ''}`;
  if (a.status === 'rejected') return `- [ ] \`${a.id}\` **WRONG:** ~~${a.text}~~\n  **Actually:** ${a.note || '(no correction given)'}`;
  return `- [ ] \`${a.id}\` **UNCONFIRMED:** ${a.text}${a.basis ? ` _(basis: ${a.basis})_` : ''}`;
}
function mdSections(plan, level = '##') {
  const L = [];
  for (const s of arrOf(plan.sections)) {
    if (!s || !s.title) continue;
    L.push(`${level} ${oneLine(s.title, 200)}`, '');
    if (s.body) L.push(String(s.body).trim(), '');
    if (strArr(s.items).length) { for (const it of strArr(s.items)) L.push(`- ${it}`); L.push(''); }
  }
  return L.join('\n');
}
function toPlanMd(plan, dir) {
  const m = meta(dir);
  const nums = stepNumberMap(plan);
  const L = [];
  L.push(`# ${oneLine(plan.title, 300)}`, '');
  L.push(`> Status: **${plan.status || 'draft'}** · lens: ${plan.lens || 'generic'} · review round ${m.round} · exported ${localDate()}`);
  L.push(`> Generated from \`${rel(dir)}/plan.json\`; edit that file, not this one (regenerate: \`${CMD} export ${planArg(dir)}\`). Steps are in order; finish each step's "Done when" before starting the next. Ids like \`q1\`, \`a2\`, \`d1\`, \`s3\` refer to the items below.`, '');
  if (plan.summary) L.push('## Summary', '', plan.summary, '');
  L.push('## Goal', '', plan.goal || '_(missing)_', '');
  if (strArr(plan.non_goals).length) { L.push('**Not doing:**', ''); for (const g of strArr(plan.non_goals)) L.push(`- ${g}`); L.push(''); }
  if (strArr(plan.context).length) { L.push('## Context', ''); for (const c of strArr(plan.context)) L.push(`- ${c}`); L.push(''); }
  if (arrOf(plan.decisions).length) { L.push('## Decisions', ''); for (const d of plan.decisions) L.push(mdDecision(d)); L.push(''); }
  if (arrOf(plan.assumptions).length) { L.push('## Assumptions', ''); for (const a of plan.assumptions) L.push(mdAssumption(a)); L.push(''); }
  if (arrOf(plan.questions).length) { L.push('## Questions', ''); for (const q of plan.questions) L.push(mdQuestion(q)); L.push(''); }
  L.push('## Steps', '');
  L.push(...mdSteps(arrOf(plan.steps).filter(Boolean), nums));
  const files = fileIndex(plan);
  if (files.length) {
    L.push('## Files touched', '', '| File | Change | Steps |', '| --- | --- | --- |');
    for (const f of files) L.push(`| \`${mdCell(f.path)}\`${f.to ? ` → \`${mdCell(f.to)}\`` : ''} | ${[...f.changes].join(', ')} | ${[...new Set(f.steps)].join(', ')} |`);
    L.push('');
  }
  if (arrOf(plan.risks).length) {
    L.push('## Risks', '');
    for (const r of plan.risks) L.push(`- \`${r.id}\` ${r.text} (likelihood ${r.likelihood || '?'}, impact ${r.impact || '?'})${r.mitigation ? `\n  **Mitigation:** ${r.mitigation}` : ''}`);
    L.push('');
  }
  if (strArr(plan.verification).length) { L.push('## Verification', ''); for (const v of strArr(plan.verification)) L.push(`- [ ] ${v}`); L.push(''); }
  L.push(mdSections(plan));
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
function toHandoffMd(plan, dir) {
  const nums = stepNumberMap(plan);
  const steps = arrOf(plan.steps);
  const remaining = steps.filter((s) => !['done', 'skipped'].includes(s.status));
  const commands = [...new Set(steps.flatMap((s) => strArr(s.commands)))];
  const openQ = arrOf(plan.questions).filter((q) => q.status !== 'answered');
  const openD = arrOf(plan.decisions).filter((d) => !d.chosen);
  const hasSections = arrOf(plan.sections).some((s) => s && s.title);
  let n = 0; const H = (t) => `## ${++n}. ${t}`;
  const L = [];
  L.push(`# Handoff: ${oneLine(plan.title, 300)}`, '');
  L.push(`> For a fresh agent session with no memory of the planning conversation. Read the whole file before acting.`);
  L.push(`> Full plan with visuals: \`${rel(dir)}/plan.json\` and \`plan.html\`. This file is meant to be enough on its own. Ids like \`q1\`, \`a2\`, \`d1\`, \`s3\` refer to items in this file.`, '');
  L.push(H('Mission'), '', plan.goal || '', '');
  if (plan.summary) L.push(plan.summary, '');
  if (strArr(plan.non_goals).length) { L.push('**Out of scope — do not do these:**', ''); for (const g of strArr(plan.non_goals)) L.push(`- ${g}`); L.push(''); }
  L.push(H('Current state'), '');
  L.push('### Where things stand', '');
  L.push('<!-- TODO(agent): What is already done (by step id), the branch, uncommitted or half-finished work, and anything the user said during planning that is not captured below. Replace this comment with that text. -->', '');
  L.push('### Step status', '');
  steps.forEach((s, i) => L.push(`- Step ${i + 1} (\`${s.id}\`) ${oneLine(s.title, 200)}: **${s.status || 'todo'}**`));
  L.push('');
  if (strArr(plan.context).length) { L.push('### Background', ''); for (const c of strArr(plan.context)) L.push(`- ${c}`); L.push(''); }
  L.push(H('Decisions already made — do not reopen'), '');
  const decided = arrOf(plan.decisions).filter((d) => d.chosen);
  if (decided.length) for (const d of decided) L.push(mdDecision(d)); else L.push('_None recorded._');
  const facts = arrOf(plan.assumptions).filter((a) => a.status && a.status !== 'open');
  const answered = arrOf(plan.questions).filter((q) => q.status === 'answered');
  if (facts.length || answered.length) {
    L.push('', '### Settled with the user', '');
    for (const a of facts) L.push(mdAssumption(a));
    for (const q of answered) L.push(mdQuestion(q));
  }
  if (openQ.length || openD.length) {
    L.push('', '### Still open — ask the user before acting on these', '');
    for (const q of openQ) L.push(mdQuestion(q));
    for (const d of openD) L.push(mdDecision(d));
  }
  L.push('');
  L.push(H('Remaining steps'), '', 'Do these in order. A step is finished only when every "Done when" check passes.', '');
  if (remaining.length) L.push(...mdSteps(remaining, nums)); else L.push('_All steps are done._', '');
  L.push(H('Commands'), '');
  L.push('### Setup from a clean checkout', '');
  L.push('<!-- TODO(agent): How to install, run, and test from a clean checkout: exact commands, env vars (names and where to get values), ports. For non-code work: the tools, accounts, and files needed. Replace this comment with that text. -->', '');
  if (commands.length) { const f = fence(commands); L.push('### Commands used by the steps', '', f + 'sh', ...commands, f, ''); }
  L.push(H('How to verify'), '');
  if (strArr(plan.verification).length) for (const v of strArr(plan.verification)) L.push(`- [ ] ${v}`); else L.push('<!-- TODO(agent): end-to-end checks that prove the whole change works. -->');
  L.push('');
  if (arrOf(plan.risks).length) { L.push('### Risks to watch', ''); for (const r of plan.risks) L.push(`- \`${r.id}\` ${r.text}${r.mitigation ? ` — mitigation: ${r.mitigation}` : ''}`); L.push(''); }
  if (hasSections) L.push(H('More from the plan'), '', mdSections(plan, '###'));
  L.push(H('Gotchas and things already tried'), '');
  L.push('<!-- TODO(agent): Traps you found while investigating: surprising code paths, flaky tests, approaches that were rejected and why, files that look related but are not. Write "None found" if truly none. Replace this comment with that text. -->', '');
  L.push(H('First action'), '');
  L.push('<!-- TODO(agent): The exact first thing the next agent should do (a command to run or a file to open), and what it should see. Replace this comment with that text. -->', '');
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ---------- HTTP client helpers (CLI side) ----------
// Secret shared by the CLI and the server (both run as this user, file mode 0600). Agent-side routes require it,
// so web pages and other local programs can't take feedback, post replies, or stop the server.
const TOKEN_FILE = path.join(HOME, 'token');
let TOKEN = null;
function authToken() {
  if (TOKEN && fs.existsSync(TOKEN_FILE)) return TOKEN;
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString('hex'), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  return TOKEN;
}
const tokenProof = (token, nonce) => crypto.createHash('sha256').update(`${token}:${nonce}`).digest('hex');
// The token goes only to a server that has proved it already knows it (see health()).
function request(port, method, p, body, timeoutMs = 5000, auth = true) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { ...(auth ? { 'x-planboard-token': authToken() } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) };
    const req = http.request({ host: HOST, port, method, path: p, headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let j = null; try { j = JSON.parse(buf); } catch { }
        if (res.statusCode >= 400) reject(Object.assign(new Error((j && j.error) || buf || `HTTP ${res.statusCode}`), { status: res.statusCode }));
        else resolve(j);
      });
    });
    req.on('error', reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}
// Health check without the token. `ours` is true only if the server proved it knows this HOME's token.
// The proof covers the port the server itself listens on, so a program that relays to the real server
// from another port fails it. A server too old to send a proof at all is `legacy`.
async function health(port) {
  const nonce = rid() + rid(); const token = authToken();
  try {
    const h = await request(port, 'GET', `/_api/health?nonce=${nonce}`, null, 1200, false);
    if (!h || h.app !== 'planboard') return null;
    // Only a proof bound to this port makes a server ours. A 1.2.0 server's port-less proof shows it knows the
    // token too, but a relay could pass it along, so such a server is treated as legacy: stopped without the token.
    const proved = !!h.proof && h.proof === tokenProof(token, `${nonce}:${port}`);
    const oldProof = !proved && !!h.proof && h.proof === tokenProof(token, nonce);
    return { ...h, legacy: !('proof' in h) || oldProof, ours: h.home === HOME && proved };
  } catch { return null; }
}
// Is this pid the planboard server for this port? Its command line is `planboard.mjs serve --port <port>`,
// and no other process can hold that port, so a matching pid can't be some other planboard server.
function isPlanboardServer(pid, port) {
  try { return new RegExp(`planboard\\.mjs\\s+serve\\s+--port\\s+${Number(port)}(?!\\d)`).test(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return false; }
}
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, HOST, () => s.close(() => resolve(true)));
  });
}
async function runningServer() {
  const info = readJSON(path.join(HOME, 'server.json'), null);
  if (!info || !info.port) return null;
  const h = await health(info.port);
  return h && h.ours ? { port: info.port, h } : null;
}
async function waitUntilDown(port, ms = 4000) {
  for (let t = 0; t < ms; t += 100) { if (!(await health(port))) return true; await sleep(100); }
  return false;
}
// Stop an older planboard for this HOME without giving it the token: ask it, and if it refuses (1.1.0 and
// 1.2.0 want the token), signal its process, but only after checking that the pid serves this port.
async function stopLegacy(port, h) {
  try { await request(port, 'POST', '/_api/shutdown', {}, 2000, false); } catch { }
  if (await waitUntilDown(port, 1500)) return true;
  if (h && h.pid && isPlanboardServer(h.pid, port)) { try { process.kill(h.pid, 'SIGTERM'); } catch { } return waitUntilDown(port); }
  return false;
}
// One server per PLANBOARD_HOME: commands started in parallel take a lock so only one of them starts it.
async function withStartLock(fn) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const lock = path.join(HOME, 'start.lock');
  const alive = (pid) => { try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; } return isPlanboardCommand(pid); };
  const isPlanboardCommand = (pid) => { try { return /planboard\.mjs/.test(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return false; } };
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const pid = Number(fs.readFileSync(lock, 'utf8')) || 0;
        // left behind by a command that died, or older than any real start: take it over
        if (!pid || !alive(pid) || Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.unlinkSync(lock); continue; }
      } catch { continue; }
      if (i > 120) fail(`Another planboard command has been starting the server for over 12 s. If none is running, delete ${lock}.`);
      await sleep(100);
    }
  }
  try { return await fn(); } finally { try { fs.unlinkSync(lock); } catch { } }
}
async function ensureServer() {
  const cur = await runningServer();
  if (cur && cur.h.version === VERSION) return cur.port;
  return withStartLock(startServer);
}
async function startServer() {
  const cur = await runningServer();
  if (cur) {
    if (cur.h.version === VERSION) return cur.port;
    try { await request(cur.port, 'POST', '/_api/shutdown', {}); } catch { }
    await waitUntilDown(cur.port);
  }
  let port = null;
  for (let p = BASE_PORT; p < BASE_PORT + 40; p++) {
    const h = await health(p);
    if (h && h.ours && h.version === VERSION) return p;
    if (h && h.home === HOME && h.legacy && (await stopLegacy(p, h))) { port = p; break; }
    if (await portFree(p)) { port = p; break; }
  }
  if (!port) fail(`No free port between ${BASE_PORT} and ${BASE_PORT + 39}. Set PLANBOARD_PORT.`);
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  authToken();
  const log = fs.openSync(path.join(HOME, 'server.log'), 'a', 0o600);
  const child = spawn(process.execPath, [SELF, 'serve', '--port', String(port)], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const h = await health(port);
    if (h && h.ours) return port;
  }
  fail(`The local server did not start. See ${path.join(HOME, 'server.log')}`);
}
async function register(port, dir) { return request(port, 'POST', '/_api/register', { dir }); }
function openBrowser(url) {
  const plat = process.platform;
  let cmd, args;
  if (plat === 'darwin') { cmd = 'open'; args = [url]; }
  else if (plat === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
  else {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
    cmd = 'xdg-open'; args = [url];
  }
  try { const c = spawn(cmd, args, { detached: true, stdio: 'ignore' }); c.on('error', () => { }); c.unref(); return true; } catch { return false; }
}

// ---------- feedback formatting (what the agent reads) ----------
const VERDICT = { confirm: 'CONFIRMED', reject: 'REJECTED', edit: 'CORRECTED' };
const REFS = tildify(path.join(SKILL_DIR, 'references'));
function fmtTarget(t, omitKind) {
  if (!t) return '';
  const id = t.id || t.section || '';
  const label = t.label ? `"${oneLine(t.label, 90)}"` : '';
  return [omitKind ? '' : t.kind, id, label].filter(Boolean).join(' ');
}
function fmtText(s) { return String(s || '').includes('\n') ? '\n' + indent(String(s).trim(), 6) : ` "${String(s).trim()}"`; }
function fmtDuration(s) { return s < 120 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`; }
function fmtItem(i, n) {
  const tag = `[${n}]`;
  const mode = i.mode === 'ask' ? 'ASK' : 'CHANGE';
  switch (i.kind) {
    case 'answer': {
      const parts = [...(i.choiceLabels || []).map((l) => `"${l}"`)];
      if (i.text) parts.push(`own answer: "${String(i.text).trim()}"`);
      return `${tag} ANSWER to question ${fmtTarget(i.target, true)}\n    → ${parts.join(' + ') || '(empty)'}${(i.choice || []).length ? `   (option ${i.choice.join(', ')})` : ''}`;
    }
    case 'assumption':
      return `${tag} ASSUMPTION ${fmtTarget(i.target, true)}\n    → ${VERDICT[i.verdict] || i.verdict}${i.text ? `. User says:${fmtText(i.text)}` : ''}`;
    case 'decision':
      return `${tag} DECISION ${fmtTarget(i.target, true)}\n    → CHOSE "${i.choiceLabel || i.choice}" (option ${i.choice})${i.text ? `. Note:${fmtText(i.text)}` : ''}`;
    case 'comment': {
      const L = [`${tag} ${mode} — comment on ${fmtTarget(i.target) || 'the page'}`];
      if (i.target && i.target.quote) L.push(`    on the text: "${oneLine(i.target.quote, 200)}"`);
      L.push(`    says:${fmtText(i.text)}`);
      return L.join('\n');
    }
    case 'message': return `${tag} ${mode} — message:${fmtText(i.text)}`;
    case 'approve-section': return `${tag} LOOKS GOOD — ${fmtTarget(i.target)}. Treat it as settled; don't rework it unless something else forces it.`;
    case 'approve': return `${tag} APPROVED THE PLAN → wants: ${OUTPUTS[i.output] || i.output}${i.text ? `\n    note:${fmtText(i.text)}` : ''}`;
    case 'end': return `${tag} ENDED THE REVIEW in the browser.`;
    case 'custom': return `${tag} INPUT from ${fmtTarget(i.target) || 'a page control'}:${fmtText(i.text)}${i.data !== undefined ? `\n    data: ${JSON.stringify(i.data)}` : ''}`;
    default: return `${tag} ${i.kind}: ${JSON.stringify(i)}`;
  }
}
const isChangeItem = (i) => ['answer', 'assumption', 'decision', 'custom'].includes(i.kind) || (['comment', 'message'].includes(i.kind) && i.mode !== 'ask');
function formatFeedback(r, dir, { after = null } = {}) {
  const D = planArg(dir);
  const poll = `${CMD} poll ${D}`;
  if (r.type === 'timeout') {
    const tab = r.clients === 0 ? 'No browser tab has the plan open right now; if the user closed it, tell them the link or run open again.' : 'The page is open in the browser.';
    return `No feedback yet (waited ${fmtDuration(r.waited)}). ${tab}\n${listenAgain(D)}`;
  }
  if (r.type === 'none') return 'No new feedback.';
  // Two listeners must not keep replacing each other, so this one stands down.
  if (r.type === 'replaced') return `A newer wait on this plan took over, so this one stopped. Don't start another: the newer one (from this session or another session) gets the feedback. Only if you are sure nothing else is listening (for example you started a second wait by mistake and then stopped it), listen again with: ${CMD} wait ${D} --background`;
  if (r.type === 'ended') return endedText(r.by, dir);
  const items = r.batches.flatMap((b) => b.items);
  const L = [];
  const advanced = items.some(isChangeItem);
  const onlyAsks = items.every((i) => ['comment', 'message'].includes(i.kind) && i.mode === 'ask');
  L.push(`FEEDBACK on ${rel(dir)} — ${items.length} item${items.length === 1 ? '' : 's'}${advanced ? ` (round ${r.round}: the page marks with Δ whatever you change next)` : onlyAsks ? ' (questions only; the plan\'s round is unchanged)' : ''}`, '');
  const again2 = new Set(Array.isArray(r.redelivered) ? r.redelivered : []);
  if (again2.size) {
    // item numbers as printed below
    const nums = []; let k = 0;
    for (const b of r.batches) for (const _ of b.items) { k++; if (again2.has(b.id)) nums.push(k); }
    const n = nums.length;
    const which = n === items.length ? (n === 1 ? 'This item was' : `All ${n} items were`) : `${n === 1 ? 'Item' : 'Items'} ${nums.map((x) => `[${x}]`).join(', ')} ${n === 1 ? 'was' : 'were'}`;
    L.push(`NOTE: ${which} delivered before, but the earlier wait ended before confirming it got ${n === 1 ? 'it' : 'them'}. Check whether you already applied ${n === 1 ? 'it' : 'them'} (look at plan.json and your last reply) before applying again.`, '');
  }
  items.forEach((it, i) => L.push(fmtItem(it, i + 1)));
  L.push('', 'What to do now:');
  const kinds = new Set(items.map((i) => i.kind));
  const verdicts = new Set(items.filter((i) => i.kind === 'assumption').map((i) => i.verdict));
  const change = items.some((i) => ['comment', 'message'].includes(i.kind) && i.mode !== 'ask');
  const ask = items.some((i) => ['comment', 'message'].includes(i.kind) && i.mode === 'ask');
  const approve = items.find((i) => i.kind === 'approve');
  const userEnded = items.some((i) => i.kind === 'end') || (r.ended && r.endedBy === 'user');
  if (kinds.has('answer')) L.push('- ANSWER: set questions[id].status "answered" and .answer (plain words). Then update every step, file, or decision that depends on it.');
  if (verdicts.has('confirm')) L.push('- CONFIRMED: set assumptions[id].status "confirmed" (and .note if the user said something).');
  if (verdicts.has('reject')) L.push('- REJECTED: set assumptions[id].status "rejected" and .note with what is true instead (ask in your reply if you don\'t know). Fix every step that relied on it.');
  if (verdicts.has('edit')) L.push('- CORRECTED: set assumptions[id].status "rejected" and .note to the user\'s corrected fact. Fix every step that relied on the old belief.');
  if (kinds.has('decision')) L.push('- DECISION: set decisions[id].chosen, .status "decided", and .why. Remove or rewrite anything that only made sense for the other options.');
  if (change) L.push('- CHANGE: edit plan.json / plan.html so the plan reflects it. If you disagree or it conflicts with something, keep the plan as is and explain why in your reply.');
  if (ask) L.push("- ASK: answer in your reply. Don't change the plan for it unless the answer exposes a real gap — then say what you changed.");
  if (kinds.has('custom')) L.push('- INPUT: apply it the way the control that sent it was meant to be used, and record the result in plan.json so it reaches the outputs.');
  if (approve) {
    if (items.some((i) => i !== approve && isChangeItem(i))) L.push('- The approval came with the changes above: apply them first. If one leaves a step without a valid basis (e.g. a rejected assumption with no correction), add an open question to plan.json instead of guessing, and say so in your reply.');
    if (approve.text) L.push('- Record the approval note in plan.json (in `context`, or in the step it concerns) so it reaches plan.md / handoff.md.');
    L.push(`- APPROVED: set plan.json "status": "approved", run \`${CMD} check ${D}\`, then produce "${OUTPUTS[approve.output] || approve.output}" following ${REFS}/outputs.md.`);
    L.push(`  Then post the result with \`${CMD} reply ${D} "<where the output is and what happens next>"\`.`);
    L.push(approve.output === 'continue'
      ? `  While building, check for comments between steps with: ${poll}`
      : `  Then keep listening in the background, so comments the user adds later still reach you: ${CMD} wait ${D} --background${approve.output === 'agent' ? ` (if you choose to build here instead, check between steps with: ${poll})` : ''}`);
  } else if (userEnded) {
    L.push(`- The user ended the review. Apply what is above, then continue in the terminal. Don't run wait or reopen the page unless they ask.`);
  } else if (r.ended) {
    L.push(`- You ended this review earlier. Apply what is above and reply if needed; reopen the page only if the user asks.`);
  } else if (after && after.mode === 'build') {
    L.push(`- Run \`${CMD} check ${D}\` and fix errors.`);
    L.push(`- Reply in the page: \`${CMD} reply ${D} "<what you changed, answers to ASK items>"\`.`);
    L.push(`- You're building (${after.output === 'continue' ? 'the user chose "Build it here"' : 'the user let you choose and you chose to build'}): continue with the next step and check again between steps with: ${poll}  (don't run wait).`);
  } else if (after && after.mode === 'files') {
    L.push(`- Run \`${CMD} check ${D}\` and fix errors.`);
    const how = { 'plan.md': `\`${CMD} export ${D}\` (rebuilds plan.md)`, 'handoff.md': `\`${CMD} export ${D} --handoff --update\` (rebuilds handoff.md, keeps your filled-in parts)` };
    L.push(`- The plan is approved and ${after.files.join(' and ')} ${after.files.length > 1 ? 'are' : 'is'} the output: bring ${after.files.length > 1 ? 'them' : 'it'} up to date with ${after.files.map((f) => how[f]).join(' and ')}.`);
    L.push(`- Reply in the page: \`${CMD} reply ${D} "<what you changed>"\`.`);
    L.push(`- ${listenAgain(D)}`);
  } else if (after && after.mode === 'pick') {
    L.push(`- Run \`${CMD} check ${D}\` and fix errors.`);
    L.push(`- The user approved the plan and let you choose the output, and you haven't produced one yet: apply the feedback above, then pick and produce it following ${REFS}/outputs.md.`);
    L.push(`- Reply in the page: \`${CMD} reply ${D} "<what you changed>"\`.`);
    L.push(`- ${listenAgain(D)}`);
  } else {
    L.push(`- Run \`${CMD} check ${D}\` and fix errors.`);
    L.push(`- Reply in the page: \`${CMD} reply ${D} "<what you changed, answers to ASK items>"\` (use --file for long replies).`);
    L.push(`- ${listenAgain(D)}`);
  }
  return L.join('\n');
}
// How to keep listening. Background first: Claude Code runs the command in the background and wakes the agent
// when it exits, i.e. the moment the user sends feedback; the agent stays free to talk in the meantime.
function listenAgain(D) {
  return `Listen again in the background (Bash tool with run_in_background: true; you're woken when the user sends feedback): ${CMD} wait ${D} --background
  Without background commands: ${CMD} wait ${D} with the Bash tool timeout set to 600000, repeated on "No feedback yet".`;
}
function endedText(by, dir) {
  return by === 'user'
    ? `The user ended the review in the browser. Stop waiting. Continue in the terminal; don't reopen the page unless they ask (then use: ${CMD} open ${planArg(dir)} --reopen).`
    : `This review was ended from the terminal. Reopen it with: ${CMD} open ${planArg(dir)}`;
}

// ---------- commands ----------
const LENS_HINTS = {
  feature: 'Feature or bug: show the flow that changes (pb-diagram sequence or flowchart with :::new / :::changed nodes), the shape of the data or API (pb-code), and for bugs the root cause with evidence.',
  'new-project': 'New project: show the architecture (pb-diagram flowchart), the stack choices as decisions, the folder layout (pb-tree), and milestones (pb-timeline). Use section ids "architecture" and "milestones".',
  refactor: 'Refactor or migration: show before vs after (section id "before-after"): small shapes side by side in a pb-split, diagrams stacked one above the other with data-caption "Today" / "After this plan"; the rollout order, and a rollback plan as a plan.json section with id "rollback" (so it reaches plan.md; place it here with <div data-pb="section:rollback"></div>).',
  'non-code': 'Non-code project: show deliverables (section id "deliverables"), a timeline (pb-timeline), who does what (pb-table), and any budget or numbers as a small table. Put the numbers in a plan.json section too, so they reach plan.md.',
  generic: 'Pick the form that fits: diagram for structure or flow, table for comparisons, timeline for sequence in time, mock for UI, code for exact shapes.',
};
function cmdNew(a) {
  const title = a._.slice(1).join(' ').trim();
  if (!title) fail(`Usage: ${CMD} new "<title>" [--lens ${LENSES.join('|')}] [--root <project dir>]`);
  const lens = a.lens || 'generic';
  if (!LENSES.includes(lens)) fail(`--lens must be one of ${LENSES.join(', ')}`);
  const root = path.resolve(a.root || '.');
  const base = path.join(root, '.plans');
  const slug = slugify(title);
  const date = localDate();
  let dir = path.join(base, `${date}-${slug}`);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(base, `${date}-${slug}-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  const plan = JSON.parse(fs.readFileSync(path.join(ASSETS, 'plan.template.json'), 'utf8'));
  plan.title = title; plan.lens = lens;
  writeJSON(path.join(dir, 'plan.json'), plan, 0o644);
  const html = fs.readFileSync(path.join(ASSETS, 'plan.template.html'), 'utf8')
    .replaceAll('{{TITLE}}', escHtml(title)).replaceAll('{{LENS_HINT}}', LENS_HINTS[lens]);
  fs.writeFileSync(path.join(dir, 'plan.html'), html);
  let gitHint = '';
  const gi = path.join(root, '.gitignore');
  if (fs.existsSync(path.join(root, '.git'))) {
    const txt = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (!/^\/?\.plans\/?$/m.test(txt)) gitHint = `\nNote: .plans/ is not in .gitignore. Ask the user whether plans should be committed; if not, add ".plans/" to .gitignore.`;
  }
  const R = rel(dir);
  print(`Created ${R}/ with plan.json and plan.html (lens: ${lens}).
Next:
  1. Fill plan.json (${REFS}/plan-schema.md) and plan.html (${REFS}/design.md, ${REFS}/components.md).
  2. ${CMD} check ${planArg(dir)}
  3. ${CMD} open ${planArg(dir)}${gitHint}`);
}
function printHandoffCheck(f) {
  const r = lintHandoff(fs.readFileSync(f, 'utf8'));
  print([`check ${rel(f)}: ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}, ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}`, ...r.errors.map((e) => `ERROR ${e}`), ...r.warnings.map((w) => `WARN  ${w}`)].join('\n'));
  process.exit(r.errors.length ? 1 : 0);
}
function cmdCheck(a) {
  if (a.handoff && a._[1] && /\.md$/i.test(a._[1]) && fs.existsSync(a._[1]) && fs.statSync(a._[1]).isFile()) return printHandoffCheck(path.resolve(a._[1]));
  const dir = resolvePlanDir(a._[1]);
  if (a.handoff) {
    const f = path.join(dir, 'handoff.md');
    if (!fs.existsSync(f)) fail(`No handoff.md in ${rel(dir)}. Create it with: ${CMD} export ${planArg(dir)} --handoff  (or pass the file: ${CMD} check <path/to/handoff.md> --handoff)`);
    return printHandoffCheck(f);
  }
  const r = lintDir(dir);
  const L = [`check ${rel(dir)}: ${lintSummary(r)}`];
  for (const e of r.errors) L.push(`ERROR ${e}`);
  for (const w of r.warnings) L.push(`WARN  ${w}`);
  if (!r.errors.length && !r.warnings.length) L.push('Clean. Before opening, do the cold-start test: could a fresh agent do every step from this plan alone, without asking anything?');
  print(L.join('\n'));
  process.exit(r.errors.length ? 1 : 0);
}
// The page shows "Draft" until the plan is under review; opening it is that moment.
function markInReview(dir, from = ['draft']) {
  const f = path.join(dir, 'plan.json');
  try {
    const text = fs.readFileSync(f, 'utf8'); const plan = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (plan.status && !from.includes(plan.status)) return;
    // edit the text in place so the agent's own formatting survives
    const next = plan.status ? text.replace(new RegExp(`("status"\\s*:\\s*)"${plan.status}"`), '$1"in-review"') : text.replace(/^(\s*\{)(\s*)/, (m, brace, ws) => `${brace}${ws || '\n  '}"status": "in-review",${ws || '\n  '}`);
    if (next !== text) fs.writeFileSync(f, next);
  } catch { }
}
async function cmdOpen(a) {
  const dir = resolvePlanDir(a._[1]);
  const m = meta(dir);
  if (m.ended && m.endedBy === 'user' && !a.reopen) { print(endedText('user', dir)); return; }
  const reopened = !!m.ended;
  // reopening starts a new review round: the earlier approval no longer decides what feedback means
  if (m.ended) { m.ended = false; m.endedBy = null; delete m.approvedOutput; delete m.approvedAt; setMeta(dir, m); }
  const lint = lintDir(dir);
  // opening starts (or, after an ended review, restarts) the review
  if (!lint.errors.length) markInReview(dir, reopened ? ['draft', 'approved'] : ['draft']);
  const port = await ensureServer();
  const reg = await request(port, 'POST', '/_api/register', { dir, reopened });
  let opened = false;
  if (reg.clients > 0) opened = 'already';
  else if (!a['no-open'] && !process.env.PLANBOARD_NO_OPEN) opened = openBrowser(reg.url);
  const D = planArg(dir);
  print(`Plan page: ${reg.url}${opened === 'already' ? '  (already open in a browser tab — it reloads on its own)' : opened ? '  (opened in the browser)' : '  (open this link in a browser)'}${reopened ? '\nThe review was ended; it is open again.' : ''}
check: ${lintSummary(lint)}${lint.errors.length ? `\nFix the errors first: ${CMD} check ${D}` : ''}
Next: tell the user in one line that the plan is open, then listen for feedback in the background (Bash tool with
run_in_background: true). You're woken when the user sends feedback, and can keep talking with them meanwhile:
  ${CMD} wait ${D} --background
Without background commands: ${CMD} wait ${D} with the Bash tool timeout set to 600000, repeated on "No feedback yet".`);
}
// What the agent should do with feedback that arrives after approval. null while the plan is under review
// (plan.json "status" isn't "approved"). Otherwise { mode, output, files }: mode 'build' (building in this
// session), 'files' (plan.md / handoff.md were chosen or written; files lists which), or 'pick' (the user let
// the agent decide and nothing has been produced yet).
function afterApproval(dir) {
  const m = meta(dir); const { plan } = loadPlan(dir);
  if (!plan || plan.status !== 'approved') return null;
  const output = m.approvedOutput || 'agent';
  const started = Array.isArray(plan.steps) && plan.steps.some((x) => x && ['doing', 'done'].includes(x.status));
  const have = ['plan.md', 'handoff.md'].filter((f) => fs.existsSync(path.join(dir, f)));
  const chosen = { 'plan-md': ['plan.md'], 'handoff-md': ['handoff.md'], both: ['plan.md', 'handoff.md'] }[output];
  if (output === 'continue' || (output === 'agent' && started)) return { mode: 'build', output };
  if (chosen) return { mode: 'files', output, files: chosen };
  if (have.length) return { mode: 'files', output, files: have };
  return { mode: 'pick', output };
}
async function cmdWait(a, nonBlocking = false) {
  const dir = resolvePlanDir(a._[1]);
  let t = 0;
  if (!nonBlocking) {
    t = a.timeout == null ? (a.background ? WAIT_BACKGROUND_S : WAIT_DEFAULT_S) : Number(a.timeout);
    if (!Number.isFinite(t) || t < 1 || t > WAIT_BACKGROUND_S) fail(`--timeout must be between 1 and ${WAIT_BACKGROUND_S} seconds (got "${a.timeout}"). For a non-blocking check use: ${CMD} poll ${planArg(dir)}`);
  }
  const port = await ensureServer();
  const { id } = await register(port, dir);
  // A background wait outlives nothing: if the session that started it goes away (we get re-parented),
  // stop, so the page doesn't say "Agent is waiting" with nobody listening.
  const parent = process.ppid;
  if (t > 0) setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 3000).unref();
  let r;
  try { r = await request(port, 'GET', `/p/${id}/_api/wait?timeout=${t}`, null, (t + 30) * 1000); }
  catch (e) {
    print(`The wait was interrupted (${e.message}). Nothing is lost: undelivered feedback stays queued.\n${listenAgain(planArg(dir))}`);
    process.exit(0);
  }
  if (a.json) print(JSON.stringify(r, null, 2));
  else print(formatFeedback(r, dir, { after: afterApproval(dir) }));
  // Only now that it has been printed does the server drop it; if this process died before printing, the next wait re-delivers it.
  if (r && r.type === 'feedback') { try { await request(port, 'POST', `/p/${id}/_api/ack`, { batchIds: r.batches.map((x) => x.id) }); } catch { } }
}
async function readStdin() { const chunks = []; for await (const c of process.stdin) chunks.push(c); return Buffer.concat(chunks).toString('utf8'); }
const REPLY_MAX = 50_000;
async function cmdReply(a) {
  if (!a._[1] || !fs.existsSync(a._[1].replace(/^~(?=\/)/, os.homedir()))) fail(`reply needs the plan folder first. Usage: ${CMD} reply <plan dir> "<text>"   (or --file <path>, or --file - for stdin)`);
  const dir = resolvePlanDir(a._[1]);
  let text = a._.slice(2).join(' ');
  if (a.file) text = a.file === '-' ? await readStdin() : fs.readFileSync(path.resolve(a.file), 'utf8');
  else if (text === '-') text = await readStdin();
  text = String(text || '').trim();
  if (!text) fail(`Usage: ${CMD} reply <plan dir> "<text>"   (or --file <path>, or --file - for stdin)`);
  if (text.length > REPLY_MAX) fail(`reply too long (${text.length} characters; the limit is ${REPLY_MAX}). Shorten it, or put the detail in plan.json / plan.html and reply with a summary.`);
  const port = await ensureServer();
  const { id } = await register(port, dir);
  await request(port, 'POST', `/p/${id}/_api/reply`, { text });
  print('Reply posted to the page.');
}
function cmdLast(a) {
  const dir = resolvePlanDir(a._[1]);
  const last = readJSON(stPath(dir, 'last.json'), null);
  if (!last) return print('No feedback has been delivered for this plan yet.');
  if (a.json) return print(JSON.stringify(last, null, 2));
  print(`(re-showing feedback delivered ${new Date(last.deliveredAt).toLocaleString()})\n` + formatFeedback(last, dir, { after: afterApproval(dir) }));
}
async function cmdStatus() {
  const cur = await runningServer();
  if (!cur) { print('Server: not running (starts on demand with open/wait).'); return; }
  print(`Server: running on http://${HOST}:${cur.port} (v${cur.h.version}, pid ${cur.h.pid})`);
  try {
    const r = await request(cur.port, 'GET', '/_api/sessions');
    for (const s of r.sessions) print(`- ${s.title || s.name}  ${s.url}  ${s.listening ? 'agent listening' : 'agent not listening'}${s.clients ? `, ${s.clients} tab${s.clients > 1 ? 's' : ''} open` : ''}${s.queued ? `, ${s.queued} batch(es) queued` : ''}${s.ended ? ', ended' : ''}  (${tildify(s.dir)})`);
  } catch { }
}
async function cmdEnd(a) {
  const dir = resolvePlanDir(a._[1]);
  const m = meta(dir);
  if (m.ended && m.endedBy === 'user') { print('The user already ended this review in the browser; nothing to do.'); return; }
  m.ended = true; m.endedBy = 'agent'; setMeta(dir, m);
  const cur = await runningServer();
  if (cur) { try { await request(cur.port, 'POST', `/p/${sessionId(dir)}/_api/end`, { by: 'agent' }); } catch { } }
  print('Review ended. The page is now read-only.');
}
async function cmdStop() {
  // Stop every server that belongs to this PLANBOARD_HOME (normally one), and return only once they are gone.
  const ports = new Set(); let legacy = 0;
  const cur = await runningServer(); if (cur) ports.add(cur.port);
  for (let p = BASE_PORT; p < BASE_PORT + 40; p++) {
    const h = await health(p); if (!h) continue;
    if (h.ours) ports.add(p);
    else if (h.home === HOME && h.legacy) {
      if (await stopLegacy(p, h)) legacy++;
      else fail(`An older planboard server on port ${p} did not stop.${h.pid && isPlanboardServer(h.pid, p) ? ` Stop it with: kill ${h.pid}` : ' Find what is listening there with: lsof -nP -iTCP:' + p + ' -sTCP:LISTEN'}`);
    }
  }
  if (!ports.size) return print(legacy ? 'Server stopped.' : 'Server is not running.');
  for (const p of ports) { try { await request(p, 'POST', '/_api/shutdown', {}); } catch { } }
  for (const p of ports) if (!(await waitUntilDown(p))) fail(`The server on port ${p} did not stop. See ${path.join(HOME, 'server.log')}`);
  print('Server stopped.');
}
// The four handoff parts only the session can write; `export --handoff --update` carries them over.
function carryOverBlanks(fresh, old) {
  const out = fresh.split('\n'); const prev = old.split('\n'); let kept = 0;
  for (const [lvl, name] of HANDOFF_BLANKS) {
    // keep what was written even if the TODO comment was left next to it
    const o = handoffBlank(prev, lvl, name); const body = o ? o.body.replace(/<!--\s*TODO\(agent\)[\s\S]*?-->/g, '').trim() : '';
    if (!body) continue;
    const n = handoffBlank(out, lvl, name); if (!n) continue;
    out.splice(n.i + 1, n.j - n.i - 1, '', ...body.split('\n'), ''); kept++;
  }
  return { text: out.join('\n'), kept };
}
function cmdExport(a) {
  if (a.update && !a.handoff) fail('--update only works with --handoff (plan.md is always rebuilt from plan.json).');
  if (a.update && a.force) fail('Use --update (rebuild handoff.md and keep your filled-in parts) or --force (start it over), not both.');
  if ((a.force || a.update) && a.html) fail('--force and --update are for --handoff.');
  const dir = resolvePlanDir(a._[1]);
  const { plan, error } = loadPlan(dir);
  if (error) fail(error);
  // plan.md and handoff.md come from plan.json only, so only plan.json errors block them; --html also needs plan.html.
  const lint = lintDir(dir);
  const blocking = lint.errors.filter((e) => a.html || !e.startsWith('plan.html'));
  if (blocking.length && !a['skip-check']) {
    const where = blocking.every((e) => e.startsWith('plan.html')) ? 'plan.html' : blocking.some((e) => e.startsWith('plan.html')) ? 'plan.json and plan.html' : 'plan.json';
    fail(`check found ${blocking.length} error${blocking.length === 1 ? '' : 's'} in ${where}, so the export would be wrong. Fix ${blocking.length === 1 ? 'it' : 'them'} first (or pass --skip-check):\n${blocking.map((e) => `  ERROR ${e}`).join('\n')}`);
  }
  if (a.html) {
    const out = path.resolve(a.out || path.join(dir, 'plan.export.html'));
    fs.writeFileSync(out, buildStandalone(dir, plan, { withConversation: !!a['with-conversation'] }));
    return print(`Wrote ${rel(out)} — one self-contained file that opens without the server; feedback is copied to the clipboard instead of sent.${a['with-conversation'] ? ' It includes the review conversation and the plan folder path.' : ' The review conversation is left out (add --with-conversation to keep it).'}`);
  }
  if (a.handoff) {
    const out = path.resolve(a.out || path.join(dir, 'handoff.md'));
    const exists = fs.existsSync(out);
    if (a.update && !exists) fail(`There is no ${rel(out)} to update. Create it with: ${CMD} export ${planArg(dir)} --handoff${a.out ? ` --out ${shq(a.out)}` : ''}`);
    if (exists && !a.force && !a.update) fail(`${rel(out)} already exists (it may hold your filled-in notes). Use --update to rebuild it from plan.json and keep your filled-in parts, --force to start over, or --out <path>.`);
    let text = toHandoffMd(plan, dir); let kept = 0; let backup = null;
    if (exists && (a.update || a.force)) {
      const old = fs.readFileSync(out, 'utf8');
      // keep the two previous versions: handoff.md.bak (just now) and handoff.md.bak.1 (the time before)
      backup = `${out}.bak`; if (fs.existsSync(backup)) fs.renameSync(backup, `${backup}.1`); fs.writeFileSync(backup, old);
      if (a.update) ({ text, kept } = carryOverBlanks(text, old));
    }
    fs.writeFileSync(out, text);
    const checkCmd = `${CMD} check ${shq(a.out ? rel(out) : rel(dir))} --handoff`;
    if (a.update) return print(`Updated ${rel(out)} from plan.json and kept ${kept} of your 4 filled-in parts (where things stand, setup, gotchas, first action).
Anything else you edited by hand was replaced by the plan.json version; the previous file is in ${rel(backup)} — copy back what you still need.
${kept < 4 ? 'Fill the remaining blanks, then run:' : 'Re-read "Where things stand" and "First action" in case the change affects them, then run:'}
  ${checkCmd}`);
    if (backup) print(`(the previous ${path.basename(out)} is in ${rel(backup)})`);
    return print(`Wrote ${rel(out)} with everything plan.json knows.
Now replace every TODO(agent) comment (where things stand, setup, gotchas, first action) with what you learned in this session, then run:
  ${checkCmd}`);
  }
  const out = path.resolve(a.out || path.join(dir, 'plan.md'));
  fs.writeFileSync(out, toPlanMd(plan, dir));
  print(`Wrote ${rel(out)} (generated from plan.json — edit plan.json, not this file, then export again).`);
}
function cmdLink() {
  const binDir = path.join(os.homedir(), '.local', 'bin');
  const target = path.join(binDir, 'planboard');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(target, `#!/bin/sh\nexec node ${shq(SELF)} "$@"\n`, { mode: 0o755 });
  const onPath = (process.env.PATH || '').split(':').includes(binDir);
  print(`Installed ${target}.${onPath ? ' You can now run `planboard` directly.' : `\nAdd it to PATH: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc  (or ~/.bashrc)`}`);
}
function cmdHelp() {
  print(`planboard ${VERSION} — interactive plan review between you and a coding agent.
In commands below, "planboard" means: ${CMD}

  new "<title>" [--lens feature|new-project|refactor|non-code|generic] [--root <project dir>]
                          Create <root>/.plans/<date>-<slug>/ with plan.json + plan.html
                          (root defaults to the current directory)
  check [dir] [--handoff] Validate plan.json + plan.html (or handoff.md) and flag vague wording
  check <file.md> --handoff
                          Validate a handoff written somewhere else
  open [dir] [--no-open] [--reopen]
                          Start the local server and open the plan in the browser.
                          A review the user ended needs --reopen; one you ended reopens as is.
  wait [dir] [--background] [--timeout s] [--json]
                          Return when the user sends feedback. --background listens up to
                          24 h: run it as a background command and you're woken when it
                          returns. Without it: 540 s, for a Bash tool timeout of 600000.
  poll [dir]              Non-blocking: print feedback if any is queued
  reply <dir> "<text>"    Post a reply in the page (or --file <path>, --file - for stdin)
  last [dir]              Re-print the last feedback delivered (if a wait was cut off)
  export [dir] [--handoff [--update | --force] | --html [--with-conversation]] [--out path]
                          plan.md (default), handoff.md skeleton, or one-file HTML.
                          --update rebuilds handoff.md and keeps your filled-in parts;
                          --force starts it over. Refuses while check reports errors
                          (plan.json errors; for --html also plan.html), unless --skip-check.
  end [dir]               End the review from the agent side (page becomes read-only)
  status                  Show the server and open plans
  stop                    Stop the local server
  link                    Install a "planboard" shortcut in ~/.local/bin

[dir] defaults to the newest plan in the nearest .plans/ folder (this directory or a parent).
Data lives next to the plan in .planboard/. Put "--" before text that starts with "--".
Server: http://${HOST}:${BASE_PORT}+ (localhost only).
Env: PLANBOARD_PORT, PLANBOARD_HOME (default ~/.planboard), PLANBOARD_NO_OPEN=1,
     PLANBOARD_IDLE_MINUTES (default 180).`);
}

const PB_STUB = '<link rel="icon" href="data:,"><script>window.planboard=window.planboard||{_q:[],ready:function(f){this._q.push(f)}};</script>';
// ---------- standalone export ----------
function stateFor(id, dir) {
  const { plan, error } = loadPlan(dir);
  const m = meta(dir);
  let bhtml = null;
  try { bhtml = fs.readFileSync(stPath(dir, 'baseline/plan.html'), 'utf8'); } catch { }
  const bplan = readJSON(stPath(dir, 'baseline/plan.json'), null);
  let planMtime = 0;
  try { planMtime = fs.statSync(path.join(dir, 'plan.json')).mtimeMs; } catch { }
  return {
    app: 'planboard', version: VERSION, id, name: path.basename(dir), dir: tildify(dir),
    plan, planError: error, planMtime, round: m.round, ended: m.ended, endedBy: m.endedBy,
    transcript: transcriptOf(dir).slice(-300),
    baseline: m.round > 1 && (bplan || bhtml) ? { plan: bplan, html: bhtml } : null,
  };
}
function buildStandalone(dir, plan, { withConversation = false } = {}) {
  let html;
  try { html = fs.readFileSync(path.join(dir, 'plan.html'), 'utf8'); } catch { html = defaultPage(plan.title); }
  const css = fs.readFileSync(path.join(ASSETS, 'shell.css'), 'utf8');
  const js = fs.readFileSync(path.join(ASSETS, 'shell.js'), 'utf8');
  const state = { ...stateFor(sessionId(dir), dir), standalone: true, status: null };
  // A shared file shouldn't carry the review conversation or where the plan lives on this machine.
  if (!withConversation) Object.assign(state, { transcript: [], dir: path.basename(dir), baseline: null });
  const safe = (s) => s.replace(/<\/(script|style)/gi, '<\\/$1');
  const head = `${PB_STUB}<style>${safe(css)}</style>`;
  const tail = `<script>window.__PB_STATE__=${JSON.stringify(state).replace(/</g, '\\u003c')};</script><script>${safe(js)}</script>`;
  // Inline local images referenced relatively
  html = html.replace(/(<img[^>]+src=["'])(?!https?:|data:|\/)([^"']+)(["'])/gi, (all, a, src, b) => {
    try {
      const p = path.resolve(dir, src);
      if (!p.startsWith(dir + path.sep)) return all;
      const ext = path.extname(p).slice(1).toLowerCase();
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[ext];
      if (!mime) return all;
      return `${a}data:${mime};base64,${fs.readFileSync(p).toString('base64')}${b}`;
    } catch { return all; }
  });
  return injectInto(html, head, tail);
}
function injectInto(html, head, tail) {
  // the frame is responsive; without this, phones lay the page out 980 px wide
  if (!/<meta[^>]+name\s*=\s*["']?viewport/i.test(html)) head = '<meta name="viewport" content="width=device-width, initial-scale=1">' + head;
  const hm = /<head[^>]*>/i.exec(html);
  html = hm ? html.slice(0, hm.index + hm[0].length) + head + html.slice(hm.index + hm[0].length) : head + html;
  const bi = html.toLowerCase().lastIndexOf('</body>');
  return bi >= 0 ? html.slice(0, bi) + tail + html.slice(bi) : html + tail;
}
function defaultPage(title) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escHtml(title || 'Plan')}</title></head><body>
<div data-pb="overview"></div><div data-pb="decisions"></div><div data-pb="questions"></div><div data-pb="assumptions"></div>
<div data-pb="steps"></div><div data-pb="files"></div><div data-pb="risks"></div><div data-pb="verification"></div><div data-pb="sections"></div>
</body></html>`;
}

// ---------- server ----------
// One process per PLANBOARD_HOME. The control port (the one in server.json) serves only the CLI: health,
// and token-protected agent routes. Each plan's page gets its own port, so each plan is its own browser
// origin: a plan page can't read or post to another plan, or to the agent routes.
function cmdServe(a) {
  const port = Number(a.port) || BASE_PORT;
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const SESS_FILE = path.join(HOME, 'sessions.json');
  const PORTS_FILE = path.join(HOME, 'plan-ports.json');
  const sessions = readJSON(SESS_FILE, {});
  for (const [id, dir] of Object.entries(sessions)) if (typeof dir !== 'string' || !fs.existsSync(path.join(dir, 'plan.json'))) delete sessions[id];
  const planPorts = readJSON(PORTS_FILE, {});
  // Each open tab registers a random secret (POST /_api/hello). Later, after a lost connection, the tab asks the
  // server at its address to prove it knows that secret, so a program that took over the port can't pass as us.
  const TABS_FILE = path.join(HOME, 'tab-secrets.json');
  // tighten files written by older versions
  try { fs.chmodSync(HOME, 0o700); } catch { }
  for (const f of ['sessions.json', 'plan-ports.json', 'server.json', 'server.log', 'token', 'tab-secrets.json']) { try { fs.chmodSync(path.join(HOME, f), 0o600); } catch { } }
  const tabSecrets = readJSON(TABS_FILE, {});
  const live = new Map();
  let lastActivity = Date.now();
  const L = (id) => {
    if (!live.has(id)) live.set(id, { clients: new Set(), waiters: [], graceUntil: 0, lastDeliveredAt: null, lastReplyAt: null, watchers: [] });
    return live.get(id);
  };
  const log = (...x) => console.log(new Date().toISOString(), ...x);

  // Plans are local files that may come from a cloned repo: keep them offline and unable to send data anywhere.
  const CSP = "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";
  const send = (res, code, body, type = 'text/plain; charset=utf-8', extra = {}) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP, ...extra });
    res.end(body);
  };
  const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
  const readBody = (req, limit = 2_000_000) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= limit) chunks.push(c); });
    req.on('end', () => {
      if (size > limit) return reject(Object.assign(new Error(`request too large (${(size / 1e6).toFixed(1)} MB; the limit is ${limit / 1e6} MB)`), { status: 413 }));
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
  const pendingOf = (dir) => readJSON(stPath(dir, 'pending.json'), []);
  const sseSend = (res, event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { } };
  const broadcast = (id, event, data) => { for (const c of L(id).clients) sseSend(c, event, data); };
  const statusOf = (id) => {
    const s = L(id); const dir = sessions[id]; const m = meta(dir); const now = Date.now();
    return {
      listening: s.waiters.length > 0 || now < s.graceUntil, queued: queueOf(dir).length + pendingOf(dir).length, clients: s.clients.size,
      lastDeliveredAt: s.lastDeliveredAt || readJSON(stPath(dir, 'last.json'), {}).deliveredAt || null,
      lastReplyAt: s.lastReplyAt, ended: m.ended, endedBy: m.endedBy, round: m.round, now,
    };
  };
  const pushStatus = (id) => broadcast(id, 'status', statusOf(id));
  const pushStatusLater = (id, ms = 15500) => setTimeout(() => sessions[id] && pushStatus(id), ms);

  const watch = (id, dir) => {
    const s = L(id); if (s.watchers.length) return;
    let t = null;
    const onChange = (file) => {
      const f = String(file || '');
      if (f.startsWith('.planboard') || /\.tmp$|\.swp$|~$|^\.#/.test(f) || ['plan.md', 'handoff.md'].includes(f) || f.endsWith('.export.html') || /\.bak(\.\d+)?$/.test(f)) return;
      clearTimeout(t);
      t = setTimeout(() => broadcast(id, 'reload', { file: f }), 180);
    };
    for (const d of [dir, path.join(dir, 'assets')]) {
      try { if (fs.existsSync(d)) s.watchers.push(fs.watch(d, (ev, file) => onChange(d === dir ? file : 'assets/' + file))); } catch (e) { log('watch failed', d, e.message); }
    }
  };

  // ---- one listener (port) per plan ----
  const listeners = new Map(); // id -> Promise<port>
  const listenOn = (srv, p) => new Promise((resolve, reject) => {
    const onErr = (e) => reject(e);
    srv.once('error', onErr);
    srv.listen(p, HOST, () => { srv.removeListener('error', onErr); resolve(srv.address().port); });
  });
  const planPort = (id) => {
    if (!listeners.has(id)) listeners.set(id, (async () => {
      let srv = makeServer(id), p;
      try { p = await listenOn(srv, planPorts[id] || 0); }
      catch { srv = makeServer(id); p = await listenOn(srv, 0); }
      srv.on('error', (e) => log('plan server error', id, e.message));
      if (planPorts[id] !== p) { planPorts[id] = p; writeJSON(PORTS_FILE, planPorts); }
      return p;
    })());
    return listeners.get(id);
  };
  // A plan page lives under a secret path, /<key>/, so other local users and processes can't read the plan or
  // its conversation through its port; only the link that `open` prints (to this user) works.
  const KEYS_FILE = path.join(HOME, 'page-keys.json');
  const pageKeys = readJSON(KEYS_FILE, {});
  const pageKey = (id) => { if (!pageKeys[id]) { pageKeys[id] = crypto.randomBytes(16).toString('hex'); writeJSON(KEYS_FILE, pageKeys); } return pageKeys[id]; };
  const planUrl = async (id) => `http://${HOST}:${await planPort(id)}/${pageKey(id)}/`;
  const ensureSession = (dir) => {
    const id = sessionId(dir);
    if (sessions[id] !== dir) { sessions[id] = dir; writeJSON(SESS_FILE, sessions); }
    // review state written by older versions may still be world-readable
    try { const st = path.join(dir, '.planboard'); fs.chmodSync(st, 0o700); for (const f of fs.readdirSync(st)) { try { fs.chmodSync(path.join(st, f), fs.statSync(path.join(st, f)).isDirectory() ? 0o700 : 0o600); } catch { } } } catch { }
    watch(id, dir);
    return id;
  };
  for (const [id, dir] of Object.entries(sessions)) { watch(id, dir); planPort(id).catch((e) => log('plan listener failed', id, e.message)); }

  // Delivered batches move from queue.json to pending.json and stay there until the CLI acknowledges
  // them after printing (POST _api/ack). A wait that dies mid-delivery gets them again next time.
  const deliver = (id) => {
    const s = L(id); const dir = sessions[id];
    while (s.waiters.length) {
      const pend = pendingOf(dir); const fresh = queueOf(dir);
      const q = [...pend, ...fresh]; if (!q.length) return;
      const w = s.waiters.shift(); clearTimeout(w.timer);
      if (w.res.destroyed || w.res.writableEnded) continue;
      const m = meta(dir);
      const payload = { type: 'feedback', batches: q, round: m.round, ended: m.ended, endedBy: m.endedBy, redelivered: pend.map((b) => b.id) };
      writeJSON(stPath(dir, 'pending.json'), q);
      writeJSON(stPath(dir, 'queue.json'), []);
      const now = Date.now();
      writeJSON(stPath(dir, 'last.json'), { ...payload, deliveredAt: now });
      const ids = new Set(q.map((b) => b.id));
      const tr = transcriptOf(dir).map((e) => (ids.has(e.id) ? { ...e, delivered: now } : e));
      writeJSON(stPath(dir, 'transcript.json'), tr);
      s.lastDeliveredAt = now;
      json(w.res, 200, payload);
      broadcast(id, 'transcript', { delivered: [...ids], at: now });
      pushStatus(id);
      return;
    }
  };

  const isChange = (i) => ['answer', 'assumption', 'decision', 'custom'].includes(i.kind) || (['comment', 'message'].includes(i.kind) && i.mode !== 'ask');
  const clean = (i) => {
    const o = {};
    for (const k of ['kind', 'key', 'mode', 'verdict', 'choice', 'choiceLabel', 'choiceLabels', 'output', 'text', 'data']) if (i[k] !== undefined) o[k] = i[k];
    if (i.target && typeof i.target === 'object') {
      o.target = {};
      for (const k of ['kind', 'id', 'section', 'label', 'quote']) if (i.target[k] != null) o.target[k] = String(i.target[k]).slice(0, 2000);
    }
    if (typeof o.text === 'string') o.text = o.text.slice(0, 20000);
    if (o.data !== undefined) { let n = 0; try { n = JSON.stringify(o.data).length; } catch { n = Infinity; } if (n > 20000) o.data = { dropped: `control data too large (${n} characters; limit 20000)` }; }
    for (const k of ['key', 'mode', 'verdict', 'choiceLabel', 'output']) if (o[k] !== undefined) o[k] = String(o[k]).slice(0, 2000);
    return o;
  };

  // The token is re-read on every check, so a recreated token file works without restarting the server.
  const currentToken = () => { try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; } };
  const hasToken = (req) => {
    const want = Buffer.from(currentToken()); const got = Buffer.from(String(req.headers['x-planboard-token'] || ''));
    return want.length > 0 && got.length === want.length && crypto.timingSafeEqual(got, want);
  };
  const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

  // ---- control port: CLI only ----
  async function handleControl(req, res, url) {
    const p = url.pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return send(res, 403, 'Forbidden origin');
    }
    if (p === '/_api/health') {
      const nonce = String(url.searchParams.get('nonce') || '').slice(0, 64); const tok = currentToken();
      return json(res, 200, { app: 'planboard', version: VERSION, pid: process.pid, home: HOME, port, proof: nonce && tok ? tokenProof(tok, `${nonce}:${req.socket.localPort}`) : null });
    }
    if (p === '/' || p === '') return send(res, 200, 'planboard is running. Open a plan from the terminal: planboard open <plan folder>');
    const agent = /^\/p\/([0-9a-f]{10})\/_api\/(wait|reply|end|ack)$/.exec(p);
    if (!agent && !['/_api/register', '/_api/sessions', '/_api/shutdown'].includes(p)) {
      // an old /p/<id>/ link: the address now includes a secret, so don't redirect (that would hand it out)
      if (/^\/p\/[0-9a-f]{10}(\/|$)/.test(p)) return send(res, 410, 'This plan link is out of date. Ask the agent to run planboard open and use the link it prints.');
      return send(res, 404, 'Not found');
    }
    if (!hasToken(req)) return json(res, 403, { error: 'Forbidden: agent routes need the planboard token' });

    if (p === '/_api/register' && req.method === 'POST') {
      const b = await readBody(req);
      const dir = fs.realpathSync(path.resolve(String(b.dir || '')));
      if (!fs.existsSync(path.join(dir, 'plan.json'))) return json(res, 400, { error: 'no plan.json in ' + dir });
      const id = ensureSession(dir);
      if (b.reopened) broadcast(id, 'reload', { file: 'reopened' });
      return json(res, 200, { id, url: await planUrl(id), clients: L(id).clients.size });
    }
    if (p === '/_api/sessions') {
      const out = [];
      for (const [id, dir] of Object.entries(sessions)) { const { plan } = loadPlan(dir); out.push({ id, dir, name: path.basename(dir), title: plan && plan.title, url: await planUrl(id), ...statusOf(id) }); }
      return json(res, 200, { sessions: out });
    }
    if (p === '/_api/shutdown' && req.method === 'POST') { json(res, 200, { ok: true }); log('shutdown requested'); setTimeout(() => process.exit(0), 60); return; }
    if (!agent) return send(res, 405, 'Method not allowed');
    const id = agent[1]; const route = agent[2]; const dir = sessions[id];
    if (!dir) return json(res, 404, { error: 'Unknown plan. Open it again from the terminal.' });

    if (route === 'wait') {
      const t = Math.max(0, Math.min(Number(url.searchParams.get('timeout')) || 0, WAIT_BACKGROUND_S));
      const s = L(id);
      const mm = meta(dir);
      if (queueOf(dir).length || pendingOf(dir).length) {
        const w = { res, timer: null }; s.waiters.unshift(w); deliver(id); return;
      }
      if (mm.ended) return json(res, 200, { type: 'ended', by: mm.endedBy });
      if (t === 0) return json(res, 200, { type: 'none' });
      for (const old of s.waiters.splice(0)) { clearTimeout(old.timer); if (!old.res.writableEnded && !old.res.destroyed) json(old.res, 200, { type: 'replaced' }); }
      const w = { res, timer: null };
      w.timer = setTimeout(() => {
        s.waiters = s.waiters.filter((x) => x !== w);
        s.graceUntil = Date.now() + 15000;
        json(res, 200, { type: 'timeout', waited: t, clients: s.clients.size });
        pushStatusLater(id);
      }, t * 1000);
      s.waiters.push(w);
      res.on('close', () => {
        if (!res.writableFinished) {
          clearTimeout(w.timer);
          s.waiters = s.waiters.filter((x) => x !== w);
          s.graceUntil = Date.now() + 15000;
          pushStatusLater(id);
        }
      });
      pushStatus(id);
      return;
    }
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
    const b = await readBody(req);
    if (route === 'reply') {
      const text = String(b.text || '').trim().slice(0, 50000);
      if (!text) return json(res, 400, { error: 'empty reply' });
      const entry = { id: rid(), at: Date.now(), from: 'agent', kind: 'reply', text };
      const tr = transcriptOf(dir); tr.push(entry);
      writeJSON(stPath(dir, 'transcript.json'), tr.slice(-500));
      L(id).lastReplyAt = entry.at;
      broadcast(id, 'transcript', { entry });
      pushStatus(id);
      return json(res, 200, { ok: true });
    }
    if (route === 'ack') {
      const done = new Set(Array.isArray(b.batchIds) ? b.batchIds.map(String) : []);
      writeJSON(stPath(dir, 'pending.json'), pendingOf(dir).filter((x) => !done.has(x.id)));
      pushStatus(id);
      return json(res, 200, { ok: true });
    }
    // route === 'end'
    const mm = meta(dir);
    // A review the user ended stays user-ended (it then needs open --reopen), even if the agent also runs end.
    if (!(mm.ended && mm.endedBy === 'user')) { mm.ended = true; mm.endedBy = b.by === 'user' ? 'user' : 'agent'; setMeta(dir, mm); }
    broadcast(id, 'ended', { by: mm.endedBy });
    pushStatus(id);
    for (const w of L(id).waiters.splice(0)) { clearTimeout(w.timer); if (!w.res.writableEnded) json(w.res, 200, { type: 'ended', by: mm.endedBy }); }
    return json(res, 200, { ok: true });
  }

  // ---- a plan's own port: its page, its page API, its files ----
  async function handlePlan(id, req, res, url) {
    const dir = sessions[id];
    if (!dir) return send(res, 404, 'This plan is no longer open. Open it again from the terminal.');
    const own = req.socket.localPort;
    const prefix = `/${pageKey(id)}`;
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) {
      return send(res, 404, '<!doctype html><meta charset="utf-8"><title>Plan link changed</title><p style="font:15px system-ui;margin:40px">This plan link is out of date or incomplete. Ask the agent to run <code>planboard open</code> and use the link it prints.</p>', 'text/html; charset=utf-8');
    }
    if (url.pathname === prefix) { res.writeHead(302, { location: prefix + '/' }); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Only this plan's own page may post here (pages of other plans live on other ports, i.e. other origins).
      const origin = req.headers.origin;
      if (origin && !new RegExp(`^http://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${own}$`).test(origin)) return send(res, 403, 'Forbidden origin');
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, 'Expected application/json');
    }
    const p = url.pathname.slice(prefix.length);
    if (p === '/' || p === '/index.html') {
      let html;
      try { html = fs.readFileSync(path.join(dir, 'plan.html'), 'utf8'); } catch { const { plan } = loadPlan(dir); html = defaultPage(plan && plan.title); }
      const head = `${PB_STUB}<link rel="stylesheet" href="${prefix}/_pb/shell.css?v=${VERSION}">`;
      const tail = `<script>window.__PB_ID__=${JSON.stringify(id)};</script><script src="${prefix}/_pb/shell.js?v=${VERSION}"></script>`;
      return send(res, 200, injectInto(html, head, tail), 'text/html; charset=utf-8');
    }
    if (p.startsWith('/_pb/')) {
      const name = p.slice(5);
      if (!['shell.js', 'shell.css'].includes(name)) return send(res, 404, 'Not found');
      return send(res, 200, fs.readFileSync(path.join(ASSETS, name)), name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
    }
    if (p === '/_api/state') {
      const tab = String(url.searchParams.get('tab') || ''), nonce = String(url.searchParams.get('nonce') || '').slice(0, 64);
      const sec = tab && tabSecrets[id] && tabSecrets[id][tab];
      return json(res, 200, { ...stateFor(id, dir), dir, status: statusOf(id), draft: readJSON(stPath(dir, 'draft.json'), null), tabProof: sec && nonce ? tokenProof(sec.secret, `${nonce}:${req.socket.localPort}`) : null });
    }
    if (p === '/_api/hello' && req.method === 'POST') {
      const b = await readBody(req, 4000);
      const tab = String(b.tab || ''), secret = String(b.secret || '');
      if (!/^[\w-]{6,64}$/.test(tab) || !/^[\w-]{16,128}$/.test(secret)) return json(res, 400, { error: 'bad hello' });
      const mine = tabSecrets[id] = tabSecrets[id] || {};
      mine[tab] = { secret, at: Date.now() };
      // keep tabs from the last 60 days, at most 200 per plan
      for (const k of Object.keys(mine).sort((x, y) => mine[y].at - mine[x].at).filter((k, n) => n >= 200 || Date.now() - mine[k].at > 60 * 86400_000)) delete mine[k];
      writeJSON(TABS_FILE, tabSecrets);
      return json(res, 200, { ok: true });
    }
    // The page's unsent feedback, kept on the server too, so it survives a new browser, a cleared cache,
    // or the plan moving to another port.
    if (p === '/_api/draft' && req.method === 'POST') {
      const b = await readBody(req, 500_000);
      const queue = Array.isArray(b.queue) ? b.queue.filter((i) => i && typeof i === 'object' && ITEM_KINDS.has(i.kind)).slice(0, 200).map((i) => ({ ...clean(i), ...(Number.isFinite(i.at) ? { at: i.at } : {}) })) : [];
      writeJSON(stPath(dir, 'draft.json'), { queue, text: String(b.text || '').slice(0, 20000), at: Date.now() });
      return json(res, 200, { ok: true });
    }
    if (p === '/_api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1500\n\n');
      const s = L(id); s.clients.add(res);
      sseSend(res, 'status', statusOf(id));
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { } }, 25000);
      res.on('close', () => { clearInterval(ka); s.clients.delete(res); });
      return;
    }
    if (p === '/_api/send' && req.method === 'POST') {
      const b = await readBody(req);
      const mm = meta(dir);
      if (mm.ended && !(b.items || []).every((i) => i.kind === 'end')) return json(res, 409, { error: 'This review has ended. Ask the agent to reopen it.' });
      const items = Array.isArray(b.items) ? b.items.filter((i) => i && ITEM_KINDS.has(i.kind)).slice(0, 200).map(clean) : [];
      if (!items.length) return json(res, 400, { error: 'nothing to send' });
      const at = Date.now();
      const batch = { id: rid(), at, round: mm.round, items };
      if (items.some(isChange)) {
        for (const f of ['plan.json', 'plan.html']) {
          try { fs.mkdirSync(stPath(dir, 'baseline'), { recursive: true }); fs.copyFileSync(path.join(dir, f), stPath(dir, `baseline/${f}`)); } catch { }
        }
        mm.round += 1;
      }
      const ap = items.find((i) => i.kind === 'approve');
      if (ap) { mm.approvedOutput = String(ap.output || 'agent'); mm.approvedAt = at; }
      if (items.some((i) => i.kind === 'end')) { mm.ended = true; mm.endedBy = 'user'; }
      setMeta(dir, mm);
      writeJSON(stPath(dir, 'queue.json'), [...queueOf(dir), batch]);
      writeJSON(stPath(dir, 'draft.json'), { queue: [], text: '', at });
      const entry = { id: batch.id, at, from: 'user', kind: 'batch', round: batch.round, items };
      const tr = transcriptOf(dir); tr.push(entry);
      writeJSON(stPath(dir, 'transcript.json'), tr.slice(-500));
      broadcast(id, 'transcript', { entry });
      if (mm.ended) broadcast(id, 'ended', { by: 'user' });
      deliver(id);
      pushStatus(id);
      return json(res, 200, { ok: true, id: batch.id, round: mm.round });
    }
    if (p.startsWith('/_api/')) return send(res, 404, 'Not found');
    // static files inside the plan folder
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let relPath;
    try { relPath = decodeURIComponent(p.slice(1)); } catch { return send(res, 400, 'Bad path'); }
    if (relPath.split('/').some((seg) => seg.startsWith('.') || seg === '')) return send(res, 404, 'Not found');
    const fp = path.resolve(dir, relPath);
    if (!fp.startsWith(dir + path.sep)) return send(res, 403, 'Forbidden');
    // Follow symlinks only if they stay inside the plan folder and don't lead into a dot folder or file.
    let real; try { real = fs.realpathSync(fp); } catch { return send(res, 404, 'Not found'); }
    if (!real.startsWith(dir + path.sep)) return send(res, 403, 'Forbidden: links out of the plan folder are not served');
    if (path.relative(dir, real).split(path.sep).some((seg) => seg.startsWith('.'))) return send(res, 404, 'Not found');
    let stat; try { stat = fs.statSync(real); } catch { return send(res, 404, 'Not found'); }
    if (!stat.isFile()) return send(res, 404, 'Not found');
    const ext = path.extname(fp).slice(1).toLowerCase();
    const TYPES = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf' };
    return send(res, 200, fs.readFileSync(real), TYPES[ext] || 'application/octet-stream');
  }

  function makeServer(planId) {
    const srv = http.createServer((req, res) => {
      lastActivity = Date.now();
      const done = (e) => { log('error', req.url, e.stack || e.message); if (!res.headersSent) json(res, e.status || 500, { error: e.message }); else try { res.end(); } catch { } };
      if (!LOCAL_HOST.test(String(req.headers.host || ''))) return send(res, 403, 'Forbidden host');
      const url = new URL(req.url, 'http://local');
      (planId ? handlePlan(planId, req, res, url) : handleControl(req, res, url)).catch(done);
    });
    srv.keepAliveTimeout = 5000;
    srv.requestTimeout = 0;
    srv.headersTimeout = 20000;
    return srv;
  }

  const server = makeServer(null);
  server.on('error', (e) => { log('server error', e.message); process.exit(1); });
  server.listen(port, HOST, () => {
    writeJSON(path.join(HOME, 'server.json'), { pid: process.pid, port, version: VERSION, home: HOME, startedAt: Date.now() });
    log(`planboard ${VERSION} listening on http://${HOST}:${port}`);
  });
  const cleanup = () => {
    const info = readJSON(path.join(HOME, 'server.json'), null);
    if (info && info.pid === process.pid) { try { fs.unlinkSync(path.join(HOME, 'server.json')); } catch { } }
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
  setInterval(() => {
    const busy = [...live.values()].some((s) => s.clients.size || s.waiters.length);
    if (!busy && Date.now() - lastActivity > IDLE_MS) { log('idle, exiting'); process.exit(0); }
  }, 60_000).unref();
}

// ---------- main ----------
const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) fail(`Node 18 or newer is required (you have ${process.versions.node}).`);
const run = {
  new: () => cmdNew(args), check: () => cmdCheck(args), open: () => cmdOpen(args),
  wait: () => cmdWait(args), poll: () => cmdWait(args, true), reply: () => cmdReply(args),
  last: () => cmdLast(args), export: () => cmdExport(args), end: () => cmdEnd(args),
  status: () => cmdStatus(), stop: () => cmdStop(), serve: () => cmdServe(args), link: () => cmdLink(),
  help: () => cmdHelp(), version: () => print(VERSION),
};
if (!cmd || args.help || !run[cmd]) { cmdHelp(); if (cmd && !run[cmd] && cmd !== 'help') process.exit(1); }
else Promise.resolve().then(run[cmd]).catch((e) => fail(e.message));
