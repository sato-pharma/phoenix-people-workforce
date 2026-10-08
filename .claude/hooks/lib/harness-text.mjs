// What the context injectors may MATCH ON — the owner's own words and the command's own words, never
// text the harness wrote around them or a string the command merely searches for.
//
// WHY. `.claude/hooks/module-memory-injector.mjs` and `.claude/hooks/trap-injector.mjs` read raw text
// and inject a module or a trap cluster on a keyword. Measured 2026-10-08 in one settings audit that
// touched no module at all, they injected payroll, sales-closing, sales-attribution, recruitment,
// notifications and engineering, plus six trap clusters — about 25,000 tokens — because:
//   - a background agent's completion arrives in `prompt` as `<task-notification>…</task-notification>`
//     behind a "[SYSTEM NOTIFICATION - NOT USER INPUT]" banner, so the word "notification" loaded the
//     Email module, and the agent's REPORT text (which named payroll and closing files) loaded those;
//   - `git grep -n -i "railway run" -- docs/x.md` matched the Engineering command regex and the
//     Production cluster on the SEARCH PATTERN, and a Grep tool `pattern` was matched the same way.
//
// Both functions only ever REMOVE text, so a hook using them can inject less, never more. The paths a
// hook reads (`pathTokens`) still come from the raw command: a quoted path is a real path.
//
// The envelope rule is the one `.claude/hooks/autorun-guard.mjs` proved on 11,732 prompts (a
// lower-case hyphenated tag is harness text, as a CLASS); it is copied rather than shared because
// that guard's own tests pin its behaviour.

// Opens an envelope: a lower-case, hyphenated tag — task-notification, system-reminder, command-name,
// scheduled-task, ci-monitor-event, and whatever the harness names next.
const ENVELOPE_OPEN = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?=[\s/>])[^>]*>/;

// The banner the harness writes in front of a task notification, through to the next blank line.
const SYSTEM_BANNER = /\[SYSTEM NOTIFICATION[^\]\n]*\][\s\S]*?(?:\n[ \t]*\n|$)/g;

/**
 * The prompt with every harness envelope and banner cut out. An envelope runs from its opening tag
 * to the LAST matching close (so a close tag quoted inside a notice cannot hand the rest back as typed
 * text), or to the end of the prompt when it never closes.
 */
export function ownerText(prompt) {
  let text = String(prompt || '');
  for (let open = ENVELOPE_OPEN.exec(text); open; open = ENVELOPE_OPEN.exec(text)) {
    const close = `</${open[1]}>`;
    const at = text.lastIndexOf(close);
    const end = at > open.index ? at + close.length : text.length;
    text = `${text.slice(0, open.index)} ${text.slice(end)}`;
  }
  return text.replace(SYSTEM_BANNER, ' ');
}

// Heredoc bodies (`<<'EOF' … EOF`) and PowerShell here-strings (@' … '@ and @" … "@): always prose.
const BODIES = [/<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\s*\2\s*$/gm, /@'[\s\S]*?^'@/gm, /@"[\s\S]*?^"@/gm];

// Single- and double-quoted runs on one line.
const QUOTED = [/'[^'\n]*'/g, /"[^"\n]*"/g];

// A quoted run that BEGINS like a path is kept: on this machine every path under
// "F:/Phoenix Workforce/…" has to be quoted for its space, and a path is real work (`cd "…/_wt-x"` is
// worktree work). A backslash counts only after a drive letter, so a regex escape such as "railway\b"
// is still a search pattern, not a path.
const PATHY = /^(?:[A-Za-z]:[\\/]|~\/|\.{1,2}\/|\/|[\w.@-]+\/)/;

const blank = (m) => m.replace(/[^\n]/g, ' ');

/**
 * The command with heredoc bodies and every quoted string that is not a path blanked to spaces of the
 * same length: what is left is the command's own words — the program, its subcommand, its flags, its
 * bare arguments and its paths. A search pattern, a commit message or an echoed sentence is quoted,
 * so it stops reading as the work itself.
 */
export function commandForKeywords(cmd) {
  let text = String(cmd || '');
  for (const re of BODIES) text = text.replace(re, blank);
  for (const re of QUOTED) text = text.replace(re, (m) => (PATHY.test(m.slice(1, -1)) ? m : blank(m)));
  return text;
}
