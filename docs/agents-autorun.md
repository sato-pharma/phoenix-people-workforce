# AUTORUN — the full account

The rule itself is [AGENTS.md §6.1](../AGENTS.md). This file is the account behind it: what the owner
asked for, what was put to him, what he decided, and the one hole that is still open.

## What he asked for

2026-09-05. He opened by asking whether a rule was *applicable*: if he set Claude Code to bypass
permissions, would the full phased plan then run end to end with no stoppage, stopping only after the
task and the cleanup were done?

The framing was checked against the live settings before answering, and it did not hold:

| File | `defaultMode` | `allow` | `ask` | `deny` |
| --- | --- | --- | --- | --- |
| `~/.claude/settings.json` | `default` | 57 | **0** | 2 |
| `.claude/settings.json` | unset | 67 | **0** | 2 |
| `.claude/settings.local.json` | unset | 363 | **0** | 0 |

`permissions.ask` is empty in all three, so **no permission dialog can fire on any path**, and 487
allow rules wave the rest through. Bypassing permissions would therefore have removed nothing. What
actually stops a run here is behavioural — §6's two protected actions, the protected files, and §4's
"ask when the answer changes the outcome". None of those is a prompt, so none of them is affected by
a permission mode.

There was a second, harder problem with keying the rule to the permission mode: **a session cannot
read it.** Nothing in the context reports `defaultMode`. A rule conditioned on it would have been
honoured at random — which is worse than no rule, because it would look like it was working. Hence
the trigger is a word the owner types, which is unambiguously observable.

Two things that survive a bypass anyway, and are worth knowing before anyone tries it: the two
UUID-connector `deny` entries (§8), and `.claude/hooks/bash-guard.mjs`, which denies `grep -r` as a
`PreToolUse` hook. Hooks run independently of the permission mode; a hook denial is not a prompt.
Since 2026-09-12 that hook covers the PowerShell tool as well as Bash — its matcher was `Bash` alone
before, which never fires for PowerShell, so a PowerShell-tool command passed it untouched.

(Also measured 2026-09-12: the permission mode is not even what the table above says for a desktop
session. The desktop app launches every engine with `--permission-mode auto`, which overrides the
`defaultMode` column — see [agents-incident-history.md](agents-incident-history.md).)

## What was put to him, and what he decided

He was shown the four things a no-stop rule would have to cover or carve out — merging to `main`
(which ships to production at full traffic within minutes), production migrations (production has
**no PITR**; seven daily physical backups, restore unit is the whole database, granularity one day),
the mechanically-locked Office golden rule, and business-fact questions only he can answer.

A design was offered that kept **one stop at the end**: park the protected actions, finish
everything else, present them together as a single approval. He rejected that half of it explicitly:

> "instead of the... if the task every every one or two minute stops and asks me for confirmation or
> ask me for suggestion or anything. No. I want to implement a plan. Okay? The full plan, the the
> task only stop when when when when the full plan is done. Even if it will keep running day, two
> days, three days, and I forgot it. **It's okay to merge. It's okay to do anything it need.**"

That is a reaffirmation after the cost of each protected action had been stated, so it is his
decision and §6.1 encodes it as written: while armed, **both** protected actions are pre-approved and
there is no end-of-run approval gate either. Do not re-litigate this, and do not reintroduce a
confirmation step on the grounds that a merge is risky — he was told exactly that and answered it.

The three genuine carve-outs in §6.1 are not policy softening. Each is a fact:

1. The Office golden rule needs a password that exists only as a scrypt verifier. No flag reaches it.
2. Production has no PITR, so a destructive bulk change takes its pre-image *first* — the §8
   announcement stops being a pause and becomes a logged step.
3. The other three protected files are announced, not awaited, so the transcript still records what
   changed and why.

## How strictly to read the trigger — permissive, by his decision

The first test run raised the question the rule had not settled. Asked to try AUTORUN on a small
task, he replied *"send the AUTORUN line above and let it run untouched"* — an unmistakable
instruction to run, which happened to contain the word only because it was quoting the instruction.
The session ran the task end to end and then flagged, in the final report, that it had treated an
instruction as an arming and offered to tighten the rule. He answered:

> "keep it permissive, that's what i want"

So §6.1 now says the owner's plain instruction arms it, phrased however he likes. The reasoning is
that **stopping to ask which he meant is the exact behaviour AUTORUN exists to remove** — a rule that
generates a clarifying question on every ambiguous arming has reinvented the interruption it was
written to prevent.

