# Lenses

The lens (`plan.json` → `lens`, set with `planboard new --lens …`) says what kind of work the plan is for. It changes three things: the hint written into a new `plan.html`, which checks `check` runs, and the label on the overview.

`check` finds sections by id, looking in both `plan.json` `sections[].id` and `data-pb-section="…"` attributes in `plan.html`. A match is a case-insensitive substring: `rollback`, `rollback-plan`, and `db-rollback` all count as a rollback section.

| Lens | `check` expects a section id containing | Also checked |
| --- | --- | --- |
| `feature` | (none) | every step names files or commands |
| `new-project` | `architecture`, `stack`, or `structure` | every step names files or commands |
| `refactor` | `rollback`, **and** one of `before`, `after`, `current`, `target` | every step names files or commands |
| `non-code` | `deliverable` | |
| `generic` | (none) | |

These are warnings, not errors: if a check doesn't apply, say why in the plan instead of adding an empty section.

## Feature or bug fix (`feature`)

Must show:

- **The flow that changes.** A sequence diagram (for request/response or multi-actor flows) or a flowchart (for logic or wiring), with new pieces `:::new` and modified ones `:::changed`. Recommended section id: `flow`.
- **The shape of the data or API.** The new table, type, request/response body, or config, as a `figure.pb-code`. Recommended id: `data`.
- **For UI work:** a mock of the changed screen, before and after if it replaces something (`pb-split` + `pb-mock`). Recommended id: `screens`.
- **For a bug:** the root cause with evidence. Show the failing path, mark the exact line or call where it goes wrong, and quote the evidence that proves it (log line with file and line number, stack trace, a failing test, a repro command and its output) in a `pb-callout--evidence`. State how you know the fix addresses the cause, not just the symptom, and add a done-when that reproduces the original failure and shows it gone. Recommended id: `root-cause`.

Typical questions: limits and timeouts, behaviour in edge cases (empty, duplicate, unauthorised), copy the user will see. Typical risks: breaking an existing path, data the change can't handle.

## New project (`new-project`)

Must show:

- **Architecture.** A flowchart of the parts and how they talk (processes, services, storage, third parties as `:::external`). Section id: `architecture`.
- **Stack decisions.** Each real choice (framework, database, hosting, auth) as a decision with options, pros/cons, and your pick. Put trivial or forced choices in `context` instead.
- **Folder layout.** A `pb-tree` of the initial structure, with one line on what lives where. Section id: `structure`.
- **Milestones.** A `pb-timeline` from empty repo to first usable version, each milestone with what the user can do at that point. Section id: `milestones`.

Steps start from an empty directory: the exact scaffold command, versions pinned, how to run it locally, and the first test. Done-when for the first milestone should be something the user can click or run.

## Refactor or migration (`refactor`)

Must show:

- **Before and after.** The current shape and the target shape: module structure, data model, call graph, or API. Small shapes (a folder tree, a schema, a code signature) go side by side in a `pb-split`; diagrams go one above the other, today first, each with a `data-caption` (see "Wide diagrams" in `design.md`). Section id: `before-after`.
- **Rollout order.** The sequence that keeps everything working at each step: expand → migrate → contract. Say which steps can ship on their own. A `pb-timeline` or a numbered `pb-flow` works. Section id: `rollout`.
- **Compatibility window.** What runs side by side and for how long: old and new code paths, dual writes, a feature flag, a deprecated endpoint kept alive. Give the end condition ("remove `legacy_user_id` after 7 days with zero reads in `pg_stat_statements`").
- **Rollback.** How to undo each step, how long it takes, and the point after which rollback is no longer simple (for example once old columns are dropped). Put it in `plan.json` `sections` with id `rollback`, so it reaches plan.md, and place it on the page with `<div data-pb="section:rollback"></div>`. Don't also write a `data-pb-section="rollback"` section in plan.html: section ids are shared between the two files, and `check` reports the duplicate.

Steps should be safe to stop between. Done-when should include "existing tests pass unchanged" and a check that nothing still uses the old shape (a `rg` command that prints nothing).

## Non-code project (`non-code`)

For events, research, content, hiring, operations, purchasing.

Must show:

- **Deliverables.** Each concrete thing that will exist at the end, with its format and acceptance check ("a 10-slide deck reviewed by Sam by Nov 3"). Section id: `deliverables`.
- **Timeline.** A `pb-timeline` with dates, the current point marked `data-state="now"`. Section id: `timeline`.
- **Owners.** Who does what, as a `pb-table` (task, owner, due). Section id: `owners`.
- **Budget and numbers.** A small `pb-table` with amounts, units, and totals (`td.num`). Section id: `budget`.

Steps use `commands` rarely; `done_when` is still required (a signed contract, a sent invite, a published page). Name people and dates exactly, not "the team" or "soon".

plan.html isn't exported, so also put the deliverables, timeline, owners and budget in `plan.json` `sections` (as `items`, one line each with the numbers). That way they reach plan.md and handoff.md.

## Generic (`generic`)

No lens checks. Pick the form by the shape of the information (`design.md` §2). Use this when the work doesn't fit the others, or mixes them so much that one lens's checks would mislead.
