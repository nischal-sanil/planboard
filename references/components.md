# Components

Building blocks for your own sections in `plan.html`. All of them are styled by the frame (`assets/shell.css`), work in light and dark mode, and need no scripts or network. Use them as-is; don't restyle the frame or invent colours (see `design.md`).

## Sections and comment targets

Wrap each part of your page in a section so it gets a nav entry, Δ marks, and a "Looks good" button:

```html
<section data-pb-section="flow" data-pb-title="How it works">
  <h2>How it works</h2>
  …
</section>
```

- `data-pb-section` — stable kebab-case id. Keep it the same across rounds; Δ marks compare sections by this id. Don't use a built-in block id (`overview`, `decisions`, `questions`, `assumptions`, `steps`, `files`, `risks`, `verification`).
- `data-pb-title` — the label in the nav bar. Defaults to the section's first heading.
- `data-pb-id="…"` on any element inside a section makes it a precise comment target and gets its own Δ mark when it changes. Ids must be unique on the page and stable across rounds.
- `data-pb-label="…"` — the readable name the agent sees in feedback ("new login form"). Defaults to the element's text.
- Users can also select any text and comment on it; the comment carries the quote and the nearest target.
- The frame adds **Comment** and **Looks good** buttons to every top-level section heading, and makes `data-pb-id` elements reachable by keyboard (Tab to a section's blocks, arrow keys between them, Enter opens the comment box) and by tap on touch screens. You don't add anything for this.
- When an element with a `data-pb-id` changes between rounds it gets a Δ mark; a changed diagram also marks each new or changed node with a teal triangle. Keep ids stable so this stays accurate.

## Text

```html
<p class="pb-lead">One sentence that frames the section, slightly larger.</p>
<p class="pb-small pb-muted">A quiet footnote.</p>
<span class="pb-mono">src/lib/session.ts</span>
```

## Tags

```html
<span class="pb-tag">neutral</span>
<span class="pb-tag pb-tag--new">new</span>
<span class="pb-tag pb-tag--changed">changed</span>
<span class="pb-tag pb-tag--removed">removed</span>
<span class="pb-tag pb-tag--move">moved</span>
<span class="pb-tag pb-tag--external">external</span>
<span class="pb-tag pb-tag--done">done</span>
<span class="pb-tag pb-tag--doing">in progress</span>
<span class="pb-tag pb-tag--needs">needs you</span>
```

Also available: `pb-tag--edit` (= changed), `pb-tag--delete` (= removed), `pb-tag--muted` (= external), `pb-tag--delta` (teal; reserved for the frame's change marks, don't use it yourself).

## Callouts

```html
<div class="pb-callout"><p>Neutral note.</p></div>
<div class="pb-callout pb-callout--warn"><p>Something the user should look at.</p></div>
<div class="pb-callout pb-callout--risk"><p>Breaks production if skipped.</p></div>
<div class="pb-callout pb-callout--good"><p>Already handled by <code>rateLimit()</code>.</p></div>
<div class="pb-callout pb-callout--evidence">
  <p><b>Evidence:</b> <code>logs/api-2026-10-01.log</code> line 4412 shows <code>TokenExpiredError</code> 0.8 s after issue.</p>
</div>
```

`--warn` uses marigold, so keep it for things the user must act on.

## Grid and cards

```html
<div class="pb-grid pb-grid--3">
  <div class="pb-card pb-card--new" data-pb-id="svc-worker" data-pb-label="worker service">
    <div class="pb-card__title">worker <span class="pb-tag pb-tag--new">new</span></div>
    <p>Consumes <code>jobs</code> queue, 4 concurrent.</p>
  </div>
  <div class="pb-card pb-card--changed"><div class="pb-card__title">api</div><p>Enqueues instead of running inline.</p></div>
  <div class="pb-card pb-card--muted"><div class="pb-card__title">billing</div><p>Untouched.</p></div>
</div>
```

`pb-grid` alone is auto-fit (min 220 px per column); `--2`, `--3`, `--4` fix the column count and collapse to one column below 760 px. Card variants: `--new`, `--changed`, `--removed` (dashed red), `--muted` (dashed, transparent).

## Table

```html
<div class="pb-tablewrap">
  <table class="pb-table">
    <thead><tr><th></th><th>Postgres</th><th>Redis</th><th class="num">Cost / month</th></tr></thead>
    <tbody>
      <tr class="is-rec"><th>Option A (recommended)</th><td data-v="yes">already running</td><td data-v="no">not in stack</td><td class="num">$0</td></tr>
      <tr><th>Option B</th><td data-v="partial">read replica only</td><td data-v="yes">managed</td><td class="num">$45</td></tr>
    </tbody>
  </table>
</div>
```

`td[data-v=yes|no|partial]` adds ✓ / ✕ / ◐. `tr.is-rec` tints the recommended row green. `.num` right-aligns numbers. Always wrap in `pb-tablewrap` so wide tables scroll instead of breaking the layout.

## Before / after

```html
<div class="pb-split">
  <div class="pb-split__before" data-label="Today">…current shape…</div>
  <div class="pb-split__arrow"></div>
  <div class="pb-split__after" data-label="After this plan" data-pb-id="after-shape">…target shape…</div>
</div>
```

`data-label` defaults to "Before" / "After". Stacks vertically below 760 px. Put anything inside: a diagram, a tree, a mock, code.

## Timeline

```html
<ol class="pb-timeline">
  <li data-state="done"><span class="pb-timeline__when">Oct 6</span><div class="pb-timeline__what">Flag off in prod</div><div class="pb-timeline__detail">Deploy with <code>FEATURE_X=0</code>.</div></li>
  <li data-state="now"><span class="pb-timeline__when">Oct 7</span><div class="pb-timeline__what">Staff only</div></li>
  <li><span class="pb-timeline__when">Oct 14</span><div class="pb-timeline__what">Everyone</div></li>
</ol>
```

`data-state="done"` fills the dot green, `"now"` rings it blue. Keep `__when` short (it is 80 px wide): a date, "Week 2", "Day 0".

## Key–value list

```html
<dl class="pb-kv">
  <dt>Owner</dt><dd>Platform team</dd>
  <dt>Budget</dt><dd>$1,200 / month</dd>
  <dt>Deadline</dt><dd>2026-11-01</dd>
</dl>
```

## Code

```html
<figure class="pb-code" data-pb-id="model">
  <figcaption>prisma/schema.prisma <span class="pb-tag pb-tag--new">new model</span></figcaption>
<pre><code>model LoginToken {
  id        String   @id @default(cuid())
  expiresAt DateTime
}</code></pre>
</figure>
```

The figcaption gets a Copy button. Escape `<`, `>`, and `&` inside `<pre>` as `&lt;`, `&gt;`, `&amp;`.

Diff (lines starting with `+`, `-`, `@@` are coloured):

```html
<pre class="pb-diff">@@ src/lib/email.ts
-export async function send(to, subject) {
+export async function send(to, subject, opts = {}) {
   …
</pre>
```

## Step strip

A small numbered flow for a handful of steps that doesn't need a diagram:

```html
<ol class="pb-flow">
  <li>User enters email</li>
  <li class="is-new">Server emails a link</li>
  <li class="is-changed">Click signs in</li>
</ol>
```

## File tree

The Files block is generated from `steps[].files`. For a tree you draw yourself (a new project's layout, a target structure):

```html
<ul class="pb-tree">
  <li><span class="pb-tree__dir">src/</span>
    <ul>
      <li><span class="pb-tree__file"><span class="pb-chg pb-chg--new">new</span> <span class="pb-tree__name">worker.ts</span></span></li>
      <li><span class="pb-tree__file"><span class="pb-chg pb-chg--edit">edit</span> <span class="pb-tree__name">api.ts</span></span></li>
      <li><span class="pb-tree__file is-delete"><span class="pb-chg pb-chg--delete">delete</span> <span class="pb-tree__name">legacy.ts</span></span></li>
    </ul>
  </li>
</ul>
```

`pb-chg--new|edit|delete|move` are the same change chips the Files block uses.

## UI mock

```html
<div class="pb-mock" data-url="app.example.com/login">
  <div class="pb-mock__body">
    …plain HTML boxes styled in your page's &lt;style&gt;…
    <span class="pb-pin" style="top: 12px; right: 12px">1</span>
  </div>
</div>
<p class="pb-small"><span class="pb-pin pb-pin-inline">1</span> New "Email me a link" button.</p>
```

`pb-mock--phone` gives a 300 px phone frame. `pb-pin` is a marigold numbered marker positioned absolutely inside `__body`; `pb-pin-inline` is the same marker in running text, for the legend. Build mocks from simple boxes in your own `<style>` using the tokens below; don't screenshot real apps from the internet.

## Tabs

```html
<div class="pb-tabs">
  <div data-tab="Option A" data-default>…</div>
  <div data-tab="Option B">…</div>
</div>
```

Only for parallel alternatives the user compares one at a time. Never hide required reading in a tab.

## Collapsible detail

```html
<details class="pb-more">
  <summary>Full error log (42 lines)</summary>
  <pre>…</pre>
</details>
```

## Image

```html
<figure class="pb-figure" data-pb-id="error-screenshot">
  <img src="assets/error.png" alt="Checkout page showing 'Payment failed' after a valid card">
  <figcaption>What users see today (captured from staging on 2026-10-01).</figcaption>
</figure>
```

Put the file next to plan.html (here `assets/error.png`). Local images only; `export --html` inlines them.

## Width

Add `pb-wide` to an element that should use the full width of the content column (wide tables, big diagrams).

## Diagrams

Write Mermaid-style source in a `pre.pb-diagram`. The frame renders it to SVG offline, in the plan's colours, with every node and message commentable.

```html
<pre class="pb-diagram" data-pb-id="arch" data-caption="New parts are green.">
flowchart LR
  ui[Login page]:::changed --> api[POST /api/auth/magic-link]:::new
  api --> db[(LoginToken)]:::new
</pre>
```

- `data-pb-id` names the diagram; nodes become `arch:ui`, `arch:api`, … as comment targets. Without it, diagrams are numbered `dg1`, `dg2`, … in page order, which shift when you add one, so set it.
- `data-caption` adds a caption under the diagram.
- `data-src="…"` can hold the source instead of the element's text.
- Escape `<` and `&` in labels as `&lt;` and `&amp;` (it is HTML). A literal `<br>` in a label is a line break.
- Node and participant ids are letters, digits and `_`, with single hyphens between them allowed (`login-token`, not `login-token.ts`; put the file name in the label: `tok["login-token.ts"]`).
- `planboard check` parses every diagram and reports syntax errors with the diagram's id, so you don't have to open the page to find them.
- Wide diagrams scale down slightly, then scroll sideways. Every diagram has an **Expand** button (or double-click) that opens it full screen with zoom (−, +, Fit, 100%) and drag-to-pan; comments still work there. Expand is a fallback: lay diagrams out so they read without it (see "Wide diagrams" in `design.md`).
- A syntax error shows the message and the source on the page instead of the picture; `check` reports the same error. `check` can't judge layout, so look at the page after a diagram change to see that it reads well.

### Flowchart

First line: `flowchart LR` (or `TD`/`TB`, `RL`, `BT`; `graph` also works). One statement per line, or several separated by `;`. `%%` starts a comment.

Node shapes (`id` then the shape around the label):

| Syntax | Shape |
| --- | --- |
| `a[Label]` | rectangle |
| `a(Label)` | rounded |
| `a([Label])` | stadium / pill |
| `a[(Label)]` | database cylinder |
| `a((Label))` | circle |
| `a{Label}` | diamond (decision) |
| `a{{Label}}` | hexagon |
| `a[[Label]]` | subroutine |
| `a[/Label/]` | parallelogram (input/output) |
| `a>Label]` | flag |

Quote labels that contain brackets or other syntax characters: `a["POST /api (v2)"]`. After the first mention, refer to a node by its id alone.

Edges:

| Syntax | Meaning |
| --- | --- |
| `a --> b` | arrow |
| `a --- b` | line, no arrow |
| `a -.-> b` | dashed arrow (optional, async, background) |
| `a ==> b` | thick arrow (the main path) |
| `a --x b` | ends in a red ✕ (blocked, rejected) |
| `a <--> b` | arrow both ways |
| `a -->\|label\| b` or `a -- label --> b` | labelled edge |
| `a & b --> c` | fan-in; `a --> b & c` fans out |
| `a --> b --> c` | chain |

Groups:

```text
subgraph api [API server]
  route --> handler
end
```

Subgraphs can nest. Nodes first mentioned inside a subgraph belong to it. Edges connect nodes, not subgraphs: `x --> api` where `api` is a subgraph id is an error; point at a node inside it.

Classes (the only colours a diagram may use):

| Class | Meaning |
| --- | --- |
| `new` | added by this plan (green) |
| `changed` | modified (blue) |
| `removed` | deleted (red, dashed, struck through) |
| `external` | third-party or out of scope (grey, dashed) |
| `focus` | the thing to look at (heavy outline) |
| `needs` | waiting on the user (marigold) |
| `risk` | at risk or broken today (red outline, not struck through) |

Apply with `a[Label]:::new` or `class a,b new`. Any other class name gets no colour, and `check` warns about it. `classDef`, `style`, `linkStyle`, and `click` lines are ignored.

### Sequence diagram

```text
sequenceDiagram
  autonumber
  actor U as User
  participant B as Browser
  participant API as /api/auth :::new
  participant M as Postmark :::external
  U->>B: Enters email
  B->>API: POST { email }
  API-->>B: 200 ok
  Note over U,B: User opens the email
  alt link valid
    API-->>B: redirect /dashboard
  else expired
    API-->>B: "Link expired"
  end
```

- `participant X` or `actor X` (rounded), optional `as Label`, optional `:::new` / `:::changed` / `:::external` / `:::risk`. Participants appear in order of first mention.
- Messages: `->>` solid arrow, `-->>` dashed arrow (replies), `->` solid line, `-->` dashed line, `-x` / `--x` lost message (red ✕), `-)` / `--)` async. `A->>A: text` is a self-call.
- `Note over A: …`, `Note over A,B: …`, `Note left of A: …`, `Note right of A: …`
- Frames: `alt` / `else` / `end`, `opt`, `loop`, `par` / `and`, `critical` / `option`, `break`, each with an optional label, nested freely. `rect …` draws an unlabelled frame (its colour argument is ignored). Labels too long for the frame are shortened with … (the full text shows on hover).
- `autonumber` numbers every message.
- Ignored: `activate`, `deactivate`, `box`, `title`, `links`, `create`, `destroy`, and `+`/`-` activation marks on arrows.
- Participants, messages, and notes are all comment targets; feedback names them by their text.

Need a diagram type this doesn't cover (gantt, ER, state)? Use a `pb-timeline`, a table, or inline SVG. Loading Mermaid or anything else from the internet doesn't work: the page blocks remote resources, and `check` warns about them.

## Custom controls (JS API)

Inline `<script>` in plan.html runs before the frame starts, so wrap code in `planboard.ready`:

```html
<section data-pb-section="budget" data-pb-title="Budget">
  <h2>Monthly budget cap</h2>
  <label>Cap: <input type="range" id="cap" min="50" max="500" step="50" value="200"> <output id="cap-v">$200</output></label>
  <script>
    planboard.ready((pb) => {
      const r = document.getElementById('cap'), out = document.getElementById('cap-v');
      r.addEventListener('input', () => {
        out.textContent = '$' + r.value;
        pb.queue({ key: 'cap', label: 'Monthly budget cap', text: `Set the cap to $${r.value}/month`, data: { cap: Number(r.value) } });
      });
    });
  </script>
</section>
```

The user still presses Send; the agent receives `INPUT from control "Monthly budget cap": "Set the cap to $300/month"` plus the `data` JSON.

`window.planboard` after ready:

| Member | Does |
| --- | --- |
| `ready(fn)` | Runs `fn(api)` once the frame has rendered (immediately if it already has). Also fires a `planboard:ready` event on `window`. |
| `queue({ key, label, text, data })` | Queues a custom feedback item. The same `key` replaces the earlier one. |
| `unqueue(key)` | Removes it. |
| `isQueued(key)` | `true` if queued. |
| `plan` | The parsed plan.json (read-only use). |
| `flash(el)` | Briefly highlights an element. |
| `md(text)`, `mdInline(text)` | Render the markdown subset to HTML. |
| `renderDiagrams()` | Renders `pre.pb-diagram` elements (and tabs, code figures, diffs) added after load. Safe to call more than once. |

Query your own elements inside `ready`: the frame moves the page into its layout and replaces placeholders and diagram `pre`s before calling you.

## Tokens

Use these in your page's `<style>` so it follows light and dark mode:

| Token | Use |
| --- | --- |
| `--pb-paper` | card / panel background |
| `--pb-page` | page background |
| `--pb-wash` | subtle fill (code, inputs) |
| `--pb-ink`, `--pb-ink-2`, `--pb-ink-3` | text: primary, secondary, muted |
| `--pb-rule`, `--pb-rule-2` | borders: light, stronger |
| `--pb-link`, `--pb-focus` | links, focus rings |
| `--pb-new`, `--pb-new-bg` | green: new / done |
| `--pb-mod`, `--pb-mod-bg` | blue: modified |
| `--pb-del`, `--pb-del-bg` | red: removed / risk |
| `--pb-mov`, `--pb-mov-bg` | purple: moved |
| `--pb-ext`, `--pb-ext-bg` | grey: external |
| `--pb-needs`, `--pb-needs-bg`, `--pb-needs-line`, `--pb-needs-ink` | marigold: needs the user |
| `--pb-delta`, `--pb-delta-bg`, `--pb-delta-ink` | teal: reserved for the frame's Δ marks |
| `--pb-font`, `--pb-mono` | font stacks |
| `--pb-r`, `--pb-r-lg` | corner radius 6 px, 10 px |
| `--pb-shadow` | popover shadow |

Prefix your own classes with a short plan-specific prefix (`ml-form`, not `form`) so they never collide with `pb-*`.
