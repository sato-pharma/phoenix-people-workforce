---
name: ask-deny-strip-is-committed-not-live
description: "The owner's 2026-08-14 request to empty the repo's permissions.ask/.deny WAS done and committed (9dc46657) but never pushed — a branch switch in the shared folder took it out of the working tree, so LIVE is still ask=16/deny=3."
metadata: 
  node_type: memory
  type: project
  originSessionId: 6796632f-f080-4e9e-8cee-93af8f3cbe33
  modified: 2026-08-14T02:24:42.486Z
---

On 2026-08-14 the owner instructed, three times and after being shown the trade-off, that this repo's
permission behavior be made identical to `F:\FTP 2026\FTP PORTAL` (which ships **no** committed
`.claude/settings.json` at all — that folder difference, not the account, was the whole cause of his
"many blocks on auto mode" complaint; see [[both-max-accounts-share-one-local-config]]).

**It was done, and it is NOT in effect.** Commit `9dc46657`
*"chore(claude): empty the project ask/deny rules and correct the docs describing them"* — 3 files,
`.claude/settings.json` (ask→`[]`, deny→`[]`, all 81 allow + all 4 hooks untouched), `CLAUDE.md`,
`AGENTS.md` — lives **only on branch `codex/recruitment-minor-findings`**. It was never pushed, so
PR #2116 (merged 02:09Z from that same branch) did not carry it. A parallel session then switched the
shared folder to `codex/intake-retry-duplicate-candidate`, and the working tree went back to
**ask = 16, deny = 3** (verified live: 5567 bytes, `CLAUDE.md:87` reads the original paragraph).

**Why:** nothing was lost or overruled — the commit is safe on its branch. But any session that reads
the old note, or CLAUDE.md's own text, and concludes "no dialog will fire on the protected files" is
wrong. Prompts on `Bash(git push*)`, `Bash(gh pr merge*)`, the six `mcp__*github*` write tools and
`Edit`/`Write` on the three protected files are all still armed right now.

**How to apply:**
1. **Do not re-apply it into another session's branch.** The folder is shared; dropping three
   unrelated file edits into someone's recruitment PR is the §5 hazard. Restore it only from a branch
   of your own: `git cherry-pick 9dc46657`.
2. If the owner complains about permission prompts again, this is the answer — and check
   `git branch --show-current` first, because whether the relief is present depends entirely on which
   branch the folder is sitting on.
3. **The locks never depended on the settings file anyway.** CLAUDE.md's own wording governs: "This
   lock is behavioral first, whatever the settings say," and "never read its absence as approval."
   The protected-file gate, the merge-approval gate (AGENTS §6) and the never-`--auto` rule
   (AGENTS §2) bind either way. Ask in plain words.
4. The auto-mode classifier blocked the original edit and allowed it only after the owner
   re-authorized explicitly in chat — a soft block, clearable by stated user intent, not a hard one.
