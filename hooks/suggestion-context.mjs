// SessionStart hook: teach every session how the owner phrases his NEXT message.
//
// Claude Code's prompt suggestions (the ghost text in the input box) have exactly one knob:
// on/off (`promptSuggestionEnabled` / CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION). There is no custom
// prompt and no hook that returns a suggestion. What they DO have is the conversation itself —
// the suggestion is a background request that reuses this session's prompt cache. So the only
// way to shape them is to put the right context INTO the conversation, and to make the reply's
// **Next step:** line say the exact words he would type.
//
// Two blocks. ALWAYS is emitted in every folder: the no-closing ban is an owner rule everywhere
// (2026-09-15, "keeps suggestion close chat") — until that day this hook was silent outside
// Phoenix, so FTP-Portal and every other folder never received the ban at all. PHOENIX adds the
// measured vocabulary and stays Phoenix-only, because it costs context.
//
// The Phoenix vocabulary is MEASURED, not invented: mined on 2026-09-13 from the owner's typed
// prompts in his 150 most recent Phoenix transcripts (2,956 prompts). "merge it" alone opened
// 266 of them. Re-mine before editing the ranking; do not reorder it from memory.
//
// Fires on startup, resume, clear and compact (compaction can drop the earlier copy).
import fs from 'node:fs';

// 2026-09-15, second ruling the same day: "it keeps me in a loop — it must focus on completing the
// task, then suggest the next step". The morning's fix for the closing ban made EVERY reply carry
// a command to type, with "check other pending items" and "polish <x> again" as fallbacks, so a
// finished task always handed him another turn. Those fallbacks are gone.
//
// 2026-09-18 AMENDS THAT: "always put something in the box". Answering "nothing is a valid answer"
// left his input box reading "<no suggestion>" turn after turn, and he ruled against it after
// watching it happen. Only the EMPTY OUTCOME is retired — the loop ban was always about WHAT gets
// suggested (never a re-check, a status read, a closing word) and it stands in full. When nothing
// needs him the box carries the next REAL action, never filler and never invented work.
const ALWAYS = `PROMPT SUGGESTION RULES — owner rules, every folder (2026-09-15, amended 2026-09-18). Apply to every **Next step:** line, and to a wrap_up reply button wherever this session has that tool.
FINISH FIRST. The task is completed before anything is suggested. Anything Claude can do itself — re-check, re-run, verify, polish, look up a status, run the tests, show a diff — is done in the same turn, never suggested as his next message.
ALWAYS PUT SOMETHING IN THE BOX (owner rule, 2026-09-18 — his words). The suggestion is NEVER empty. Prefer what genuinely needs him: a decision, an approval (merge, publish), a click only he can make, or information only he has. Commit, push and opening the PR are Claude's own work since 2026-09-16 — done in the turn, never suggested.
- THE SURFACE IS WHICHEVER ONE THE RUNNING BUILD GIVES, AND THE QUOTED WORDS ARE THE CONSTANT. He put app build 2.31226.1 BACK on 2026-10-15 20:03 Cairo (from his own kept Claude-2.31226.1.msix), and that build mounts NO turn box: there is no mcp__ccd_turn__ pair in the session, so the app never drops the suggestion request and THE GHOST TEXT IS BACK - the **Next step:** line’s curly-quoted words reach his input box again and Tab+Enter sends them. On the 2026-10-13 build (app 44.7.0) the app mounted the turn box and zeroed the suggestion (zt && (Q.promptSuggestions = void 0)), and there the SAME words ship as a wrap_up REPLY BUTTON, actions[0].message verbatim. So: ALWAYS end the line in the words he would type; call mcp__ccd_turn__wrap_up with actions[0] = { label: <1-3 words>, message: <those words, VERBATIM> } WHENEVER that tool exists in the session, and never mention a box he has not got. next-step-capture.mjs clause 7 warns about a missing button ONLY in a session whose tool list carries mcp__ccd_turn__.
- If the last reply's **Next step:** line ends in curly-quoted words, the suggestion - ghost text, or a button where the turn box exists - is those words, verbatim.
- A question was put to him -> the recommended answer, naming it ("use option A for the certificate").
- Finished work that needs his approval -> "merge" + the real PR number + "when green" (the way "merge 3805 when green" names 3805). Never a placeholder inside the quoted words: the suggestion echoes it verbatim, and he sent one unfilled on 2026-09-17.
- Nothing needs him -> the next REAL action, named with its real target ("open cns and pedia on production", "fix the Settings tab copy"). Never filler, and never invented work — if the thread has an obvious next move, that is the suggestion.
LOOP BAN. Never suggest anything that re-enters work Claude could have finished: check / verify / status of something again, polish again, continue, check other pending items, show me the diff, run the tests. Never carry another session's next step into this one.
CLOSING BAN. The owner never types a closing message. Never suggest, in any wording or language: close, end, stop, quit, exit, leave, bye, done, finish, wrap up, thanks, ok, cool, perfect, a bare yes or go, or a question back to Claude.
NEVER ECHO THE NEXT STEP LINE BACK AT HIM. "nothing waits on you — <what finished>" is CLAUDE'S sentence, not a phrase he has ever typed — never suggest it, a paraphrase of it, or a shortened "nothing waits on you." He typed one back on 2026-09-16 because it was offered as ghost text, and it cost him a turn. Since 2026-09-18 that sentence should not appear in a **Next step:** line at all: the line always ends in words he could send as-is.`;

