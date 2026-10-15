// Stop hook: ENFORCE the "Next step:" line on every reply, and capture it so
// statusline.mjs can print it on the bar the owner is typing at.
//
// This runs after EVERY reply, so it has to be cheap and it has to be silent.
// Two constraints drove the shape of it:
//   1. Transcripts here reach tens of MB (sessions run for days), so it reads only
//      the tail of the file, never the whole thing.
//   2. A Stop hook that throws is noise on every single turn. Everything is wrapped;
//      on any failure the previous value simply stays on screen.
//
// MODE: `node ~/.claude/hooks/next-step-capture.mjs selftest` runs the decision table against the
// REAL hook as a child process and prints `0 failed` — 31 cases as of 2026-10-06. Added that day
// because this file lives OUTSIDE the repository, so no CI job and no repo test could ever see it
// weaken: every clause below was added after a measured failure reached his input box, and a
// regression would simply let that failure through again, silently, on every reply.
//
// Nothing here may be verified by reading it. Break a clause, run the selftest, and watch the
// assertion that OWNS that clause fire alone — proved 2026-10-06 on three separate breaks
// (isMoneyMove's clause loop, isHisOwnClick's clause loop, and the stop_hook_active guard), and
// restore from a copy, never from git, since this file is not in git at all.
//
// The hourly off-machine backup (~/.claude/scripts/claude-scripts-backup.mjs, HOOK_SELFTESTS) runs
// that mode AFTER pushing the source, so a weakened hook reaches the backup branch and only then
// fails the task into one Telegram message.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.USERPROFILE || os.homedir();
const DIR = path.join(HOME, '.claude', '.next-step');
const TAIL_BYTES = 512 * 1024;
const PRUNE_AFTER_MS = 7 * 24 * 3600 * 1000;

/** Read only the last TAIL_BYTES of a file, dropping the half-line at the seam. */
function tail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return size > len ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Walk the transcript backwards to the last thing the main assistant actually SAID.
 * Skipped on the way: sidechain entries (those are subagent output, not the reply)
 * and tool-only turns (real content, but no text block to search).
 */
function lastAssistantText(jsonl) {
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant' || entry.isSidechain) continue;
    const blocks = entry.message?.content;
    if (!Array.isArray(blocks)) continue;
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}

/**
 * Pull the recommendation out of "**Next step:** do the thing".
 *
 * Takes the FIRST match, and only on a line that STARTS with the phrase.
 *
 * Both halves changed on 2026-09-08, when the owner moved the recommendation to the
 * TOP of the reply ("okkay but put ur recommendation first", 2026-09-07 — AGENTS.md §4).
 * This used to keep the LAST match on a line matching anywhere, which was right while
 * the rule said "closing line": the real one came last, so last-wins made the phrase
 * safe to use mid-reply.
 *
 * Under the new ordering that inverts, and it fails silently in the one direction
 * nobody notices — the reply looks correct and the bar shows something else. Measured
 * against the old rule on 2026-09-08, with a correct opening line present:
 *
 *   "...after that the next step: is yours to choose."   -> bar read "is yours to choose."
 *   a quoted table row of BAD examples                    -> bar read 'run the tests, or open the PR." |'
 *
 * Anchoring kills both: prose starts with a word, a table row starts with "|", and
 * neither is the recommendation. Leading whitespace and the "**" of the bold marker are
 * allowed because they are part of the documented format.
 *
 * NO FALLBACK to the old loose match, deliberately. A reply that does not carry the
 * format leaves the bar EMPTY, and empty is meaningful here (see the write below) — the
 * statusline nudges about it. A blank bar is a visible failure; the wrong sentence
 * confidently displayed is not.
 */
