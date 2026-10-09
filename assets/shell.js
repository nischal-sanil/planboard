/* planboard shell — injected at the end of the plan page by the local server.
   Reads plan.json through the server, renders the built-in blocks into data-pb placeholders,
   and turns the page into a two-way conversation with the agent. No dependencies. */
/* Diagram parsers (Mermaid-style subset). Pure functions with no DOM access, kept outside the frame so
   `planboard check` can load this file in a sandbox and validate a plan's diagrams. */
var PB_PARSE = (() => {
  'use strict';
  const unq = (s) => String(s ?? '').trim().replace(/^"(.*)"$/s, '$1').replace(/<br\s*\/?>/gi, '\n').replace(/#quot;/g, '"').replace(/#amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  function parseFlow(src) {
    const raw = src.split('\n').flatMap((l) => l.replace(/%%.*$/, '').split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/)).map((l) => l.trim()).filter(Boolean);
    const head = raw.shift() || '';
    const m = /^(?:flowchart|graph)\b\s*(LR|RL|TD|TB|BT)?/i.exec(head);
    if (!m) throw new Error('first line must be "flowchart LR", "flowchart TD" or "sequenceDiagram"');
    const G = { dir: (m[1] || 'TD').toUpperCase().replace('TB', 'TD'), nodes: new Map(), edges: [], groups: [] };
    const stack = [];
    const ensure = (id) => {
      if (!G.nodes.has(id)) G.nodes.set(id, { id, label: id, shape: 'rect', cls: [], group: null, order: G.nodes.size });
      const n = G.nodes.get(id); if (stack.length && !n.group) { n.group = stack[stack.length - 1]; } return n;
    };
    const SHAPES = [['[(', ')]', 'db'], ['([', '])', 'stadium'], ['((', '))', 'circle'], ['[[', ']]', 'sub'], ['{{', '}}', 'hex'], ['[/', '/]', 'para'], ['[\\', '\\]', 'para'], ['[', ']', 'rect'], ['(', ')', 'round'], ['{', '}', 'diamond'], ['>', ']', 'flag']];
    const readNode = (s) => {
      const mm = /^\s*([A-Za-z0-9_]\w*(?:-(?=[A-Za-z0-9_])\w+)*)/.exec(s); if (!mm) return null;
      let rest = s.slice(mm[0].length); let shape = null, label = null;
      for (const [o, c, sh] of SHAPES) {
        if (!rest.startsWith(o)) continue;
        let i = o.length;
        if (rest[i] === '"') { const j = rest.indexOf('"', i + 1); if (j > 0 && rest.startsWith(c, j + 1)) { label = rest.slice(i, j + 1); rest = rest.slice(j + 1 + c.length); shape = sh; break; } }
        const j = rest.indexOf(c, i); if (j < 0) throw new Error(`missing "${c}" in: ${s.trim()}`);
        label = rest.slice(i, j); rest = rest.slice(j + c.length); shape = sh; break;
      }
      let cls = null; const cm = /^:::([\w-]+)/.exec(rest); if (cm) { cls = cm[1]; rest = rest.slice(cm[0].length); }
      return { id: mm[1], shape, label, cls, rest };
    };
    const readEdge = (s) => {
      let mm = /^\s*(--|==|-\.)(?![->.=]|[xo](?:\s|$))\s*(.+?)\s*(-->|==>|\.->|---|===|\.-)/.exec(s);
      if (mm) { const tok = mm[1] + mm[3]; return { label: unq(mm[2]), dashed: tok.includes('.'), thick: tok.includes('='), arrow: tok.endsWith('>'), rest: s.slice(mm[0].length) }; }
      mm = /^\s*(<)?(-\.+-?>|-\.+-|={2,}>|={3,}|-{2,}>|-{3,}|--[xo])(?:\|([^|]*)\|)?/.exec(s);
      if (mm) { const tok = mm[2]; return { label: mm[3] ? unq(mm[3]) : null, dashed: tok.includes('.'), thick: tok.includes('='), arrow: tok.endsWith('>'), cross: tok.endsWith('x'), back: !!mm[1], rest: s.slice(mm[0].length) }; }
      return null;
    };
    for (const line of raw) {
      let mm;
      if ((mm = /^subgraph\s+(.+)$/i.exec(line))) {
        const r = mm[1].trim(); const t = /^([A-Za-z0-9_]\w*(?:-(?=[A-Za-z0-9_])\w+)*)\s*\[(.*)\]$/.exec(r);
        const g = { id: t ? t[1] : 'g' + G.groups.length, title: unq(t ? t[2] : r), parent: stack[stack.length - 1] || null };
        G.groups.push(g); stack.push(g); continue;
      }
      if (/^end$/i.test(line)) { stack.pop(); continue; }
      if ((mm = /^class\s+([\w,\s-]+?)\s+([\w-]+)\s*$/i.exec(line))) { for (const id of mm[1].split(',')) ensure(id.trim()).cls.push(mm[2]); continue; }
      if (/^(classDef|style|linkStyle|click|direction|accTitle|accDescr)\b/i.test(line)) continue;
      let rest = line; let prev = null;
      while (rest.trim()) {
        const group = [];
        for (; ;) {
          const n = readNode(rest); if (!n) throw new Error(`can't read a node at: "${rest.trim()}"`);
          const node = ensure(n.id);
          if (n.label != null) { node.label = unq(n.label); node.shape = n.shape; }
          if (n.cls) node.cls.push(n.cls);
          group.push(node.id); rest = n.rest;
          const amp = /^\s*&\s*/.exec(rest); if (amp) { rest = rest.slice(amp[0].length); continue; }
          break;
        }
        if (prev) for (const a of prev.from) for (const b of group) G.edges.push({ ...prev.e, from: a, to: b });
        if (!rest.trim()) break;
        const e = readEdge(rest);
        if (e && !e.rest.trim()) throw new Error(`arrow with nothing after it: "${line}"`); if (!e) throw new Error(`expected an arrow (-->, -.->, ==>, ---) at: "${rest.trim()}"`);
        rest = e.rest; prev = { from: group, e };
      }
    }
    if (!G.nodes.size) throw new Error('no nodes');
    for (const g of G.groups) if (G.nodes.has(g.id)) throw new Error(`"${g.id}" is a subgraph; draw edges to a node inside it instead`);
    return G;
  }

  function parseSeq(src) {
    const lines = src.split('\n').map((l) => l.replace(/%%.*$/, '').trim()).filter(Boolean);
    lines.shift();
    const P = new Map(); const rows = []; let auto = false;
    const ensure = (id) => { if (!P.has(id)) P.set(id, { id, label: id, kind: 'participant', cls: [] }); return P.get(id); };
    for (const l of lines) {
      let m;
      if (/^autonumber\b/i.test(l)) { auto = true; continue; }
      if ((m = /^(participant|actor)\s+([^\s:]+)(?:\s+as\s+(.+?))?\s*(?::::([\w-]+))?$/i.exec(l))) { const p = ensure(m[2]); p.kind = m[1].toLowerCase(); if (m[3]) p.label = unq(m[3]); if (m[4]) p.cls.push(m[4]); continue; }
      if ((m = /^note\s+(over|left of|right of)\s+([^:]+?)\s*:\s*(.*)$/i.exec(l))) { const ps = m[2].split(',').map((s) => s.trim()); ps.forEach(ensure); rows.push({ t: 'note', where: m[1].toLowerCase(), ps, text: unq(m[3]) }); continue; }
      if ((m = /^(alt|opt|loop|par|critical|break|rect)\b\s*(.*)$/i.exec(l))) { const kind = m[1].toLowerCase(); rows.push({ t: 'start', kind, label: kind === 'rect' ? '' : unq(m[2]) }); continue; }
      if ((m = /^(else|and|option)\b\s*(.*)$/i.exec(l))) { rows.push({ t: 'else', label: unq(m[2]) }); continue; }
      if (/^end$/i.test(l)) { rows.push({ t: 'end' }); continue; }
      if (/^(activate|deactivate|box|title|links?|create|destroy)\b/i.test(l)) continue;
      if ((m = /^([\w.]+)\s*(-->>|->>|--x|-x|--\)|-\)|-->|->)\s*[+-]?\s*([\w.]+)\s*:\s*(.*)$/.exec(l)) || (m = /^([\w.]+(?:-[\w.]+)*)\s*(-->>|->>|--x|-x|--\)|-\)|-->|->)\s*[+-]?\s*([\w.]+(?:-[\w.]+)*)\s*:\s*(.*)$/.exec(l))) {
        ensure(m[1]); ensure(m[3]);
        rows.push({ t: 'msg', from: m[1], to: m[3], text: unq(m[4]), dashed: m[2].startsWith('--'), arrow: !/^-+>$/.test(m[2]) || m[2].includes('>>'), cross: m[2].endsWith('x'), open: /^-+>$/.test(m[2]) });
        continue;
      }
      throw new Error(`can't read this line: "${l}"`);
    }
    if (!P.size) throw new Error('no participants');
    return { P: [...P.values()], rows, auto };
  }
  return { unq, parseFlow, parseSeq };
})();

