# Designing the plan page

The page exists so the user understands the plan faster and more exactly than they would from text, and can point at the part they disagree with. Every visual has to earn its place by doing that.

## 1. One picture first

Right after the overview, show the one picture that makes the plan click. Ask: "If the user looks at only one thing, what must they see to judge this plan?"

| Kind of plan | The first picture |
| --- | --- |
| A flow changes (login, checkout, a job pipeline) | Sequence diagram of the new flow, new participants marked `:::new` |
| Parts are added or rewired | Flowchart of the system, `:::new` / `:::changed` / `:::external` nodes |
| A bug | The failing path with the exact point it breaks, plus the evidence (log line, stack trace, repro) |
| A refactor or migration | Before / after side by side (`pb-split`) |
| UI work | A mock of the screen, with numbered pins for what changes |
| A new project | Architecture flowchart |
| A non-code project | Deliverables and a timeline |

Then the details, in this order unless the plan needs another:

1. Overview (built in: title, summary, goal, not doing, context, at-a-glance numbers)
2. The one picture, with the questions and decisions it raises placed right under it
3. Other visuals: data shapes, screens, comparisons
4. Decisions, questions, assumptions (whatever is not already placed inline)
5. Steps, files, risks, verification
6. Extra sections (rollout, rollback, budget)

Put the things the user must act on early. They should not have to scroll past ten steps to find the question that changes step 2.

## 2. Pick the form by the shape of the information

| The information is… | Show it as | Component |
| --- | --- | --- |
| Things happening in order between actors | Sequence diagram | `pre.pb-diagram` `sequenceDiagram` |
| Parts and how they connect | Flowchart | `pre.pb-diagram` `flowchart` |
| Branching logic | Flowchart with `{diamond}` decisions | `pre.pb-diagram` |
| Two or more options across the same criteria | Table, recommended row marked | `pb-table`, `tr.is-rec`, `td[data-v]` |
| Current vs target | Side by side | `pb-split` |
| Events over time | Timeline | `pb-timeline` |
| A folder layout | Tree | `pb-tree` |
| A screen | Mock with pins | `pb-mock`, `pb-pin` |
| An exact interface: schema, types, API shape, config | Code | `figure.pb-code` |
| An exact change to existing code | Diff | `pre.pb-diff` |
| Proof for a claim | Evidence callout with the source | `pb-callout--evidence` |
| A few labelled facts (owner, budget, date) | Key–value list | `pb-kv` |
| A short linear process (3–6 steps) | Step strip | `pb-flow` |
| Reasoning, a caveat, a narrative | A paragraph | `<p>` |

A paragraph is fine when it is genuinely the clearest form. Don't force a diagram onto an idea that is one sentence.

## 3. Write unambiguously

The plan is done when a fresh agent with no memory of the conversation could carry out every step without asking anything. Write for that agent.

**Name things exactly.**

- Bad: "Update the auth logic to support the new flow."
- Good: "In `src/lib/session.ts`, add `createSession(userId: string): Promise<string>` that inserts into `Session` and returns the cookie value."

**Make done-when observable.**

- Bad: "Login works correctly."
- Good: "`pnpm playwright test e2e/magic-link.spec.ts` passes." / "`curl -i localhost:3000/api/health` returns `200`."

**Put numbers on it.**

- Bad: "Rate-limit the endpoint appropriately." / "Links expire after a short time."
- Good: "5 requests per IP per 15 minutes; the 6th returns `429`." / "Links expire after 15 minutes (`MAGIC_LINK_TTL_MINUTES=15`)."

**Unknowns go where the user can resolve them.**

- Bad (buried in a step): "Probably store tokens in Redis, unless we'd rather use Postgres."
- Good: a decision `d1` with both options, pros/cons, and your recommendation, placed next to the architecture diagram.
- Something you believe but didn't check → an assumption with a `basis`. Something only the user knows → a question with options and a suggestion. A fork with trade-offs → a decision.

**Replace vague words.** `check` flags these in every text field of plan.json: "etc.", "and so on", "as needed", "if needed", "appropriate(ly)", "properly", "somehow", "maybe", "probably", "should work", "various", "some kind of", "TBD", "TODO", "whatever", "accordingly", "necessary changes", "handle errors / edge cases" (without saying how), "clean up" (without saying what), a trailing "…", "stuff", "nice to have".

- Bad: "Handle errors."
- Good: "If Postmark returns 5xx, retry twice with 1 s backoff, then log `email_send_failed` and still return `200` to the client."

**Say what is out.** Non-goals stop scope from creeping in silently: "Not removing password login", "Not changing the session cookie format".

**One claim per item.** An assumption that bundles two beliefs can't be confirmed with one click. A question that asks two things gets half an answer.

**Use the same name for the same thing** everywhere: in the diagram, the steps, the files, and the code block. If the node says `login-token.ts`, the step says `src/lib/login-token.ts`, not "the token module".

