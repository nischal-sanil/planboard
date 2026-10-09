# plan.json schema

`plan.json` is the structured backbone of a plan. `check` is strict: wrong types (a string where a list belongs), unknown values, and misspelled field names (`dependsOn`, `done-when`) are reported, so run it after every edit. The page renders it into the built-in blocks, `check` lints it, `export` turns it into `plan.md` / `handoff.md`, and the Δ marks compare it against the copy saved when the user last sent changes. Keep it valid JSON (no comments, no trailing commas). `check` reports parse errors with line and column.

Free-form visuals go in `plan.html`, not here (see `design.md` and `components.md`).

## Top level

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schema` | `1` | yes | Always `1`. |
| `title` | string | yes | Short, specific: "Add magic-link login", not "Auth work". |
| `lens` | `feature` \| `new-project` \| `refactor` \| `non-code` \| `generic` | no (default `generic`) | Decides which lens checks `check` runs. See `lenses.md`. |
| `status` | `draft` \| `in-review` \| `approved` | no (default `draft`) | `planboard open` changes `draft` to `in-review`. Set `approved` yourself when the user approves. |
| `summary` | markdown | warned if missing | One short paragraph a newcomer reads first. |
| `goal` | markdown | yes | The outcome in one or two sentences, observable. |
| `non_goals` | string[] | warned if empty | What this plan will not do. |
| `context` | string[] | no | Facts you verified: stack, versions, where things live. |
| `assumptions` | Assumption[] | no | Things you believe but did not verify. |
| `questions` | Question[] | no | Things only the user can answer. |
| `decisions` | Decision[] | no | Real forks with trade-offs. |
| `steps` | Step[] | yes (≥ 1) | Ordered work. |
| `risks` | Risk[] | no | |
| `verification` | string[] | warned if empty | End-to-end checks for the whole plan. |
| `sections` | Section[] | no | Extra text sections (rollout, budget notes, glossary). |
| `output_hint` | `{ "recommend": Output, "why": string }` \| `null` | no | Pre-selects an output in the Approve dialog. `Output` is one of `continue`, `plan-md`, `handoff-md`, `both`, `agent`. |

## Ids

- Every assumption, question, decision, step, and risk has an `id`. Ids are unique **across all of these lists together**, not just within one list.
- Convention: `a1, a2…` assumptions, `q1…` questions, `d1…` decisions, `s1…` steps, `r1…` risks. Add new items with the next free number; never renumber or reuse an id, because the Δ marks and the user's past comments refer to items by id.
- Option ids (inside questions and decisions) only need to be unique within their item. Make them short and meaningful: `db`, `redis`, `o15`.
- Section ids (`sections[].id` and `data-pb-section` in plan.html) are kebab-case and must not collide with the built-in block ids: `overview`, `decisions`, `questions`, `assumptions`, `steps`, `files`, `risks`, `verification`.

## Assumption

```json
{ "id": "a1", "text": "Every user row has a verified email.", "basis": "`User.emailVerifiedAt` is non-null in the seed data; production not checked.", "status": "open" }
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | required |
| `text` | markdown (inline) | required. One belief, stated as a fact that can be true or false. |
| `basis` | markdown (inline) | What you saw that makes you believe it. Warned if missing. |
| `status` | `open` \| `confirmed` \| `rejected` | default `open`. |
| `note` | markdown (inline) | What the user said when they confirmed, rejected, or corrected it. |

Lifecycle: `open` → user clicks Confirm / Wrong / Correct it → you set `confirmed` or `rejected` (a correction is `rejected` with the corrected fact in `note`) and fix every step that depended on it.

## Question