(() => {
  'use strict';
  if (typeof document === 'undefined' || window.__PB_BOOTED__) return;
  window.__PB_BOOTED__ = true;

  const STANDALONE = !!window.__PB_STATE__;
  const ID = STANDALONE ? window.__PB_STATE__.id : window.__PB_ID__;
  const BASE = location.pathname.replace(/[^/]*$/, '');
  const API = (p) => BASE + '_api/' + p;
  const K = { queue: `pb:q:${ID}`, mode: 'pb:mode', side: 'pb:side', scroll: `pb:scroll:${ID}`, draft: `pb:draft:${ID}`, compact: `pb:compact:${ID}` };

  let S = null; let PLAN = {}; let status = null; let connected = STANDALONE; let skew = 0;
  let queue = []; let changes = []; let sending = false;
  const originals = new Map(); const originalIds = new Map();
  const readyQ = (window.planboard && window.planboard._q) || [];
  let isReady = false;

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const rid = () => Math.random().toString(36).slice(2, 10);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const arr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
  const store = {
    get(k, d, ss) { try { const v = (ss ? sessionStorage : localStorage).getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v, ss) { try { (ss ? sessionStorage : localStorage).setItem(k, JSON.stringify(v)); } catch { } },
    del(k, ss) { try { (ss ? sessionStorage : localStorage).removeItem(k); } catch { } },
  };
  function h(tag, a, ...kids) {
    const el = document.createElement(tag);
    if (a) for (const [k, v] of Object.entries(a)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }
  const safe = (fn, ...a) => { try { return fn(...a); } catch (e) { console.error('[planboard]', e); } };
  const short = (s, n = 90) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const plain = (s) => String(s ?? '').replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const motion = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
  const fmtTime = (t) => { try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

  const ICON = {
    comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    panel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M14.5 4.5v15"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  };
  const { unq, parseFlow, parseSeq } = PB_PARSE;
  const DELTA = (n) => `<span class="pb-delta" title="Changed since your last feedback (round ${n})"><svg viewBox="0 0 13 12"><path d="M6.5 1 12 11H1Z"/></svg>${n}</span>`;

  // ---------- tiny markdown ----------
  function mdInline(s) {
    let t = esc(s);
    const codes = [];
    t = t.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?=[^*\w]|$)/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    t = t.replace(/\[([^\]]+)\]\(((?:https?:\/\/|#|\.{0,2}\/)[^)\s]*)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
    return t;
  }
  function md(s) {
    if (s == null || s === '') return '';
    const lines = String(s).replace(/\r/g, '').split('\n');
    const out = []; let i = 0;
    const isBlock = (l) => /^\s*(```|[-*]\s+|\d+[.)]\s+|#{1,4}\s|>\s?)/.test(l);
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        const buf = []; i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++; out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`); continue;
      }
      if (!line.trim()) { i++; continue; }
      if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/).test(lines[i])) {
          let item = lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/, ''); i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i])) item += ' ' + lines[i++].trim();
          const box = /^\[( |x)\]\s+/i.exec(item);
          items.push(box ? `<li class="${box[1].toLowerCase() === 'x' ? 'is-done' : ''}" data-box>${mdInline(item.slice(box[0].length))}</li>` : `<li>${mdInline(item)}</li>`);
        }
        const cls = items.some((x) => x.includes('data-box')) ? ' class="pb-check"' : '';
        out.push(ordered ? `<ol${cls}>${items.join('')}</ol>` : `<ul${cls}>${items.join('')}</ul>`); continue;
      }
      if (/^#{1,4}\s/.test(line)) { out.push(`<h4>${mdInline(line.replace(/^#+\s/, ''))}</h4>`); i++; continue; }
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${md(buf.join('\n'))}</blockquote>`); continue;
      }
      const buf = [line]; i++;
      while (i < lines.length && lines[i].trim() && !isBlock(lines[i])) buf.push(lines[i++]);
      out.push(`<p>${buf.map(mdInline).join('<br>')}</p>`);
    }
    return out.join('');
  }

  // ---------- queue ----------
  // Unsent feedback lives in this browser (localStorage) and on the server (draft.json), so it survives a
  // cleared cache, another browser, or the plan moving to a new address. The server copy is only written
  // while this page is sure it's talking to its own planboard server (see verifyServer).
  let trusted = true, downSince = 0, moved = false, draftT = 0;
  const syncDraft = () => {
    if (STANDALONE || isEnded()) return;
    clearTimeout(draftT);
    draftT = setTimeout(() => {
      if (!trusted) return;
      const text = $('#pb-input') ? $('#pb-input').value : '';
      fetch(API('draft'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queue: queue.map(({ at, ...x }) => x), text }) }).catch(() => { });
    }, 600);
  };
  const saveQueue = () => { store.set(K.queue, queue); syncDraft(); };
  function enqueue(item) {
    if (isEnded()) { toast('This review has ended.', true); return; }
    queue = queue.filter((i) => i.key !== item.key);
    queue.push({ ...item, at: Date.now() });
    saveQueue(); onQueueChanged();
  }
  function dequeue(key) { queue = queue.filter((i) => i.key !== key); saveQueue(); onQueueChanged(); }
  const queued = (key) => queue.find((i) => i.key === key);
  function onQueueChanged() { safe(renderConvo); safe(refreshStates); safe(updateTop); safe(updateNavBadges); }
  const isEnded = () => !!(S && S.ended) || !!(status && status.ended);

  function sentItem(key) {
    for (let i = S.transcript.length - 1; i >= 0; i--) {
      const e = S.transcript[i];
      if (e.from === 'user' && e.kind === 'batch') { const it = e.items.find((x) => x.key === key); if (it) return { item: it, entry: e }; }
    }
    return null;
  }

  // ---------- boot ----------
  async function boot() {
    try {
      S = STANDALONE ? window.__PB_STATE__ : await (await fetch(API('state'), { cache: 'no-store' })).json();
    } catch (e) {
      document.body.insertAdjacentHTML('afterbegin', `<div style="font:14px system-ui;padding:12px 16px;background:#fbe6e3;color:#7a1f14">Planboard couldn't reach its local server. Ask the agent to run <code>planboard open</code> again, then reload.</div>`);
      return;
    }
    S.transcript = S.transcript || [];
    PLAN = (S.plan && typeof S.plan === 'object') ? S.plan : {};
    status = S.status || null;
    queue = store.get(K.queue, []);
    if (!queue.length && S.draft && Array.isArray(S.draft.queue) && S.draft.queue.length) { queue = S.draft.queue; store.set(K.queue, queue); }
    document.body.classList.add('pb-on');
    if (PLAN.title && (!document.title || /^\s*$/.test(document.title))) document.title = PLAN.title;
    captureOriginals();
    buildFrame();
    const doc = $('#pb-doc');
    if (S.planError) doc.prepend(h('div', { class: 'pb-banner pb-banner--error', text: `The agent's plan.json has an error, so built-in blocks may be missing:\n${S.planError}` }));
    if (isEnded()) doc.prepend(endedBanner());
    safe(renderBackbone);
    safe(enhance);
    safe(computeChanges);
    safe(buildNav);
    safe(setupComments);
    safe(renderConvo);
    safe(refreshStates);
    safe(updateTop);
    safe(updateNavBadges);
    safe(restoreDraft);
    restoreScroll();
    setupKeys();
    isReady = true;
    for (const fn of readyQ.splice(0)) safe(fn, api);
    window.dispatchEvent(new CustomEvent('planboard:ready', { detail: api }));
    if (!STANDALONE) connect();
  }

  function captureOriginals() {
    for (const sec of $$('body [data-pb-section]')) originals.set(sec.getAttribute('data-pb-section'), norm(sec.outerHTML));
    for (const el of $$('body [data-pb-section] [data-pb-id]')) originalIds.set(el.getAttribute('data-pb-id'), norm(el.outerHTML));
  }
  const norm = (s) => String(s).replace(/\s+/g, ' ').replace(/> </g, '><').trim();

  // ---------- frame ----------
  let elTop, elNav, elSide, elApp;
  function buildFrame() {
    const doc = h('article', { class: 'pb-doc', id: 'pb-doc' });
    for (const n of [...document.body.childNodes]) {
      if (n.nodeType === 1 && n.tagName === 'SCRIPT' && ((n.src || '').includes('/_pb/') || /__PB_|__PB_BOOTED__/.test(n.textContent))) continue;
      doc.append(n);
    }
    elTop = h('header', { class: 'pb-top' });
    elNav = h('nav', { class: 'pb-nav', 'aria-label': 'Plan sections' });
    elSide = buildSide();
    const main = h('main', { class: 'pb-main', id: 'pb-main' }, doc);
    elApp = h('div', { class: 'pb-app' + (store.get(K.side, true) ? '' : ' pb-side-closed') }, elTop, elNav, h('div', { class: 'pb-body' }, main, elSide));
    document.body.prepend(elApp);
  }
  function endedBanner() {
    return h('div', { class: 'pb-banner pb-banner--ended', id: 'pb-ended', text: S.endedBy === 'user' ? 'You ended this review. The page is read-only. Ask the agent to reopen it to keep going.' : 'The agent ended this review. The page is read-only.' });
  }

  // ---------- built-in blocks ----------
  const BLOCKS = ['overview', 'decisions', 'questions', 'assumptions', 'steps', 'files', 'risks', 'verification', 'sections'];
  const inlineUsed = new Set();
  function renderBackbone() {
    const doc = $('#pb-doc');
    for (const el of $$('[data-pb]', doc)) {
      const m = /^(question|decision|assumption|step|risk|section):(.+)$/.exec(el.getAttribute('data-pb'));
      if (!m) continue;
      const node = renderSingle(m[1], m[2].trim());
      if (node) { inlineUsed.add(`${m[1]}:${m[2].trim()}`); el.replaceWith(node); }
      else el.replaceWith(h('div', { class: 'pb-banner pb-banner--error', text: `data-pb="${m[0]}" — no ${m[1]} with id "${m[2]}" in plan.json` }));
    }
    const placed = new Set();
    for (const el of $$('[data-pb]', doc)) {
      const kind = el.getAttribute('data-pb');
      if (!BLOCKS.includes(kind)) continue;
      placed.add(kind);
      const node = renderBlock(kind);
      if (node) el.replaceWith(node); else el.remove();
    }
    if (!placed.has('overview')) { const n = renderBlock('overview'); if (n) doc.prepend(n); }
    for (const kind of BLOCKS) if (!placed.has(kind) && kind !== 'overview') { const n = renderBlock(kind); if (n) doc.append(n); }
  }
  function renderSingle(kind, id) {
    const list = { question: PLAN.questions, decision: PLAN.decisions, assumption: PLAN.assumptions, step: PLAN.steps, risk: PLAN.risks, section: PLAN.sections }[kind] || [];
    const it = list.find((x) => x && x.id === id);
    if (!it) return null;
    if (kind === 'question') return renderQuestion(it);
    if (kind === 'decision') return renderDecision(it);
    if (kind === 'assumption') return renderAssumption(it);
    if (kind === 'risk') return renderRisk(it);
    if (kind === 'section') return renderPlanSection(it);
    if (kind === 'step') { const i = PLAN.steps.indexOf(it); return h('ol', { class: 'pb-steps', start: i + 1 }, it.phase ? h('li', { class: 'pb-phase', role: 'presentation', text: it.phase }) : null, renderStep(it, i)); }
  }
  function block(id, title, meta, ...kids) {
    return h('section', { class: `pb-block pb-block--${id}`, 'data-pb-section': id, 'data-pb-title': title, id: `pb-sec-${id}` },
      h('div', { class: 'pb-block__head' }, h('h2', { text: title }), meta ? h('span', { class: 'pb-block__meta', text: meta }) : null, h('div', { class: 'pb-block__tools' })),
      ...kids);
  }
  function renderBlock(kind) {
    const P = PLAN;
    const notInline = (k) => (x) => x && !inlineUsed.has(`${k}:${x.id}`);
    switch (kind) {
      case 'overview': return renderOverview();
      case 'decisions': {
        const items = (P.decisions || []).filter(notInline('decision')); if (!items.length) return null;
        const done = (P.decisions || []).filter((d) => d.chosen).length;
        return block('decisions', 'Decisions', `${done} of ${(P.decisions || []).length} decided`, items.map(renderDecision));
      }
      case 'questions': {
        const items = (P.questions || []).filter(notInline('question')); if (!items.length) return null;
        const open = (P.questions || []).filter((q) => q.status !== 'answered').length;
        return block('questions', 'Questions for you', open ? `${open} open` : 'all answered', items.map(renderQuestion));
      }
      case 'assumptions': {
        const items = (P.assumptions || []).filter(notInline('assumption')); if (!items.length) return null;
        return block('assumptions', 'Assumptions', 'Confirm or correct what the agent believes', items.map(renderAssumption));
      }
      case 'steps': {
        const steps = P.steps || []; if (!steps.length) return null;
        const done = steps.filter((s) => s.status === 'done').length;
        let phase = null;
        const list = h('ol', { class: 'pb-steps' + (store.get(K.compact, false) ? ' is-compact' : '') }, steps.filter(notInline('step')).map((s) => {
          const head = s.phase && s.phase !== phase ? h('li', { class: 'pb-phase', role: 'presentation', text: s.phase }) : null;
          phase = s.phase || null;
          return [head, renderStep(s, steps.indexOf(s))];
        }));
        const b = block('steps', 'Steps', `${steps.length} step${steps.length > 1 ? 's' : ''}${done ? ` · ${done} done` : ''}`, list);
        $('.pb-block__tools', b).append(h('button', { class: 'pb-btn pb-btn--ghost pb-btn--sm', type: 'button', text: list.classList.contains('is-compact') ? 'Show details' : 'Titles only', onclick: (e) => { const c = list.classList.toggle('is-compact'); store.set(K.compact, c); e.currentTarget.textContent = c ? 'Show details' : 'Titles only'; } }));
        return b;
      }
      case 'files': return renderFiles();
      case 'risks': {
        const items = (P.risks || []).filter(notInline('risk')); if (!items.length) return null;
        const score = (r) => ({ low: 1, med: 2, medium: 2, high: 3 }[r.likelihood] || 2) * ({ low: 1, med: 2, medium: 2, high: 3 }[r.impact] || 2);
        return block('risks', 'Risks', `${items.length}`, [...items].sort((a, b) => score(b) - score(a)).map(renderRisk));
      }
      case 'verification': {
        const v = arr(P.verification); if (!v.length) return null;
        return block('verification', 'How we will know it works', 'End-to-end checks',
          h('div', { class: 'pb-item' }, h('ul', { class: 'pb-check' }, v.map((x, i) => h('li', { 'data-pb-id': `verify-${i + 1}`, 'data-pb-kind': 'check', 'data-pb-label': plain(x), html: mdInline(x) })))));
      }
      case 'sections': {
        const s = (P.sections || []).filter(notInline('section')); if (!s.length) return null;
        const frag = document.createDocumentFragment(); s.forEach((x) => frag.append(renderPlanSection(x))); return frag;
      }
    }
    return null;
  }
  function renderPlanSection(s) {
    if (!s.body && !arr(s.items).length) return block(s.id, s.title, null);
    return block(s.id, s.title, null, h('div', { class: 'pb-item pb-sectext' },
      s.body ? h('div', { 'data-pb-id': `${s.id}-body`, 'data-pb-kind': 'section text', 'data-pb-label': s.title, html: md(s.body) }) : null,
      arr(s.items).length ? h('ul', {}, arr(s.items).map((x, i) => h('li', { 'data-pb-id': `${s.id}-${i + 1}`, 'data-pb-kind': 'point', 'data-pb-label': plain(x), html: mdInline(x) }))) : null));
  }

  function renderOverview() {
    const P = PLAN;
    const sec = h('section', { class: 'pb-block pb-overview', 'data-pb-section': 'overview', 'data-pb-title': 'Overview', id: 'pb-sec-overview' });
    const lens = { feature: 'Feature or fix', 'new-project': 'New project', refactor: 'Refactor or migration', 'non-code': 'Non-code project', generic: 'Plan' }[P.lens] || 'Plan';
    sec.append(h('div', { class: 'pb-overview__lens' }, h('span', { class: 'pb-tag', text: lens }), h('span', { class: 'pb-tag' + (P.status === 'approved' ? ' pb-tag--done' : ''), id: 'pb-status-tag', text: P.status === 'approved' ? 'Approved' : P.status === 'in-review' ? 'In review' : 'Draft' })));
    sec.append(h('h1', { 'data-pb-id': 'title', 'data-pb-kind': 'title', 'data-pb-label': P.title || '', text: P.title || S.name }));
    if (P.summary) sec.append(h('div', { class: 'pb-summary', 'data-pb-id': 'summary', 'data-pb-kind': 'summary', 'data-pb-label': 'Summary', html: md(P.summary) }));
    const ng = arr(P.non_goals);
    sec.append(h('div', { class: 'pb-goalgrid' },
      h('div', { class: 'pb-goal', 'data-pb-id': 'goal', 'data-pb-kind': 'goal', 'data-pb-label': 'Goal' }, h('h3', { text: 'Goal' }), h('div', { class: 'pb-goal__text', html: md(P.goal || '—') })),
      ng.length ? h('div', { class: 'pb-nongoal', 'data-pb-id': 'non_goals', 'data-pb-kind': 'non-goals', 'data-pb-label': 'Not doing' }, h('h3', { text: 'Not doing' }), h('ul', {}, ng.map((g) => h('li', { html: mdInline(g) })))) : null));
    const ctx = arr(P.context);
    if (ctx.length) sec.append(h('div', { class: 'pb-context', 'data-pb-id': 'context', 'data-pb-kind': 'context', 'data-pb-label': 'Context' }, h('h3', { text: 'Context' }), h('ul', {}, ctx.map((c) => h('li', { html: mdInline(c) })))));
    const steps = P.steps || []; const files = fileIndex();
    const dec = P.decisions || []; const risks = P.risks || [];
    const counts = { new: 0, edit: 0, delete: 0, move: 0 }; files.forEach((f) => f.changes.forEach((c) => counts[c] = (counts[c] || 0) + 1));
    const g = h('div', { class: 'pb-glance', id: 'pb-glance' });
    const cell = (label, value, cls) => h('div', {}, h('b', { class: cls || '', text: value }), label);
    if (steps.length) g.append(cell('steps', steps.filter((s) => s.status === 'done').length ? `${steps.filter((s) => s.status === 'done').length}/${steps.length}` : String(steps.length)));
    if (files.length) g.append(cell(`files${counts.new ? ` · ${counts.new} new` : ''}${counts.delete ? ` · ${counts.delete} deleted` : ''}`, String(files.length)));
    if (dec.length) g.append(cell('decided', `${dec.filter((d) => d.chosen).length}/${dec.length}`));
    if (risks.length) g.append(cell(`risks${risks.some((r) => r.impact === 'high') ? ` · ${risks.filter((r) => r.impact === 'high').length} high impact` : ''}`, String(risks.length)));
    g.append(h('div', { id: 'pb-glance-needs' }, h('b', { class: 'is-needs', text: '0' }), 'need you'));
    sec.append(g);
    if (steps.some((s) => s.status === 'done' || s.status === 'doing')) {
      const pct = Math.round((steps.filter((s) => s.status === 'done').length / steps.length) * 100);
      sec.append(h('div', { class: 'pb-progress', title: `${pct}% of steps done` }, h('i', { style: `width:${pct}%` })));
    }
    return sec;
  }

  function itemHead(title, id, extra) {
    return h('div', { class: 'pb-item__head' }, h('span', { class: 'pb-item__title', html: mdInline(title || '') }), h('span', { class: 'pb-id', text: id }), extra || null);
  }
  function renderQuestion(q) {
    const el = h('div', { class: 'pb-item pb-question', 'data-pb-id': q.id, 'data-pb-kind': 'question', 'data-pb-label': plain(q.text) });
    el.append(itemHead(q.text, q.id));
    if (q.why) el.append(h('div', { class: 'pb-item__sub', html: 'Why it matters: ' + mdInline(q.why) }));
    const opts = q.options || [];
    const optWrap = h('div', { class: 'pb-qbody' });
    if (opts.length) {
      optWrap.append(h('div', { class: 'pb-opts' }, opts.map((o) => h('button', {
        type: 'button', class: 'pb-opt', 'data-opt': o.id, 'aria-pressed': 'false',
        onclick: () => pickOption(q, o.id),
      }, o.id === q.recommended ? h('span', { class: 'pb-opt__rec', text: 'Suggested' }) : null, h('span', { class: 'pb-opt__label', html: mdInline(o.label) }), o.detail ? h('span', { class: 'pb-opt__detail', html: mdInline(o.detail) }) : null))));
    }
    if (q.allow_other !== false) {
      const inp = h('input', { class: 'pb-input', type: 'text', placeholder: opts.length ? 'Or type your own answer' : 'Type your answer', 'aria-label': 'Your answer' });
      const go = () => {
        const v = inp.value.trim(); if (!v) { inp.focus(); return; }
        const cur = queued(`answer:${q.id}`);
        const choice = q.multi && cur ? cur.choice : [];
        enqueue({ kind: 'answer', key: `answer:${q.id}`, target: { kind: 'question', id: q.id, label: plain(q.text) }, choice, choiceLabels: choice.map((c) => plain(opts.find((o) => o.id === c)?.label || c)), text: v });
        inp.value = '';
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      optWrap.append(h('div', { class: 'pb-other' }, inp, h('button', { class: 'pb-btn', type: 'button', text: 'Use this', onclick: go })));
    }
    el.append(optWrap);
    if (q.status === 'answered' && q.answer) el.append(h('div', { class: 'pb-answer', html: mdInline(q.answer) }));
    el.append(h('div', { class: 'pb-item__actions' }, h('span', { class: 'pb-item__state' })));
    return el;
  }
  function pickOption(q, oid) {
    const key = `answer:${q.id}`; const cur = queued(key); const opts = q.options || [];
    let choice;
    if (q.multi) { const set = new Set(cur ? cur.choice : []); set.has(oid) ? set.delete(oid) : set.add(oid); choice = [...set]; }
    else { if (cur && cur.choice && cur.choice[0] === oid && !cur.text) { dequeue(key); return; } choice = [oid]; }
    if (!choice.length && !(cur && cur.text)) { dequeue(key); return; }
    enqueue({ kind: 'answer', key, target: { kind: 'question', id: q.id, label: plain(q.text) }, choice, choiceLabels: choice.map((c) => plain(opts.find((o) => o.id === c)?.label || c)), text: q.multi && cur ? cur.text : undefined });
  }
  function renderDecision(d) {
    const el = h('div', { class: 'pb-item pb-decision', 'data-pb-id': d.id, 'data-pb-kind': 'decision', 'data-pb-label': plain(d.title) });
    el.append(itemHead(d.title, d.id, d.chosen ? h('span', { class: 'pb-tag pb-tag--done', text: 'Decided' }) : null));
    if (d.context) el.append(h('div', { class: 'pb-item__sub', html: md(d.context) }));
    el.append(h('div', { class: 'pb-dec__opts' }, (d.options || []).map((o) => h('div', {
      class: 'pb-dec__opt' + (o.id === d.recommended ? ' is-rec' : '') + (d.chosen ? (o.id === d.chosen ? ' is-chosen' : ' is-dim') : ''), 'data-opt': o.id,
      'data-pb-id': `${d.id}.${o.id}`, 'data-pb-kind': 'option', 'data-pb-label': `${plain(d.title)} › ${plain(o.label)}`,
    },
      h('div', { class: 'pb-dec__label' }, h('span', { html: mdInline(o.label) }), o.id === d.recommended && !d.chosen ? h('span', { class: 'pb-tag', text: 'Agent recommends' }) : null, o.id === d.chosen ? h('span', { class: 'pb-tag pb-tag--done', text: 'Chosen' }) : null),
      o.detail ? h('div', { class: 'pb-dec__detail', html: md(o.detail) }) : null,
      arr(o.pros).length ? h('ul', { class: 'pb-pc pb-pc--pro' }, arr(o.pros).map((p) => h('li', { html: mdInline(p) }))) : null,
      arr(o.cons).length ? h('ul', { class: 'pb-pc pb-pc--con' }, arr(o.cons).map((p) => h('li', { html: mdInline(p) }))) : null,
      h('button', {
        type: 'button', class: 'pb-btn pb-btn--sm pb-choose', text: d.chosen && o.id === d.chosen ? 'Chosen' : 'Choose this',
        onclick: () => {
          const key = `decision:${d.id}`; const cur = queued(key);
          if (cur && cur.choice === o.id) { dequeue(key); return; }
          if (d.chosen === o.id && !cur) { toast('Already chosen.'); return; }
          enqueue({ kind: 'decision', key, target: { kind: 'decision', id: d.id, label: plain(d.title) }, choice: o.id, choiceLabel: plain(o.label) });
        },
      })))));
    if (d.chosen && d.why) el.append(h('div', { class: 'pb-why', html: mdInline(d.why) }));
    el.append(h('div', { class: 'pb-item__actions' }, h('span', { class: 'pb-item__state' })));
    const noteIn = h('input', { class: 'pb-input', type: 'text', placeholder: 'A note for the agent about this choice', 'aria-label': 'Note about this decision' });
    const saveNote = () => { const cur = queued(`decision:${d.id}`); if (cur) enqueue({ ...cur, text: noteIn.value.trim() || undefined }); noteBox.hidden = true; };
    noteIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveNote(); } if (e.key === 'Escape') noteBox.hidden = true; });
    const noteBox = h('div', { class: 'pb-other pb-dec__note', hidden: true }, noteIn, h('button', { class: 'pb-btn', type: 'button', text: 'Save note', onclick: saveNote }));
    el.append(noteBox);
    return el;
  }
  function renderAssumption(a) {
    const el = h('div', { class: 'pb-item pb-assumption', 'data-pb-id': a.id, 'data-pb-kind': 'assumption', 'data-pb-label': plain(a.text) });
    el.append(h('div', { class: 'pb-item__head' }, h('span', { class: 'pb-assume__text', html: mdInline(a.text) }), h('span', { class: 'pb-id', text: a.id })));
    if (a.basis) el.append(h('div', { class: 'pb-assume__basis', html: mdInline(a.basis) }));
    if (a.note) el.append(h('div', { class: 'pb-note', html: mdInline(a.note) }));
    const fix = h('div', { class: 'pb-other', hidden: true });
    const ta = h('input', { class: 'pb-input', type: 'text', placeholder: "What's actually true?" });
    const queueFix = () => { const v = ta.value.trim(); if (!v) { ta.focus(); return; } enqueue({ kind: 'assumption', key: `assumption:${a.id}`, target: { kind: 'assumption', id: a.id, label: plain(a.text) }, verdict: 'edit', text: v }); fix.hidden = true; ta.value = ''; };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); queueFix(); } if (e.key === 'Escape') fix.hidden = true; });
    fix.append(ta, h('button', { class: 'pb-btn', type: 'button', text: 'Queue correction', onclick: queueFix }));
    const vb = (verdict, label) => h('button', {
      type: 'button', class: 'pb-btn pb-btn--sm', 'data-verdict': verdict, text: label,
      onclick: () => {
        const key = `assumption:${a.id}`; const cur = queued(key);
        if (verdict === 'edit') { fix.hidden = !fix.hidden; if (!fix.hidden) ta.focus(); return; }
        if (cur && cur.verdict === verdict) { dequeue(key); return; }
        enqueue({ kind: 'assumption', key, target: { kind: 'assumption', id: a.id, label: plain(a.text) }, verdict });
      },
    });
    el.append(h('div', { class: 'pb-item__actions' }, vb('confirm', 'Confirm'), vb('reject', 'Wrong'), vb('edit', 'Correct it…'), h('span', { class: 'pb-item__state' })), fix);
    return el;
  }
  const stepNum = () => { const m = new Map(); (PLAN.steps || []).forEach((s, i) => m.set(s.id, i + 1)); return m; };
  function renderStep(s, i) {
    const nums = stepNum();
    const li = h('li', { class: 'pb-step', 'data-status': s.status || 'todo', id: `pb-step-${s.id}` });
    li.append(h('div', { class: 'pb-step__num', text: s.status === 'done' ? '✓' : String(i + 1), 'aria-label': `Step ${i + 1}` }));
    const card = h('div', { class: 'pb-item', 'data-pb-id': s.id, 'data-pb-kind': 'step', 'data-pb-label': `Step ${i + 1}: ${plain(s.title)}` });
    const tags = [s.size ? h('span', { class: 'pb-tag', title: 'Size: S = under an hour, M = a few hours, L = a day or more', text: s.size }) : null,
    s.status === 'doing' ? h('span', { class: 'pb-tag pb-tag--doing', text: 'In progress' }) : null,
    s.status === 'done' ? h('span', { class: 'pb-tag pb-tag--done', text: 'Done' }) : null,
    s.status === 'skipped' ? h('span', { class: 'pb-tag pb-tag--muted', text: 'Skipped' }) : null];
    card.append(h('div', { class: 'pb-item__head' }, h('span', { class: 'pb-step__title', html: mdInline(s.title) }), h('span', { class: 'pb-id', text: s.id }), ...tags));
    const deps = arr(s.depends_on);
    if (deps.length) card.append(h('div', { class: 'pb-deps' }, 'After ', deps.map((d, k) => [k ? ', ' : '', h('a', { href: `#pb-step-${d}`, text: `step ${nums.get(d) || d}` })])));
    if (s.detail) card.append(h('div', { class: 'pb-step__body', html: md(s.detail) }));
    if ((s.files || []).length) card.append(h('div', { class: 'pb-part' }, h('div', { class: 'pb-part__label', text: 'Files' }), h('ul', { class: 'pb-files' }, s.files.map((f) => h('li', { 'data-pb-id': `${s.id}:${f.path}`, 'data-pb-kind': 'file', 'data-pb-label': `${f.path} (step ${i + 1})` },
      h('span', { class: `pb-chg pb-chg--${f.change || 'edit'}`, text: f.change || 'edit' }),
      h('span', { class: 'pb-files__path', text: f.change === 'move' && f.to ? `${f.path} → ${f.to}` : f.path }),
      f.what ? h('span', { class: 'pb-files__what', html: mdInline(f.what) }) : null)))));
    if (arr(s.commands).length) {
      const pre = h('pre', {}, h('code', { text: arr(s.commands).join('\n') }));
      card.append(h('div', { class: 'pb-part' }, h('div', { class: 'pb-part__label', text: 'Run' }), h('div', { class: 'pb-cmd' }, pre, copyBtn(() => arr(s.commands).join('\n')))));
    }
    if (arr(s.done_when).length) card.append(h('div', { class: 'pb-part' }, h('div', { class: 'pb-part__label', text: 'Done when' }), h('ul', { class: 'pb-check' }, arr(s.done_when).map((d) => h('li', { html: mdInline(d) })))));
    if (s.notes) card.append(h('div', { class: 'pb-note', html: md(s.notes) }));
    li.append(card);
    return li;
  }
  function copyBtn(getText) {
    return h('button', { class: 'pb-btn pb-btn--sm pb-copy', type: 'button', html: ICON.copy + 'Copy', onclick: async (e) => { await copyText(getText()); const b = e.currentTarget; b.lastChild.textContent = 'Copied'; setTimeout(() => (b.lastChild.textContent = 'Copy'), 1200); } });
  }
  function fileIndex() {
    const idx = new Map(); const nums = stepNum();
    for (const s of PLAN.steps || []) for (const f of s.files || []) {
      if (!f || !f.path) continue;
      if (!idx.has(f.path)) idx.set(f.path, { path: f.path, to: f.to, changes: new Set(), steps: [] });
      const e = idx.get(f.path); e.changes.add(f.change || 'edit'); e.steps.push({ id: s.id, n: nums.get(s.id) });
    }
    return [...idx.values()].sort((a, b) => a.path.localeCompare(b.path));
  }
  function renderFiles() {
    const files = fileIndex(); if (!files.length) return null;
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split('/'); const name = parts.pop(); let node = root;
      for (const p of parts) { if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] }); node = node.dirs.get(p); }
      node.files.push({ ...f, name });
    }
    const renderNode = (node) => {
      const ul = h('ul', {});
      for (const [name, child] of [...node.dirs.entries()].sort()) {
        let label = name + '/'; let c = child;
        while (c.files.length === 0 && c.dirs.size === 1) { const [n2, c2] = [...c.dirs.entries()][0]; label += n2 + '/'; c = c2; }
        ul.append(h('li', {}, h('span', { class: 'pb-tree__dir', text: label }), renderNode(c)));
      }
      for (const f of node.files) {
        const ch = [...f.changes];
        ul.append(h('li', { 'data-pb-id': `file:${f.path}`, 'data-pb-kind': 'file', 'data-pb-label': f.path },
          h('span', { class: 'pb-tree__file' + (ch.includes('delete') ? ' is-delete' : '') },
            h('span', { class: `pb-chg pb-chg--${ch[0]}`, text: ch.join('+') }),
            h('span', { class: 'pb-tree__name', text: f.name + (f.to ? ` → ${f.to}` : '') }),
            h('span', { class: 'pb-tree__steps' }, 'step ', [...new Map(f.steps.map((s) => [s.id, s])).values()].map((s, k) => [k ? ', ' : '', h('a', { href: `#pb-step-${s.id}`, text: String(s.n) })])))));
      }
      return ul;
    };
    const tree = renderNode(root); tree.className = 'pb-tree';
    const counts = {}; files.forEach((f) => f.changes.forEach((c) => (counts[c] = (counts[c] || 0) + 1)));
    const sum = h('div', { class: 'pb-filesum' }, ['new', 'edit', 'delete', 'move'].filter((c) => counts[c]).map((c) => h('span', { class: `pb-chg pb-chg--${c}`, text: `${counts[c]} ${c}` })));
    return block('files', 'Files', `${files.length} file${files.length > 1 ? 's' : ''}`, sum, tree);
  }
  function renderRisk(r) {
    const meter = (label, v) => h('span', { class: 'pb-meter', 'data-v': v === 'medium' ? 'med' : (v || 'med') }, label, h('i', {}, h('b'), h('b'), h('b')));
    return h('div', { class: 'pb-item pb-risk', 'data-pb-id': r.id, 'data-pb-kind': 'risk', 'data-pb-label': plain(r.text) },
      h('div', {}, h('span', { class: 'pb-risk__text', html: mdInline(r.text) }), ' ', h('span', { class: 'pb-id', text: r.id })),
      h('div', { class: 'pb-risk__meters' }, meter('Likelihood', r.likelihood), meter('Impact', r.impact)),
      r.mitigation ? h('div', { class: 'pb-risk__mit', html: mdInline(r.mitigation) }) : null);
  }

  // ---------- item states (needs you / queued / sent / settled) ----------
  function refreshStates() {
    const ended = isEnded();
    for (const el of $$('#pb-doc .pb-question')) {
      const q = (PLAN.questions || []).find((x) => x.id === el.getAttribute('data-pb-id')); if (!q) continue;
      const key = `answer:${q.id}`; const cur = queued(key); const sent = sentItem(key);
      const answered = q.status === 'answered';
      // sent after plan.json last changed = the agent hasn't recorded it yet (covers re-answering an answered question)
      const pendingSent = sent && !cur && (!answered || sent.entry.at > (S.planMtime || 0));
      el.toggleAttribute('data-needs', !answered && !cur && !pendingSent && !ended);
      el.setAttribute('data-state', cur ? 'queued' : pendingSent ? 'sent' : answered ? 'answered' : 'open');
      el.classList.toggle('is-settled', answered && !cur);
      for (const b of $$('.pb-opt', el)) { b.setAttribute('aria-pressed', String(!!(cur && (cur.choice || []).includes(b.dataset.opt)))); b.disabled = ended; }
      for (const x of $$('.pb-other input, .pb-other button', el)) x.disabled = ended;
      const body = $('.pb-qbody', el); if (body) body.hidden = (answered && !cur && !el.classList.contains('is-reopened')) || (ended && !cur);
      const st = $('.pb-item__state', el);
      st.innerHTML = '';
      if (cur) st.append(h('strong', { text: 'Queued: ' }), answerText(cur), ' ', h('button', { class: 'pb-btn pb-btn--ghost pb-btn--sm', type: 'button', text: 'Undo', onclick: () => dequeue(key) }));
      else if (pendingSent) st.append(h('strong', { text: sent.entry.delivered ? 'Delivered: ' : 'Sent: ' }), answerText(sent.item), ' — waiting for the agent to update the plan');
      else if (answered && !ended) st.append(h('button', { class: 'pb-btn pb-btn--ghost pb-btn--sm', type: 'button', text: 'Change answer', onclick: () => { el.classList.add('is-reopened'); refreshStates(); } }));
    }
    for (const el of $$('#pb-doc .pb-decision')) {
      const d = (PLAN.decisions || []).find((x) => x.id === el.getAttribute('data-pb-id')); if (!d) continue;
      const key = `decision:${d.id}`; const cur = queued(key); const sent = sentItem(key);
      const decided = !!d.chosen; const pendingSent = sent && !cur && sent.item.choice !== d.chosen;
      el.toggleAttribute('data-needs', !decided && !cur && !pendingSent && !ended);
      el.setAttribute('data-state', cur ? 'queued' : pendingSent ? 'sent' : decided ? 'decided' : 'open');
      for (const o of $$('.pb-dec__opt', el)) {
        const picked = cur && cur.choice === o.dataset.opt;
        o.classList.toggle('is-picked', !!picked);
        const btn = $('.pb-choose', o); if (btn) { btn.textContent = picked ? 'Picked — undo' : (d.chosen === o.dataset.opt ? 'Chosen' : 'Choose this'); btn.hidden = ended; }
      }
      const st = $('.pb-item__state', el); st.innerHTML = '';
      const noteBox = $('.pb-dec__note', el); if (noteBox && !cur) noteBox.hidden = true;
      if (cur) st.append(h('strong', { text: 'Queued: ' }), cur.choiceLabel + (cur.text ? ` — “${short(cur.text, 60)}”` : ''), ' ', h('button', { class: 'pb-btn pb-btn--ghost pb-btn--sm', type: 'button', text: cur.text ? 'Edit note' : 'Add a note', onclick: () => { if (!noteBox) return; noteBox.hidden = false; const i = $('input', noteBox); i.value = cur.text || ''; i.focus(); } }));
      else if (pendingSent && !decided) st.append(h('strong', { text: sent.entry.delivered ? 'Delivered: ' : 'Sent: ' }), sent.item.choiceLabel || '', ' — waiting for the agent to record it');
    }
    for (const el of $$('#pb-doc .pb-assumption')) {
      const a = (PLAN.assumptions || []).find((x) => x.id === el.getAttribute('data-pb-id')); if (!a) continue;
      const key = `assumption:${a.id}`; const cur = queued(key); const sent = sentItem(key);
      const settled = a.status === 'confirmed' || a.status === 'rejected';
      const pendingSent = sent && !cur && (!settled || sent.entry.at > (S.planMtime || 0));
      el.toggleAttribute('data-needs', !settled && !cur && !pendingSent && !ended);
      el.setAttribute('data-state', cur ? 'queued' : pendingSent ? 'sent' : (a.status || 'open'));
      for (const b of $$('[data-verdict]', el)) {
        const on = cur && cur.verdict === b.dataset.verdict;
        b.classList.toggle('pb-btn--primary', !!on);
        b.hidden = ended || (settled && !cur && !el.classList.contains('is-reopened'));
      }
      const st = $('.pb-item__state', el); st.innerHTML = '';
      const V = { confirm: 'Confirmed', reject: 'Wrong', edit: 'Corrected' };
      if (cur) st.append(h('strong', { text: 'Queued: ' }), V[cur.verdict] + (cur.text ? ` — “${short(cur.text, 60)}”` : ''), ' ', h('button', { class: 'pb-btn pb-btn--ghost pb-btn--sm', type: 'button', text: 'Undo', onclick: () => dequeue(key) }));
      else if (pendingSent) st.append(h('strong', { text: sent.entry.delivered ? 'Delivered: ' : 'Sent: ' }), V[sent.item.verdict] || '', ' — waiting for the agent');
      else if (settled) st.append(h('span', { class: `pb-tag ${a.status === 'confirmed' ? 'pb-tag--done' : 'pb-tag--removed'}`, text: a.status === 'confirmed' ? 'Confirmed' : 'Rejected' }), ' ', ended ? null : h('button', { class: 'pb-btn pb-btn--ghost pb-btn--sm', type: 'button', text: 'Change', onclick: () => { el.classList.add('is-reopened'); refreshStates(); } }));
    }
    // queued comments outline their targets
    for (const el of $$('.pb-has-note')) el.classList.remove('pb-has-note');
    for (const i of queue) if (i.kind === 'comment' && i.target) { const t = findTarget(i.target); if (t) t.classList.add('pb-has-note'); }
    for (const el of $$('[data-pb-ok]')) el.setAttribute('aria-pressed', String(!!queued(`approve-section:${el.getAttribute('data-pb-ok')}`)));
    const n = needsCount();
    const g = $('#pb-glance-needs b'); if (g) g.textContent = String(n);
    document.body.classList.toggle('pb-is-ended', ended);
    const tag = $('#pb-status-tag'); if (tag) tag.textContent = ended ? 'Review ended' : PLAN.status === 'approved' ? 'Approved' : PLAN.status === 'in-review' ? 'In review' : 'Draft';
  }
  function answerText(i) { return [...(i.choiceLabels || []), i.text ? `“${short(i.text, 60)}”` : ''].filter(Boolean).join(' + '); }
  const needsCount = () => $$('#pb-doc [data-needs]').length;
  function findTarget(t) {
    if (t.id) { const el = $(`#pb-doc [data-pb-id="${CSS.escape(t.id)}"]`); if (el) return el; }
    if (t.section) return $(`#pb-doc [data-pb-section="${CSS.escape(t.section)}"]`);
    return null;
  }

  // ---------- changes since last feedback ----------
  const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, kk) => ((o[kk] = x[kk]), o), {}) : x));
  let baselineDom = null;
  function computeChanges() {
    changes = [];
    if (!S.baseline) return;
    const B = S.baseline.plan || {}; const round = S.round;
    const kinds = [['decisions', 'decision', (x) => x.title], ['questions', 'question', (x) => x.text], ['assumptions', 'assumption', (x) => x.text], ['steps', 'step', (x) => x.title], ['risks', 'risk', (x) => x.text], ['sections', 'section', (x) => x.title]];
    if (S.baseline.plan) {
      for (const [k, kind, label] of kinds) {
        const before = new Map((B[k] || []).filter(Boolean).map((x) => [x.id, x]));
        for (const it of PLAN[k] || []) {
          if (!it) continue;
          const b = before.get(it.id);
          if (!b) changes.push({ type: 'new', kind, id: it.id, label: plain(label(it)) });
          else if (stable(b) !== stable(it)) changes.push({ type: 'changed', kind, id: it.id, label: plain(label(it)) });
          before.delete(it.id);
        }
        for (const [id, b] of before) changes.push({ type: 'removed', kind, id, label: plain(label(b)) });
      }
      const ov = [['title', 'title'], ['summary', 'summary'], ['goal', 'goal'], ['non_goals', 'non_goals'], ['context', 'context']];
      for (const [f, id] of ov) if (stable(B[f]) !== stable(PLAN[f])) changes.push({ type: B[f] == null ? 'new' : 'changed', kind: 'overview', id, label: { title: 'Title', summary: 'Summary', goal: 'Goal', non_goals: 'Not doing', context: 'Context' }[f] });
      if (stable(B.verification) !== stable(PLAN.verification)) changes.push({ type: 'changed', kind: 'section', section: 'verification', label: 'How we will know it works' });
    }
    if (S.baseline.html) {
      const dom = new DOMParser().parseFromString(S.baseline.html, 'text/html');
      baselineDom = dom;
      const bsec = new Map($$('[data-pb-section]', dom).map((s) => [s.getAttribute('data-pb-section'), norm(s.outerHTML)]));
      const bids = new Map($$('[data-pb-section] [data-pb-id]', dom).map((s) => [s.getAttribute('data-pb-id'), norm(s.outerHTML)]));
      for (const [id, html] of originals) {
        if (!bsec.has(id)) { changes.push({ type: 'new', kind: 'section', section: id, label: sectionTitleById(id) }); continue; }
        if (bsec.get(id) !== html) {
          const inner = [...originalIds].filter(([eid, eh]) => $(`#pb-doc [data-pb-section="${CSS.escape(id)}"] [data-pb-id="${CSS.escape(eid)}"]`) && bids.get(eid) !== eh);
          if (inner.length) inner.forEach(([eid]) => changes.push({ type: bids.has(eid) ? 'changed' : 'new', kind: 'element', id: eid, label: `${sectionTitleById(id)} › ${short(elLabel($(`#pb-doc [data-pb-id="${CSS.escape(eid)}"]`)), 50)}` }));
          else changes.push({ type: 'changed', kind: 'section', section: id, label: sectionTitleById(id) });
        }
        bsec.delete(id);
      }
      for (const [id] of bsec) if (!['overview', 'decisions', 'questions', 'assumptions', 'steps', 'files', 'risks', 'verification'].includes(id) && !(PLAN.sections || []).some((s) => s.id === id)) changes.push({ type: 'removed', kind: 'section', section: id, label: id });
    }
    for (const c of changes) {
      if (c.type === 'removed') continue;
      const el = c.id ? $(`#pb-doc [data-pb-id="${CSS.escape(c.id)}"]`) : $(`#pb-doc [data-pb-section="${CSS.escape(c.section)}"]`);
      if (!el) continue;
      c.el = el; el.classList.add('pb-changed');
      const mark = h('span', { html: DELTA(round) }).firstChild;
      const head = $(':scope > .pb-item__head, :scope > .pb-block__head', el) || (el.matches('h1,h2,h3,h4,li') ? el : null);
      if (head) head.append(' ', mark);
      else if (el.matches('[data-pb-section]')) { const hd = $('h1, h2, h3', el); if (hd) hd.append(' ', mark); else { mark.classList.add('pb-delta--block'); el.prepend(mark); } }
      else if (el.namespaceURI === 'http://www.w3.org/2000/svg') el.classList.add('pbd-changed');
      else if (el.matches('figure.pb-diagram')) { const n = safe(markDiagramNodes, el, round) || 0; diagramNote(el, h('span', { class: 'pb-diagram__changed' }, mark, n ? ` Changed since your last feedback: ${n} part${n === 1 ? '' : 's'} marked with a teal triangle${el.classList.contains('is-scroll') ? ' (scroll or Expand to see all)' : ''}` : ' Changed since your last feedback')); }
      else if (el.matches('figure') && $(':scope > figcaption', el)) $(':scope > figcaption', el).append(' ', mark);
      else { mark.classList.add('pb-delta--block'); el.prepend(mark); }
    }
  }
  // Inside a changed diagram, mark the nodes / participants / messages that are new or different.
  function markDiagramNodes(fig, round) {
    if (!baselineDom) return 0;
    const dg = fig.getAttribute('data-pb-id');
    const old = $(`[data-pb-id="${CSS.escape(dg)}"]`, baselineDom); if (!old) return 0;
    for (const br of $$('br', old)) br.replaceWith('<br>');
    const oldSrc = (old.getAttribute('data-src') || old.textContent).replace(/^\s*\n/, '').replace(/\s+$/, '');
    const newSrc = fig.getAttribute('data-src') || '';
    const isSeq = (x) => /^\s*sequenceDiagram/i.test(x.split('\n').find((l) => l.trim() && !l.trim().startsWith('%%')) || '');
    let marks = [];
    try {
      if (isSeq(newSrc)) {
        const a = isSeq(oldSrc) ? parseSeq(oldSrc) : { P: [], rows: [] }; const b = parseSeq(newSrc);
        const op = new Map(a.P.map((p) => [p.id, `${p.label}|${p.cls}`]));
        marks = b.P.filter((p) => op.get(p.id) !== `${p.label}|${p.cls}`).map((p) => `${dg}:${p.id}`);
        const oldMsgs = new Set(a.rows.filter((r) => r.t === 'msg' || r.t === 'note').map((r) => `${r.from}>${r.to}:${r.text}`));
        b.rows.forEach((r, i) => { if ((r.t === 'msg' || r.t === 'note') && !oldMsgs.has(`${r.from}>${r.to}:${r.text}`)) marks.push(`${dg}:${r.t === 'msg' ? 'm' : 'n'}${i + 1}`); });
      } else {
        const a = isSeq(oldSrc) ? { nodes: new Map() } : parseFlow(oldSrc); const b = parseFlow(newSrc);
        const sig = (n) => `${n.label}|${n.shape}|${n.cls.join(',')}`;
        for (const [id, n] of b.nodes) if (!a.nodes.has(id) || sig(a.nodes.get(id)) !== sig(n)) marks.push(`${dg}:${id}`);
      }
    } catch { return 0; }
    for (const id of marks) {
      const g = $(`[data-pb-id="${CSS.escape(id)}"]`, fig); if (!g) continue;
      g.classList.add('pbd-changed');
      const text = g.matches('.pbd-node, .pbd-actor') ? null : $('text', g);
      const bb = (text || g).getBBox();
      const [x, y] = text ? [bb.x + bb.width + 12, bb.y + bb.height / 2] : [bb.x + bb.width - 2, bb.y + 2];
      g.insertAdjacentHTML('beforeend', `<g class="pbd-dmark" transform="translate(${x},${y})"><title>Changed since your last feedback (round ${round})</title><path d="M0,-8 L8,6 H-8 Z"/></g>`);
    }
    return $$('.pbd-dmark', fig).length;
  }

  // ---------- nav ----------
  function topSections() { return $$('#pb-doc [data-pb-section]').filter((s) => !s.parentElement.closest('[data-pb-section]')); }
  function headingText(hd) { if (!hd) return ''; const c = hd.cloneNode(true); for (const x of c.querySelectorAll('.pb-sec-tools, .pb-delta')) x.remove(); return c.textContent.trim(); }
  function sectionTitle(sec) { return sec.getAttribute('data-pb-title') || headingText($('h1, h2, h3', sec)) || sec.getAttribute('data-pb-section'); }
  function sectionTitleById(id) { const s = $(`#pb-doc [data-pb-section="${CSS.escape(id)}"]`); return s ? sectionTitle(s) : id; }
  function buildNav() {
    elNav.innerHTML = '';
    const secs = topSections();
    for (const s of secs) {
      if (!s.id) s.id = 'pb-sec-' + s.getAttribute('data-pb-section');
      elNav.append(h('a', { href: '#' + s.id, 'data-for': s.id, onclick: (e) => { e.preventDefault(); s.scrollIntoView({ behavior: motion(), block: 'start' }); history.replaceState(null, '', '#' + s.id); } }, h('span', { text: sectionTitle(s) }), h('span', { class: 'pb-nav__badges' })));
    }
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((ents) => {
      for (const e of ents) if (e.isIntersecting) { for (const a of $$('a', elNav)) a.classList.toggle('is-active', a.dataset.for === e.target.id); const a = $(`a[data-for="${CSS.escape(e.target.id)}"]`, elNav); if (a) a.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    }, { rootMargin: '-110px 0px -65% 0px' });
    secs.forEach((s) => io.observe(s));
  }
  function updateNavBadges() {
    for (const a of $$('a', elNav)) {
      const s = document.getElementById(a.dataset.for); if (!s) continue;
      const b = $('.pb-nav__badges', a); b.innerHTML = '';
      const n = $$('[data-needs]', s).length + (s.hasAttribute('data-needs') ? 1 : 0);
      const d = $$('.pb-changed', s).length + (s.classList.contains('pb-changed') ? 1 : 0);
      if (n) b.append(h('span', { class: 'pb-nav__dot pb-nav__dot--needs', title: `${n} need your input`, text: String(n) }));
      if (d) b.append(h('span', { class: 'pb-nav__dot pb-nav__dot--delta', title: `${d} changed since your last feedback`, text: 'Δ' + d }));
    }
  }

  // ---------- top bar ----------
  function statusInfo() {
    if (isEnded()) return { cls: '', text: 'Review ended', line: 'This review has ended.' };
    if (STANDALONE) return { cls: '', text: 'Offline copy', line: 'This is a saved copy. Sending copies your feedback so you can paste it to the agent.' };
    if (moved) return { cls: '', text: 'Plan moved', line: 'This address no longer belongs to the plan. Ask the agent to run planboard open and use the new link; your unsent feedback goes with it.' };
    if (!connected) return { cls: '', text: 'Reconnecting…', line: Date.now() - downSince > 20000 ? 'Still no planboard server. If the agent restarted it, the plan may have a new address: ask it to run planboard open. Your unsent feedback is saved.' : 'Lost the local server. Retrying…' };
    if (!status) return { cls: '', text: '…', line: '' };
    const now = Date.now() + skew;
    if (status.listening) return { cls: 'waiting', text: 'Agent is waiting for you', line: 'The agent is listening. It gets your feedback the moment you send it.' };
    if (status.queued) return { cls: '', text: 'Sent — not picked up yet', line: 'Your feedback is saved and will reach the agent when it next checks.' };
    if (status.lastDeliveredAt && now - status.lastDeliveredAt < 45 * 60e3 && (!status.lastReplyAt || status.lastReplyAt < status.lastDeliveredAt)) return { cls: 'working', text: 'Agent is working…', line: 'The agent has your feedback and is updating the plan.' };
    return { cls: '', text: 'Agent not listening', line: "The agent isn't listening right now. What you send is saved and delivered when it checks again." };
  }
  function updateTop() {
    if (!elTop) return;
    const st = statusInfo(); const n = needsCount(); const q = queue.length + ($('#pb-input')?.value.trim() ? 1 : 0);
    const fk = elTop.contains(document.activeElement) ? document.activeElement.getAttribute('data-k') : null;
    elTop.innerHTML = '';
    const add = (...xs) => xs.forEach((x) => x && elTop.append(x));
    add(
      h('div', { class: 'pb-top__title', title: PLAN.title || S.name, text: PLAN.title || S.name }),
      S.round > 1 ? h('span', { class: 'pb-tag pb-top__hide-narrow', title: 'Each time you send changes, the round goes up. Δ marks show what changed since.', text: `Round ${S.round}` }) : null,
      h('div', { class: 'pb-top__spacer' }),
      h('div', { class: 'pb-top__group' },
        h('span', { class: `pb-status pb-top__hide-narrow ${st.cls ? 'pb-status--' + st.cls : ''}`, title: st.line, text: st.text }),
        n ? h('button', { class: 'pb-btn pb-btn--needs', 'data-k': 'needs', type: 'button', title: 'Jump to the next item that needs your input (N)', html: `${ICON.next}${n} need${n === 1 ? 's' : ''} you`, onclick: jumpNext }) : null,
        changes.length ? h('button', { class: 'pb-btn pb-btn--delta pb-top__hide-narrow', 'data-k': 'delta', type: 'button', title: 'What changed since your last feedback', text: `Δ ${changes.length} changed`, onclick: (e) => openChanges(e.currentTarget) }) : null,
        h('button', { class: 'pb-btn pb-btn--ghost pb-top__hide-narrow', 'data-k': 'side', type: 'button', title: 'Show or hide the conversation (C)', html: `${ICON.panel}${q ? `Conversation · ${q} to send` : 'Conversation'}`, onclick: toggleSide }),
        h('button', { class: 'pb-btn pb-btn--primary', 'data-k': 'approve', type: 'button', text: PLAN.status === 'approved' ? 'Approved ✓' : 'Approve plan', disabled: isEnded() || null, onclick: openApprove }),
        h('button', { class: 'pb-btn pb-btn--icon pb-btn--ghost', 'data-k': 'more', type: 'button', 'aria-label': 'More', html: ICON.dots, onclick: (e) => openMenu(e.currentTarget) })));
    if (fk) $(`[data-k="${fk}"]`, elTop)?.focus();
    renderAgentLine();
    const sendBtn = $('#pb-send');
    if (sendBtn) sendBtn.textContent = STANDALONE ? 'Copy feedback' : (q ? `Send ${q}` : 'Send');
  }
  let jumpIdx = -1;
  function jumpNext() {
    const list = $$('#pb-doc [data-needs]'); if (!list.length) return;
    jumpIdx = (jumpIdx + 1) % list.length;
    const el = list[jumpIdx]; el.scrollIntoView({ behavior: motion(), block: 'center' }); flash(el, 'pb-flash-needs');
  }
  function flash(el, cls = 'pb-flash') { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); setTimeout(() => el.classList.remove(cls), 1700); }

  // ---------- floating menus ----------
  let openFloat = null;
  function closeFloat() { if (openFloat) { openFloat.remove(); openFloat = null; } }
  function placeFloat(el, anchor, align = 'right') {
    document.body.append(el); openFloat = el;
    const r = anchor.getBoundingClientRect(); const w = el.offsetWidth;
    let left = align === 'right' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, innerWidth - w - 8));
    el.style.left = left + scrollX + 'px'; el.style.top = r.bottom + scrollY + 6 + 'px';
    setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!el.contains(e.target)) { closeFloat(); document.removeEventListener('mousedown', off); } }), 0);
  }
  function openChanges(anchor) {
    closeFloat();
    const m = h('div', { class: 'pb-menu pb-changes', role: 'menu' });
    m.append(h('div', { class: 'pb-menu__note', text: `Changed since you last sent feedback (round ${S.round})` }));
    const word = { new: 'New', changed: 'Changed', removed: 'Removed' };
    for (const c of changes) {
      m.append(h('button', { type: 'button', disabled: c.type === 'removed' || !c.el || null, onclick: () => { closeFloat(); c.el.scrollIntoView({ behavior: motion(), block: 'center' }); flash(c.el); } },
        h('span', { class: `pb-tag ${c.type === 'new' ? 'pb-tag--new' : c.type === 'removed' ? 'pb-tag--removed' : 'pb-tag--delta'}`, text: word[c.type] }),
        h('span', {}, short(c.label || c.id || c.section, 70), h('br'), h('small', { text: `${c.kind}${c.id ? ' ' + c.id : ''}` }))));
    }
    if (changes.length) m.append(h('div', { class: 'pb-menu__sep' }), h('button', { type: 'button', text: 'Step through all changes', onclick: () => { closeFloat(); stepChanges(); } }));
    placeFloat(m, anchor);
  }
  // A small bar that walks through the changes one at a time, at the user's pace.
  function stepChanges() {
    const list = changes.filter((c) => c.el); if (!list.length) return;
    $('#pb-stepper')?.remove();
    let i = 0;
    const label = h('span', { class: 'pb-stepper__label' });
    const prev = h('button', { class: 'pb-btn pb-btn--sm', type: 'button', text: '‹ Previous', onclick: () => go(i - 1) });
    const next = h('button', { class: 'pb-btn pb-btn--sm pb-btn--primary', type: 'button', text: 'Next ›', onclick: () => go(i + 1) });
    const close = () => { bar.remove(); document.removeEventListener('keydown', onKey); };
    const bar = h('div', { class: 'pb-stepper', id: 'pb-stepper', role: 'group', 'aria-label': 'Step through changes' }, label, prev, next, h('button', { class: 'pb-btn pb-btn--sm pb-btn--ghost', type: 'button', text: 'Done', onclick: close }));
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const go = (k) => {
      i = Math.max(0, Math.min(list.length - 1, k)); const c = list[i];
      label.textContent = `Change ${i + 1} of ${list.length}: ${short(c.label || c.id || c.section, 60)}`;
      prev.disabled = i === 0; next.disabled = i === list.length - 1;
      c.el.scrollIntoView({ behavior: motion(), block: 'center' }); flash(c.el);
    };
    document.body.append(bar); document.addEventListener('keydown', onKey);
    go(0); (next.disabled ? bar.lastChild : next).focus();
  }
  function openMenu(anchor) {
    closeFloat();
    const m = h('div', { class: 'pb-menu', role: 'menu' },
      h('button', { type: 'button', text: 'Copy feedback as text', onclick: async () => { closeFloat(); const items = currentItems(); if (!items.length) return toast('Nothing queued yet.'); await copyText(formatText(items)); toast('Copied. You can paste it into the terminal.'); } }),
      h('button', { type: 'button', text: 'Jump to next item that needs you  (N)', onclick: () => { closeFloat(); jumpNext(); } }),
      h('button', { type: 'button', text: 'Show or hide conversation  (C)', onclick: () => { closeFloat(); toggleSide(); } }),
      changes.length ? h('button', { type: 'button', text: `What changed (${changes.length})…`, onclick: () => { closeFloat(); openChanges(anchor); } }) : null,
      changes.some((c) => c.el) ? h('button', { type: 'button', text: 'Step through the changes', onclick: () => { closeFloat(); stepChanges(); } }) : null,
      h('div', { class: 'pb-menu__sep' }),
      !STANDALONE && !isEnded() ? h('button', { type: 'button', text: 'End review…', onclick: () => { closeFloat(); confirmEnd(anchor); } }) : null,
      h('div', { class: 'pb-menu__note', html: `Plan folder: <span class="pb-mono">${esc(S.dir || S.name)}</span><br>To comment: select text, hover a block, or Tab to it and press Enter. Shortcuts: N next item, C conversation, / type a message.` }));
    placeFloat(m, anchor);
  }

  // ---------- conversation panel ----------
  let mode = store.get(K.mode, 'ask');
  function buildSide() {
    const side = h('aside', { class: 'pb-side', 'aria-label': 'Conversation' });
    const head = h('div', { class: 'pb-side__head', onclick: (e) => { if (innerWidth <= 980 && !e.target.closest('button')) side.classList.toggle('is-open'); } },
      h('span', { text: 'Conversation' }), h('span', { class: 'pb-tag', id: 'pb-qcount', hidden: true }),
      h('button', { class: 'pb-btn pb-btn--ghost pb-btn--sm pb-top__hide-narrow', type: 'button', text: 'Hide', onclick: toggleSide }));
    const list = h('div', { class: 'pb-convo', id: 'pb-convo', 'aria-live': 'polite' });
    const ta = h('textarea', { class: 'pb-textarea', id: 'pb-input', rows: 3, placeholder: 'Ask a question or describe a change', 'aria-label': 'Message to the agent' });
    ta.addEventListener('input', () => { store.set(K.draft, ta.value, true); autoGrow(ta); updateTop(); syncDraft(); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendAll(); } });
    const seg = h('div', { class: 'pb-seg', role: 'group', 'aria-label': 'Message type' },
      h('button', { type: 'button', 'data-mode': 'ask', 'aria-pressed': String(mode === 'ask'), title: 'Just answer me — no plan change needed', text: 'Ask' }),
      h('button', { type: 'button', 'data-mode': 'change', 'aria-pressed': String(mode === 'change'), title: 'Update the plan', text: 'Change' }));
    seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; mode = b.dataset.mode; store.set(K.mode, mode); for (const x of $$('button', seg)) x.setAttribute('aria-pressed', String(x === b)); $('#pb-seg-help').textContent = mode === 'ask' ? 'Agent answers; plan stays as is' : 'Agent updates the plan'; });
    const comp = h('div', { class: 'pb-composer' },
      h('div', { class: 'pb-agentline', id: 'pb-agentline' }),
      ta,
      h('div', { class: 'pb-composer__row' }, seg, h('span', { class: 'pb-seg__help', id: 'pb-seg-help', text: mode === 'ask' ? 'Agent answers; plan stays as is' : 'Agent updates the plan' }), h('button', { class: 'pb-btn pb-btn--primary', id: 'pb-send', type: 'button', text: 'Send', onclick: () => sendAll() })),
      h('div', { class: 'pb-composer__hint', text: 'Enter sends everything queued · Shift+Enter for a new line' }));
    side.append(head, list, comp);
    return side;
  }
  function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(220, ta.scrollHeight + 2) + 'px'; }
  function convoToEnd() { requestAnimationFrame(() => { const l = $('#pb-convo'); if (l) l.scrollTop = l.scrollHeight; }); }
  function toggleSide() {
    if (innerWidth <= 980) { if (elSide.classList.toggle('is-open')) convoToEnd(); return; }
    const closed = elApp.classList.toggle('pb-side-closed'); store.set(K.side, !closed); updateTop();
    if (!closed) convoToEnd();
  }
  function renderAgentLine() {
    const el = $('#pb-agentline'); if (!el) return;
    const st = statusInfo(); el.textContent = st.line;
    const ta = $('#pb-input'); const ended = isEnded();
    $('.pb-composer')?.classList.toggle('is-ended', ended);
    if (ta) { ta.disabled = ended; ta.placeholder = ended ? 'This review has ended' : 'Ask a question or describe a change'; }
    const sb = $('#pb-send'); if (sb) sb.disabled = ended || sending;
  }
  const KIND_LABEL = { answer: 'Answer', assumption: 'Assumption', decision: 'Decision', comment: 'Comment', message: 'Message', 'approve-section': 'Looks good', approve: 'Approved', end: 'End', custom: 'Input' };
  function itemSummary(i) {
    const t = i.target || {};
    const V = { confirm: 'Confirmed', reject: 'Wrong', edit: 'Corrected' };
    switch (i.kind) {
      case 'answer': return `${short(t.label, 60)} → ${answerText(i)}`;
      case 'assumption': return `${V[i.verdict] || i.verdict}: ${short(t.label, 60)}${i.text ? ` → “${short(i.text, 80)}”` : ''}`;
      case 'decision': return `${short(t.label, 50)} → ${i.choiceLabel}${i.text ? ` (“${short(i.text, 60)}”)` : ''}`;
      case 'comment': return `On ${short(t.label, 50)}${t.quote ? ` (“${short(t.quote, 40)}”)` : ''}: ${i.text}`;
      case 'message': return i.text;
      case 'approve-section': return short(t.label, 70);
      case 'approve': return `Approved → ${({ continue: 'build it here', 'plan-md': 'plan.md', 'handoff-md': 'handoff.md', both: 'plan.md + handoff.md', agent: 'agent decides' })[i.output] || i.output}${i.text ? ` — “${short(i.text, 80)}”` : ''}`;
      case 'end': return 'Ended the review';
      case 'custom': return `${short(t.label, 50)}: ${i.text}`;
      default: return i.kind;
    }
  }
  function kindTag(i) {
    const askish = ['comment', 'message'].includes(i.kind);
    const label = askish ? (i.mode === 'ask' ? 'Ask' : 'Change') : KIND_LABEL[i.kind] || i.kind;
    return h('span', { class: `pb-msg__kind ${askish ? (i.mode === 'ask' ? 'pb-msg__kind--ask' : 'pb-msg__kind--change') : ''}`, text: label });
  }
  function renderConvo() {
    const list = $('#pb-convo'); if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.innerHTML = '';
    if (!S.transcript.length && !queue.length) list.append(h('div', { class: 'pb-convo__empty', html: 'Nothing sent yet.<br>Answer questions, confirm assumptions, pick decisions, or select any text to comment. Everything queues here until you press Send.' }));
    for (const e of S.transcript) {
      if (e.from === 'agent') list.append(h('div', { class: 'pb-msg pb-msg--agent' }, h('div', { class: 'pb-msg__meta', text: `Agent · ${fmtTime(e.at)}` }), h('div', { html: md(e.text) })));
      else if (e.kind === 'batch') list.append(h('div', { class: 'pb-msg pb-msg--user' },
        h('div', { class: 'pb-msg__meta', text: `You · ${fmtTime(e.at)} · ${e.delivered ? 'delivered' : 'waiting for the agent'}` }),
        h('ul', { class: 'pb-msg__items' }, e.items.map((i) => h('li', {}, kindTag(i), itemSummary(i))))));
    }
    if (queue.length) list.append(h('div', { class: 'pb-msg pb-msg--system', text: `${queue.length} queued — not sent yet` }));
    for (const i of queue) list.append(h('div', { class: 'pb-msg pb-msg--queued' },
      h('div', { class: 'pb-msg__meta' }, h('span', { text: 'Queued' }), h('button', { class: 'pb-x', type: 'button', 'aria-label': 'Remove', text: '×', onclick: () => dequeue(i.key) })),
      h('div', {}, kindTag(i), itemSummary(i))));
    if (nearBottom || queue.length) { list.scrollTop = list.scrollHeight; convoToEnd(); }
    const qc = $('#pb-qcount'); if (qc) { qc.hidden = !queue.length; qc.textContent = `${queue.length} queued`; }
    updateTop();
  }
  function currentItems() {
    const items = [...queue];
    const ta = $('#pb-input'); const v = ta ? ta.value.trim() : '';
    if (v) items.push({ kind: 'message', key: `message:${rid()}`, mode, text: v });
    return items;
  }
  async function sendAll(extra) {
    if (sending) return;
    const items = currentItems(); if (extra) items.push(...extra);
    if (!items.length) { toast('Nothing to send yet. Type a message or interact with the plan first.'); $('#pb-input')?.focus(); return; }
    if (STANDALONE) { await copyText(formatText(items)); toast('Copied. Paste it into your chat with the agent.'); return; }
    if (moved || (!trusted && !(await verifyServer()))) { toast("Not sent: this page can't reach its planboard server. Your feedback is still queued.", true); return; }
    sending = true; renderAgentLine();
    const wasListening = !!(status && status.listening);
    try {
      const r = await fetch(API('send'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: items.map(({ at, ...x }) => x) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      queue = []; saveQueue();
      const ta = $('#pb-input'); if (ta) { ta.value = ''; autoGrow(ta); store.del(K.draft, true); }
      if (j.round) S.round = j.round;
      onQueueChanged();
      toast(wasListening ? 'Sent. The agent has it.' : 'Sent. It will reach the agent when it next checks.');
    } catch (e) {
      toast(`Couldn't send: ${e.message}. Your feedback is still queued.`, true);
    } finally { sending = false; renderAgentLine(); }
  }
  function formatText(items) {
    const L = [`Feedback on the plan "${PLAN.title || S.name}" (${S.dir || ''}):`, ''];
    items.forEach((i, n) => {
      const askish = ['comment', 'message'].includes(i.kind);
      L.push(`${n + 1}. ${askish ? (i.mode === 'ask' ? 'ASK' : 'CHANGE') : (KIND_LABEL[i.kind] || i.kind).toUpperCase()}${i.target && i.target.id ? ` [${i.target.id}]` : ''}: ${itemSummary(i)}`);
    });
    return L.join('\n');
  }

  // ---------- comments ----------
  let hoverBar, selBtn, pop = null, hoverEl = null;
  function setupComments() {
    const doc = $('#pb-doc');
    hoverBar = h('div', { class: 'pb-cbtn-wrap', style: 'position:absolute;z-index:87;display:none;gap:4px' },
      // mousedown must not move focus: a focused block would lose focus and hide this bar before the click lands
      h('button', { class: 'pb-cbtn', style: 'display:grid;position:static', type: 'button', title: 'Comment on this (or Tab to a block and press Enter)', 'aria-label': 'Comment on this', html: ICON.comment, onmousedown: (e) => e.preventDefault(), onclick: () => hoverEl && openPop(hoverEl) }));
    document.body.append(hoverBar);
    addSectionTools();
    // Keyboard: blocks you can comment on are focusable; Enter opens the comment box. One Tab stop per
    // section (roving tabindex): the arrow keys move between the blocks inside it.
    const groups = new Map();
    for (const el of $$('#pb-doc [data-pb-id]')) {
      if (el.closest('svg') || ['file', 'check', 'point'].includes(el.getAttribute('data-pb-kind')) || el.matches('a[href], button, input, select, textarea, [tabindex]')) continue;
      el.setAttribute('data-pb-focus', '');
      el.setAttribute('aria-keyshortcuts', 'Enter');
      const sec = topSections().find((x) => x.contains(el)) || doc;
      if (!groups.has(sec)) groups.set(sec, []); groups.get(sec).push(el);
    }
    for (const list of groups.values()) list.forEach((el, i) => el.setAttribute('tabindex', i ? '-1' : '0'));
    blockFocus(!isEnded());
    doc.addEventListener('keydown', (e) => {
      const t = e.target; if (!t.matches || !t.matches('[data-pb-focus]') || !['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      const list = [...groups.values()].find((l) => l.includes(t)); if (!list) return;
      const i = list.indexOf(t);
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : ['ArrowDown', 'ArrowRight'].includes(e.key) ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
      e.preventDefault();
      if (j === i) return;
      t.setAttribute('tabindex', '-1'); list[j].setAttribute('tabindex', '0'); list[j].focus();
      list[j].scrollIntoView({ block: 'nearest', behavior: motion() });
    });
    doc.addEventListener('focusin', (e) => {
      const t = e.target; if (!t.matches || !t.matches('[data-pb-focus]')) return;
      const list = [...groups.values()].find((l) => l.includes(t));
      if (list && !isEnded()) for (const el of list) el.setAttribute('tabindex', el === t ? '0' : '-1');
      if (pop || isEnded()) return;
      if (hoverEl && hoverEl !== t) hoverEl.classList.remove('pb-hover-target');
      hoverEl = t; showHoverBar(t);
    });
    doc.addEventListener('focusout', (e) => { if (hoverEl && e.target === hoverEl && !pop && !hoverBar.contains(e.relatedTarget)) hideHoverBar(); });
    doc.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && !isEnded() && e.target.matches && e.target.matches('[data-pb-focus]')) { e.preventDefault(); openPop(e.target); } });
    // Touch: a tap on a block shows its comment button; a long-press selection offers Comment too.
    let lastPointer = 'mouse';
    document.addEventListener('pointerdown', (e) => {
      lastPointer = e.pointerType;
      if (e.pointerType !== 'touch' || pop || isEnded()) return;
      if (hoverBar.contains(e.target)) return;
      const t = doc.contains(e.target) && !e.target.closest('button, a, input, textarea, select, label, summary') ? e.target.closest('[data-pb-id]') : null;
      if (t) { if (hoverEl && hoverEl !== t) hoverEl.classList.remove('pb-hover-target'); hoverEl = t; showHoverBar(t); } else hideHoverBar();
    }, true);
    let selT = 0;
    document.addEventListener('selectionchange', () => { if (lastPointer !== 'touch') return; clearTimeout(selT); selT = setTimeout(() => onSelection(), 350); });
    selBtn = h('button', { class: 'pb-btn pb-btn--sm pb-selbtn', type: 'button', html: ICON.comment + 'Comment', onmousedown: (e) => e.preventDefault(), onclick: () => { const s = selInfo; selBtn.style.display = 'none'; if (!s) return; const sel = getSelection(); openPop(s.target, s.quote, sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0).getBoundingClientRect() : s.rect); } });
    document.body.append(selBtn);
    let raf = 0;
    doc.addEventListener('mousemove', (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (pop || isEnded()) return;
        const t = e.target.closest && e.target.closest('[data-pb-id]');
        if (!t || !doc.contains(t)) return;
        if (t !== hoverEl) { if (hoverEl) hoverEl.classList.remove('pb-hover-target'); hoverEl = t; showHoverBar(t); }
      });
    });
    doc.addEventListener('mouseleave', () => { setTimeout(() => { if (!hoverBar.matches(':hover')) hideHoverBar(); }, 120); });
    hoverBar.addEventListener('mouseleave', (e) => { if (!doc.contains(e.relatedTarget)) hideHoverBar(); });
    document.addEventListener('mouseup', (e) => setTimeout(() => onSelection(e), 0));
    document.addEventListener('keyup', (e) => { if (e.shiftKey) onSelection(e); });
    window.addEventListener('scroll', () => { if (hoverEl) showHoverBar(hoverEl); }, { passive: true });
  }
  function showHoverBar(t) {
    const r = t.getBoundingClientRect();
    hoverBar.style.display = 'flex';
    const w = hoverBar.offsetWidth;
    let top = r.top + scrollY + 6;
    if (r.top < 100) top = scrollY + 100;
    hoverBar.style.top = top + 'px';
    hoverBar.style.left = Math.min(r.right + scrollX - w - 6, innerWidth + scrollX - w - 8) + 'px';
    t.classList.add('pb-hover-target');
  }
  // Every top-level section gets visible Comment and Looks good buttons (mouse, keyboard and touch).
  function toggleLooksGood(sec) {
    const sid = sec.getAttribute('data-pb-section'); const key = `approve-section:${sid}`;
    if (queued(key)) { dequeue(key); toast('Removed'); }
    else { enqueue({ kind: 'approve-section', key, target: { kind: 'section', section: sid, label: sectionTitle(sec) } }); toast(`Queued: “${sectionTitle(sec)}” looks good`); }
  }
  function addSectionTools() {
    for (const sec of topSections()) {
      if ($(':scope .pb-sec-tools', sec)) continue;
      const sid = sec.getAttribute('data-pb-section');
      const tools = h('span', { class: 'pb-sec-tools' },
        h('button', { class: 'pb-btn pb-btn--ghost pb-btn--sm', type: 'button', title: 'Comment on this section', html: ICON.comment + 'Comment', onclick: () => openPop(sec) }),
        h('button', { class: 'pb-btn pb-btn--ghost pb-btn--sm pb-sec-ok', type: 'button', 'data-pb-ok': sid, 'aria-pressed': 'false', title: 'Looks good — mark this section settled', html: ICON.check + 'Looks good', onclick: () => toggleLooksGood(sec) }));
      const slot = $(':scope > .pb-block__head > .pb-block__tools', sec) || $(':scope > .pb-overview__lens', sec);
      if (slot) slot.prepend(tools);
      else { const hd = $(':scope > h1, :scope > h2, :scope > h3', sec) || $('h1, h2, h3', sec); tools.classList.add('pb-sec-tools--float'); (hd || sec).prepend(tools); }
    }
  }
  // Blocks are reachable by keyboard only while the review is open.
  function blockFocus(on) {
    for (const el of $$('#pb-doc [data-pb-focus]')) {
      if (on) { if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', el.getAttribute('data-pb-tab') || '-1'); }
      else if (el.hasAttribute('tabindex')) { el.setAttribute('data-pb-tab', el.getAttribute('tabindex')); el.removeAttribute('tabindex'); }
    }
  }
  function hideHoverBar() { hoverBar.style.display = 'none'; if (hoverEl) hoverEl.classList.remove('pb-hover-target'); hoverEl = null; }
  let selInfo = null;
  function onSelection(e) {
    if (pop && e && pop.contains(e.target)) return;
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { selBtn.style.display = 'none'; selInfo = null; return; }
    const text = sel.toString().trim();
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    const doc = $('#pb-doc');
    if (!text || text.length < 2 || !doc.contains(node) || node.closest('input, textarea, [contenteditable]')) { selBtn.style.display = 'none'; selInfo = null; return; }
    const target = node.closest('[data-pb-id], [data-pb-section]') || doc;
    const rect = range.getBoundingClientRect();
    selInfo = { target, quote: text.slice(0, 600), rect };
    selBtn.style.display = 'inline-flex';
    selBtn.style.top = rect.bottom + scrollY + 6 + 'px';
    selBtn.style.left = Math.max(8, Math.min(rect.left + scrollX + rect.width / 2 - 45, innerWidth + scrollX - 110)) + 'px';
  }
  function elLabel(el) {
    if (!el) return '';
    if (el.getAttribute && el.getAttribute('data-pb-label')) return el.getAttribute('data-pb-label');
    if (el.hasAttribute && el.hasAttribute('data-pb-section')) return sectionTitle(el);
    const c = el.cloneNode(true);
    for (const x of c.querySelectorAll('button, .pb-sec-tools, .pb-delta, .pb-diagram__bar, .pb-item__actions')) x.remove();
    return short(c.textContent, 80);
  }
  function describe(el) {
    if (!el || el.id === 'pb-doc') return { kind: 'page', label: 'the page' };
    const sec = el.closest('[data-pb-section]');
    const sid = sec && sec.getAttribute('data-pb-section');
    if (el.hasAttribute('data-pb-id')) {
      const kind = el.getAttribute('data-pb-kind') || 'element';
      const label = elLabel(el);
      const builtIn = ['question', 'decision', 'assumption', 'step', 'risk', 'option', 'file', 'goal', 'non-goals', 'context', 'summary', 'title', 'check', 'point', 'section text'].includes(kind);
      return { kind, id: el.getAttribute('data-pb-id'), section: sid || undefined, label: builtIn || !sec ? label : `${sectionTitle(sec)} › ${label}` };
    }
    return { kind: 'section', section: sid, label: sectionTitle(el) };
  }
  let popOpener = null;
  function openPop(targetEl, quote, rect) {
    const from = document.activeElement;
    closePop(); hideHoverBar();
    popOpener = from && from !== document.body ? from : targetEl;
    if (isEnded()) { toast('This review has ended.', true); return; }
    const t = describe(targetEl);
    let pmode = 'change';
    const ta = h('textarea', { class: 'pb-textarea', rows: 3, placeholder: 'What should change, or what do you want to know?' });
    const seg = h('div', { class: 'pb-seg' },
      h('button', { type: 'button', 'data-mode': 'change', 'aria-pressed': 'true', text: 'Change', title: 'Update the plan' }),
      h('button', { type: 'button', 'data-mode': 'ask', 'aria-pressed': 'false', text: 'Ask', title: 'Just answer me' }));
    const saveDraft = () => store.set(K.draft + ':pop', { t, quote, text: ta.value, mode: pmode }, true);
    seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; pmode = b.dataset.mode; for (const x of $$('button', seg)) x.setAttribute('aria-pressed', String(x === b)); saveDraft(); ta.focus(); });
    const add = (andSend) => {
      const v = ta.value.trim(); if (!v) { ta.focus(); ta.classList.add('pb-flash-needs'); return; }
      enqueue({ kind: 'comment', key: `comment:${rid()}`, mode: pmode, target: { ...t, quote: quote || undefined }, text: v });
      closePop(); getSelection()?.removeAllRanges();
      if (andSend) sendAll(); else toast('Queued. Press Send when you are done.');
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(true); }
      else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); add(false); }
      else if (e.key === 'Escape' && !ta.value.trim()) closePop();
    });
    ta.addEventListener('input', saveDraft);
    pop = h('div', { class: 'pb-pop', role: 'dialog', 'aria-label': 'Comment' },
      h('div', { class: 'pb-pop__target', html: `On <b>${esc(short(t.label, 80))}</b>${t.id ? ` <span class="pb-id">${esc(t.id)}</span>` : ''}` }),
      quote ? h('div', { class: 'pb-pop__quote', text: short(quote, 220) }) : null,
      ta,
      h('div', { class: 'pb-pop__row' }, seg, h('button', { class: 'pb-btn', type: 'button', text: 'Cancel', onclick: closePop }), h('button', { class: 'pb-btn', type: 'button', text: 'Queue', title: 'Enter', onclick: () => add(false) }), h('button', { class: 'pb-btn pb-btn--primary', type: 'button', text: 'Send now', title: 'Ctrl/Cmd + Enter', onclick: () => add(true) })));
    document.body.append(pop);
    const r = rect || targetEl.getBoundingClientRect();
    const w = pop.offsetWidth, ph = pop.offsetHeight;
    let top = (rect ? r.bottom : Math.min(r.top + 40, r.bottom)) + scrollY + 8;
    if (top - scrollY + ph > innerHeight - 10) top = Math.max(scrollY + 100, r.top + scrollY - ph - 8);
    pop.style.top = top + 'px';
    pop.style.left = Math.max(8, Math.min((rect ? r.left : r.right - w) + scrollX, innerWidth + scrollX - w - 12)) + 'px';
    ta.focus();
    setTimeout(() => document.addEventListener('mousedown', popOutside), 0);
  }
  function popOutside(e) { if (pop && !pop.contains(e.target) && !$('textarea', pop).value.trim()) closePop(); }
  function closePop() {
    if (pop) {
      const hadFocus = pop.contains(document.activeElement);
      pop.remove(); pop = null; store.del(K.draft + ':pop', true);
      if (hadFocus && popOpener && document.contains(popOpener) && popOpener.focus) popOpener.focus({ preventScroll: true });
    }
    document.removeEventListener('mousedown', popOutside);
  }

  // ---------- approve / end ----------
  // Modal dialogs: focus moves in and stays in (Tab cycles), Escape or the backdrop closes, focus returns after.
  function showModal(dialog, focusEl, openerEl) {
    const opener = openerEl || document.activeElement;
    const back = h('div', { class: 'pb-modal-back' }, dialog);
    // Tab stops in order; a radio group is one stop (its checked radio), like the browser does it.
    const focusables = () => $$('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select, a[href], [tabindex]:not([tabindex="-1"])', dialog)
      .filter((el) => !(el.type === 'radio' && !el.checked && $$(`input[type=radio][name="${CSS.escape(el.name)}"]`, dialog).some((r) => r.checked)));
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); document.documentElement.classList.remove('pb-modal-open'); const o = opener && document.contains(opener) ? opener : $('[data-k=more]'); if (o && o.focus) o.focus(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const f = focusables(); if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (i === f.length - 1 || i < 0)) { e.preventDefault(); f[0].focus(); }
    };
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.body.append(back);
    document.documentElement.classList.add('pb-modal-open');
    document.addEventListener('keydown', onKey, true);
    (focusEl || focusables()[0])?.focus();
    return close;
  }
  function openApprove() {
    if (isEnded()) return;
    const n = needsCount();
    const hint = PLAN.output_hint || {};
    const choices = [
      ['continue', 'Build it here', 'The agent starts implementing in this session and ticks steps off on this page as it goes.'],
      ['handoff-md', 'Write handoff.md', 'Everything a fresh session needs: context, decisions and why, exact steps, commands, how to verify.'],
      ['plan-md', 'Write plan.md', 'A step-by-step checklist file to work through later or hand to another tool.'],
      ['both', 'plan.md and handoff.md', 'Both files.'],
      ['agent', 'Let the agent decide', 'It picks based on how much room is left in this session.'],
    ];
    let pick = choices.some((c) => c[0] === hint.recommend) ? hint.recommend : 'agent';
    const pending = currentItems();
    const changing = pending.filter((i) => (i.kind === 'assumption' && i.verdict !== 'confirm') || i.kind === 'custom' || (['comment', 'message'].includes(i.kind) && i.mode !== 'ask'));
    const note = h('textarea', { class: 'pb-textarea', rows: 2, placeholder: 'Optional note for the agent (anything to keep in mind)' });
    let close = null;
    const form = h('div', { class: 'pb-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pb-appr-h' },
      h('h2', { id: 'pb-appr-h', text: 'Approve this plan' }),
      h('p', { text: 'What should the agent do next?' }),
      choices.map(([id, title, sub]) => h('label', { class: 'pb-choice' },
        h('input', { type: 'radio', name: 'pb-out', value: id, checked: id === pick || null, onchange: () => (pick = id) }),
        h('div', {}, h('b', {}, title, id === hint.recommend ? h('span', { class: 'pb-tag', text: 'Agent suggests' }) : null), h('span', { text: id === hint.recommend && hint.why ? `${sub} ${hint.why}` : sub })))),
      n ? h('div', { class: 'pb-modal__warn', text: `${n} item${n === 1 ? ' still needs' : 's still need'} your input. The agent will list ${n === 1 ? 'it' : 'them'} as open in the output.` }) : null,
      changing.length ? h('div', { class: 'pb-modal__warn', text: `You're also sending ${changing.length} change${changing.length === 1 ? '' : 's'} (${changing.map((i) => (i.kind === 'assumption' ? 'an assumption marked wrong' : i.kind === 'custom' ? 'input from a page control' : 'a change request')).filter((x, k, a) => a.indexOf(x) === k).join(', ')}). The agent applies ${changing.length === 1 ? 'it' : 'them'} before writing the output; anything it can't resolve becomes an open question.` }) : null,
      pending.length ? h('div', { class: 'pb-modal__warn', text: `Your ${pending.length} queued item${pending.length === 1 ? '' : 's'} will be sent along with the approval.` }) : null,
      note,
      h('div', { class: 'pb-modal__row' }, h('button', { class: 'pb-btn', type: 'button', text: 'Cancel', onclick: () => close() }),
        h('button', { class: 'pb-btn pb-btn--primary', type: 'button', text: 'Approve and send', onclick: () => { close(); sendAll([{ kind: 'approve', key: 'approve', output: pick, text: note.value.trim() || undefined }]); } })));
    close = showModal(form, $('input:checked', form));
  }
  function confirmEnd(opener) {
    let close = null;
    const keep = h('button', { class: 'pb-btn', type: 'button', text: 'Keep reviewing', onclick: () => close() });
    close = showModal(h('div', { class: 'pb-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pb-end-h' },
      h('h2', { id: 'pb-end-h', text: 'End this review?' }),
      h('p', { text: `The page becomes read-only and the agent stops waiting for you. ${queue.length ? `Your ${queue.length} queued item${queue.length === 1 ? '' : 's'} will be sent first.` : ''}` }),
      h('div', { class: 'pb-modal__row' }, keep, h('button', { class: 'pb-btn pb-btn--primary', type: 'button', text: 'End review', onclick: () => { close(); sendAll([{ kind: 'end', key: 'end' }]); } }))), keep, opener);
  }

  // ---------- component enhancements ----------
  function enhance() {
    for (const pre of $$('#pb-doc pre.pb-diff:not([data-pb-done])')) {
      pre.setAttribute('data-pb-done', '');
      const lines = pre.textContent.replace(/\n$/, '').split('\n');
      pre.innerHTML = lines.map((l) => `<span class="${l.startsWith('+') ? 'pb-diff__add' : l.startsWith('-') ? 'pb-diff__del' : l.startsWith('@@') ? 'pb-diff__hunk' : ''}">${esc(l) || ' '}</span>`).join('');
    }
    for (const t of $$('#pb-doc .pb-tabs:not(.is-ready)')) {
      const panes = $$(':scope > [data-tab]', t); if (!panes.length) continue;
      const bar = h('div', { class: 'pb-tabs__bar', role: 'tablist' });
      const show = (i) => { panes.forEach((p, k) => p.classList.toggle('is-active', k === i)); $$('button', bar).forEach((b, k) => b.setAttribute('aria-selected', String(k === i))); };
      panes.forEach((p, i) => bar.append(h('button', { type: 'button', role: 'tab', text: p.getAttribute('data-tab'), onclick: () => show(i) })));
      t.prepend(bar); t.classList.add('is-ready'); show(Math.max(0, panes.findIndex((p) => p.hasAttribute('data-default'))));
    }
    for (const f of $$('#pb-doc figure.pb-code:not([data-pb-done])')) {
      f.setAttribute('data-pb-done', '');
      const cap = $(':scope > figcaption', f); const pre = $(':scope > pre', f);
      if (cap && pre) { const b = copyBtn(() => pre.textContent); b.style.marginLeft = 'auto'; cap.append(b); }
    }
    let n = $$('#pb-doc .pb-diagram.is-rendered').length;
    for (const el of $$('#pb-doc .pb-diagram:not(.is-rendered)')) safe(renderDiagram, el, `dg${++n}`);
  }

  // ---------- diagrams (Mermaid-style subset, rendered offline) ----------
  let mctx = null, fontFam = null;
  function tw(text, size = 13, weight = 400) {
    if (!mctx) { mctx = document.createElement('canvas').getContext('2d'); fontFam = getComputedStyle(document.body).fontFamily; }
    mctx.font = `${weight} ${size}px ${fontFam}`; return mctx.measureText(text).width;
  }
  function wrapLines(text, maxW, size = 13, weight = 400) {
    const out = [];
    for (const para of String(text).split('\n')) {
      const words = para.split(/\s+/).filter(Boolean); let line = '';
      for (const w of words) { const t = line ? line + ' ' + w : w; if (tw(t, size, weight) > maxW && line) { out.push(line); line = w; } else line = t; }
      out.push(line);
    }
    return out.length ? out : [''];
  }
  const svgText = (lines, x, y, lh, cls = '') => `<text class="${cls}" x="${x}" y="${y - ((lines.length - 1) * lh) / 2}" text-anchor="middle" dominant-baseline="central">${lines.map((l, i) => `<tspan x="${x}" dy="${i ? lh : 0}">${esc(l)}</tspan>`).join('')}</text>`;

  function renderDiagram(el, dgId) {
    // A literal <br> inside <pre> is parsed as an element; turn it back into text so labels keep their line breaks.
    for (const br of $$('br', el)) br.replaceWith('<br>');
    const src = (el.getAttribute('data-src') || el.textContent).replace(/^\s*\n/, '').replace(/\s+$/, '');
    const baseId = el.getAttribute('data-pb-id') || dgId;
    const caption = el.getAttribute('data-caption');
    let svg;
    try {
      const first = src.split('\n').find((l) => l.trim() && !l.trim().startsWith('%%')) || '';
      if (/^\s*sequenceDiagram/i.test(first)) svg = seqSvg(parseSeq(src), baseId);
      else svg = flowSvg(parseFlow(src), baseId);
    } catch (e) {
      el.classList.add('is-rendered');
      el.innerHTML = `<div class="pb-diagram__error">Diagram error: ${esc(e.message)}</div><pre><code>${esc(src)}</code></pre>`;
      return;
    }
    const fig = h('figure', { class: 'pb-diagram is-rendered', 'data-src': src, html: svg + (caption ? `<figcaption>${esc(caption)}</figcaption>` : '') });
    for (const a of el.attributes) if (!['class', 'data-src'].includes(a.name)) fig.setAttribute(a.name, a.value);
    fig.className = (el.className + ' is-rendered').trim();
    if (!fig.hasAttribute('data-pb-id')) fig.setAttribute('data-pb-id', baseId);
    if (!fig.hasAttribute('data-pb-kind')) fig.setAttribute('data-pb-kind', 'diagram');
    if (!fig.hasAttribute('data-pb-label')) fig.setAttribute('data-pb-label', caption || `diagram ${baseId}`);
    // A bar above every diagram: a note (scroll hint, what changed) and the Expand button.
    fig.prepend(h('div', { class: 'pb-diagram__bar' }, h('span', { class: 'pb-diagram__note' }),
      h('button', { class: 'pb-btn pb-btn--ghost pb-btn--sm pb-diagram__expand', type: 'button', title: 'Show the diagram full screen (or double-click it)', html: ICON.expand + 'Expand', onclick: () => expandDiagram(fig) })));
    fig.addEventListener('dblclick', (e) => { if (!e.target.closest('button') && !fig.closest('.pb-zoom')) expandDiagram(fig); });
    el.replaceWith(fig);
    fitDiagram(fig);
  }
  function diagramNote(fig, ...content) { const n = $(':scope > .pb-diagram__bar > .pb-diagram__note', fig); if (n) n.replaceChildren(...content); }
  function fitDiagram(fig) {
    const svg = $(':scope > svg', fig); if (!svg) return;
    svg.style.width = ''; svg.style.maxWidth = ''; fig.classList.remove('is-scroll'); fig.removeAttribute('title');
    const nat = Number(svg.getAttribute('width')) || 0; const avail = fig.clientWidth - 30;
    if (!avail || nat <= avail) { svg.style.maxWidth = '100%'; return; }
    if (nat <= avail * 1.18) { svg.style.width = '100%'; svg.style.maxWidth = '100%'; return; }
    svg.style.maxWidth = 'none'; fig.classList.add('is-scroll'); fig.title = 'Scroll sideways, or press Expand to see the whole diagram';
    if (!fig.classList.contains('pb-changed')) diagramNote(fig, 'Wider than the page: scroll sideways, or Expand →');
  }
  // Full-screen view of one diagram. The real figure moves into the overlay (inside the page), so its
  // comment targets, Δ marks and keyboard focus keep working; it moves back on close.
  function expandDiagram(fig) {
    if ($('#pb-zoom')) return;
    const svg = $(':scope > svg', fig); if (!svg) return;
    const opener = document.activeElement;
    const holder = h('div', { class: 'pb-diagram-holder', style: `height:${fig.offsetHeight}px` });
    fig.replaceWith(holder);
    const nat = Number(svg.getAttribute('width')) || 600;
    const vb = svg.viewBox && svg.viewBox.baseVal; const natH = vb && vb.width ? nat * (vb.height / vb.width) : nat * 0.6;
    const body = h('div', { class: 'pb-zoom__body' });
    const pct = h('span', { class: 'pb-zoom__pct', 'aria-live': 'polite' });
    let z = 1;
    const apply = (nz) => { z = Math.max(0.25, Math.min(3, nz)); svg.style.width = Math.round(nat * z) + 'px'; svg.style.maxWidth = 'none'; pct.textContent = `${Math.round(z * 100)}%`; if (hoverEl) hideHoverBar(); };
    const fitZ = () => { const r = body.getBoundingClientRect(); return Math.min((r.width - 48) / nat, (r.height - 48) / natH); };
    const btn = (label, title, fn, cls = '') => h('button', { class: `pb-btn pb-btn--sm ${cls}`, type: 'button', title, html: label, onclick: fn });
    const title = fig.getAttribute('data-caption') || fig.getAttribute('data-pb-label') || 'Diagram';
    let close;
    const closeBtn = btn('Close', 'Close (Esc)', () => close(), 'pb-btn--primary');
    const box = h('div', { class: 'pb-zoom', id: 'pb-zoom', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Diagram: ${title}` },
      h('div', { class: 'pb-zoom__head' },
        h('b', { class: 'pb-zoom__title', text: title }),
        h('span', { class: 'pb-zoom__help', text: isEnded() ? 'Drag or scroll to move around.' : 'Drag or scroll to move around. Hover or Tab to a part to comment on it.' }),
        h('span', { class: 'pb-zoom__tools' },
          btn('−', 'Zoom out', () => apply(z / 1.25)), pct, btn('+', 'Zoom in', () => apply(z * 1.25)),
          btn('Fit', 'Fit the whole diagram on screen', () => apply(fitZ())), btn('100%', 'Actual size', () => apply(1)), closeBtn)),
      body);
    fig.classList.add('is-zoomed');
    body.append(fig);
    $('#pb-doc').append(box);
    document.documentElement.classList.add('pb-modal-open');
    apply(Math.min(1.5, Math.max(fitZ(), 0.75)));
    // drag the background to pan
    let drag = null;
    body.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse' || e.button !== 0 || e.target.closest('[data-pb-id]:not(figure), button, a')) return; drag = { x: e.clientX, y: e.clientY, l: body.scrollLeft, t: body.scrollTop }; body.setPointerCapture(e.pointerId); body.classList.add('is-dragging'); });
    body.addEventListener('pointermove', (e) => { if (!drag) return; body.scrollLeft = drag.l - (e.clientX - drag.x); body.scrollTop = drag.t - (e.clientY - drag.y); });
    const endDrag = () => { drag = null; body.classList.remove('is-dragging'); };
    body.addEventListener('pointerup', endDrag); body.addEventListener('pointercancel', endDrag);
    body.addEventListener('scroll', () => { if (hoverEl) showHoverBar(hoverEl); }, { passive: true });
    body.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); apply(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); } }, { passive: false });
    const onKey = (e) => {
      if (e.key === 'Escape' && !pop) { e.preventDefault(); e.stopPropagation(); close(); }
      else if (!e.target.closest('input, textarea') && (e.key === '+' || e.key === '=')) apply(z * 1.25);
      else if (!e.target.closest('input, textarea') && e.key === '-') apply(z / 1.25);
    };
    // keep keyboard focus in the overlay (the comment box and its button live outside it)
    const onFocus = (e) => { if (!box.contains(e.target) && !(pop && pop.contains(e.target)) && !hoverBar.contains(e.target)) closeBtn.focus(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    close = () => {
      document.removeEventListener('keydown', onKey, true); document.removeEventListener('focusin', onFocus);
      hideHoverBar(); closePop();
      fig.classList.remove('is-zoomed'); holder.replaceWith(fig); box.remove();
      document.documentElement.classList.remove('pb-modal-open');
      fitDiagram(fig);
      const back = opener && document.contains(opener) ? opener : $('.pb-diagram__expand', fig); back?.focus();
    };
    closeBtn.focus();
  }

  function flowSvg(G, dg) {
    const horiz = G.dir === 'LR' || G.dir === 'RL';
    const N = [...G.nodes.values()];
    const all = new Map(N.map((n) => [n.id, n]));
    const byId = (id) => all.get(id);
    for (const n of N) {
      n.lines = wrapLines(n.label, horiz ? 170 : 190, 13.5);
      const w = Math.max(...n.lines.map((l) => tw(l, 13.5)));
      let W = Math.max(w + 28, 64), H = n.lines.length * 18 + 18;
      if (n.shape === 'diamond') { W = W * 1.3 + 16; H = H * 1.45 + 10; }
      if (n.shape === 'circle') { W = H = Math.max(W, H, 54); }
      if (n.shape === 'db') H += 14;
      if (n.shape === 'hex' || n.shape === 'para' || n.shape === 'flag') W += 22;
      n.w = W; n.h = H;
    }
    // 1. break cycles (DFS back edges are reversed for layering only)
    const E = G.edges.map((e) => ({ ...e }));
    const adj = new Map(N.map((n) => [n.id, []])); E.forEach((e, i) => adj.get(e.from).push(i));
    const vis = new Set(), onst = new Set();
    const dfs = (v) => { vis.add(v); onst.add(v); for (const i of adj.get(v)) { const e = E[i]; if (e.from === e.to) { e.self = true; continue; } if (onst.has(e.to)) e.rev = true; else if (!vis.has(e.to)) dfs(e.to); } onst.delete(v); };
    N.forEach((n) => { if (!vis.has(n.id)) dfs(n.id); });
    const DE = E.filter((e) => !e.self).map((e) => (e.rev ? { u: e.to, v: e.from, e } : { u: e.from, v: e.to, e }));
    const succ = new Map(N.map((n) => [n.id, []])), pred = new Map(N.map((n) => [n.id, []]));
    DE.forEach((d) => { succ.get(d.u).push(d.v); pred.get(d.v).push(d.u); });
    // 2. layers: sources as late as possible, everything else as early as possible after them
    const topo = []; { const indeg = new Map(N.map((n) => [n.id, pred.get(n.id).length])); const q = N.filter((n) => !indeg.get(n.id)).map((n) => n.id); while (q.length) { const u = q.shift(); topo.push(u); for (const v of succ.get(u)) { indeg.set(v, indeg.get(v) - 1); if (!indeg.get(v)) q.push(v); } } }
    const toSink = new Map(); for (const u of [...topo].reverse()) toSink.set(u, Math.max(0, ...succ.get(u).map((v) => toSink.get(v) + 1)));
    const maxL = Math.max(0, ...toSink.values());
    const layer = new Map();
    for (const u of topo) layer.set(u, pred.get(u).length ? Math.max(...pred.get(u).map((p) => layer.get(p) + 1)) : maxL - toSink.get(u));
    // sinks hug their latest predecessor
    for (const u of topo) if (!succ.get(u).length && pred.get(u).length) layer.set(u, Math.max(...pred.get(u).map((p) => layer.get(p) + 1)));
    { const mn = Math.min(...layer.values()); for (const [k, v] of layer) layer.set(k, v - mn); }
    N.forEach((n) => (n.layer = layer.get(n.id)));
    // 3. dummy nodes so long edges get their own lane
    const chains = new Map(); let dn = 0;
    const OE = []; // ordering edges between consecutive layers
    for (const d of DE) {
      const lu = layer.get(d.u), lv = layer.get(d.v);
      let prev = d.u; const ds = [];
      for (let l = lu + 1; l < lv; l++) {
        const id = `\u0001d${dn++}`; const dm = { id, dummy: true, w: horiz ? 8 : 8, h: 8, layer: l, group: null, order: 1e6 + dn };
        all.set(id, dm); ds.push(dm); OE.push([prev, id]); prev = id;
      }
      OE.push([prev, d.v]);
      chains.set(d.e, ds);
    }
    const nodesAll = [...all.values()];
    const L = []; nodesAll.forEach((n) => (L[n.layer] = L[n.layer] || []).push(n));
    for (let i = 0; i < L.length; i++) L[i] = L[i] || [];
    L.forEach((a) => a.sort((x, y) => x.order - y.order));
    const pos = new Map(); L.forEach((a) => a.forEach((n, i) => pos.set(n.id, i)));
    const up = new Map(nodesAll.map((n) => [n.id, []])), down = new Map(nodesAll.map((n) => [n.id, []]));
    OE.forEach(([a, b]) => { down.get(a).push(b); up.get(b).push(a); });
    const gkey = (n) => (n.group ? n.group.id : null);
    // 4. ordering: barycenter sweeps, keeping subgraph members together
    const crossings = () => { let c = 0; for (let l = 0; l < L.length - 1; l++) { const es = []; for (const n of L[l]) for (const v of down.get(n.id)) es.push([pos.get(n.id), pos.get(v)]); for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) if ((es[i][0] - es[j][0]) * (es[i][1] - es[j][1]) < 0) c++; } return c; };
    let best = { c: crossings(), order: L.map((a) => a.slice()) };
    for (let it = 0; it < 12; it++) {
      const goingDown = it % 2 === 0;
      for (const a of goingDown ? L : [...L].reverse()) {
        for (const n of a) { const ref = goingDown ? up.get(n.id) : down.get(n.id); n.bary = ref.length ? ref.reduce((s, v) => s + pos.get(v), 0) / ref.length : pos.get(n.id); }
        const gb = new Map(); for (const n of a) if (gkey(n)) { const g = gb.get(gkey(n)) || { s: 0, c: 0 }; g.s += n.bary; g.c++; gb.set(gkey(n), g); }
        const key = (n) => (gkey(n) ? gb.get(gkey(n)).s / gb.get(gkey(n)).c : n.bary);
        a.sort((x, y) => key(x) - key(y) || (gkey(x) === gkey(y) ? x.bary - y.bary : 0) || x.order - y.order);
        a.forEach((n, i) => pos.set(n.id, i));
      }
      const c = crossings(); if (c < best.c) best = { c, order: L.map((a) => a.slice()) };
    }
    best.order.forEach((a, l) => { L[l] = a; a.forEach((n, i) => pos.set(n.id, i)); });
    // 5. coordinates
    const labelW = Math.max(0, ...E.filter((e) => e.label).map((e) => Math.min(tw(e.label, 12), 160) + 16));
    const layerGap = horiz ? Math.max(56, Math.min(labelW + 28, 190)) : (labelW ? 62 : 44);
    const nodeGap = horiz ? 22 : (labelW ? Math.max(30, Math.min(labelW - 40, 110)) : 30); const gpad = G.groups.length ? 16 : 0;
    const mainSz = (n) => (horiz ? n.w : n.h), crossSz = (n) => (horiz ? n.h : n.w);
    // subgraph frames: each nesting level adds GPAD around its members, plus GTITLE on top for the title
    const GPAD = 14, GTITLE = 18;
    const memberOf = (n, g) => { for (let x = n.group; x; x = x.parent) if (x === g) return true; return false; };
    const gDepth = (g) => { let d = 0; for (let x = g.parent; x; x = x.parent) d++; return d; };
    const nestBelow = (g) => Math.max(0, ...G.groups.filter((c) => c.parent === g).map((c) => 1 + nestBelow(c)));
    const before = [], after = [];
    for (const g of G.groups) {
      const ls = nodesAll.filter((n) => !n.dummy && memberOf(n, g)).map((n) => n.layer); if (!ls.length) continue;
      const lv = nestBelow(g) + 1, l0 = Math.min(...ls), l1 = Math.max(...ls);
      const titleSide = horiz ? 0 : (GPAD + GTITLE) * lv, plainSide = GPAD * lv;
      const startRoom = G.dir === 'BT' ? plainSide : horiz ? plainSide : titleSide, endRoom = G.dir === 'BT' ? titleSide : plainSide;
      before[l0] = Math.max(before[l0] || 0, startRoom - layerGap / 2 + 8);
      after[l1] = Math.max(after[l1] || 0, endRoom - layerGap / 2 + 8);
    }
    let acc = 0; const LM = L.map((a, l) => { acc += Math.max(0, before[l] || 0); const sz = Math.max(8, ...a.map(mainSz)); const r = { start: acc, size: sz }; acc += sz + layerGap + Math.max(0, after[l] || 0); return r; });
    const gapOf = (p, n) => (p.dummy && n.dummy ? nodeGap * 0.6 : nodeGap) + (gkey(p) !== gkey(n) ? gpad * 2 : 0);
    const place = (a) => { let prevEnd = 0, prev = null; for (const n of a) { const half = crossSz(n) / 2; const lower = prev ? prevEnd + gapOf(prev, n) + half : -Infinity; n.c = Math.max(n.want ?? (prev ? lower : half), lower); prevEnd = n.c + half; prev = n; } };
    L.forEach((a) => { a.forEach((n) => (n.want = undefined)); place(a); const mid = a.length ? (a[0].c + a[a.length - 1].c) / 2 : 0; a.forEach((n) => (n.c -= mid)); });
    for (let it = 0; it < 10; it++) {
      for (const a of it % 2 ? [...L].reverse() : L) {
        for (const n of a) { const ref = [...up.get(n.id), ...down.get(n.id)]; n.want = ref.length ? ref.reduce((s, v) => s + byId(v).c, 0) / ref.length : n.c; }
        place(a);
        const shift = a.reduce((s, n) => s + (n.want - n.c), 0) / (a.length || 1);
        a.forEach((n) => (n.c += shift));
      }
    }
    // keep outsiders (and edge lanes) out of each subgraph's box, which spans every layer its members are on
    for (const g of [...G.groups].sort((a, b) => gDepth(b) - gDepth(a))) {
      const mem = nodesAll.filter((n) => memberOf(n, g)); if (!mem.length) continue;
      const lv = nestBelow(g) + 1;
      const lo = Math.min(...mem.map((n) => n.c - crossSz(n) / 2)) - GPAD * lv - (horiz ? GTITLE * lv : 0) - 6, hi = Math.max(...mem.map((n) => n.c + crossSz(n) / 2)) + GPAD * lv + 6;
      for (let l = Math.min(...mem.map((n) => n.layer)); l <= Math.max(...mem.map((n) => n.layer)); l++) {
        const a = L[l]; const mi = a.map((n, i) => (memberOf(n, g) ? i : -1)).filter((i) => i >= 0);
        const isAfter = (n, i) => (mi.length ? i > mi[mi.length - 1] : n.c >= (lo + hi) / 2);
        let min = hi;
        a.forEach((n, i) => { if (!isAfter(n, i)) return; const half = crossSz(n) / 2; n.c = Math.max(n.c, min + half); min = n.c + half + nodeGap; });
        let max = lo;
        for (let i = a.length - 1; i >= 0; i--) { const n = a[i]; if (memberOf(n, g) || isAfter(n, i)) continue; const half = crossSz(n) / 2; n.c = Math.min(n.c, max - half); max = n.c - half - nodeGap; }
      }
    }
    for (const n of nodesAll) { const lm = LM[n.layer]; const mc = lm.start + lm.size / 2; if (horiz) { n.x = mc; n.y = n.c; } else { n.x = n.c; n.y = mc; } }
    if (G.dir === 'RL') nodesAll.forEach((n) => (n.x = -n.x));
    if (G.dir === 'BT') nodesAll.forEach((n) => (n.y = -n.y));
    // 6. subgraph boxes
    // innermost first, so each frame wraps its child frames (and their titles) instead of overlapping them
    const GBm = new Map();
    for (const g of [...G.groups].sort((a, b) => gDepth(b) - gDepth(a))) {
      const mem = N.filter((n) => memberOf(n, g)); if (!mem.length) continue;
      let x1 = Math.min(...mem.map((n) => n.x - n.w / 2)), y1 = Math.min(...mem.map((n) => n.y - n.h / 2)), x2 = Math.max(...mem.map((n) => n.x + n.w / 2)), y2 = Math.max(...mem.map((n) => n.y + n.h / 2));
      for (const c of G.groups) if (c.parent === g && GBm.has(c)) { const b = GBm.get(c); x1 = Math.min(x1, b.x1); y1 = Math.min(y1, b.y1); x2 = Math.max(x2, b.x2); y2 = Math.max(y2, b.y2); }
      GBm.set(g, { g, x1: x1 - GPAD, y1: y1 - GPAD - GTITLE, x2: x2 + GPAD, y2: y2 + GPAD, d: gDepth(g) });
    }
    const GB = [...GBm.values()].sort((a, b) => a.d - b.d);
    // 7. edges: through their dummy lane, smooth curves
    const side = (n, towards) => {
      if (horiz) { const r = towards.x >= n.x; return [n.x + (r ? 1 : -1) * n.w / 2 * (n.dummy ? 0 : 1), n.y]; }
      const d = towards.y >= n.y; return [n.x, n.y + (d ? 1 : -1) * n.h / 2 * (n.dummy ? 0 : 1)];
    };
    const curve = (pts) => {
      let d = `M${pts[0][0]},${pts[0][1]}`;
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        if (horiz) { const dx = (x1 - x0) / 2; d += ` C${x0 + dx},${y0} ${x1 - dx},${y1} ${x1},${y1}`; }
        else { const dy = (y1 - y0) / 2; d += ` C${x0},${y0 + dy} ${x1},${y1 - dy} ${x1},${y1}`; }
      }
      return d;
    };
    const paths = [];
    const pairKey = (x, y) => x + '\u0002' + y;
    const pairs = new Set(E.filter((e) => !e.self).map((e) => pairKey(e.from, e.to)));
    // labels of a fan-out sit near the targets (where the edges are spread apart), of a fan-in near the source
    const labOut = new Map(), labIn = new Map();
    for (const e of E) if (e.label && !e.self) { labOut.set(e.from, (labOut.get(e.from) || 0) + 1); labIn.set(e.to, (labIn.get(e.to) || 0) + 1); }
    for (const e of E) {
      const a = byId(e.from), b = byId(e.to); let d, mid;
      if (e.self) {
        const x = a.x, y = horiz ? a.y - a.h / 2 : a.y; const xr = a.x + a.w / 2;
        d = horiz ? `M${x - 10},${y} C${x - 22},${y - 34} ${x + 22},${y - 34} ${x + 10},${y}` : `M${xr},${y - 8} C${xr + 34},${y - 22} ${xr + 34},${y + 22} ${xr},${y + 8}`;
        mid = horiz ? [x, y - 30] : [xr + 30, y];
      } else if (a.layer === b.layer) {
        const [x1, y1] = horiz ? [a.x + a.w / 2, a.y] : [a.x, a.y + a.h / 2]; const [x2, y2] = horiz ? [b.x + b.w / 2, b.y] : [b.x, b.y + b.h / 2];
        const bulge = 36;
        d = horiz ? `M${x1},${y1} C${x1 + bulge},${y1} ${x2 + bulge},${y2} ${x2},${y2}` : `M${x1},${y1} C${x1},${y1 + bulge} ${x2},${y2 + bulge} ${x2},${y2}`;
        mid = horiz ? [Math.max(x1, x2) + bulge * 0.75, (y1 + y2) / 2] : [(x1 + x2) / 2, Math.max(y1, y2) + bulge * 0.75];
      } else {
        const lane = chains.get(e) || [];
        const seq = e.rev ? [b, ...lane, a] : [a, ...lane, b];
        const pts = seq.map((n, i) => (i === 0 ? side(n, seq[1]) : i === seq.length - 1 ? side(n, seq[i - 1]) : [n.x, n.y]));
        if (e.rev) pts.reverse();
        if (pairs.has(pairKey(e.to, e.from))) { const off = (e.from < e.to ? 1 : -1) * 9; for (const pt of pts) pt[horiz ? 1 : 0] += off; }
        d = curve(pts);
        const two = pts.length === 2;
        const k = two ? 0 : Math.floor((pts.length - 1) / 2);
        const t = !two ? 0.5 : (labOut.get(e.from) || 0) >= 3 ? 0.78 : (labIn.get(e.to) || 0) >= 3 ? 0.22 : 0.55;
        const [p0, p1] = [pts[k], pts[k + 1]];
        mid = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
        // keep the label inside the gap between the two layers, clear of both nodes, and on its own edge
        if (e.label) {
          const ax = horiz ? 0 : 1; const lines = wrapLines(e.label, 160, 12);
          const half = (horiz ? Math.max(...lines.map((l) => tw(l, 12))) + 10 : lines.length * 15 + 4) / 2 + 3;
          const lo = Math.min(p0[ax], p1[ax]) + half, hi = Math.max(p0[ax], p1[ax]) - half;
          mid[ax] = lo <= hi ? Math.min(Math.max(mid[ax], lo), hi) : (p0[ax] + p1[ax]) / 2;
          const f = p1[ax] === p0[ax] ? 0.5 : (mid[ax] - p0[ax]) / (p1[ax] - p0[ax]);
          mid[1 - ax] = p0[1 - ax] + (p1[1 - ax] - p0[1 - ax]) * f;
        }
      }
      paths.push({ e, d, mid });
    }
    // nudge edge labels apart so they don't sit on top of each other
    const lab = paths.filter((p) => p.e.label).map((p) => { const lines = wrapLines(p.e.label, 160, 12); return { p, w: Math.max(...lines.map((l) => tw(l, 12))) + 10, h: lines.length * 15 + 4 }; });
    {
      const k = horiz ? 1 : 0, size = (L) => (k ? L.h : L.w), other = (L) => (k ? L.w : L.h);
      lab.sort((A, B) => A.p.mid[k] - B.p.mid[k]);
      for (let i = 1; i < lab.length; i++) for (let j = 0; j < i; j++) {
        const A = lab[j], B = lab[i];
        if (Math.abs(A.p.mid[1 - k] - B.p.mid[1 - k]) >= (other(A) + other(B)) / 2 + 2) continue;
        const need = A.p.mid[k] + (size(A) + size(B)) / 2 + 4;
        if (B.p.mid[k] < need) { B.p.mid = [...B.p.mid]; B.p.mid[k] = need; }
      }
    }
    // 8. bounds + svg
    const xs = [], ys = [];
    nodesAll.forEach((n) => { xs.push(n.x - n.w / 2, n.x + n.w / 2); ys.push(n.y - n.h / 2, n.y + n.h / 2); });
    GB.forEach((b) => { xs.push(b.x1, b.x2); ys.push(b.y1, b.y2); });
    paths.forEach((p) => { if (p.e.label) { const w = Math.min(tw(p.e.label, 12), 160) + 12; xs.push(p.mid[0] - w / 2, p.mid[0] + w / 2); ys.push(p.mid[1] - 12, p.mid[1] + 12); } if (p.e.self) { xs.push(p.mid[0] + 12); ys.push(p.mid[1] + 12, p.mid[1] - 12); } });
    const pad = 12; const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad, W = Math.max(...xs) + pad - minX, H = Math.max(...ys) + pad - minY;
    const uid = dg + '-' + Math.random().toString(36).slice(2, 7);
    const out = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${W} ${H}" width="${Math.ceil(W)}" data-natural-width="${Math.ceil(W)}" role="img" aria-label="Diagram">`);
    out.push(`<defs><marker id="${uid}-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0.5 L10,5 L0,9.5 z" class="pbd-arrow"/></marker><marker id="${uid}-t" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4.2" markerHeight="4.2" orient="auto-start-reverse"><path d="M0,0.5 L10,5 L0,9.5 z" class="pbd-arrow"/></marker><marker id="${uid}-x" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="9" markerHeight="9" orient="auto"><path d="M1,1 L9,9 M9,1 L1,9" class="pbd-xmark"/></marker></defs>`);
    for (const b of GB) out.push(`<g class="pbd-group" data-pb-id="${esc(dg)}:${esc(b.g.id)}" data-pb-kind="diagram group" data-pb-label="${esc(b.g.title)}"><rect x="${b.x1}" y="${b.y1}" width="${b.x2 - b.x1}" height="${b.y2 - b.y1}" rx="10"/><text x="${b.x1 + 10}" y="${b.y1 + 15}">${esc(b.g.title)}</text></g>`);
    for (const p of paths) {
      const cls = ['pbd-edge', p.e.dashed && 'is-dashed', p.e.thick && 'is-thick'].filter(Boolean).join(' ');
      const mk = `url(#${uid}-${p.e.thick ? 't' : 'a'})`;
      out.push(`<path class="${cls}" d="${p.d}"${p.e.arrow ? ` marker-end="${mk}"` : p.e.cross ? ` marker-end="url(#${uid}-x)"` : ''}${p.e.back ? ` marker-start="${mk}"` : ''}/>`);
    }
    for (const p of paths) if (p.e.label) {
      const lines = wrapLines(p.e.label, 160, 12); const w = Math.max(...lines.map((l) => tw(l, 12))) + 10, hh = lines.length * 15 + 4;
      out.push(`<g class="pbd-label"><rect x="${p.mid[0] - w / 2}" y="${p.mid[1] - hh / 2}" width="${w}" height="${hh}" rx="3"/>${svgText(lines, p.mid[0], p.mid[1], 15)}</g>`);
    }
    for (const n of N) {
      const x = n.x - n.w / 2, y = n.y - n.h / 2, w = n.w, hh = n.h;
      let shape;
      switch (n.shape) {
        case 'round': shape = `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="12"/>`; break;
        case 'stadium': shape = `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="${hh / 2}"/>`; break;
        case 'circle': shape = `<circle cx="${n.x}" cy="${n.y}" r="${w / 2}"/>`; break;
        case 'diamond': shape = `<polygon points="${n.x},${y} ${x + w},${n.y} ${n.x},${y + hh} ${x},${n.y}"/>`; break;
        case 'hex': shape = `<polygon points="${x + 12},${y} ${x + w - 12},${y} ${x + w},${n.y} ${x + w - 12},${y + hh} ${x + 12},${y + hh} ${x},${n.y}"/>`; break;
        case 'para': shape = `<polygon points="${x + 12},${y} ${x + w},${y} ${x + w - 12},${y + hh} ${x},${y + hh}"/>`; break;
        case 'flag': shape = `<polygon points="${x},${y} ${x + w},${y} ${x + w - 12},${n.y} ${x + w},${y + hh} ${x},${y + hh}"/>`; break;
        case 'db': { const ry = 7; shape = `<path d="M${x},${y + ry} A${w / 2},${ry} 0 0 1 ${x + w},${y + ry} V${y + hh - ry} A${w / 2},${ry} 0 0 1 ${x},${y + hh - ry} Z"/><path d="M${x},${y + ry} A${w / 2},${ry} 0 0 0 ${x + w},${y + ry}" style="fill:none"/>`; break; }
        case 'sub': shape = `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="3"/><path d="M${x + 8},${y} V${y + hh} M${x + w - 8},${y} V${y + hh}" style="fill:none"/>`; break;
        default: shape = `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="5"/>`;
      }
      const cls = n.cls.map((c) => 'c-' + c).join(' ');
      out.push(`<g class="pbd-node ${cls}" data-pb-id="${esc(dg)}:${esc(n.id)}" data-pb-kind="diagram node" data-pb-label="${esc(n.label.replace(/\n/g, ' '))}">${shape}${svgText(n.lines, n.x, n.y + (n.shape === 'db' ? 4 : 0), 18)}</g>`);
    }
    out.push('</svg>');
    return out.join('');
  }

  function seqSvg(D, dg) {
    const P = D.P; const idx = new Map(P.map((p, i) => [p.id, i]));
    P.forEach((p) => { p.lines = wrapLines(p.label, 150, 13, 600); p.w = Math.max(84, Math.max(...p.lines.map((l) => tw(l, 13, 600))) + 26); p.h = p.lines.length * 17 + 16; });
    const headH = Math.max(...P.map((p) => p.h));
    const gaps = P.slice(1).map((p, i) => P[i].w / 2 + p.w / 2 + 28);
    const MAXW = 300;
    for (const r of D.rows) {
      if (r.t === 'msg') {
        const a = idx.get(r.from), b = idx.get(r.to);
        r.lines = wrapLines(r.text, MAXW, 13); const need = Math.max(...r.lines.map((l) => tw(l, 13))) + (D.auto ? 50 : 30);
        if (a === b) { if (a < gaps.length) gaps[a] = Math.max(gaps[a], need + 30); }
        else { const lo = Math.min(a, b), hi = Math.max(a, b); const cur = gaps.slice(lo, hi).reduce((s, g) => s + g, 0); if (cur < need) for (let i = lo; i < hi; i++) gaps[i] += (need - cur) / (hi - lo); }
      } else if (r.t === 'note') {
        r.lines = wrapLines(r.text, 220, 12); r.w = Math.max(...r.lines.map((l) => tw(l, 12))) + 20;
        const is = r.ps.map((p) => idx.get(p)); const lo = Math.min(...is), hi = Math.max(...is);
        if (r.where === 'over' && hi > lo) { const cur = gaps.slice(lo, hi).reduce((s, g) => s + g, 0); if (cur < r.w - 20) for (let i = lo; i < hi; i++) gaps[i] += (r.w - 20 - cur) / (hi - lo); }
        if (r.where === 'right of' && lo < gaps.length) gaps[lo] = Math.max(gaps[lo], r.w + 30);
        if (r.where === 'left of' && lo > 0) gaps[lo - 1] = Math.max(gaps[lo - 1], r.w + 30);
      } else if (r.t === 'start' || r.t === 'else') r.lines = r.label ? [r.label] : [];
    }
    const X = [0]; gaps.forEach((g, i) => X.push(X[i] + g));
    // notes can stick out past the first/last participant: measure them the same way they are drawn below
    const noteX = (r) => { const is = r.ps.map((p) => X[idx.get(p)]); const lo = Math.min(...is), hi = Math.max(...is); if (r.where === 'over') { const w = Math.max(r.w, hi - lo + 40); return [(lo + hi) / 2 - w / 2, (lo + hi) / 2 + w / 2]; } return r.where === 'right of' ? [lo + 14, lo + 14 + r.w] : [lo - 14 - r.w, lo - 14]; };
    const notes = D.rows.filter((r) => r.t === 'note').map(noteX);
    const left = Math.min(-P[0].w / 2, ...notes.map((n) => n[0] - 6)) - 30;
    const right = Math.max(X[X.length - 1] + P[P.length - 1].w / 2, ...notes.map((n) => n[1] + 6), ...D.rows.filter((r) => r.t === 'msg' && r.from === r.to).map((r) => X[idx.get(r.from)] + Math.max(...r.lines.map((l) => tw(l, 12.5))) + 50)) + 30;
    const out = []; let y = headH + 22; let num = 0; const frames = []; const fdraw = []; const uid = dg + '-' + Math.random().toString(36).slice(2, 7);
    const body = [];
    D.rows.forEach((r, ri) => {
      if (r.t === 'msg') {
        const a = X[idx.get(r.from)], b = X[idx.get(r.to)]; const lh = 15; const tH = r.lines.length * lh;
        y += tH + 6;
        const cls = `pbd-msg${r.dashed ? ' is-dashed' : ''}`;
        const tid = `${dg}:m${ri + 1}`;
        if (a === b) {
          const tx = a + 14; body.push(`<g data-pb-id="${esc(tid)}" data-pb-kind="message" data-pb-label="${esc(r.text)}">`);
          r.lines.forEach((l, i) => body.push(`<text class="pbd-msgtext" x="${tx + 8}" y="${y - tH + i * lh + 4}">${esc(l)}</text>`));
          body.push(`<path class="${cls}" d="M${a},${y} H${a + 36} V${y + 22} H${a + 2}"${!r.open ? ` marker-end="url(#${uid}-a)"` : ''}/></g>`);
          if (D.auto) body.push(`<g class="pbd-num"><circle cx="${a - 12}" cy="${y}" r="8"/><text x="${a - 12}" y="${y}" text-anchor="middle" dominant-baseline="central">${++num}</text></g>`);
          y += 34;
        } else {
          const dir = b > a ? 1 : -1; const x2 = b - dir * 2;
          body.push(`<g data-pb-id="${esc(tid)}" data-pb-kind="message" data-pb-label="${esc(r.text)}">`);
          body.push(svgText(r.lines, (a + b) / 2, y - tH / 2 - 4, lh, 'pbd-msgtext'));
          body.push(`<line class="${cls}" x1="${a}" y1="${y}" x2="${x2}" y2="${y}"${!r.open && !r.cross ? ` marker-end="url(#${uid}-a)"` : ''}/>`);
          if (r.cross) body.push(`<path class="pbd-x" d="M${x2 - 5},${y - 5} l10,10 M${x2 + 5},${y - 5} l-10,10"/>`);
          body.push('</g>');
          if (D.auto) body.push(`<g class="pbd-num"><circle cx="${a + dir * 12}" cy="${y}" r="8"/><text x="${a + dir * 12}" y="${y}" text-anchor="middle" dominant-baseline="central">${++num}</text></g>`);
          y += 16;
        }
      } else if (r.t === 'note') {
        const is = r.ps.map((p) => X[idx.get(p)]); const lo = Math.min(...is), hi = Math.max(...is);
        let x1, w = r.w;
        if (r.where === 'over') { w = Math.max(r.w, hi - lo + 40); x1 = (lo + hi) / 2 - w / 2; }
        else if (r.where === 'right of') x1 = lo + 14; else x1 = lo - 14 - w;
        const hh = r.lines.length * 15 + 12; y += 6;
        body.push(`<g class="pbd-note" data-pb-id="${esc(dg)}:n${ri + 1}" data-pb-kind="note" data-pb-label="${esc(r.text)}"><rect x="${x1}" y="${y}" width="${w}" height="${hh}" rx="4"/>${svgText(r.lines, x1 + w / 2, y + hh / 2, 15)}</g>`);
        y += hh + 12;
      } else if (r.t === 'start') {
        y += 8; frames.push({ kind: r.kind, label: r.label, y0: y, elses: [], depth: frames.length }); y += 26;
      } else if (r.t === 'else') {
        const f = frames[frames.length - 1]; if (f) { y += 4; f.elses.push({ y, label: r.label }); y += 22; }
      } else if (r.t === 'end') {
        const f = frames.pop(); if (f) { y += 6; f.y1 = y; fdraw.push(f); y += 8; }
      }
    });
    while (frames.length) { const f = frames.pop(); f.y1 = y; fdraw.push(f); }
    const totalH = y + 16;
    const minX = left, W = right - left;
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} 0 ${W} ${totalH}" width="${Math.ceil(W)}" role="img" aria-label="Sequence diagram">`);
    out.push(`<defs><marker id="${uid}-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0.5 L10,5 L0,9.5 z" class="pbd-arrow" style="fill:var(--pb-ink-2)"/></marker></defs>`);
    for (const f of fdraw) {
      const inset = f.depth * 8; const x1 = minX + 12 + inset, x2 = minX + W - 12 - inset;
      const tab = f.kind; const tw0 = tw(tab, 11.5, 650) + 16;
      // labels longer than the frame are cut with … (the full text is in a tooltip)
      const fit = (t, maxW) => { let x = `[${t}]`; if (tw(x, 11.5, 500) <= maxW) return x; while (t.length > 1 && tw(`[${t}…]`, 11.5, 500) > maxW) t = t.slice(0, -1); return `[${t.trimEnd()}…]`; };
      const lbl = (t, x, y, maxW) => `<text x="${x}" y="${y}" style="font-weight:500">${esc(fit(t, maxW))}<title>${esc(t)}</title></text>`;
      out.push(`<g class="pbd-frame"><rect class="pbd-frame__box" x="${x1}" y="${f.y0}" width="${x2 - x1}" height="${f.y1 - f.y0}" rx="4"/><path d="M${x1},${f.y0} h${tw0} v12 l-6,7 H${x1} Z"/><text x="${x1 + 7}" y="${f.y0 + 13}">${esc(tab)}</text>${f.label ? lbl(f.label, x1 + tw0 + 8, f.y0 + 13, x2 - x1 - tw0 - 16) : ''}${f.elses.map((e) => `<line x1="${x1}" y1="${e.y}" x2="${x2}" y2="${e.y}"/>${e.label ? lbl(e.label, x1 + 8, e.y + 14, x2 - x1 - 16) : ''}`).join('')}</g>`);
    }
    P.forEach((p, i) => out.push(`<line class="pbd-life" x1="${X[i]}" y1="${headH}" x2="${X[i]}" y2="${totalH - 6}"/>`));
    out.push(...body);
    P.forEach((p, i) => {
      const cls = p.cls.map((c) => 'c-' + c).join(' ');
      out.push(`<g class="pbd-actor ${cls}" data-pb-id="${esc(dg)}:${esc(p.id)}" data-pb-kind="participant" data-pb-label="${esc(p.label)}"><rect x="${X[i] - p.w / 2}" y="2" width="${p.w}" height="${headH - 4}" rx="${p.kind === 'actor' ? (headH - 4) / 2 : 6}"/>${svgText(p.lines, X[i], headH / 2, 17)}</g>`);
    });
    out.push('</svg>');
    return out.join('');
  }

  // ---------- live connection ----------
  let es = null, wasDown = false;
  function connect() {
    es = new EventSource(API('events'));
    es.addEventListener('status', (e) => { status = JSON.parse(e.data); skew = (status.now || Date.now()) - Date.now(); connected = true; if (status.round && status.round !== S.round) S.round = status.round; updateTop(); });
    es.addEventListener('reload', () => softReload());
    es.addEventListener('transcript', (e) => {
      const d = JSON.parse(e.data);
      if (d.entry && !S.transcript.some((x) => x.id === d.entry.id)) S.transcript.push(d.entry);
      if (d.delivered) for (const x of S.transcript) if (d.delivered.includes(x.id)) x.delivered = d.at;
      renderConvo(); refreshStates(); updateNavBadges();
      if (d.entry && d.entry.from === 'agent') { if (innerWidth <= 980) { elSide.classList.add('is-open'); convoToEnd(); } else if (elApp.classList.contains('pb-side-closed')) toast('The agent replied. Open the conversation to read it.'); }
    });
    es.addEventListener('ended', (e) => { const d = JSON.parse(e.data); S.ended = true; S.endedBy = d.by; if (!$('#pb-ended')) $('#pb-doc').prepend(endedBanner()); hideHoverBar(); blockFocus(false); refreshStates(); updateTop(); updateNavBadges(); });
    es.onerror = () => { if (connected || !downSince) downSince = Date.now(); connected = false; wasDown = true; trusted = false; updateTop(); scheduleCheck(); };
    es.onopen = async () => {
      if (wasDown) {
        wasDown = false;
        const st = await verifyServer();
        if (!st) return;
        if (st.version !== S.version) return softReload();
      }
      connected = true; downSince = 0; updateTop();
    };
  }
  // While disconnected, check every few seconds who answers at this address. The browser stops retrying the
  // event stream for good if a non-planboard server answers, so reconnect it ourselves once ours is back.
  let checkT = 0;
  function scheduleCheck() {
    clearTimeout(checkT);
    checkT = setTimeout(async () => {
      if (connected || moved) return;
      const st = await verifyServer();
      if (st && es && es.readyState === 2) { wasDown = false; connect(); if (st.version !== S.version) softReload(); }
      else if (!st && !moved) scheduleCheck();
    }, 4000);
  }
  // After a lost connection, make sure the server now answering at this address is this plan's planboard
  // (the plan may have moved to another port and something else taken this one). Returns its state or null.
  async function verifyServer() {
    let st;
    try { const r = await fetch(API('state'), { cache: 'no-store' }); st = await r.json().catch(() => null); }
    catch { return null; } // nothing answers: the server is just down, keep retrying
    if (st && st.app === 'planboard' && st.id === ID) { trusted = true; return st; }
    if (es) es.close();
    moved = true; connected = false; updateTop();
    if (!$('#pb-moved')) $('#pb-doc').prepend(h('div', { class: 'pb-banner pb-banner--error', id: 'pb-moved', text: "This page lost its planboard server, and something else now answers at this address. The plan probably moved to a new address: ask the agent to run planboard open and use the link it prints. Your unsent feedback is saved and will be there." }));
    return null;
  }
  function softReload() {
    store.set(K.scroll, scrollY, true);
    if (pop) { const ta = $('textarea', pop); if (ta && ta.value.trim()) store.set(K.draft + ':pop', JSON.parse(sessionStorage.getItem(K.draft + ':pop') || 'null'), true); }
    location.reload();
  }
  function restoreScroll() {
    const y = store.get(K.scroll, null, true);
    if (y != null) { store.del(K.scroll, true); requestAnimationFrame(() => scrollTo(0, y)); }
    else if (location.hash) { const t = document.getElementById(location.hash.slice(1)); if (t) setTimeout(() => t.scrollIntoView(), 50); }
  }
  function restoreDraft() {
    const d = store.get(K.draft, '', true) || (S.draft && S.draft.text) || ''; const ta = $('#pb-input'); if (d && ta) { ta.value = d; autoGrow(ta); }
    const p = store.get(K.draft + ':pop', null, true);
    if (p && p.text && p.text.trim()) {
      enqueue({ kind: 'comment', key: `comment:${rid()}`, mode: p.mode === 'ask' ? 'ask' : 'change', target: { ...p.t, quote: p.quote || undefined }, text: p.text.trim() });
      store.del(K.draft + ':pop', true);
      toast('The page reloaded with new changes. Your unfinished comment was saved to the queue.');
    }
  }

  // ---------- misc ----------
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch {
      const ta = h('textarea', { style: 'position:fixed;left:-9999px' }); ta.value = t; document.body.append(ta); ta.select(); try { document.execCommand('copy'); } catch { } ta.remove(); return true;
    }
  }
  let toastT = null;
  function toast(msg, isErr) {
    $$('.pb-toast').forEach((t) => t.remove());
    const t = h('div', { class: 'pb-toast' + (isErr ? ' pb-toast--error' : ''), role: 'status', text: msg });
    document.body.append(t); clearTimeout(toastT); toastT = setTimeout(() => t.remove(), isErr ? 6000 : 2800);
  }
  function setupKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeFloat(); if (pop && !$('textarea', pop).value.trim()) closePop(); selBtn && (selBtn.style.display = 'none'); }
      const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
      if (typing || e.metaKey || e.ctrlKey || e.altKey || document.documentElement.classList.contains('pb-modal-open')) return;
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); jumpNext(); }
      else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); toggleSide(); }
      else if (e.key === '/') { e.preventDefault(); if (innerWidth <= 980) elSide.classList.add('is-open'); else if (elApp.classList.contains('pb-side-closed')) toggleSide(); $('#pb-input')?.focus(); }
    });
  }

  // ---------- public API for agent-written scripts ----------
  const api = {
    _q: readyQ,
    ready(fn) { if (isReady) safe(fn, api); else readyQ.push(fn); },
    queue({ key, label, text, data } = {}) { enqueue({ kind: 'custom', key: 'custom:' + (key || rid()), target: { kind: 'control', label: label || 'page control' }, text: String(text ?? ''), data }); },
    unqueue(key) { dequeue('custom:' + key); },
    isQueued(key) { return !!queued('custom:' + key); },
    get plan() { return PLAN; },
    flash: (el) => flash(el),
    md, mdInline,
    renderDiagrams: () => enhance(),  // safe to call again: already-enhanced elements are skipped
  };
  window.planboard = api;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
