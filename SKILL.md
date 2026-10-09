---
name: planboard
description: Interactive visual planning in the browser. The agent writes a rich plan page (diagrams, file maps, steps with checks, decisions, open questions), opens it locally, and the user answers questions, confirms assumptions, picks options, and comments on any part; the agent receives that feedback, updates the plan, and finally produces plan.md, handoff.md, or keeps building. Use this whenever the user asks to plan, scope, design, spec, break down, or think through any work — features, bug fixes, new projects, refactors, migrations, or non-code projects — or says "/planboard", "let's plan", "make a plan", "show me the plan", "review the plan", or wants to give feedback on a plan visually, even if they never mention a browser. Also use it when the user wants a plan.md or handoff.md from a plan that was reviewed here.
---

# Planboard

You write the plan as a local web page; the user reviews it in the browser; their clicks and comments come back to you as structured feedback; you revise until they approve. The page is how you show the plan at its clearest. The chat stays short.

In every command below, `planboard` means `node <this skill's directory>/scripts/planboard.mjs` (the skill's base directory is shown when this skill loads). Needs Node 18+. Run `planboard help` for all commands.

## The loop

1. **Investigate before you plan.** Read the code, configs, docs, and history that matter. Anything you did not verify is an assumption or a question, not a fact. Note file paths, function names, versions, and commands as you go; the plan needs them.
2. **Create the plan folder:** `planboard new "<title>" --lens <feature|new-project|refactor|non-code|generic>`. This makes `.plans/<date>-<slug>/plan.json` and `plan.html` in the current directory; if your shell is in a subfolder, add `--root <project root>`.
3. **Fill `plan.json`** — the structured backbone (schema: `references/plan-schema.md`). Goal, non-goals, context, assumptions, questions, decisions, ordered steps with files / commands / done-when, risks, verification, extra sections.
4. **Fill `plan.html`** — the free-form part where you show the plan in whatever form explains it best: flows, architecture, before/after, UI mocks, data shapes, timelines, comparisons. Read `references/design.md` (how to choose and write the visuals), `references/components.md` (building blocks and the offline diagram syntax), and `references/lenses.md` (what each kind of work must show).
5. **Check:** `planboard check <dir>` and fix every error and the warnings that are real. Then do the cold-start test yourself: could a fresh agent with no memory of this conversation do every step from the plan alone without asking anything? If not, add what is missing.
6. **Open:** `planboard open <dir>` (it also sets `"status": "in-review"`). Tell the user in one line that the plan is open and what you most need from them (e.g. "2 questions and 1 decision need you").
7. **Wait:** `planboard wait <dir>` with the Bash tool timeout set to `600000`. It returns when the user sends feedback, or after ~9 minutes with "No feedback yet" — then run it again. If a wait is cut off before it prints, the next `wait` or `poll` delivers the same feedback again; `planboard last <dir>` re-prints the most recent delivery.
8. **Apply the feedback.** The output lists each item and says what to do. Record answers, assumption verdicts, and decisions in `plan.json` (see "Applying feedback"), update everything that depends on them, run `check`, then `planboard reply <dir> "<what changed, answers to ASK items>"` (the folder always comes first) and wait again. The page reloads by itself and marks what you changed with Δ.
9. **On approval**, produce what the user picked, following `references/outputs.md`: build here, `plan.md`, `handoff.md`, or both.

Keep terminal messages to one or two lines while the page is open; the page and your page replies carry the detail.

## What makes a plan unambiguous

- **Name things exactly.** Real file paths, function and component names, routes, env vars, table and column names, package versions, exact commands. "Update the auth logic" is not a step; "In `src/lib/session.ts`, add `createSession(userId)` that …" is.
- **Every step has observable done-when checks** — a command that passes, a URL that shows X, a test name. Not "works correctly".
- **Unknowns live where the user can resolve them.** Something you believe but didn't verify → assumption with a `basis`. Something only the user can decide → question with options and your recommendation. A real fork with trade-offs → decision with pros/cons and your pick. Never bury an unknown in step prose.
- **Non-goals are explicit**, so scope can't creep silently.
- **No vague words** ("as needed", "handle errors", "etc.", "properly", "clean up"). `check` flags them; replace them with the specific thing.
- **Numbers over adjectives:** limits, sizes, timeouts, counts, dates.
- **Steps are ordered and small** (S under an hour, M a few hours, L a day+). Over 15 steps, give every step a `phase` (the page and plan.md group steps under it) or split the plan.

## Showing it well

- Lead with the one picture that makes the plan click (a sequence for a flow, an architecture with new/changed parts colored, a before/after for a refactor, a mock for UI work). Then the details.
- Pick the form by the shape of the information: sequence → diagram; comparison → table; time → timeline; structure → tree or flowchart; UI → mock; exact interface → code block. A paragraph is fine when it is genuinely the clearest form.
- Put a question or decision right next to the visual it affects: `<div data-pb="question:q1"></div>`.
- Give wide diagrams the full width: never put a sequence diagram or left-to-right flowchart inside a side-by-side `pb-split` or grid; stack before/after diagrams one above the other, each with a `data-caption` (`references/design.md`, "Wide diagrams").
- Mark anything in your own sections the user may want to point at with `data-pb-id="..."` (and `data-pb-label` for a readable name), so their comments land precisely.
- Colours mean the same thing on every plan: marigold = needs the user, teal Δ = changed since their last feedback, green = new/done, blue = modified, red = removed/risk, purple = moved, grey = external. Use the provided classes rather than inventing colours.
- The page must work offline: the server blocks anything loaded from the internet (scripts, styles, fonts, images). Use the built-in `pb-diagram` renderer, inline SVG, and local files next to plan.html.

## Applying feedback

| Item | Do this in `plan.json` |
| --- | --- |
| ANSWER | `questions[id].status = "answered"`, `.answer` = the answer in plain words. Then update dependent steps. |
| ASSUMPTION → CONFIRMED | `assumptions[id].status = "confirmed"`, `.note` = anything the user added. |
| ASSUMPTION → REJECTED | `status = "rejected"`, `.note` = what is true instead (ask in your reply if the user didn't say). Fix every step that relied on it. |
| ASSUMPTION → CORRECTED | `status = "rejected"`, `.note` = the user's corrected fact. Fix every step that relied on the old belief. |
| DECISION | `decisions[id].chosen`, `.status = "decided"`, `.why`. Remove anything that only applied to other options. A `Note:` from the user goes into `.why` or the affected step. |
| CHANGE comment/message | Edit the plan. If you disagree or it conflicts with something, keep the plan and explain in your reply. |
| ASK comment/message | Answer in the reply. Change the plan only if the answer exposes a real gap, and say so. |
| INPUT from a page control | Apply it the way your control meant it (its `data` holds the values) and record the result in `plan.json`. |
| LOOKS GOOD | That section is settled; don't rework it unless something else forces it. |
| APPROVED | Apply the other items in the same batch first. Put the approval `note` (if any) in `context` or the step it concerns. Set `"status": "approved"` and produce the chosen output (`references/outputs.md`). Don't wait again unless asked. |
| ENDED | Stop waiting. Continue in the terminal. Don't reopen the page unless the user asks (`open --reopen`). |

If the user types in the terminal while the page is open, answer there and keep the plan in sync; the page reloads on its own.

## Files

- `scripts/planboard.mjs` — CLI and local server (localhost only, one server for all plans, idle shutdown).
- `assets/shell.js`, `assets/shell.css` — the page frame injected by the server. Don't copy them into plans.
- `assets/plan.template.json`, `assets/plan.template.html` — what `new` scaffolds.
- `examples/magic-link-login/` — a complete plan using every block; copy patterns from it.
- `references/` — schema, design guide, components, lenses, outputs. Read the ones the current step points to.
