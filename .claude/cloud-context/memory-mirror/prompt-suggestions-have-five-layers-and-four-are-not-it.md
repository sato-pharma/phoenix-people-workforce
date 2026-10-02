---
name: prompt-suggestions-have-five-layers-and-four-are-not-it
description: "\"Suggestions not appearing\" has FIVE independent layers, and the four a session reaches first are almost always already correct — the one that is usually the answer is the APP's own `prompt_suggestions`, which the app says applies only from a session's next start or resume. Holds the measured ladder, the commands for each rung, and the two things that are NOT the cause (the status bar and the Stop hook)."
metadata:
  node_type: memory
  type: project
  originSessionId: 0e88bd89-241a-48ce-8073-3ee1d7f63569
  modified: 2026-10-02T17:30:15.852Z
---

Measured end to end on 2026-10-02, after the owner reported *"suggwstions again not appearing"*. Every
one of the first four rungs was already correct, so a session that stops at any of them concludes
"it should be working" and has nothing to offer him.

**The ladder, in the order worth checking — cheapest and most-often-wrong LAST, deliberately:**

1. **CLI env var, both copies** (his standing rule — never remove either):
   `node -e "const s=require('C:/Users/satoh/.claude/settings.json');console.log(s.env?.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, s.promptSuggestionEnabled)"`
   and `powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION','User')"`.
   Both read `true` on 10-02. `Machine` being empty is CORRECT — the rule asks for the User variable.
2. **Usage throttle.** The global rule says the variable is what keeps suggestions on *near the usage
   limit*, so a session reaches for this early. `get_usage` read **47%** of the 5-hour window and
   **13%** weekly — nowhere near, so it was not the cause. Measure it rather than assuming it.
3. **Context size.** 37% of 800k, auto-compact at 96%. Not it.
4. 🔴 **THE STATUS BAR IS A DIFFERENT FEATURE AND IS NOT THE ANSWER — do not spend the turn there.**
   `next-step-capture.mjs` (Stop hook) writes `~/.claude/.next-step/<sessionId>.txt` and
   `statusline.mjs` prints it as a row. Both worked perfectly: the file was written within a second of
   the reply, holding the line **with the curly quotes intact** (verify with `od -c`: `342 200 234` is
   U+201C, `342 200 235` is U+201D), and running the statusline script with the app's own stdin JSON
   printed the `> Next step:` row, exit 0. **The owner distinguishes the two** — asked whether the bar
   or the in-box ghost text was missing, he answered *"non this nor this"*.
5. 🔴 **THE APP'S OWN `prompt_suggestions` — the rung only `mcp__ccd_settings__get_settings` can see,
   and the one that carries the real constraint.** It is a *separate* setting from the two in
   `~/.claude/settings.json`, and its own text is the finding:
   **"Show a suggested next prompt in the message box after each reply. Each suggestion is one more
   model request. _Applies from a session's next start or resume._"**
   So the switch reading `On` does **not** mean this session has it — a session that was running when
   it changed, or that had its model switched mid-session (`/model` was used here), carries whatever
   it started with. **The lever is a fresh session, which is HIS click**, and it goes in the prose,
   never in the Next step box ([[never-put-his-physical-actions-in-the-next-step-box]]).

**How to answer him:** report the four rungs as measured-and-ruled-out with their numbers, then rung 5
as the live one, and put the fresh session in the prose. Never tell him to reinstall, never restart
the app ([[claude-app-slow-is-a-stale-worktree-watch]] — and his rule is that the app is never yours to
restart), and never remove either env copy to "reset" it: an audit removed one on 2026-09-15 and he
ordered it back.

**Collateral, confirmed the same day:** ports 3000 and 3001 were both **`ssh.exe` Railway tunnels** at
11 MB and 10 MB, not dev servers — exactly [[a-listener-on-port-3000-may-be-the-preview-tunnel]]. So a
RAM recommendation built on "stop the dev server to get 3.5 GB back" would have been fiction; there was
no dev server at all, and the pressure was the 8 open sessions.