```json
{
  "id": "q1",
  "text": "How long should a login link stay valid?",
  "why": "Sets `MAGIC_LINK_TTL_MINUTES` and the email wording.",
  "options": [
    { "id": "o15", "label": "15 minutes", "detail": "Common default." },
    { "id": "o60", "label": "1 hour" }
  ],
  "recommended": "o15",
  "allow_other": true,
  "status": "open"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | required |
| `text` | markdown (inline) | required. One question, answerable in one click or one line. |
| `why` | markdown (inline) | What the answer changes in the plan. Warned if missing. |
| `options` | `{ id, label, detail? }[]` | Optional. Without options the user types an answer. |
| `recommended` | option id | Your suggestion; shown as "Suggested". Must be an existing option id. |
| `allow_other` | boolean | default `true`: shows a free-text field. `false` with no options is an error. |
| `multi` | boolean | default `false`. `true` lets the user pick several options. |
| `status` | `open` \| `answered` | default `open`. |
| `answer` | markdown (inline) | Required once `answered`: the answer in plain words ("15 minutes"), not the option id. |

Lifecycle: `open` → user answers → you set `status: "answered"` and `answer`, then update every dependent step. If the user answers again later ("Change answer"), overwrite `answer`.

## Decision

```json
{
  "id": "d1",
  "title": "Where to store login tokens",
  "context": "Created per request, read once, then deleted. Hundreds a day.",
  "options": [
    { "id": "db", "label": "New `LoginToken` table", "detail": "One Prisma model.", "pros": ["No new infrastructure"], "cons": ["Needs a cleanup job"] },
    { "id": "redis", "label": "Redis with a TTL", "pros": ["Expiry is automatic"], "cons": ["Redis isn't in the stack yet"] }
  ],
  "recommended": "db",
  "status": "open"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | required |
| `title` | markdown (inline) | required. Name the fork, not the answer. |
| `context` | markdown | Constraints that matter for the choice. |
| `options` | `{ id, label, detail?, pros?, cons? }[]` | At least 2 (warned otherwise). `detail` is markdown; `pros`/`cons` are string arrays (inline markdown). |
| `recommended` | option id | Your pick. Warned if neither `recommended` nor `chosen` is set. |
| `chosen` | option id | Set when decided. |
| `status` | `open` \| `decided` | `decided` requires `chosen`. |
| `why` | markdown (inline) | The reason for the choice. Warned if `chosen` is set without it. |

Lifecycle: `open` → user picks an option → you set `chosen`, `status: "decided"`, `why`, and remove anything that only applied to the other options.

## Step

```json
{
  "id": "s2",
  "title": "Write token helpers with tests",
  "detail": "`consumeLoginToken(raw, nonce)` returns the user id if …",
  "files": [
    { "path": "src/lib/login-token.ts", "change": "new", "what": "`createLoginToken`, `consumeLoginToken`." },
    { "path": "src/old/name.ts", "change": "move", "to": "src/new/name.ts" }
  ],
  "commands": ["pnpm vitest run src/lib/login-token.test.ts"],
  "done_when": ["All 5 test cases pass"],
  "depends_on": ["s1"],
  "size": "M",
  "status": "todo",
  "notes": "Optional aside shown under the step."
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | required |
| `title` | markdown (inline) | required. An action: verb + exact object. |
| `detail` | markdown | How, with names. Warned over ~1800 characters: split the step. |
| `files` | `{ path, change?, to?, what? }[]` | `change` is `new` \| `edit` (default) \| `delete` \| `move`; `move` needs `to`. Paths are relative to the project root. These feed the Files block and the file table in `plan.md`. |
| `commands` | string[] | Exact shell commands, one per entry. |
| `done_when` | string[] | **Required.** Observable checks: a command that passes, a URL that shows X, a test name. |
| `depends_on` | step id[] | Must be ids of **earlier** steps (steps run in list order). Shown as "After step N". |

List fields (`files`, `commands`, `done_when`, `depends_on`, and at the top level `non_goals`, `context`, `verification`) must be JSON lists even with one entry: `"done_when": ["npm test passes"]`, not a bare string.
| `size` | `S` \| `M` \| `L` | S under an hour, M a few hours, L a day or more. |
| `status` | `todo` \| `doing` \| `done` \| `skipped` | default `todo`. Update it while building; the page shows progress live. |
| `notes` | markdown | |
| `phase` | string | Optional group name ("Backend", "Rollout"). The page and plan.md show a heading whenever it changes. Give every step a phase or none, and keep each phase's steps together (`check` warns otherwise). Required on every step once a plan has more than 15 steps. |

For `feature`, `refactor`, and `new-project` lenses, `check` warns about a step that names no files and no commands.

## Risk

```json
{ "id": "r1", "text": "Email scanners pre-open links and burn the token.", "likelihood": "med", "impact": "high", "mitigation": "Verify page needs a click before consuming." }
```

`likelihood` and `impact` are `low` \| `med` \| `high` (`medium` is accepted). The page sorts risks by likelihood × impact. `mitigation` is warned if missing.

## Section

```json
{ "id": "rollout", "title": "Rollout", "body": "Ship behind `FEATURE_MAGIC_LINK`.", "items": ["Day 0: deploy with the flag off", "Day 1: staff only"] }
```

`id` and `title` are required. `body` is markdown, `items` is a string array (inline markdown). Use these for text-shaped extras that should also appear in `plan.md`. Anything visual (diagrams, mocks, tables) goes in plan.html instead; plan.html sections are not exported to markdown.

Section ids from `sections` and from `data-pb-section` attributes in plan.html share one id space: the same id in both is a duplicate error, so give each id one place. They also count for the lens checks: a `sections` entry with id `rollback` satisfies the refactor rollback check just like a `data-pb-section="rollback"` would. Put anything that must reach plan.md in `sections`.

## Markdown subset

Fields marked "markdown" support blocks and inline formatting; "markdown (inline)" fields support inline formatting only. Both `plan.md` export and the page use the same text, so write markdown that reads well raw.

Inline:

- `` `code` ``, `**bold**`, `*italic*` (asterisks only; underscores are not italic), `~~strike~~`
- Links `[text](url)` where the url starts with `http://`, `https://`, `#`, `/`, `./` or `../`

Blocks (markdown fields only):

- `-` or `*` bullet lists, `1.` or `1)` numbered lists. A line indented 2+ spaces continues the previous item. No nested lists.
- `- [ ]` and `- [x]` checklists
- Fenced code blocks with ```` ``` ````
- `>` blockquotes (a line starting with `>` and a space)
- `#` to `####` headings, all rendered as small `h4` headings
- A blank line starts a new paragraph; a single line break inside a paragraph is kept as a line break

Not supported: tables, images, nested lists, raw HTML (it is escaped). Put those in plan.html.

## Placing items in plan.html

Built-in blocks render wherever you put a placeholder:

```html
<div data-pb="overview"></div>
<div data-pb="decisions"></div>
<div data-pb="questions"></div>
<div data-pb="assumptions"></div>
<div data-pb="steps"></div>
<div data-pb="files"></div>
<div data-pb="risks"></div>
<div data-pb="verification"></div>
<div data-pb="sections"></div>
```

Any non-empty block you leave out is appended at the end of the page (`overview` goes first). A single item can be placed next to the visual it belongs to:

```html
<div data-pb="question:q1"></div>
<div data-pb="decision:d1"></div>
<div data-pb="assumption:a2"></div>
<div data-pb="step:s3"></div>
<div data-pb="risk:r1"></div>
<div data-pb="section:rollout"></div>
```

An item placed inline is left out of its block, so it never shows twice. A placeholder with an unknown id renders a red error banner on the page.

## Minimal complete example

```json
{
  "schema": 1,
  "title": "Rename `getUser` to `fetchUser`",
  "lens": "refactor",
  "status": "draft",
  "summary": "`getUser` does a network call but reads like a getter. Rename it everywhere in one commit.",
  "goal": "No reference to `getUser` remains in `src/`, and `pnpm test` passes.",
  "non_goals": ["Changing the function's behaviour or signature"],
  "context": ["`getUser` is defined in `src/api/user.ts` and has 14 call sites (`rg -n 'getUser\\(' src`)."],
  "assumptions": [
    { "id": "a1", "text": "No other package imports `getUser`.", "basis": "This repo is not published; `package.json` has `\"private\": true`.", "status": "open" }
  ],
  "questions": [],
  "decisions": [],
  "steps": [
    {
      "id": "s1",
      "title": "Rename the function and its 14 call sites",
      "files": [{ "path": "src/api/user.ts", "change": "edit", "what": "Rename the export." }],
      "commands": ["rg -l 'getUser\\(' src | xargs sed -i '' 's/getUser(/fetchUser(/g'"],
      "done_when": ["`rg -n 'getUser' src` prints nothing", "`pnpm test` passes"],
      "size": "S"
    }
  ],
  "risks": [],
  "verification": ["`pnpm build && pnpm test` pass"],
  "sections": [
    { "id": "rollback", "title": "Rollback", "body": "Revert the single commit with `git revert <sha>`." }
  ],
  "output_hint": { "recommend": "continue", "why": "One small step; build it here." }
}
```

On its own this passes `check` with 0 errors and two warnings: plan.html is missing, and the refactor lens expects a before/after section in it. See `lenses.md`.
