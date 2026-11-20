---
name: root-cause-debugging
description: Find the real cause of a Phoenix bug before changing anything — read the live evidence (production database, the app's error table, /api/healthz, Railway logs, the failing CI log), check whether the "bug" is a locked owner rule, reproduce it, prove one cause, then make one fix in the domain layer with a regression test that fails without it. Use whenever the owner reports something wrong ("this page shows zero", "the email didn't go", "CI is red", "the number is off", "it's broken again") or a test, build, deploy or query fails unexpectedly — BEFORE proposing or writing a fix. Not for new features.
argument-hint: '[what is wrong, in his words — e.g. "July units show 0 for Head Office"]'
---

# Root-cause debugging — find the cause, then fix it once

Most of the work in this repo is fixes, and the rework comes from fixing a symptom: the number is
patched on the page, the next screen shows the old number, and he reports it again. This skill is
the order of work that stops that. **No fix is written until one cause is proven with evidence.**
"Fix means fix" still holds — the investigation is how the fix is found, never a licence for
unrequested work.

## Step 0 — Is it a bug at all?

Several things in Phoenix look wrong and are the owner's deliberate rules. "Fixing" them back is
the costliest mistake in this repo. Before anything else:

1. **Read the module's memory** — `.claude/rules/<module>.md` for the files involved (it usually
   loads by itself; if it has not appeared, open it). Search it for the symptom's words.
2. **Check the locked rules** in AGENTS.md §4 ("Product rules that must not be fixed back") and the
   memory index. Known traps that read as bugs: Head Office absent from weekly and monthly, Head Office
   absent from `phx_monthly_achievement` (no rows is not zero), units of different products never
   added, the Business Review reading the live engine rather than the published closing, a price
   fix restating published months.
3. **Search the traps** — `docs/agents-session-traps-clusters.md` for the error text or tool name.
   Many "bugs" are a known trap in the tool, not the app (a piped exit code, a UTC/Cairo mix-up, a
   short SHA that returns nothing, a stale worktree).
4. **A protected file in the path** (CLAUDE.md, "Protected Files") — stop and show him the exact
   change before touching it.

If it is an owner rule, say so in one line with the rule's name, and change nothing.

## Step 1 — Read the live evidence, not the code

Read what actually happened before reading what the code says should happen. Pick the sources that
fit; run the independent reads in parallel in one step.

| Symptom | Read first |
| --- | --- |
| Wrong or missing number, blank page | The production rows themselves — `list_projects` first and print the ref, then `execute_sql` on that ref. Compare the row to the screen. |
| A server error, a 500, "something went wrong" | The app's error table, `app_error_events` (newest rows for that route), then `railway logs` for the same minute. |
| "It worked yesterday" / "after the deploy" | `/api/healthz` `revision`, then `git log` and merged PRs between the last good and current revision. |
| CI red | The failing job's own log (`gh run view <id> --log-failed`). A job that died in seconds with zero steps is billing or an outage, not your code. |
| An email or notification not received | The outbox row and its status, and `drainHealth` — a green cron proves nothing. |
| A role cannot see or do something | A dev-auth header request as that role (`x-phoenix-role`, `x-phoenix-hr-id`) against the spare's dev server, and the `assertPermission` call in the route. |
| A schema or column error (42703, "returns nothing") | `pg_class` / `pg_proc` / `information_schema` on the live database — never `list_migrations`, which is the ledger. The `select-auditor` agent does this sweep. |

Rules while reading:

- **Times in Cairo.** `gh` and the database speak UTC; convert with node before comparing.
- **One read of a changing value is not a fact** — read it twice if the conclusion rests on it.
- **Never pipe a command whose exit code is the answer.**
- **Write down the exact error text, file and line**, and the exact row or HTTP status. These go in
  the report.

## Step 2 — Reproduce it

- Make it happen on demand: the same page, role, record and month. The spare laptop's dev server
  (`localhost:3000`, pointing at PRODUCTION data) and the `run-phoenix-workforce` skill do this.
  Reading is safe; any action that writes on that server writes production.
- For a domain bug, call the `src/lib/<domain>/` function directly with the failing input.
- Cannot reproduce it → collect more evidence (Step 1). Do not guess.

## Step 3 — Trace it back to where it starts

The place the wrong value shows up is rarely where it is made. Walk backwards:

1. Which component shows the wrong value? What did it receive?
2. Which route or server action produced that? What did it receive?
3. Which domain service in `src/lib/<domain>/` computed it? From which rows?
4. Are those rows themselves wrong? Then the bug is in whatever wrote them (an import, a cron, an
   earlier fix), and possibly a **data** bug as well as a code bug.

Compare with a sibling that works — the same screen for another month, area or role; the same
calculation in another module. List every difference, however small.

## Step 4 — One cause, proven

- State it in one sentence: **"The cause is X, because Y (evidence)."**
- Prove it with the smallest possible check: one query, one function call with one input, one
  changed variable. Not a fix — a test of the theory.
- Theory wrong → a new theory from the new evidence. Never stack a second change on the first.
- Still not understood → say plainly what is not understood. Never present a guess as a cause.

## Step 5 — Fix once, at the source

1. **Regression test first** (the `add-test` skill — a test not registered in `tests/run-tests.ts`
   never runs). It must fail on the current code for the reason found.
2. **One fix, at the source** — in `src/lib/<domain>/`, never re-implemented in a page. No
   "while I'm here" changes.
3. **Prove the test is real:** with the fix removed, the new assertion fires; with it restored, it
   passes. Tests run through `~/.claude/scripts/spare-test.ps1` or in CI — never locally.
4. **A data bug as well?** Production has no point-in-time recovery — only 7 daily backups. Before
   any bulk or destructive correction: inventory the rows, back them up, show the exact change and
   announce it in plain words (AGENTS.md §8). Money is never decided in chat — name the screen
   where it is decided.
5. **Search for the same cause elsewhere** — the same query, helper or pattern in sibling modules.
   Fix it in the same PR if it is the same bug; report it if it is not.

## Three failed fixes — stop

If three fixes in a row have not cured it, or each fix uncovers a new problem somewhere else, the
design is wrong, not the line. Stop fixing. Report what each attempt showed, and put the choice to
the owner as a multiple-choice question (`AskUserQuestion`), recommended option first.

## Report

- **Cause:** one sentence, in plain words, with the proof (the row, the count, the error line, the
  revision).
- **Fix:** what changed and where, by file.
- **Proof it is fixed:** the regression test watched failing then passing, and the live result once
  it ships (`/api/healthz` revision, the screen or row re-read).
- **Not done or not verified:** say it.

## Warning signs — go back to Step 1

- "Let me just try changing X."
- Proposing a fix before reading a single live row or log line.
- Several changes at once "to see which one works".
- "It's probably the cache / a flake / the timezone" with no evidence.
- The fix lives in a page or component while the rule lives in `src/lib/`.
- The fix makes a locked rule's test go red.
- He asks "is that not happening?" or "are you guessing?" — the evidence step was skipped.
