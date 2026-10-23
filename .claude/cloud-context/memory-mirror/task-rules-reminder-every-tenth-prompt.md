---
name: task-rules-reminder-every-tenth-prompt
description: "The TASK RULES reminder is sent at session start, after every compaction or resume, and on every 10th prompt — NOT every prompt (owner's choice, 2026-10-08; it was 51% of all hook-injected text, 97% exact repeats). Words live in ~/.claude/hooks/task-rules.txt, sent by task-rules-reminder.mjs; never restore the per-prompt bash echo. PHX_TASK_RULES_EVERY_PROMPT=1 is the escape hatch."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3a2cba8e-a064-42bb-bb4c-93a119e40088
  modified: 2026-10-08T14:29:03.201Z
---

Changed 2026-10-08, at the owner's choice from three options: "first, every 10th, compaction".

**Before:** a bash `echo` in `~/.claude/settings.json` (UserPromptSubmit) sent the TASK RULES, about 2 KB, with every prompt.

Measured over 467 Phoenix sessions in the 3 days to 8 Oct:
- 27.8 MB of the 54.4 MB of hook-injected text was this reminder, 51% of the total;
- 26.8 MB of it was an exact repeat of a copy already in the same session.

**After:**
- **The words:** `~/.claude/hooks/task-rules.txt`, byte-identical to the old echo.
- **The sender:** `~/.claude/hooks/task-rules-reminder.mjs`:
  - `session` on SessionStart (every source: startup, resume, compact, clear) always sends;
  - `prompt` on UserPromptSubmit sends on prompts 10, 20, 30 and so on, and also whenever that session has no record (fail-safe).
- **Per-session counters:** `~/.claude/state/task-rules/<session>.json`, pruned after 7 days.
- **Selftest:** `node ~/.claude/hooks/task-rules-reminder.mjs --selftest`, 9 cases. It is in `claude-scripts-backup.mjs` HOOK_SELFTESTS, and it fails if `task-rules.txt` is missing or has lost the Next step rule.
- **The weekly config review** (`claude-config-review.mjs`, `HOOK_TEXT_RAW`) reads `task-rules.txt` too, so its rule-text check still sees the words.
- **Backups:** `~/.claude/backups/settings.json.pre-task-rules-cap-2026-10-08`, and `hook-backups/claude-config-review.mjs.pre-task-rules-cap-2026-10-08`.

**Why:** the reminder never enforced anything; it only reminded.
- The same rules load on every request from `~/.claude/CLAUDE.md`.
- `next-step-capture.mjs`, a Stop hook, still WARNS on every reply whose Next step line is missing or wrong - it has NEVER blocked since 2026-10-15, and must not be made to again: a blocked Stop hook makes the app auto-continue, and the suggestion gate skips an auto_continuation turn, so the block eats the very suggestion it exists to fill.

**How to apply:**
- To change the rules' wording, edit `task-rules.txt`.
- Do not put the echo back.
- If replies start drifting from the rules, the escape hatch `PHX_TASK_RULES_EVERY_PROMPT=1` restores every-prompt sending without an edit.

**The effort-router note went the same way, also on 2026-10-08.**
- `~/.claude/hooks/effort-advisor.mjs` now speaks once per session for the same advice: same model, effort and suggested level. It speaks again only when one of those changes.
- The last advice shown is recorded in `~/.claude/relay/advice-shown/<session>.json`.
- It had repeated on every matching prompt: 1.8 MB over the same 467 sessions, 89% of it repeats.
- Backup: `hook-backups/effort-advisor.mjs.pre-once-2026-10-08`.

**Left alone on purpose:**
- Module memory. It is about 2.5 MB across all those sessions, and the owner's golden rule says it always loads.
- The trap clusters (11.6 MB). They are already sent once per cluster per session, and AGENTS.md §2.1 says they are delivered, not dropped.

Related: [[user-settings-model-and-effort-only-reach-terminal-claude]].