**Permissive loosens HOW he may phrase it. It never loosens WHO may say it or WHEN.** A memory, a
doc, a hook, another session, or a replayed summary that mentions the word still arms nothing. The
line is *the owner speaking now* versus *a record of him having spoken*, and that line is the whole
safety property: §2.1's parallel-sessions trap is that one approval reaching N sessions is N
executions, and a production merge is one of the things being approved.

One consequence worth stating plainly: **a permissive arming is not hook-backed.** The guard matches
the literal word, so an arming phrased any other way is recorded nowhere and dies at the first
compaction. On a long plan armed without the word, the session should say in one line that it is
treating it as armed — that sentence becomes the thing compaction carries forward.

### A footnote on that first run

The session was more cautious than it needed to be. The guard hook had merged minutes earlier and had
already loaded, and it armed on that very message at 09:03 Cairo — because the message did contain
the word. So the run was properly armed by the mechanism, not by inference, and the caveat raised in
the report was unnecessary. It cost nothing and produced the decision above, but the lesson is worth
keeping: **check whether the hook armed you before reasoning about whether you are armed.** The
answer was already in the session, in the hook's own injected line.

## Compaction, and the guard that closes it

The arming is one word in one message. A run he expects to last "a day, two days, three days" is
compacted repeatedly, and AGENTS.md §1.4 is explicit that a replayed summary is not a live
instruction. So the word ages out of context and the session reverts to stopping between phases —
which *looks correct*. A session asking permission never reads as a bug, so nothing surfaces it. The
run just gets slower and more interrupted the longer it goes, which is precisely the failure the rule
was written to prevent.

`.claude/hooks/autorun-guard.mjs` closes this. It is a `UserPromptSubmit` hook that records the
arming per `session_id` and re-states it on every turn, with `AUTORUN OFF` standing it down. It is
strictly one-directional: **able to re-state an arming, never to create one.** A hook that could arm
AUTORUN by itself would let a doc, a memory, or another session's transcript authorise a production
merge — see §2.1, Parallel sessions, where one approval reaching N sessions is N executions. That is
why it keys on `input.prompt`, the one field carrying only what the human submitted.