function extractNextStep(text) {
  let found = null;
  for (const line of text.split('\n')) {
    // The `\**` before the separator is what lets "**Next step** — do the thing" match. The doc
    // promises `:`, `—` and `-` all work; without it, only the colon-inside-the-bold form did, and
    // the other two blanked the bar while looking exactly like the documented format.
    const m = /^\s*\**\s*next step\s*\**\s*[:—-]\s*\**\s*(.+)$/i.exec(line);
    if (m) {
      found = m[1];
      break;
    }
  }
  if (!found) return '';
  return found
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // markdown link -> its label
    .replace(/[`*_]/g, '') // the statusline is ANSI, it cannot render markdown
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Count the "**Next step:**" lines the reply actually SAID (not ones it quoted while
 * explaining this hook - stripQuoted blanks those). The owner rule is exactly one, at the
 * very top, NEVER repeated at the bottom. It has to be enforced here because extractNextStep
 * reads only the FIRST match: a second line therefore escapes every content check below, which
 * is precisely how a placeholder ("<the thing you wanted to do>") reached his box on
 * 2026-09-29 - the good opening line passed, the bad repeat was never looked at.
 */
function countNextSteps(text) {
  let n = 0;
  for (const line of stripQuoted(text).split('\n')) {
    if (/^\s*\**\s*next step\s*\**\s*[:—-]/i.test(line)) n++;
  }
  return n;
}

/** Old sessions never come back; do not let their files pile up forever. */
function prune() {
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  for (const name of fs.readdirSync(DIR)) {
    const file = path.join(DIR, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {}
  }
}

/**
 * THE RULE IS MECHANICAL FROM 2026-09-17, NOT BEHAVIORAL: every reply opens with a
 * "**Next step:**" line, whatever the model, the effort level or the permission mode.
 *
 * Until today the only thing carrying it was prose — the UserPromptSubmit TASK RULES and
 * ~/.claude/CLAUDE.md — and prose loses on a tired model. A reply that skipped the line just
 * blanked the bar (an empty capture file prints nothing, since the 2026-09-15 loop fix), so
 * the miss was INVISIBLE and nothing corrected it. The owner asked for it back on 2026-09-17:
 * "after each message ... any type any model any effort he show me a suggested next step".
 *
 * IT WARNS, IT NEVER BLOCKS (owner, 2026-10-15: "never stop suggestions from appearing in the
 * text box even if the usuage is 99.99%"). It used to answer {decision:"block"}, which hands
 * `reason` to the model and makes it keep going. That lever cost the very thing it protected:
 * a blocked Stop hook makes the desktop app auto-continue, and the app's Agent-SDK suggestion
 * gate skips any turn whose origin is "auto_continuation" BY NAME - so every block silently
 * spent the suggestion this hook exists to fill. It blocked twice on 2026-10-15 and he watched
 * the box come up empty both times. It now emits a `systemMessage`: the model reads the verdict
 * and the NEXT reply carries the line, while the reply already on screen stands and the turn ENDS
 * normally - which is the only state in which the app offers a suggestion at all.
 *
 * IT STILL FIRES AT MOST ONCE PER TURN. `stop_hook_active` stays honoured, so a continuation
 * started for any other reason is not warned at a second time.
 *
 * It FAILS OPEN everywhere else — no transcript, no text, a throw, a tool-only turn: the turn
 * ends. A hook that can strand a reply is worse than a missing line.
 */
const NUDGE = `Your reply is missing its opening line, which is required on EVERY reply. The task itself is finished: do not redo any work, do not re-run anything, do not re-verify. Output ONLY that one line, at the top. It ALWAYS ends in the exact words he would type, in curly quotes, naming the real target (the way “merge 3805 when green” names 3805) — owner rule, 2026-09-18, "always put something in the box":

  **Next step:** <the one thing that genuinely needs him — a decision, an approval, a click only he can make, or information only he has> — “<his words, naming the target>”

  **Next step:** <what just finished, when nothing needs him> — “<the next real action, naming its target>”

Never suggest: commit / push / open the PR (your own work since 2026-09-16), a re-check, a re-run, a status read, "continue", "check other pending items", any closing word (done, thanks, ok, bye, a bare yes), or a money move - paying, approving, holding, moving or re-dating money is decided on its own screen, never in chat (owner rule, 2026-09-18).`;

/**
 * CONTENT CHECKS - added 2026-09-17, after the owner watched his input box show
 * "<no suggestion>" on the one turn where something really did need him.
 *
 * The reply that produced it read:
 *   "**Next step:** nothing waits on you - the agent fixes are pushed and I'll merge
 *    #3956 on this green and verify production."
 *
 * Two rules broke in one sentence and nothing mechanical was watching either. A session
 * NEVER merges without his approval (CLAUDE.md, "ALWAYS ask before merge"), and the
 * "nothing waits on you" form deliberately carries no quoted words - so the suggester did
 * exactly what it is told and offered nothing, at the precise moment "merge 3956 when
 * green" was owed. The line read fine, the box sat empty, and no part of the machine
 * disagreed. Prose had been carrying this since 2026-09-15, and prose lost again.
 *
 * Each check costs one extra model turn when it fires, so each one fires only on evidence
 * of its own specific failure, never on a shape it merely dislikes. All are skipped on the
 * continuation pass (stop_hook_active), exactly like the missing-line block.
 */
const MERGE_CLAIM = /\b(?:i(?:'|\u2019)?ll|i\s+will|i(?:'|\u2019)?m\s+going\s+to|going\s+to)\s+(?:then\s+)?(?:squash[-\s])?merge\b/i;
const NOTHING_WAITS = /nothing\s+waits\s+on\s+you/i;
const PR_NUMBER = /(?:#|\bPR\s*#?\s*)(\d{3,5})\b/;

// A closing word, or work the session should have finished itself. Echoed verbatim into the
// box, each of these costs him a turn typing something back that changes nothing.
const BANNED_EXACT = new Set([
  'done', 'thanks', 'thank you', 'ok', 'okay', 'k', 'cool', 'perfect', 'nice', 'great',
  'yes', 'yep', 'yeah', 'go', 'go ahead', 'continue', 'close', 'stop', 'exit', 'quit',
  'bye', 'finish', 'wrap up', 'sounds good', 'no', 'nothing',
]);
const BANNED_START =
  /^(?:re-?check|check\s+(?:it|that|them|again|the\b)|verify\b|status\b|run\s+the\s+tests\b|show\s+me\s+the\s+diff\b|polish\b|nothing\s+waits\s+on\s+you)/i;
const PLACEHOLDER = /[<>[\]{}]|\bpr number\b|\bthe number\b|\bname here\b/i;

/**
 * A MONEY MOVE IN THE BOX - owner rule, 2026-09-18: "things that have money ... don't tell me
 * to approve it from here". Money is decided on its own screen, by his click, never by words he
 * sends back to a session.
 *
 * The reply that produced it quoted "pay Nahed's Tanta trip in September's payroll" - a trip
 * move on production, offered as a one-line OK. Every rule it needed already existed in prose
 * ("never approve on anyone's behalf - and never suggest it"), and the box offered it anyway.
 *
 * Read per CLAUSE, by the verb that opens it ("open X and pay Y" still carries the pay):
 *   - a verb that moves money on its own blocks alone (pay, refund, deduct ...);
 *   - a decision verb blocks only beside a money noun ("hold the 23 outstation requests",
 *     never "hold off on the rename");
 *   - an amount verb needs a money noun AND a digit ("add 511 to Nahed's expenses", never
 *     "add the salary column to the export").
 * Code work passes: merge, fix, build, make, open, investigate and retire are none of these,
 * which is also the escape the block message offers for a rule or a screen worded as a move.
 */
const MONEY_NOUN =
  /\b(?:payroll|salar(?:y|ies)|expenses?|claims?|trips?|allowances?|deductions?|bonus(?:es)?|incentives?|payouts?|payslips?|batch(?:es)?|egp|pounds?|amounts?|reimbursements?|per[\s-]?diem|overtime|loans?|refunds?|money|fuel|outstation)\b/i;
const MONEY_ALWAYS = new Set(['pay', 'repay', 'refund', 'reimburse', 'deduct', 'disburse', 'credit', 'debit', 'dock']);
const MONEY_DECIDE = new Set([
  'approve', 'accept', 'reject', 'decline', 'release', 'hold', 'unhold', 'un-hold', 'move', 'redate',
  're-date', 'rebook', 'waive', 'settle', 'reopen', 'override', 'restore', 'zero', 'apply', 'publish',
  'unpublish', 'carry',
]);
const MONEY_AMOUNT = new Set(['add', 'raise', 'increase', 'reduce', 'lower', 'trim', 'cut', 'set', 'change']);
const LEAD_FILLER = /^(?:(?:now|then|please|also|ok|okay|yes|go ahead and)\s+)+/;

function isMoneyMove(plain) {
  const noun = MONEY_NOUN.test(plain);
  for (const clause of plain.split(/\s*(?:[,;]|\band\b|\bthen\b)\s*/)) {
    const verb = (clause.replace(LEAD_FILLER, '').match(/^[a-z-]+/) || [''])[0];
    if (MONEY_ALWAYS.has(verb)) return true;
    if (noun && MONEY_DECIDE.has(verb)) return true;
    if (noun && MONEY_AMOUNT.has(verb) && /\d/.test(plain)) return true;
  }
  return false;
}

/** The words he would actually type: the LAST quoted span on the line. */
/**
 * HIS OWN CLICK IN THE BOX - the mechanical cause of the 2026-09-26 loop, measured at six dead turns.
 *
 * The box echoes the quoted words verbatim, so whatever goes there is what he SENDS BACK. An approval
 * of work already done lands perfectly ("merge 4460", "retire the worktree"): his sending it IS the
 * approval, and the session acts on it. An instruction to go and DO something in a system the session
 * cannot reach - Railway's variable screen, the Headwind console, his own terminal, his browser - lands
 * as a request the session must then decline, and the turn buys nothing.
 *
 * On 2026-09-26 that happened six times in a row: "set the HEADWIND_MDM variables on the Phoenix
 * service", "create the phoenix account and set the login and password", "apply the two variables and
 * press Deploy in railway", "run node scripts/headwind-bootstrap.mjs", "run node
 * scripts/headwind-bootstrap.mjs in the repo root", "open the rep tablets page on production". Each
 * one came straight back and each one was answered with a paragraph explaining why it could not be
 * done. Prose had already said not to; prose lost, the same way it lost on the money move.
 *
 * The rule the block encodes: the box carries an APPROVAL of the session's own work, or a DECISION he
 * answers in words. What he must do with his own hands is named in the reply's BODY, never quoted for
 * him to send. So this fires only on an imperative that also names an unreachable surface, and never on
 * an approval verb.
 */
const APPROVAL_START =
  /^(?:merge|retire|delete|remove|publish|announce|unlock|approve|reopen|rename|fix|build|make|add|write|use|keep|drop|investigate|audit|open\s+(?:a\s+)?(?:pr|issue))\b/i;
const OUTSIDE_SURFACE =
  /\b(?:railway|railway's|headwind\s+console|the\s+console|console's|cloudflare|zero\s+trust|dashboard|terminal|powershell|chrome|browser|supabase\s+dashboard|play\s+console|app\s+store|managed\s+(?:google\s+)?play|private\s+apps|iframe|play\s+developer|google\s+cloud|cloud\s+console|api\s+access|billing|expo\.dev|app\s+settings|settings\s+page|aab)\b/i;
const OUTSIDE_IMPERATIVE =
  /^(?:set|apply|press|click|type|paste|enter|put|store|save|update|copy|switch|create|sign\s+in|log\s+in|login|run|install|configure|choose|pick|select|scan|tap|toggle|turn\s+on|turn\s+off|upload|download|restart|reboot|open)\b/i;

/**
 * Verbs that are ALWAYS his hands, whatever surface (if any) they name.
 *
 * 🔴 ADDED 2026-09-29, after `upload the code-5 aab in the Managed Play iframe on Oct 1` reached his
 * input box and he sent it straight back. OUTSIDE_IMPERATIVE matched `upload`, but the surface was
 * written as the "Managed Play iframe" — and OUTSIDE_SURFACE only knew `play console`, so the
 * surface test returned false and the whole check passed a physical act. That screen is now in the
 * list, along with the other places he is sent to click (Private apps, Play developer / API access,
 * Google Cloud, billing, expo.dev).
 *
 * But a surface list can only ever be as complete as the last incident, which is why these verbs no
 * longer need one. Pressing, clicking, tapping, scanning a QR and physically handling hardware are
 * things this session cannot do at all — the owner's standing rule is never to control his screen —
 * so an imperative starting with one of them is his hands by definition, named surface or not. That
 * closes `press edit beside app file` and `scan the config 3 QR`, neither of which named a surface
 * the list knew either.
 *
 * Deliberately NOT here: upload, download, install, run, set. Each is something this session really
 * does — it uploaded the mdm APK to Headwind over the API and installed it on a tablet remotely — so
 * those stay gated on naming a surface it cannot reach.
 *
 * `aab` sits in OUTSIDE_SURFACE for the same reason, even though it is an artifact rather than a
 * screen: that list is really "places this session cannot reach", and an .aab has exactly one
 * destination — the managed-Play Private apps iframe. Proved 2026-09-29 by opening the Play Console
 * in his own Chrome: the account has no developer account at all (it redirects to /console/u/0/signup),
 * so there is no API-access page, no service account and no `eas submit` — the upload is his click or
 * it does not happen. An .apk is the opposite and stays unguarded, because Headwind takes one over
 * the REST API. If automated Play publishing ever becomes real, drop `aab` from the list.
 */
// 🔴 The tick family joined on 2026-10-01, after `untick صيدلية العروبة - عابدين before you confirm
// the rest` reached his box — the FOURTH physical act of that session and the second to defeat this
// clause, this time because the verb was simply not listed. These are GUI-only words with no second
// reading. `select`, `choose` and `pick` are deliberately NOT here: he really does say "pick the
// september month" and "choose option A" as decisions this session then acts on.
const ALWAYS_HIS_HANDS =
  /^(?:press|click|double-click|right-click|tap|untick|tick|deselect|toggle|drag|hover|scan|plug|unplug|swipe|photograph|factory\s+reset|power\s+(?:on|off)|hold\s+(?:down\s+)?the\b)/i;

const ENV_VAR_NAME = /\b[a-z0-9]+_[a-z0-9]+(?:_[a-z0-9]+)*\b/;

/**
 * Telling a PERSON something — the other half of "his hands", added 2026-09-29.
 *
 * ALWAYS_HIS_HANDS covers what he does with a screen or a device. This covers what he does with his
 * phone: `tell HR to start scanning the hiring documents`, then `tell HR to work the pedia checklist
 * first` TWICE, in one session, all three offered as ghost text by the model that then had to
 * decline them. It is the HARDER case, because it passes every test the physical one fails — it is a
 * real next action, it genuinely needs him, it is unambiguously his call, and it contains no
 * physical verb and no surface. The only thing separating `tell HR to work the pedia checklist
 * first` from `merge 4729 when green` is who performs it.
 *
 * This session cannot send it: nothing outbound reaches staff from a business system on Claude's own
 * say-so (AGENTS.md §4, and the standing ban on bulk or test sends). Drafting the message is the
 * model's work and belongs in the reply body, in full and ready to paste; sending it is his.
 *
 * SCOPED TO AN IMPERATIVE ABOUT A THIRD PARTY, so the ordinary instructions survive. `tell me what
 * the closing shows` is him asking the model for something and is not matched (the recipient is
 * `me`/`us`); `ask him about the Saginko price` is not matched for the same reason. What is matched
 * is tell/ask/remind/message/email/whatsapp/call/chase/notify/inform/announce/escalate aimed at
 * somebody who is not this conversation.
 */
const MESSAGE_TO_A_PERSON =
  /^(?:please\s+)?(?:tell|ask|remind|message|text|email|e-mail|whatsapp|call|ring|chase|notify|inform|announce\s+to|escalate\s+to|follow\s+up\s+with|check\s+with|confirm\s+with|reply\s+to|answer)\s+(?!me\b|us\b|myself\b)[a-z0-9@._'-]/i;

function isMessageToAPerson(plain) {
  return MESSAGE_TO_A_PERSON.test(plain);
}

/**
 * An APPROVAL VERB whose object is a set of records on a screen — the fourth failure class, and the
 * one that defeated every clause above because approvals are what this box is FOR.
 *
 * 🔴 FIVE TIMES ON 2026-10-01, all mine, all on the Phoenix CRM customer-links screen: `decide those
 * 21`, `confirm the 17 mechanical pharmacy names`, `open customer links and press The certain ones`,
 * `untick صيدلية العروبة - عابدين before you confirm the rest`, `confirm the 26 certain pharmacy
 * links on production`. The last was written with this very rule in view, which is why it stopped
 * being a behavioural matter.
 *
 * `APPROVAL_START` deliberately lets `approve` through, and rightly: `merge 5036` and `approve the
 * batch` are the box's whole purpose. What separates the bad ones is not the verb but the OBJECT —
 * and behind that, WHERE THE RECORD OF THE APPROVAL GETS WRITTEN. `merge 5036` is recorded by this
 * session acting on his message; confirming an identity link is recorded by his press inside his own
 * authenticated session, which writes `admin_approved`, the field that exists to mean A PERSON
 * LOOKED as against `system_validated`. A session pressing it forges who looked.
 *
 * So the test is for an approval verb with NOTHING THIS SESSION CAN ACT ON: no PR number, no branch,
 * no worktree, no file path, no command. A surface list was tried first and rejected — the five lines
 * above name five different things ("those 21", "pharmacy names", "the rest", "links on production"),
 * and a list is only ever as complete as the last incident.
 */
// 🔴 `link` and `unlink` were in this list for one test run and came straight out: they blocked
// `link the phoenix app to config 3 and push the rules`, which is the GOOD example this memory
// itself recommends — the instruction that FOLLOWS a physical act. The verb is too overloaded (link
// an app to a config, link a branch to a PR) and a false positive here costs a real suggestion.
// `link the two victoria rows` therefore still passes; that is the accepted price.
const APPROVAL_OF_RECORDS = /^(?:confirm|decide|accept|reject|tick\s+off|sign\s+off)\b/i;
const SOMETHING_TO_ACT_ON = /\b(?:\d{3,6}|codex\/[a-z0-9-]+|_wt-[a-z0-9-]+|[\w.-]+\.(?:ts|tsx|mjs|sql|json|md)|node\s+scripts|gh\s+pr)\b/i;

function isApprovalWithNothingToActOn(plain) {
  if (!APPROVAL_OF_RECORDS.test(plain)) return false;
  return !SOMETHING_TO_ACT_ON.test(plain);
}

function isHisOwnClick(plain) {
  // A GUI/hardware verb is his hands even when no surface is named — see ALWAYS_HIS_HANDS.
  // Checked BEFORE the approval allow-list: "press" is never an approval, whatever follows it.
  if (ALWAYS_HIS_HANDS.test(plain)) return true;
  // 🔴 AND IN ANY CLAUSE, NOT ONLY THE FIRST — measured 2026-10-01. `ALWAYS_HIS_HANDS` is
  // `^`-anchored, so one conjunction defeated it: "open customer links and press The certain ones"
  // starts with `open`, which is surface-gated, and the `press` behind the `and` was invisible.
  // He sent it back verbatim, the third physical act of that session. Each clause is tested with
  // the SAME regex rather than un-anchoring it, so "add a press release page" still passes — the
  // verb has to open a clause, exactly as it had to open the line.
  for (const clause of plain.split(/\b(?:and|then|after\s+that)\b|[,;]/i)) {
    if (ALWAYS_HIS_HANDS.test(clause.trim())) return true;
  }
  if (isApprovalWithNothingToActOn(plain)) return true;
  if (APPROVAL_START.test(plain)) return false;
  if (!OUTSIDE_IMPERATIVE.test(plain)) return false;
  // Naming a variable is naming his Railway screen, even when the screen is not named.
  if (ENV_VAR_NAME.test(plain)) return true;
  // `run node scripts/...` and `run pnpm ...` are his terminal even when no surface is named.
  if (/^run\s+(?:node|pnpm|npm|npx|git|railway|gh)\b/i.test(plain)) return true;
  return OUTSIDE_SURFACE.test(plain);
}

function quotedWords(step) {
  const re = /[\u201c"]([^\u201d"]{1,200})[\u201d"]/g;
  let m;
  let last = '';
  while ((m = re.exec(step))) last = m[1];
  return last.trim();
}

/**
 * Blank out what a reply QUOTES, leaving only what it SAYS: fenced blocks, blockquotes,
 * inline code, and quoted spans in either straight or curly doubles.
 *
 * The whole-reply scan below exists to catch a claim the session made in its OWN voice, and it
 * could not tell a claim from a quotation. The most quotable text on this machine is the
 * comment directly above, which carries "I'll merge #3956" verbatim.
 *
 * Measured 2026-09-18: explaining this hook to the owner reproduced its own block. The reply
 * quoted the 2026-09-17 case, MERGE_CLAIM matched inside the quotation, NOTHING_WAITS matched
 * an opening line that correctly owed him nothing, and the turn was ordered to offer
 * "merge 3956 when green" - an approval for a PR that did not exist in that session. A wrong
 * number in his input box is the same harm check 2 already guards against.
 *
 * Replaced with a space, not removed, so nothing new abuts across the gap. Deliberately does
 * NOT strip indented blocks: a 4-space list continuation is ordinary prose in a reply, and a
 * missed real claim costs more than a stray quotation does.
 */
function stripQuoted(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ') // fences first, before inline code sees them
    .replace(/(^|\n)[ \t]*>[^\n]*/g, '$1 ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/“[^”\n]{0,400}”/g, ' ')
    .replace(/"[^"\n]{0,400}"/g, ' ');
}

const DO_NOT_REDO =
  'The task itself is finished: do not redo any work, do not re-run anything, do not re-verify. Replace ONLY the opening line and output nothing else.';

function contentViolation(step, text) {
  const quoted = quotedWords(step);
  // Read what the reply SAID, never what it quoted (stripQuoted). The number matters as much
  // as the claim: sourced from a quotation it names the wrong PR in his box.
  const saidStep = stripQuoted(step);
  const said = stripQuoted(text);
  const pr = (PR_NUMBER.exec(saidStep) || PR_NUMBER.exec(said) || [])[1];

  // 1. It announced its OWN merge and asked him for nothing. The 2026-09-17 case itself.
  const claimsMerge =
    MERGE_CLAIM.test(saidStep) || (NOTHING_WAITS.test(step) && MERGE_CLAIM.test(said));
  if (!quoted && claimsMerge) {
    return [
      `Your opening line announces that YOU will merge${pr ? ` ${pr}` : ''}. You never merge anything without his approval - a standing owner rule - and because that line asked him for nothing, his input box was offered no suggestion at the exact moment the merge approval was the one thing waiting on him.`,
      '',
      'Rewrite ONLY that line so it names the approval and ends in the exact words he would type:',
      '',
      `  **Next step:** <the work is ready, the merge is his call> - \u201cmerge ${pr || 'NNNN'} when green\u201d`,
      '',
      DO_NOT_REDO,
    ].join('\n');
  }

  // 1b. No quoted words at all. OWNER RULE 2026-09-18: "always put something in the box".
  //     The box echoes this span verbatim, so an empty one renders "<no suggestion>" - which he
  //     watched happen turn after turn on 2026-09-18 and ruled against. It SUPERSEDES the
  //     2026-09-15 "suggest nothing when nothing needs him" half: the loop ban was about WHAT
  //     gets suggested (never a re-check, a status read, a closing word) and that still stands
  //     in full - it was never a licence to hand him an empty box.
  if (!quoted) {
    return [
      'Your opening line ends in no quoted words, so his input box reads "<no suggestion>". Since 2026-09-18 ("always put something in the box") EVERY Next step line ends in curly-quoted words he could send as-is. The no-quotes "nothing waits on you" form is retired.',
      '',
      'Rewrite ONLY that line. If something genuinely needs him, name it and quote the words he would type. If nothing does, say what finished and quote the next REAL action, naming its real target:',
      '',
      '  **Next step:** <what just finished> - “<the next real action, naming its target>”',
      '',
      'The quoted words are still never a re-check, a re-run, a status read, "continue", "check other pending items", "polish again", or any closing word - that half of the 2026-09-15 rule is unchanged.',
      '',
      DO_NOT_REDO,
    ].join('\n');
  }

  const plain = quoted.toLowerCase().replace(/[.!?]+$/, '').trim();

  // 2. A placeholder inside the quoted words. The box echoes that span verbatim, brackets
  //    and all: he sent one back unfilled on 2026-09-17.
  if (PLACEHOLDER.test(quoted)) {
    return [
      `The quoted words in your opening line contain a placeholder ("${quoted}"). The input box echoes that span verbatim, so he receives the brackets - it happened on 2026-09-17 and he sent it back unfilled.`,
      '',
      `Rewrite ONLY that line with the REAL target inside the quotes${pr ? ` (the number in this reply is ${pr})` : ''}. If only he knows the target, ask for it in the line and quote nothing at all.`,
      '',
      DO_NOT_REDO,
    ].join('\n');
  }

  // 2b. A money move, offered for him to OK from chat. See isMoneyMove.
  if (isMoneyMove(plain)) {
    return [
      `The quoted words in your opening line are "${quoted}" - a change that pays, moves, holds or re-dates money, offered for him to OK from chat. Owner rule, 2026-09-18 ("things that have money ... don't tell me to approve it from here"): money is never decided in chat. Report what happened and name the screen where it is decided; the decision is his click there, and you never make the change on a chat "yes".`,
      '',
      'Rewrite ONLY that line. Keep the facts, name the screen, and quote a NON-money next action with its real target:',
      '',
      '  **Next step:** <what happened, and the screen where he decides it> - “<a non-money next action, naming its target>”',
      '',
      'If the quoted words describe CODE work (a rule, a screen, a fix) rather than a money move, open them with fix / build / make so they read as the code change they are.',
      '',
      DO_NOT_REDO,
    ].join('\n');
  }

  // 3. A closing word, or work you should have finished yourself.
  if (BANNED_EXACT.has(plain) || BANNED_START.test(plain) || /\bagain\b/.test(plain)) {
    return [
      `The quoted words in your opening line are "${quoted}". He never types a closing message, and never a re-check, a status read or a re-run - anything you could do yourself belongs in this turn, not in his input box.`,
      '',
      'Replace the quoted words - do not delete them. Since 2026-09-18 the line always ends in something he could send as-is. Name what genuinely needs him and quote his words for it, or, if nothing does, say what finished and quote the next REAL action with its real target:',
      '',
      '  **Next step:** <what just finished> - “<the next real action, naming its target>”',
      '',
      DO_NOT_REDO,
    ].join('\n');
  }

  // 5. His own click, quoted for him to send back. See isHisOwnClick.
  if (isHisOwnClick(plain)) {
    return [
      `The quoted words in your opening line are "${quoted}" - something he must do with his own hands, in a system you cannot reach. The box echoes that span verbatim, so he sends it to YOU and you have to decline it. That happened six times in a row on 2026-09-26 and cost six turns.`,
      '',
      'Name it in the BODY of the reply, with the link or the exact command, and put something else in the box: an approval of work you have finished (a merge, a retire), or a decision he answers in words.',
      '',
      '  **Next step:** <what you finished, and what he must do with his own hands - in the body, not here> - \u201c<an approval of your work, or his answer to a decision>\u201d',
      '',
      DO_NOT_REDO,
    ].join('\n');
  }

  // 6. A message he sends to a PERSON. See isMessageToAPerson — same failure as clause 5, but it
  //    reads like a decision, which is why it got through three times on 2026-09-29.
  if (isMessageToAPerson(plain)) {
    return [
      `The quoted words in your opening line are "${quoted}" - a message HE sends to a person, which you cannot send for him. The box echoes that span verbatim, so it comes back to YOU as an instruction to do the one thing no session may do: nothing outbound reaches staff on Claude's own say-so. It happened three times in one session on 2026-09-29.`,
      '',
      'Put the DRAFT in the body of the reply, in full and ready to paste - that part is your work. Then quote something you can act on: an approval of work you have finished (a merge, a retire), a decision he answers in words, or the next change he can ask you for.',
      '',
      '  **Next step:** <what you finished, and the message drafted below for him to send> - “<an approval of your work, or the next change you can make>”',
      '',
      DO_NOT_REDO,
    ].join('\n');
  }

  // 4. "merge it" while this reply names the number. A terse approval can reach several of
  //    his live sessions at once, so the target is always named.
  if (/^merge\s+it\b/i.test(plain) && pr) {
    return [
      `Your opening line quotes "${quoted}" while this reply names PR ${pr}. A bare "merge it" can land in the wrong one of his live sessions, so the number always goes inside the words he types.`,
      '',
      `Rewrite ONLY that line ending in \u201cmerge ${pr} when green\u201d (or "when CI is green", matching what you said about the checks).`,
      '',
      DO_NOT_REDO,
    ].join('\n');
  }

  return null;
}

// ── selftest ──────────────────────────────────────────────────────────────────
// `node ~/.claude/hooks/next-step-capture.mjs selftest` — expects `0 failed`.
//
// 🔴 WHY A CHILD PROCESS AND NEVER AN IMPORT. This module's main body runs at import time,
// reads fd 0 and calls process.exit. An import would swallow the runner's own stdin and exit
// out of the middle of the suite, reporting a PREFIX of it as the whole of it. Spawning the
// real hook also proves what a unit test of the predicates cannot: the clause ORDER (a repeated
// line is judged before content, content before the capture is written), and that
// `stop_hook_active` really does disarm every block.
//
// USERPROFILE and HOME are redirected at the child, so the hook's capture directory AND its
// 7-day prune land in a temp folder. Without that, a selftest run would prune the owner's live
// ~/.claude/.next-step while he is working.
if (process.argv[2] === 'selftest') {
  const { execFileSync } = await import('node:child_process');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nsc-selftest-'));
  const HOME_T = path.join(TMP, 'home');
  fs.mkdirSync(path.join(HOME_T, '.claude'), { recursive: true });

  let ran = 0;
  let failed = 0;

  const decide = (reply, opts = {}) => {
    const sessionId = opts.sessionId || 'selftest-' + ran;
    const tp = path.join(TMP, sessionId + '.jsonl');
    const entries = opts.entries || [{ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }];
    fs.writeFileSync(tp, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    const out = execFileSync(process.execPath, [process.argv[1]], {
      input: JSON.stringify({
        session_id: sessionId,
        transcript_path: tp,
        stop_hook_active: opts.stopHookActive === true,
      }),
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: HOME_T, HOME: HOME_T },
    });
    const capFile = path.join(HOME_T, '.claude', '.next-step', sessionId + '.txt');
    const captured = fs.existsSync(capFile) ? fs.readFileSync(capFile, 'utf8') : null;
    if (!out.trim()) return { blocked: false, reason: '', captured };
    const parsed = JSON.parse(out);
    // `blocked` here means "the hook objected", which since 2026-10-15 it does by WARNING
    // (nextStepVerdict: 'warn') rather than {decision:"block"}. Every case below asserts on the
    // VERDICT, not on its force, so the table is unchanged.
    return {
      blocked: parsed.nextStepVerdict === 'warn' || parsed.decision === 'block',
      reason: String(parsed.reason || ''),
      captured,
      decision: parsed.decision,
      systemMessage: parsed.systemMessage,
    };
  };

  const check = (label, ok, detail) => {
    ran += 1;
    if (ok) {
      console.log('  pass  ' + label);
    } else {
      failed += 1;
      console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : ''));
    }
  };

  const GOOD = '**Next step:** the branch is pushed and both checks are green — “merge 5371 when green”';

  // Every row is a measured failure this hook exists to catch. `needle` is a fragment of the block
  // message, so a clause that starts firing for the WRONG reason fails too — which is exactly how a
  // weak test passed the delete guard's first deliberate break on 2026-10-06.
  const CASES = [
    // the line itself
    ['no Next step line at all', 'The fix is pushed and CI is green.', 'block', 'missing its opening line'],
    ['a table row is not the line (it starts with a pipe)', '| **Next step:** merge it | shipped |', 'block', 'missing its opening line'],
    ['two Next step lines', GOOD + '\n\nbody\n\n**Next step:** and again — “merge 5371 when green”', 'block', 'more than one'],
    ['no quoted words at all', '**Next step:** nothing waits on you — the fixes are pushed.', 'block', 'no suggestion'],
    // clause 1 — a merge the session will do
    ['a merge YOU will do, with no quoted words', '**Next step:** nothing waits on you — I will merge 3956 on this green and verify production.', 'block', 'announces that YOU will merge'],
    // clause 2 — a placeholder
    ['a placeholder inside the quoted words', '**Next step:** ready — “merge <PR number> when green”', 'block', 'placeholder'],
    // clause 2b — money
    ['a money move in the quoted words', '**Next step:** the trip is recorded — “pay Nahed’s Tanta trip in September’s payroll”', 'block', 'money'],
    ['a decision verb beside a money noun', '**Next step:** they are queued — “hold the 23 outstation requests”', 'block', 'money'],
    // clause 3 — closing words and re-checks
    ['a closing word', '**Next step:** all shipped — “done”', 'block', 'closing message'],
    ['a re-check', '**Next step:** the deploy is building — “check the deploy again”', 'block', 'closing message'],
    // clause 5 — his own hands
    ['his own click on a surface this session cannot reach', '**Next step:** the variables are ready — “set the HEADWIND_MDM variables in railway”', 'block', 'his own hands'],
    ['a GUI verb with no surface named at all', '**Next step:** the config is ready — “scan the config 3 QR”', 'block', 'his own hands'],
    ['a GUI verb hiding behind a conjunction', '**Next step:** the list is ready — “open customer links and press the certain ones”', 'block', 'his own hands'],
    ['an approval with nothing this session can act on', '**Next step:** 26 are mechanical — “confirm the 26 certain pharmacy links on production”', 'block', 'his own hands'],
    // clause 6 — a message to a person
    ['a message HE sends to a person', '**Next step:** the pack is assembled — “tell HR to start scanning the hiring documents”', 'block', 'message HE sends to a person'],
    // clause 4 — a bare "merge it" beside a number
    ['a bare "merge it" while the reply names the PR', 'PR #5371 is green.\n\n**Next step:** it is ready — “merge it”', 'block', 'merge 5371'],
    // the allow path — none of these may fire
    ['a merge approval naming its number', GOOD, 'allow', ''],
    ['retiring a worktree', '**Next step:** it is merged — “retire _wt-cloud-mirror-sync and delete its branch”', 'allow', ''],
    ['a money NOUN with no money verb and no digit', '**Next step:** the export is wired — “add the salary column to the export”', 'allow', ''],
    ['code work whose words merely mention payroll', '**Next step:** the rounding is reproduced — “fix the payroll rounding bug”', 'allow', ''],
    ['an overloaded verb the rule deliberately allows', '**Next step:** both rows match — “link the two victoria rows”', 'allow', ''],
    ['"next step:" mid-prose is not a second line', GOOD + '\n\nafter that the next step: is yours to choose.', 'allow', ''],
    ['a QUOTED merge claim in the body is not a claim', GOOD + '\n\nThe 2026-09-17 case read: “nothing waits on you — I will merge 3956 on this green.”', 'allow', ''],
    ['non-ASCII inside the quoted words does not throw', '**Next step:** the list is ready — “fix صيدلية العروبة in the customer map”', 'allow', ''],
  ];

  for (const [label, reply, expect, needle] of CASES) {
    let r;
    try {
      r = decide(reply);
    } catch (err) {
      check(label, false, 'the hook threw: ' + err.message);
      continue;
    }
    if (expect === 'block') {
      if (!r.blocked) check(label, false, 'expected a BLOCK, the hook allowed it');
      else {
        check(
          label,
          r.reason.toLowerCase().includes(needle.toLowerCase()),
          'blocked, but for the wrong reason — expected ' + JSON.stringify(needle) + ', got: ' + r.reason.slice(0, 160),
        );
      }
    } else {
      check(label, !r.blocked, 'expected ALLOW, the hook blocked: ' + r.reason.slice(0, 160));
    }
  }

  // The capture is what the statusline prints, so an allowed reply must leave the real words on
  // disk — markdown stripped, a link reduced to its label, whitespace collapsed.
  const cap = decide('**Next step:** ready — “merge 5371 when green”', { sessionId: 'cap' });
  check(
    'an allowed reply writes the captured line',
    cap.captured === 'ready — “merge 5371 when green”',
    'captured ' + JSON.stringify(cap.captured),
  );

  const capLink = decide('**Next step:** [#5371](https://example/x) is green — “merge 5371 when green”', { sessionId: 'caplink' });
  check(
    'a markdown link is captured as its label',
    capLink.captured !== null && capLink.captured.startsWith('#5371 is green'),
    'captured ' + JSON.stringify(capLink.captured),
  );

  // THE 2026-10-15 CHANGE, pinned both ways. A wrong line must still be answered — and it must
  // NEVER be answered with {decision:"block"}, because a block makes the app auto-continue and the
  // suggestion gate skips an "auto_continuation" turn by name. Restoring the block to "make it
  // stick" is precisely what these two catch.
  const warned = decide('**Next step:** ready — “merge <PR> when green”', { sessionId: 'warned' });
  check(
    'a wrong line is answered by a WARNING, never a block',
    warned.blocked && warned.decision === undefined && !!warned.systemMessage,
    'decision ' + JSON.stringify(warned.decision) + ', systemMessage ' + JSON.stringify(!!warned.systemMessage),
  );
  check(
    'a warned line is NOT captured, so a placeholder never becomes his ghost text',
    warned.captured === null,
    'captured ' + JSON.stringify(warned.captured),
  );

  // stop_hook_active is the infinite-loop guard: the continuation pass must never block again,
  // however wrong the reply still is.
  const cont = decide('no line here at all', { sessionId: 'cont', stopHookActive: true });
  check('stop_hook_active disarms the block', !cont.blocked, 'it blocked on the continuation pass');
  check(
    'stop_hook_active still captures, empty and meaningfully so',
    cont.captured === '',
    'captured ' + JSON.stringify(cont.captured),
  );

  // A tool-only turn has no text to judge: it must fail OPEN, never block.
  const toolOnly = decide('', {
    sessionId: 'toolonly',
    entries: [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }],
  });
  check('a tool-only turn is left alone', !toolOnly.blocked, 'it blocked a turn that said nothing');

  // A subagent's reply is not the session's reply.
  const sidechain = decide('', {
    sessionId: 'side',
    entries: [
      { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'no line in here' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: GOOD }] } },
    ],
  });
  check(
    'a sidechain entry is skipped and the real reply is read',
    !sidechain.blocked,
    'it blocked although the last main-assistant reply carried the line',
  );

  // The owner's live capture directory must be untouched by a selftest run.
  const LIVE_DIR = path.join(process.env.USERPROFILE || os.homedir(), '.claude', '.next-step');
  check(
    'the live capture directory gained no selftest file',
    !fs.existsSync(path.join(LIVE_DIR, 'cap.txt')) && !fs.existsSync(path.join(LIVE_DIR, 'cont.txt')),
    'a selftest session id reached ' + LIVE_DIR,
  );

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}

  console.log('\n' + ran + ' cases, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
  const sessionId = input?.session_id;
  const transcript = input?.transcript_path;
  if (sessionId && transcript && fs.existsSync(transcript)) {
    const text = lastAssistantText(tail(transcript));
    const step = extractNextStep(text);

    // Only a reply that actually SAID something can be missing its line - and only a line
    // that EXISTS can be wrong. One shot for both: never on the continuation pass.
    //
    // A repeat is checked BEFORE content, because only the first line is ever read: a second
    // "Next step:" line is both a rule violation on its own (one line, never repeated) and the
    // hole a placeholder slipped through on 2026-09-29.
    let reason;
    if (!step) {
      reason = NUDGE;
    } else if (countNextSteps(text) > 1) {
      reason = [
        'Your reply has more than one "**Next step:**" line. The rule is exactly one, at the very top, NEVER repeated at the bottom. Only the first line is ever read for the input box, so a second line escapes every content check - that is how a placeholder reached his box on 2026-09-29.',
        '',
        'Keep ONLY the opening line and delete every later "Next step:" line. ' + DO_NOT_REDO,
      ].join('\n');
    } else {
      reason = contentViolation(step, text);
    }
    // WARN, NEVER BLOCK - see the head of this file. `systemMessage` reaches the model without
    // forcing a continuation, so the suggestion on the reply already shown survives.
    // `nextStepVerdict` is inert to Claude Code (an unknown key is ignored) and is the field
    // the selftest reads to tell a warned verdict from a clean one.
    let warned = false;
    if (reason && text && input?.stop_hook_active !== true) {
      process.stdout.write(JSON.stringify({ nextStepVerdict: 'warn', reason, systemMessage: reason }));
      warned = true;
    }

    // A WARNED line is NEVER captured, and that is deliberate - it is the box's last guard, not a
    // leftover of the blocking era. Every content check exists to keep one specific string out of
    // his input box: a placeholder he would send unfilled (he did, 2026-09-17), a money move, a
    // bare "merge it" that reaches the wrong session, a closing word, a re-check. Writing the bad
    // line anyway would hand him exactly that as ghost text. So the file is left untouched and the
    // bar keeps its last GOOD line, which is never one of those strings.
    //
    // An empty file is meaningful and different from a missing one: it means the reply carried no
    // next step, and the bar prints nothing.
    if (!warned) {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(path.join(DIR, `${sessionId}.txt`), step, 'utf8');
      try {
        prune();
      } catch {}
    }
  }
} catch {}
process.exit(0);
