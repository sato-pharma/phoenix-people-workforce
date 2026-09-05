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