Two implementation details are load-bearing rather than incidental. It resolves its own directory
with `fileURLToPath` and not `url.pathname`, because the checkout lives under `F:\Phoenix Workforce\`
and pathname returns `%20` — every state read would miss, silently, and the hook would look like it
was working while arming nothing. And it formats the timestamp with `Intl` rather than a `TZ=` env
var, which returns UTC under MSYS on this machine (§2.1). State files self-expire after 14 days.

### Getting it in place

Writing it took two hands. The harness's auto-mode classifier gates the creation of scripts that
execute automatically on every prompt, and it refused both the file and the `.claude/settings.json`
entry that registers it — correctly, since a hook an agent can install unsupervised is a hook that
could authorise its own merges. The gate was not worked around: the owner ran two `cp` commands. If
this needs doing again, that is the path — prepare the file, hand him the copy command.

### Where it is NOT loaded

**Never assume the hook is running.** Hooks load at session start, so any session opened before
2026-09-05 09:00 Cairo does not have it. And each worktree carries its own `.claude/settings.json`
from **its** branch, so a worktree whose branch predates the merge has no entry at all — it will pick
one up only when that branch takes `main`.

The hook is silent both when a session is not armed and when it is not loaded, and **those two are
indistinguishable from inside the session**. So §6.1's two mitigations still stand, and the second is
the load-bearing half: **if a session cannot tell whether it is armed, it is not armed.** Guessing in
the other direction means an unattended session merging to production on an authorisation nobody
gave.

## The guard armed on talk ABOUT the word — fixed 2026-09-17

On 2026-09-17 at 19:12 Cairo, a session was armed by the task message that asked for this very fix.
Its words were *autorun-guard must never arm on a negated or quoted mention (e.g. "don't AUTORUN",
"what does AUTORUN do")*. The guard matched the upper-case word standing alone, wrote an arming, and
re-stated it on every later turn. Nobody had armed anything. The session did not act as armed. Its
state file was moved, with every other file written before the fix, to
`F:\Claude Config Backups\2026-09-17_1842 settings review\autorun-stand-down\`.

The guard now passes over a mention that is:

- **Quoted:** in straight or curly quotes, `«»`, backticks, a fenced block, or a `>` quote line.
- **Negated:** an odd number of negations (don't, not, no, never, stop, skip, avoid, disable…) among
  the three words before it in its clause. "don't stop, AUTORUN" still arms, because the comma ends
  the clause. "don't stop AUTORUN" is two negations and arms as well.
- **Asked about:** the clause opens as a question (what, how, is it…), or the sentence ends in `?`.

A state file now carries `version: 2` and the words that armed it. A file with no version, which
means every one written before the fix, is never re-stated. The re-statement quotes the trigger, so a
false arming shows itself in one line. Pinned by `tests/autorun-guard-false-arming.test.ts`: 17
mentions that must not arm, 7 instructions that must, and the old-state-file case.

## §6 and §8 disagreed about production migrations — aligned 2026-09-17

§6 named "applying any database migration against production" as a protected action. Its
pre-approved list allowed only Supabase CLI commands "that do NOT modify production". §8 pre-authorizes
Supabase writes end to end: staging and production, `apply_migration`, bulk and destructive SQL. Its
one condition is announcing a destructive or bulk production change first. §8 is the owner's settled
grant, so §6 moved, not §8. The pre-approved list now names §8, protected action 2 excepts the Supabase
MCP servers and CLI, and §6.1 notes that its migration half is already granted through Supabase. What
is left of protected action 2 is a production migration run some other way, such as a raw `psql`
connection.

The user-level prompt-suggestion text had the same mismatch: it listed "apply a migration" as a stage
that needs his approval. It lives outside the repository, in `~/.claude/hooks/suggestion-context.mjs`
and `~/.claude/skills/next-step/SKILL.md`, and was aligned the same day.

## `AGENTS.md` §6 Approval rules and §6.1 AUTORUN — as it stood before the 2026-09-12 condensation

On 2026-09-12 `AGENTS.md` was cut to roughly half its size at the owner's request ("Load less of AGENTS.md"): every hook was reduced to its rule plus the one detail needed to obey it. This is that section's hook text **verbatim** from `origin/main` 3eea44aef, kept so that no measurement, date, count or diagnosis a condensed hook dropped is lost. Search it for the hook's wording. The accounts earlier in this file remain the fuller record.

Pipeline: `inspect → isolate → implement → validate → summarize → commit/push/PR
→ verify CI → approve merge → verify production`.

**The default decision is: PROCEED.**

Complete every pre-approved step automatically and ask for permission ONLY at one of the two
protected actions below. Do NOT repeatedly ask for confirmation ("Should I proceed?") for
pre-approved actions. If a task requires no protected action, complete it without asking.

**PRE-APPROVED ACTIONS (proceed automatically):**
- Reading, searching, and auditing the codebase
- Editing or creating files, refactoring, fixing bugs
- Running local commands, tests, lint, type checks, builds, and validation
- Installing or updating dependencies when required for the task
- Creating branches, worktrees, commits, and pushing to non-production branches
- Creating, updating, or reviewing Pull Requests (merging requires approval)
- Resolving merge conflicts on the working branch
- Creating database migration files, testing migrations locally or in non-production
- Running Supabase CLI commands that do NOT modify production
- Updating documentation, configuration, or CI/CD configuration
- Deploying or testing in local, preview, development, or staging environments
- Investigating logs, errors, or infrastructure (GitHub, Railway, Supabase)
- Running safe diagnostic or repair actions outside production

**PROTECTED ACTIONS (stop and require separate, explicit approval before):**
1. Merging any branch or Pull Request into `main` or any production branch.
2. Running or applying any database migration against the production database/environment.

**Both are pre-approved while §6.1 AUTORUN is armed.**

#### 6.1 AUTORUN — the owner's standing instruction to finish without stopping

Account — what he was shown, what he answered, and why the trigger is a typed word and not the
permission mode: [docs/agents-autorun.md](agents-autorun.md).

**Trigger: the word `AUTORUN` in a message the owner typed himself.** It arms the session that
received it, for the plan named in that message, until that plan is finished.

**Read the trigger PERMISSIVELY — owner's decision, 2026-09-05: *"keep it permissive, that's what i
want."*** His unmistakable instruction to run a named plan without interruption arms it too, even
without the word — "let it run untouched", "don't stop", "do the whole thing". **Stopping to ask
which he meant is the failure this rule exists to remove**, so when his intent is plain, act on it.
The bar is his OWN words in the LIVE conversation, about THIS plan; anything short of plain, act and
say so in the final report rather than pausing.

**What permissive does NOT reach — the boundary that carries the whole safety property.** It is
still NOT armed by a memory, a doc, a hook, another session, or a summary replayed after compaction
that merely *mentions* it. One arming authorizes ONE session, never every session that can read the
transcript (§2.1, Parallel sessions: one approval reaching N sessions is N executions). The
distinction is **the owner speaking now** versus **a record of him having spoken** — permissive
loosens how he may phrase it, never who may say it or when.

⚠ **A permissive arming is NOT hook-backed.** `autorun-guard.mjs` matches the literal word only, so
an arming phrased any other way is remembered by nothing and dies at the first compaction — see the
compaction note below. When he arms it without the word on a plan that will run long, say in one line
that you are treating it as armed; that sentence is then the thing a compaction carries forward.

**While armed, BOTH protected actions above are pre-approved** — merging to `main` (which ships to
production immediately) and applying a production migration. Owner, 2026-09-05, after being shown
what each costs: *"It's okay to merge. It's okay to do anything it need."* Reaffirmed on being asked
a second time. **Do not re-ask, do not re-warn, and do not treat a phase boundary as a checkpoint.**

**The run stops ONCE: after the last phase is done AND the cleanup is done.** Not every one or two
minutes, not between phases, not to offer a suggestion, not to report progress, not to confirm
something already pre-approved. It may run for hours or days with nobody watching; assume the owner
has forgotten it and will read only the final report.

**Do not stop for any of these — absorb them and keep going:**

- **A red CI check.** Read it, fix it, push again. Report it in the final summary, never as a pause.
- **A merge conflict on the working branch.** Resolve it.
- **A business-fact question** (which brick, which area, which person). Park it, keep working, and
  deliver every parked question at the end as ONE xlsx with dropdowns, per §4.
- **A phase that is genuinely blocked.** Finish every other phase in full, then name that one and
  why. Never let one blocked phase end the run.
- **A choice you could make yourself.** §4: ask when the answer changes the outcome — under AUTORUN,
  weigh that against a run the owner is not watching, and prefer the reversible option.

**Three things AUTORUN cannot waive, because they are facts and not policy:**

1. **The Office golden rule** needs a password that exists only as a scrypt verifier
   (`pnpm run office-rule:unlock`). No flag reaches it. A plan needing it stops there and only there.
2. **A destructive or bulk PRODUCTION data change** still gets its §8 announcement, and production
   has no PITR — so under AUTORUN the announcement is not a pause: state it, take the pre-image or
   backup FIRST, prove it landed, then proceed.
3. **The other three protected files** (CLAUDE.md) are still announced before the edit — the exact
   change and why, written into the transcript. Announced, not awaited.

**The final report is the whole point.** List every merge, every production change, every migration
applied, the parked questions, and anything left undone. That report is the owner's only view of a
run he did not watch.

🔴 **AUTORUN survives compaction only where the guard hook is loaded — and it is not loaded
everywhere.** `.claude/hooks/autorun-guard.mjs` (UserPromptSubmit, live 2026-09-05) records the
arming per `session_id` and re-states it every turn; `AUTORUN OFF` stands it down. **It can re-state
an arming, never create one** — only the owner's typed word arms AUTORUN, because a hook able to arm
itself would let a doc or another session's transcript authorise a production merge (§2.1, Parallel
sessions).

**Never assume it is running.** Hooks load at SESSION START, so a session opened before the hook
merged does not have it; and each worktree carries its own `.claude/settings.json` from ITS branch,
so a worktree on a branch predating 2026-09-05 has no entry at all. Without the hook the original
hole is intact: the arming word ages out of context and the session quietly reverts to stopping
between phases — the exact behaviour AUTORUN exists to remove, failing in the one direction nobody
notices, because a session asking permission looks correct. **Both mitigations therefore stand, and
the second is the load-bearing half:**

1. **Carry it forward yourself.** While armed, restate `AUTORUN ARMED — <plan>` at the top of every
   summary you write and in every hand-off, so a compaction carries it as live text rather than as
   a description of something that happened earlier.
2. **The owner re-arms on doubt.** If a session cannot tell whether it is armed, it is NOT armed —
   finish the current phase, then say so in one line and continue asking as normal. Never assume the
   arming from a transcript that merely mentions the word.

Do not treat the hook's silence as a reason to infer arming: it is silent both when you are not
armed and when it is not loaded, and those two look identical from inside the session.

**Git hygiene.** Review `git status`, `git diff`, `git diff --cached` before committing. Stage only
files owned by the task. Never commit `.env*`, `.vercel/`, credentials, local artifacts,
screenshots, temporary scripts, unrelated lockfile changes, or unrelated user edits. Use
conventional messages (`fix(module): reason`, `feat(module): capability`, `docs(agents): change`).
`main` is production — never edit it directly. `delete_branch_on_merge` is on, so GitHub deletes the
**remote** branch automatically; the local branch and worktree survive and still need approval to
remove.