## 4. Put the question next to what it affects

A question about the token lifetime belongs under the sequence diagram that shows the token, not in a list at the bottom:

```html
<pre class="pb-diagram" data-pb-id="flow-seq">…</pre>
<div data-pb="question:q1"></div>
```

The same goes for a decision about storage under the architecture diagram, or an assumption about the existing API under the data shape it describes. Items placed inline don't repeat in their block.

## 5. Density

- One idea per section. If a section needs two headings, it is two sections.
- A diagram stays readable at about 12 nodes or 10 messages. Past that, split it ("Request a link" and "Use the link") or zoom out and show detail separately.
- **Wide diagrams:** the content column is about 960 px, and half of that inside a `pb-split` or a 2-column grid. Never put a sequence diagram or a wide flowchart inside `pb-split` or `pb-grid`: stack the before and after diagrams one above the other with a heading each, or put them in `pb-tabs` ("Today" / "After this plan"). Keep sequence diagrams to about 5 participants per row, use short participant aliases (`participant K as adk_core_client`), and keep message labels to a few words. Users can press Expand on any diagram, but the page should read without it.
- Diagram labels: 2–5 words. Put explanations in the caption or the text next to it.
- Tables: up to about 6 columns. More than that, transpose or split.
- Paragraphs: 3–4 sentences, then a break or a list.
- Long reference material (full logs, every call site) goes in `details.pb-more`, collapsed, with a summary line that says what's inside.
- Steps: small and ordered. Over 15, give every step a `phase` ("Backend", "Rollout") so they're grouped, or split the plan.

## 6. Colour has fixed meanings

The same colour means the same thing on every plan, so the user learns it once:

| Colour | Means | Use via |
| --- | --- | --- |
| marigold | needs the user | `pb-tag--needs`, `pb-callout--warn`, `pb-pin`, `:::needs` |
| teal Δ | changed since the user's last feedback | the frame only; never use it yourself |
| green | new / done / confirmed | `pb-tag--new`, `pb-card--new`, `:::new`, `pb-callout--good` |
| blue | modified | `pb-tag--changed`, `pb-card--changed`, `:::changed` |
| red | removed / rejected / risk | `pb-tag--removed`, `pb-callout--risk`, `:::removed` |
| purple | moved | `pb-tag--move`, `pb-chg--move` |
| grey | external / out of scope | `pb-tag--external`, `pb-card--muted`, `:::external` |

Don't mark things marigold that the user doesn't need to act on. Don't colour for decoration. If something is neither new, changed, removed, moved, external, nor waiting on the user, leave it neutral.

## 7. Accessibility

- Never rely on colour alone. Tags carry words ("new", "changed"); diagrams pair classes with a legend line or caption.
- Give every diagram a `data-caption` that states what it shows or the one thing to notice.
- Give `data-pb-label` to elements whose text alone is unclear ("Option B", "→").
- Images you add need `alt` text. Inline SVG you draw needs `role="img"` and `aria-label`.
- Custom controls must be real `<button>`, `<input>`, `<select>` elements with labels, so they work by keyboard.
- Text in mocks and diagrams must stay legible: no text under 12 px.

## 8. Offline only

The page must work with no network: plans get reviewed on planes, behind VPNs, and months later.

- No remote scripts, stylesheets, fonts, or images. The server's Content Security Policy blocks them anyway, and `check` warns about them.
- Use the built-in diagram renderer and inline SVG.
- Local images are fine: put them next to plan.html (for example `assets/screen.png`) and reference them relatively. `export --html` inlines them.

## 9. Respect the frame

The frame owns the top bar, the nav, the conversation panel, the built-in blocks, and the Δ marks.

- Style only your own elements, with a short plan-specific class prefix (`ml-`, `inv-`).
- Use the `--pb-*` tokens for colours so dark mode works.
- Don't override `.pb-*` classes, `body`, `html`, or the fonts.
- Don't use `position: fixed` or high `z-index` in your sections.

## 10. Anti-patterns

- **Wall of text.** Five paragraphs explaining a flow that one sequence diagram would show.
- **Decorative visuals.** A diagram that repeats the step list as boxes, an icon grid, a hero banner. If removing it loses no information, remove it.
- **Generic boxes.** Nodes labelled "Frontend", "Backend", "Database" when the plan touches `src/app/login/page.tsx`, `POST /api/auth/magic-link`, and the `LoginToken` table. Use the real names.
- **Restyling the frame** or inventing colours (a purple "important" box, a gradient header).
- **Hiding required reading** in tabs or collapsed sections.
- **The same information twice** in slightly different words: once in a diagram, once in prose, once in a table. Pick the clearest form and link to it.
- **Unknowns in prose.** "We may need to…" inside a step instead of a question or assumption the user can resolve with a click.
- **Changing ids between rounds.** Renaming `data-pb-section` or `data-pb-id` values makes everything look new and breaks the user's earlier comments.
