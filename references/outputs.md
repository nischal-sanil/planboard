# Outputs

When the user presses **Approve plan**, they pick what happens next. The feedback arrives as:

```text
[1] APPROVED THE PLAN → wants: handoff.md
```

First, every time:

1. Apply any other items in the same batch (answers, verdicts, comments) to `plan.json` / `plan.html`. If one leaves a step without a valid basis (for example an assumption marked wrong with no correction), add an open question instead of guessing; it will be listed as open in the output.
   If the approval has a `note`, record it in `plan.json` (in `context`, or in the step it concerns) so it reaches the outputs.
2. Set `"status": "approved"` in `plan.json`.
3. Run `planboard check <dir>` and fix errors. `export` refuses while plan.json has errors (for `--html`, plan.html errors too); `--skip-check` overrides that, but the output will be wrong where the errors are. Open questions or decisions don't block approval; they are listed as open in the outputs.
4. Produce the chosen output (below).
5. Post the result with `planboard reply <dir> "…"` (format at the end of this file).
6. Don't run `wait` again unless the user asks for more review. Don't end the review yourself; the page stays readable.

In every command, `planboard` means `node <skill dir>/scripts/planboard.mjs`.

## Which output

| Output | Pick it when | Produces |
| --- | --- | --- |
| `continue` — Build it here | The work fits in what's left of this session and the user wants it done now. | Code changes, with step progress shown live on the page. |
| `plan-md` — plan.md | The user wants a checklist to work through later, keep in the repo, or give to another tool. | `<dir>/plan.md`, generated from plan.json. |
| `handoff-md` — handoff.md | A fresh session (or another person) will build it. Best when this session has used much of its context on research. | `<dir>/handoff.md`: everything plus the session-only knowledge. |
| `both` | Both of the above. | Both files. |
| `agent` — Let the agent decide | The user leaves it to you. | Pick one of the above, say which and why in one line, then do it. |

How to decide for `agent`:

- Most of the session's context already used, or the plan has L-sized steps or more than ~8 steps → `handoff-md`.
- Small plan (a few S/M steps) and plenty of context left → `continue`.
- The user mentioned another tool, a ticket, or reviewing it later → `plan-md` (or `both` if a fresh session will also build it).
- `plan.json` `output_hint` holds your earlier recommendation; follow it unless something changed.

## plan.md

```sh
planboard export <dir>                 # writes <dir>/plan.md
planboard export <dir> --out PLAN.md   # somewhere else
```

`plan.md` is generated entirely from `plan.json`: summary, goal, non-goals, context, decisions, assumptions, questions (each with its id, so "per q1" in a step still resolves), ordered steps with files / commands / done-when checkboxes, a file table, risks, verification, and `sections`. Free-form `plan.html` content is not included, so anything the reader must know (a budget table, a timeline, owners) has to be in plan.json too, usually as a `sections` entry.

Never hand-edit `plan.md`. Change `plan.json` and export again; the command overwrites the file.

## handoff.md

```sh
planboard export <dir> --handoff       # writes <dir>/handoff.md with TODO(agent) blanks
# replace every <!-- TODO(agent) … --> comment with real text (below)
planboard check <dir> --handoff        # exits 1 until every blank has text and all sections exist
planboard check path/to/other.md --handoff   # same check for a handoff written with --out
```

The skeleton is pre-filled from `plan.json`: mission, non-goals, step status, background, decisions already made and why, what was settled with the user, what is still open, the remaining steps in full, commands used by the steps, verification, risks, and `sections`. It leaves blanks for what only this session knows; `check --handoff` fails if any of them is missing or empty:

| Blank | Fill with |
| --- | --- |
| **Current state → Where things stand** | What is already done (by step id), the branch, uncommitted or half-finished work, and anything the user said during planning that plan.json doesn't capture. |
| **Commands → Setup from a clean checkout** | How to install, run, and test from a clean checkout: exact commands, env vars (names, where to get values), ports. For non-code work: the tools, accounts, and files needed. |
| **Gotchas and things already tried** | Traps found while investigating: surprising code paths, flaky tests, files that look related but aren't, approaches tried and rejected with the reason. "None found" if truly none. |
| **First action** | The exact first thing to do (a command or a file to open) and what the next agent should see when it works. It is the last section, so it is what the next agent reads last. |

The test: a fresh agent reading only `handoff.md` can start immediately and finish every step without asking anything. `check --handoff` also warns about vague words and a very short file.

If the plan changes after you filled in handoff.md, run `planboard export <dir> --handoff --update`: it rebuilds the file from plan.json and keeps your four filled-in parts. Then re-read "Where things stand" and "First action" in case the change affects them, and run `check --handoff` again. Plain `export --handoff` refuses to overwrite an existing file; `--force` starts over from the blank skeleton; `--out <path>` writes a new copy.

## Build it here (`continue`)

1. Work through the steps in order. As you start a step, set its `status` to `"doing"` in `plan.json`; when every done-when check passes, set it to `"done"` (or `"skipped"` with a `notes` line saying why). The page reloads on each save and shows progress: the step tags, the progress bar, and the step count in the overview.
2. Between steps, run `planboard poll <dir>`. It returns at once: "No new feedback." or the user's comments. Apply CHANGE comments before the next step; answer ASK comments with `reply`. Because the user chose "Build it here", the output ends with "continue with the next step and check again between steps" instead of telling you to wait.

If the user sends feedback after an approval for plan.md or handoff.md, the output instead tells you to update those files (`export` again, `export --handoff --update`) and reply.
3. If the plan turns out wrong mid-build (a done-when can't be met, a file isn't where the plan said), update the step in `plan.json` so the page stays true, and say what changed in a reply.
4. If you need the user's decision to continue, add a question or decision to `plan.json`, `reply` that you're blocked on it, and `wait` (Bash timeout 600000).
5. When done, run the plan's `verification` checks, then post the final reply.

Don't check off a done-when you didn't actually run. If a check can't run here (needs production, a device, a person), leave the step `doing` and say so.

## Final reply format

Post it on the page with `planboard reply <dir> --file -` (stdin) or a quoted string, and give the same summary in the terminal in one to three lines.

```text
Done: <what was produced or built> — <file paths>.
Checked: <verification commands run and their result> (build only).
Open: <open questions, decisions, or unverified checks, by id — or "none">.
Next: <the single next action and who does it>.
```

Example:

```text
Done: wrote .plans/2026-10-03-magic-link-login/handoff.md (check --handoff passes).
Open: q2 (unknown email behaviour) is still unanswered; the handoff lists it.
Next: start a fresh session with "Read .plans/2026-10-03-magic-link-login/handoff.md and do it."
```