const PHOENIX = `PHOENIX SUGGESTION CONTEXT — how the owner phrases his NEXT message, measured from 2,956 prompts he typed in his last 150 Phoenix sessions. Use it for the **Next step:** line and for any predicted next prompt.
He types short imperatives. His ship cycle, in his own words:
1. "fix the" + the real thing's name · "now fix" + the real thing's name
2. commit and open the PR · push it and open the PR   (automatic since 2026-09-16 — never suggested)
3. merge it when green · "merge" + the real PR number + "when CI is green"   ("merge it" opened 266 of the 2,956)
Every suggestion names its real target; never copy a placeholder or a pattern word from this list into one.
4. retire the worktree · delete the branch too
A production migration is NOT one of his stages: AGENTS.md §8 pre-authorizes Supabase writes, apply_migration included — Claude applies it in the turn, announcing a destructive or bulk production change first. Never suggest "apply the migration".
Stage 2 (commit, push, open the PR) is AUTOMATIC since 2026-09-16 (owner rule) — Claude does it in the turn, never suggests it. Only the stages that need HIS approval are suggestions: merge, and retire the worktree and delete the branch. Verifying production after a merge, watching CI and reading a status are Claude's own work — do them in the turn and report the result; never suggest them. When the cycle is complete the box is STILL not empty (owner rule, 2026-09-18) — it carries the next REAL action in the thread, named with its real target. Never skip a stage, never repeat one already done.
Never predict an approval that is not his, or an override: approving for the CEO, sending email, publishing or reopening a month, re-raising a settled decision. A protected action names its target ("merge 3805 when green", "retire _wt-closing-fix and delete its branch") — never a bare "yes" or "go".`;

// 2026-10-12, owner: "ALWAYS SUGGESTIONS ON NEVER OFF". Self-heal both switches at every session
// start. A /config toggle, an app update or a settings rewrite could flip them off, and nothing
// would put them back. Text-level edit only, so the rest of settings.json keeps its exact layout.
// The Windows user variable is re-set only when this process did not inherit it, so an ordinary
// start spawns nothing.
let healed = '';
try {
  const file = `${process.env.USERPROFILE || process.env.HOME}/.claude/settings.json`;
  const raw = fs.readFileSync(file, 'utf8');
  let next = raw.replace(/("promptSuggestionEnabled"\s*:\s*)false/, '$1true')
    .replace(/("CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION"\s*:\s*)"(?!true")[^"]*"/, '$1"true"');
  // A key that is missing altogether: re-serialize (the layout changes only in that rare case).
  const parsed = JSON.parse(next);
  if (parsed.promptSuggestionEnabled !== true || parsed.env?.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION !== 'true') {
    parsed.promptSuggestionEnabled = true;
    parsed.env = { ...(parsed.env || {}), CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'true' };
    next = `${JSON.stringify(parsed, null, 2)}\n`;
  }
  if (next !== raw) {
    JSON.parse(next); // never write a file that no longer parses
    fs.copyFileSync(file, `${file}.pre-suggestion-heal`);
    fs.writeFileSync(file, next);
    healed += ' settings.json';
  }
  if (process.platform === 'win32' && process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION !== 'true') {
    (await import('node:child_process')).execFileSync('setx', ['CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION', 'true'], { stdio: 'ignore', windowsHide: true });
    healed += ' windows-user-variable';
  }
} catch {}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
  const cwd = String(input?.cwd || process.cwd());
  let text = /phoenix/i.test(cwd) ? `${ALWAYS}\n\n${PHOENIX}` : ALWAYS;
  if (healed) text += `\n\nPROMPT SUGGESTIONS WERE OFF and were switched back on at session start (${healed.trim()}). Owner rule 2026-10-12: always on, never off. Tell him in one line.`;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }),
  );
} catch {}
process.exit(0);
