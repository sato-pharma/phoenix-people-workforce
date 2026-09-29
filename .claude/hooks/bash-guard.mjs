#!/usr/bin/env node
// PreToolUse(Bash|PowerShell) guard — deterministic, zero-cost.
// Blocks the commands the memory documents as silent traps in THIS repo:
//   C1  recursive grep  — ~346k path entries make `grep -r` hang 10-40s+. Use rg / git grep.
//   C6  pnpm inside a LINKED WORKTREE — its deps check offers to delete the PRIMARY's
//       node_modules, which every worktree's node_modules is only a junction to.
//   C7  a raw `next dev` — it skips scripts/dev-server.mjs, so Next hands the server half of RAM
//       (8,086 MB here) instead of the launcher's 4,096, and nothing refuses a second server.
//   C8  a LOCAL typecheck — it needs 4.0-4.5 GB, dies at node's own ~4.1 GB default, and the memory
//       watchdog reaps it. A reaped run prints nothing, so the session re-runs it in another
//       spelling. PHX_TYPECHECK_OK=1 (or $env:PHX_TYPECHECK_OK=1) stands it down for one command.
//   C10 a MERGE of a PR too SMALL to be worth its own two CI runs — a merge costs the same two
//       runs whatever its size, and 110 of them landed in one day on 2026-09-29 while 41% of
//       the week's merges touched 3 files or fewer. It refuses SIZE only: nothing here delays
//       a merge or counts how many have run (the owner cut a cooldown the same evening —
//       merges go when they are ready). PHX_MERGE_OK=1 stands it down for one command.
//   C12 a `git push` whose working tree holds a SECRET — gitleaks, same binary and flags as CI,
//       run BEFORE the push so a key never reaches the remote history at all. Replaces the
//       per-PR secret-scan (owner, 2026-09-29), which billed a full minute on ~186 runs a day
//       for a 23s job. Not installed = warn and ALLOW; the daily scan over main is the backstop.
//       PHX_SECRETS_OK=1 stands it down for a finding you have read and judged a fixture.
//   C11 a MANUAL dispatch of `synthetic-journeys` past a daily cap — the production smoke suite
//       bills 3 minutes a run and its 6/day cadence is a cost decision already taken; on
//       2026-09-29 it was dispatched BY HAND 19 times against 2 scheduled. Machine-wide and
//       per day, because C9 counts per session and exempts main. PHX_SMOKE_OK=1 stands it down.
//
// And triggers one NON-blocking side effect:
//   C5  worktree removal — hands the command to worktree-exit-guard.mjs --pre-removal so the
//       backup check is LOGGED while the directory still exists. Never denies. See that file for
//       why the SessionEnd check alone was not enough.
//
// RETIRED 2026-08-10:
//   C4  standalone jq — blocked jq because it was not installed and emitted zero output, which
//       looks identical to success. jq 1.8.2 is now installed (scoop, ~/scoop/shims/jq.exe), so
//       the guard was denying a command that works. A guard asserting something untrue is worse
//       than no guard: it costs every session a wasted round trip and teaches a false fact.
//       If jq ever disappears from PATH again, restore the check rather than reasoning around it.
// FAILS OPEN: any parse/logic error exits 0 (allow). A hook bug must never block a real command.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

/** `C:\a\B` and `c:/a/b` are one folder to git and two strings to `===`. */
const normPath = (value) => String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * A command position: the start of the command, or after a newline / `|` / `&` / `;` / `(`.
 * That is what catches `cd x && pnpm run test`, a `pnpm` on its own line of a multi-line command,
 * and `$(pnpm -v)`.
 *
 * A BACKTICK is deliberately NOT a separator here. It opens a command substitution in bash, but in
 * this repo it far more often opens markdown code — `AGENTS.md` and every doc quote `pnpm install`
 * constantly — and a guard that refuses to let a session WRITE the rule down teaches the wrong
 * lesson. `$( )` covers the substitution case without that collision.
 */
const PNPM_AT_COMMAND_POSITION = /(?:^|[\n|&;(])\s*pnpm(?:\.cmd|\.exe)?(?:\s|$)/i;

/**
 * Heredoc BODIES are data, not commands: `cat > doc.md <<'EOF' … EOF` writing a paragraph about
 * `pnpm install` executes nothing. Stripping them first is what lets the newline above count as a
 * command separator — without it, documenting this very rule would be denied by it.
 */
function withoutHeredocBodies(text) {
  return text.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^[ \t]*\2[ \t]*\r?$/gm, '');
}

/**
 * Is `dir` inside a LINKED worktree rather than the primary checkout?
 *
 * Two independent tests. git answers first because it also yields the primary's path for the
 * message and it works from a SUBDIRECTORY of the worktree: from anywhere inside one, `--git-dir`
 * (<primary>/.git/worktrees/<name>) differs from `--git-common-dir` (<primary>/.git), while in the
 * primary the two are the same folder. The `.git`-is-a-FILE shape is the fallback for when git
 * cannot be run at all. Only reached once the command already matched, so its cost is never paid
 * by an ordinary command.
 */
function linkedWorktree(dir) {
  try {
    const out = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 },
    );
    const [gitDir, commonDir, toplevel] = out.trim().split(/\r?\n/);
    if (gitDir && commonDir && normPath(gitDir) !== normPath(commonDir)) {
      return {
        linked: true,
        primary: dirname(commonDir.replace(/\\/g, '/')),
        // The worktree ROOT, so package.json still resolves when the session sits in a subfolder.
        root: toplevel ? toplevel.replace(/\\/g, '/') : null,
      };
    }
    return { linked: false, primary: null, root: null };
  } catch {
    // git unavailable, or not a repository at all — fall back to the shape on disk.
  }
  try {
    if (statSync(join(dir, '.git')).isFile()) return { linked: true, primary: null, root: dir };
  } catch {
    // no .git here
  }
  return { linked: false, primary: null, root: null };
}

/**
 * AGENTS.md §5's dev-server line. The launcher picks --webpack on Windows (turbopack rejects the
 * worktree's node_modules junction), caps the heap and refuses a second server — C7 below.
 */
const DEV_SERVER = 'node scripts/dev-server.mjs --port 3000';

/**
 * The command split at its command positions — a newline, `|`, `;`, `&`, `(` — but never inside a
 * quoted string, so a commit message or an echo that MENTIONS a command is not read as running it.
 * An unbalanced quote swallows the rest of the command, which errs toward allowing: the cheap way to
 * be wrong for a guard whose worst miss is a dev server that uses too much memory.
 */
function commandSegments(text) {
  const segments = [];
  let current = '';
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if ('\n|;&('.includes(ch)) {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments;
}

/**
 * A PowerShell here-string's body is data, like a heredoc's — `@'`…`'@` is how a commit message
 * gets written from the PowerShell tool, and an apostrophe inside one would otherwise flip the
 * quote tracking above and turn the next line into a "command".
 */
function withoutHereStringBodies(text) {
  return text.replace(/@(["'])[ \t]*\r?\n[\s\S]*?\r?\n\1@/g, "''");
}

/** Wrappers that still run what they carry: `cmd /c`, a shell's `-c`, `start`, `VAR=value`, a quote. */
const LAUNCH_WRAPPERS = [
  /^cmd(?:\.exe)?\s+\/[ck]\s+/i,
  /^(?:powershell|pwsh|bash|sh)(?:\.exe)?\s+(?:-{1,2}[\w-]+\s+)*/i,
  /^start\s+(?:"[^"]*"\s+)?(?:\/\w+\s+)*/i,
  /^(?:call|exec|nohup|env)\s+/i,
  /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/,
  /^["']/,
];

function unwrapped(segment) {
  let text = segment.trim();
  for (let pass = 0; pass < 8; pass++) {
    const before = text;
    for (const wrapper of LAUNCH_WRAPPERS) text = text.replace(wrapper, '').trim();
    if (text === before) break;
  }
  return text;
}

/**
 * Next's binary told to run `dev`: through node (bare, or by a full path that may hold spaces),
 * npx, `pnpm [exec|dlx]`, or `next` itself by any path — a quoted one may hold spaces too, as every
 * path under `F:\Phoenix Workforce` does. Only flags may sit between the program and Next, so
 * `node -e "…'next dev'…"` is not read as a launch. `next build`, `next start` and
 * `node scripts/dev-server.mjs` never match.
 */
const RAW_NEXT_DEV =
  /^(?:(?:[^"'\n]*[\\/])?(?:node|npx|pnpm)(?:\.exe|\.cmd)?["']?(?:\s+-{1,2}[\w-]+(?:=\S+|\s+(?![-"'])[^\s"']+)?)*(?:\s+(?:exec|dlx))?\s+)?(?:["'][^"'\n]*[\\/]|["']?(?:[^\s"']*[\\/])?)next(?:\.cmd)?["']?[\s,'"]+dev(?:[\s,'"]|$)/i;

/**
 * Start-Process and WMI's process-create take the program and its arguments in any order, often as
 * a quoted list — so for those, a `next` followed by `dev` anywhere in the segment is the launch.
 */
const DETACHED_LAUNCHER = /(?:^|=\s*)(?:start-process|saps|invoke-cimmethod|invoke-wmimethod|wmic)\b/i;
const NEXT_THEN_DEV = /(?:^|[\s"'\\/,])next(?:\.cmd)?["']?[\s,'"]+dev(?:[\s,'"]|$)/i;

function launchesRawNextDev(segment) {
  const text = unwrapped(segment);
  return RAW_NEXT_DEV.test(text) || (DETACHED_LAUNCHER.test(text) && NEXT_THEN_DEV.test(text));
}

/**
 * The segment that starts a raw `next dev`, or null. A nudge toward the launcher, not a wall: a
 * command line assembled in a variable on one line and launched on the next is not chased, and the
 * memory watchdog stays the backstop for anything that gets past this.
 */
function rawNextDevLaunch(command) {
  return commandSegments(withoutHereStringBodies(withoutHeredocBodies(command))).find(launchesRawNextDev) ?? null;
}

/** `tsc`, however the path to it was spelled, including the `lib/tsc.js` entry node runs directly. */
const TSC_BASENAME = /^tsc(?:\.(?:js|cmd|exe|bat))?$/i;

/** The basename of a token, with either slash flavour stripped. */
const binName = (token) =>
  String(token ?? '')
    .replace(/^.*[\\/]/, '')
    .toLowerCase();

/**
 * argv for one segment, QUOTE-AWARE. A plain `split(/\s+/)` breaks
 * `"C:\Program Files\nodejs\node.exe"` into two tokens and the guard then reads `"C:\Program` as the
 * binary — and every path on this machine has a space in it, so that is the common case, not the
 * exotic one. Quote-awareness is also what keeps `echo "tsc --noEmit"` safe: there the tsc text is a
 * single ARGUMENT token, never the binary.
 */
function argvTokens(text) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const ch of String(text)) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      started = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Does this segment start a local typecheck? Every form below was taken from a real kill in
 * ~/.claude/scripts/mem-watchdog.log, not imagined: sessions reach for `.bin/tsc`, `typescript/bin/tsc`,
 * `typescript/lib/tsc.js`, a backslash spelling of the same, `-p tsconfig.json`, and a hand-raised
 * `--max-old-space-size`, because each silent death reads like a broken command rather than a kill.
 *
 * `--noEmit` is REQUIRED for a direct tsc so that a real build (`tsc -b`, an emit into dist) is not
 * caught by a rule about the checking loop. `pnpm run typecheck` needs no such test — that script IS
 * `tsc --noEmit --pretty false`. `pnpm run ci` is deliberately NOT matched: AGENTS.md §7 keeps it as
 * the owner's own opt-in for the one case CI cannot answer, a migration or a production deploy.
 */
function launchesLocalTypecheck(segment, root) {
  // TWO readings of the same segment, because `unwrapped()` strips a LEADING quote and so
  // unbalances every line whose first token is a quoted path — and on this machine it usually is:
  // `"C:\Program Files\nodejs\node.exe"`. The raw reading catches that one; the unwrapped reading
  // catches `cmd /c`, `bash -lc` and a leading `VAR=value`. A match in either is a launch.
  return [segment.trim(), unwrapped(segment)].some((text) => readsAsLocalTypecheck(text, root));
}

/**
 * Is `<manager> run <script>` a typecheck?
 *
 * By NAME first, and only the exact `typecheck`, because that is what package.json holds and the
 * name has to answer from a folder where package.json is not readable at all — which is most of
 * them, since sessions run `pnpm run typecheck` from wherever they happen to be.
 *
 * Then by BODY, resolved through one `<manager> run <other>` hop. `check:edit` was exactly that
 * hop, a bare alias for `pnpm run typecheck`, and it was deleted on 2026-09-25 for costing minutes
 * and usually returning nothing; a differently-named alias is the obvious way for this guard to be
 * walked around, by a session or by a future script. A body holding a SEPARATOR is not resolved:
 * `ci` chains eleven commands and stays the owner's own opt-in (AGENTS.md §7).
 */
function scriptIsTypecheck(script, root, seen = new Set()) {
  if (!script || seen.has(script)) return false;
  seen.add(script);
  if (script.toLowerCase() === 'typecheck') return true;

  const body = String(packageScripts(root)[script] ?? '').trim();
  if (!body) return false;
  const passthrough = /^(?:pnpm|npm|yarn)(?:\s+run)?\s+([\w:.-]+)\s*$/.exec(body);
  if (passthrough) return scriptIsTypecheck(passthrough[1], root, seen);
  if (/[|&;\n]/.test(body)) return false;
  return readsAsLocalTypecheck(body, root);
}

/** One reading of a segment: is the thing being LAUNCHED here tsc, and is it checking rather than emitting? */
function readsAsLocalTypecheck(text, root) {
  const tokens = argvTokens(text);
  let i = 0;
  // Leading `VAR=value` belongs to the environment, not the command.
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  if (i >= tokens.length) return false;

  let bin = binName(tokens[i]);
  let rest = tokens.slice(i + 1);
  const words = () => rest.filter((token) => !token.startsWith('-'));

  if (/^(?:pnpm|npm|yarn)(?:\.(?:cmd|exe))?$/.test(bin)) {
    const [first, second] = words();
    if (first === 'run') return scriptIsTypecheck(second, root);
    // `yarn <script>` needs no `run`.
    if (bin.startsWith('yarn') && first && first !== 'exec' && first !== 'dlx') {
      return scriptIsTypecheck(first, root);
    }
    if (first !== 'exec' && first !== 'dlx') return false;
    bin = binName(second);
  } else if (/^npx(?:\.(?:cmd|exe))?$/.test(bin)) {
    bin = binName(words()[0]);
  } else if (/^node(?:\.exe)?$/.test(bin)) {
    // node's own flags (`--max-old-space-size=…`) come first; the script is the first non-flag token.
    bin = binName(words()[0]);
  }

  if (!TSC_BASENAME.test(bin)) return false;
  return /--noemit\b/i.test(text);
}

/** The segment that starts a local typecheck, or null. */
function localTypecheckLaunch(command, root) {
  return (
    commandSegments(withoutHereStringBodies(withoutHeredocBodies(command))).find((segment) =>
      launchesLocalTypecheck(segment, root),
    ) ?? null
  );
}

/** A binary whose package is not named after it. */
const BIN_PACKAGE = { tsc: 'typescript', tsserver: 'typescript' };

/**
 * `node node_modules/<pkg>/<entry>` for an installed binary — read out of that package's own
 * manifest and checked on disk, never guessed. A suggestion that does not run is worse than none.
 */
function nodeEntryFor(bin, root) {
  try {
    const pkg = BIN_PACKAGE[bin] || bin;
    const manifest = JSON.parse(readFileSync(join(root, 'node_modules', pkg, 'package.json'), 'utf8'));
    const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[bin];
    if (!entry) return null;
    const relative = `node_modules/${pkg}/${String(entry).replace(/^\.\//, '')}`;
    return existsSync(join(root, relative)) ? `node ${relative}` : null;
  } catch {
    return null;
  }
}

function packageScripts(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
  } catch {
    return {};
  }
}

/** The node-direct form of `pnpm run <script>`, or null when there is no honest answer. */
function scriptAdvice(script, root, seen = new Set()) {
  if (!script || seen.has(script)) return null;
  seen.add(script);
  // The dev server is pinned by AGENTS.md §5 rather than taken from package.json: turbopack
  // rejects the node_modules junction, so the flag is not optional here.
  if (/^dev(:|$)/.test(script)) return DEV_SERVER;

  const body = String(packageScripts(root)[script] ?? '').trim();
  if (!body) return null;

  const first = body.split(/\s+/)[0];
  if (first === 'node') return body;

  // A script that is itself ONE `pnpm run <other>` (master-map:sync, the :preview pairs)
  // resolves through to the real command. The tail must hold no separator: `ci` is
  // `pnpm run check:routes && pnpm run check:migrations && …`, and a greedy tail turned that into
  // a "run instead" line that still had nine pnpm calls in it.
  const passthrough = /^pnpm\s+run\s+([\w:.-]+)\s*([^\n|&;]*)$/.exec(body);
  if (passthrough) {
    const inner = scriptAdvice(passthrough[1], root, seen);
    return inner ? `${inner} ${passthrough[2]}`.trim() : null;
  }
  // A pnpm CHAIN (`ci`) has no single equivalent — say nothing rather than something wrong.
  if (PNPM_AT_COMMAND_POSITION.test(body)) return null;

  const entry = nodeEntryFor(first, root);
  return entry ? entry + body.slice(first.length) : null;
}

/** What to run instead, for the pnpm invocation actually typed. */
function pnpmAdvice(command, root) {
  const match = /(?:^|[\n|&;(])\s*pnpm(?:\.cmd|\.exe)?\s+([^\n|&;]*)/i.exec(command);
  const argv = (match?.[1] ?? '')
    .trim()
    .split(/\s+/)
    .filter((token) => token && !token.startsWith('-'));
  const [first, second] = argv;

  if (/^(i|install|add|update|up|remove|rm|prune|dedupe|import|link|rebuild)$/i.test(first ?? '')) {
    return {
      note:
        'Nothing is installed in a worktree and nothing should be — node_modules here is a ' +
        'junction to the primary checkout\'s. Install in the PRIMARY folder only; if the junction ' +
        'itself is broken:\n  node scripts/new-session.mjs --repair',
    };
  }
  if ((first === 'exec' || first === 'dlx') && second) {
    const entry = first === 'exec' ? nodeEntryFor(second, root) : null;
    const rest = argv.slice(2).join(' ');
    if (entry) return { run: `${entry} ${rest}`.trim() };
    return { run: `npx ${[second, ...argv.slice(2)].join(' ')}`.trim() };
  }
  // `pnpm run test` and the bare shorthand `pnpm test` are the same invocation to pnpm.
  const run = scriptAdvice(first === 'run' ? second : first, root);
  // Last line of defence: a replacement that is itself pnpm would send the session straight back
  // into this deny. Silence beats an instruction that cannot be followed.
  return run && !PNPM_AT_COMMAND_POSITION.test(run) ? { run } : null;
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  // PowerShell too: a `Bash` matcher never fires for the PowerShell tool, so until 2026-09-12 the
  // C5 `rmdir`/`remove-item` branch below — PowerShell-shaped from the start — could never run.
  if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') process.exit(0);
  const cmd = String(input?.tool_input?.command ?? '');
  if (!cmd) process.exit(0);

  // C1 — recursive grep at a command position (start / after | ; & ( && ||).
  // `git grep` and `rg` are NOT matched (git grep honours .gitignore; rg isn't grep).
  const recursiveGrep =
    /(?:^|[|&;(]|&&|\|\|)\s*(?:e|f)?grep\b[^|&;\n]*?\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/;
  if (recursiveGrep.test(cmd) || /\balias\s+grep=/.test(cmd)) {
    deny(
      'Recursive grep hangs in this repo (~346k path entries get scanned; 10-40s+). ' +
        'Use `git grep` (in the shell) or the Grep tool — both honour .gitignore and stay fast. ' +
        '(`rg`/`gg` are not reliably on the shell PATH here. Never `alias grep=rg`.)',
    );
  }

  // C7 — a raw `next dev`, anywhere: primary and worktrees alike. Checked BEFORE C6 so that
  // `pnpm exec next dev` in a worktree is pointed at the launcher, not at node_modules' own copy of
  // Next's binary, which is the very form this refuses.
  //
  // Why it matters (measured 2026-09-21 on the start-server.js child that does the growing): a raw
  // `next dev` hands that server a heap limit of 8,278 MB — Next's own default of half of RAM — and
  // Next restarts it only past 80% of that, so a busy one grows to 7-8 GB; the watchdog stopped one
  // at 8.14 GB that morning. Through the launcher the limit is 4,288 MB and Next restarts it in place
  // near 3.4 GB. The launcher is also the only thing that refuses a second dev server.
  const rawLaunch = rawNextDevLaunch(cmd);
  if (rawLaunch) {
    const port = /(?:--port|-p)[=\s,'"]+(\d{2,5})/.exec(rawLaunch)?.[1] ?? '3000';
    deny(
      'A raw `next dev` is refused here: it skips scripts/dev-server.mjs, so Next gives the server half ' +
        'of RAM (8,086 MB on this machine) and restarts it only near 6.6 GB, and nothing stops a second ' +
        'server starting beside it. Start it through the launcher, which passes every flag on to Next:\n' +
        `  node scripts/dev-server.mjs --port ${port}\n` +
        'It picks --webpack on Windows, caps the heap at 4,096 MB (Next then restarts the server in place ' +
        'near 3.4 GB), and refuses a second server. PHOENIX_DEV_HEAP_MB=3072 sets a tighter cap, ' +
        'PHOENIX_DEV_HEAP_MB=0 hands the choice back to Next, and PHOENIX_ALLOW_MULTIPLE_DEV_SERVERS=1 ' +
        'allows a second server.',
    );
  }

  // C8 — a LOCAL typecheck, anywhere. Checked BEFORE C6 so that `pnpm run typecheck` in a worktree
  // gets this reason rather than the pnpm one, which would send the session to the node-direct form
  // of the very command being refused.
  //
  // Why a hook and not a rule. The rule already existed — AGENTS.md §7 has said "CI is the gate, do
  // not run a local full validation" since check:harden was retired — and it did not hold, because a
  // reaped typecheck prints NOTHING and exits non-zero. That is indistinguishable from a command the
  // session typed wrong, so the session tries another spelling: measured 2026-09-25, six kills in ten
  // minutes at 04:17, 04:19, 04:21, 04:24, 04:25 and 04:27, walking `.bin/tsc` -> `typescript/bin/tsc`
  // -> `-p tsconfig.json` -> `--max-old-space-size=6144` -> `lib/tsc.js` -> a backslash spelling.
  // A markdown rule also only loads at session start, so it never reaches the dozen sessions already
  // open; this file is re-read by node on EVERY tool call, so a session gets it on its next command.
  //
  // This is the job the heavy-job gate used to do. Its own log shows 15 plain `tsc` refusals, the
  // last three at 20:44 on 2026-09-17 ("needs 5000 MB | available 2,321 MB"), and it was retired that
  // evening for holding jobs in a queue nothing could ever release on a 16 GB box. An instant, honest
  // refusal is the half of it that was worth keeping — no queue, no waiting, no 5,000 MB floor.
  //
  // The stand-down reads both dialects, because half the commands here arrive as PowerShell, and
  // `PHX_TYPECHECK_OK=1 <cmd>` is not something PowerShell can run.
  const STAND_DOWN = /(?:^|[\s;&|(])\s*(?:\$env:)?PHX_TYPECHECK_OK\s*=\s*['"]?1['"]?(?![\w.])/i;
  if (!STAND_DOWN.test(cmd) && process.env.PHX_TYPECHECK_OK !== '1') {
    // The root is the folder the command runs in: that is where its package.json is, and so
    // where a script name resolves to a body.
    const typecheck = localTypecheckLaunch(cmd, String(input?.cwd || process.cwd()));
    if (typecheck) {
      const once =
        input.tool_name === 'PowerShell'
          ? `$env:PHX_TYPECHECK_OK=1; ${typecheck.trim()}`
          : `PHX_TYPECHECK_OK=1 ${typecheck.trim()}`;
      deny(
        'A local typecheck is refused on this machine - it does not fail, it gets KILLED, and silently. ' +
          '`tsc` over this repo needs 4.0-4.5 GB of heap; node\'s own default ceiling is about 4.1 GB, and ' +
          'with the desktop app holding ~4.2 GB across its processes, mem-watchdog.ps1 reaps tsc as the ' +
          'largest node job once free RAM drops under its floor. Raising --max-old-space-size makes it the ' +
          'BIGGEST job and so the FIRST victim: 4096, 5120, 6144 and 7168 were all tried and all reaped.\n' +
          'Push the branch instead. The PR\'s required `typecheck` check runs cold on a clean runner in ' +
          'about three minutes, and it is the check that actually blocks the merge (AGENTS.md §7).\n' +
          'For a one-off you will sit and watch, stand this guard down for that one command:\n' +
          `  ${once}`,
      );
    }
  }

  // C9 — a REPEAT workflow_dispatch in one session, on a branch that a dispatch cannot help.
  //
  // WHY. On 2026-09-27 one session ran `gh workflow run` against ci.yml on
  // codex/backup-tables-out-of-public SEVENTY-ONE times between 07:04 and 10:11 Cairo. Every run came
  // back startup_failure: GitHub creates the run, refuses to compile the workflow, and returns no
  // logs, no job list and no workflow name (it files them under a synthetic `BuildFailed` workflow,
  // id 303299204, state "deleted"). There was nothing to read, so the session simply tried again —
  // 58% of that day's failed runs, from one loop. Same shape as C8: an outcome carrying NO diagnostic
  // reads as a command typed wrong, so the session retries instead of trying something else.
  //
  // The real cause was nothing the session could have fixed by retrying. The repository had lost its
  // Pro entitlement: branches/main/protection returned 403 "Upgrade to GitHub Pro or make this
  // repository public to enable this feature" and branches/main read protected:false, so Actions
  // could not compile any workflow AND protection could not be enforced. #4524, #4525 and #4526
  // merged inside 25 seconds at 10:12Z with ZERO check-runs on their head SHAs.
  //
  // WHAT THIS IS NOT. It is not a cost control. Measured the same day: a ci.yml dispatch averages 1.2
  // billable minutes and a startup_failure bills essentially nothing, so those 71 runs cost about
  // zero. Arguing this clause from money would get it deleted by the next person who measured it.
  // The argument is that a dispatch on a PR branch is USELESS BY CONSTRUCTION — its check runs never
  // enter the PR's statusCheckRollup, so branch protection ignores them however green they are.
  //
  // WHAT IT MUST NEVER TOUCH, each one a real recovery someone needed:
  //   * `main` — exempt entirely, no counter. A dispatch there is AGENTS.md §2.1's own outage
  //     recovery, main is not gated by a PR so the rollup caveat does not apply, and since #4537
  //     main's CI run is the production deploy gate: a commit already serving production with no
  //     verdict is worse than any number of wasted runs. One session needed exactly this at 14:37 on
  //     2026-09-27, after a push run was stranded with self-hosted labels baked in at creation.
  //   * `gh run rerun <id>` — never counted. It is the sanctioned recovery, keeps the original
  //     event, and so its checks DO reach the rollup. This deny points at it.
  //   * the FIRST dispatch of anything, and the second — the cap starts at the third, so a workflow
  //     meant to be fired by hand (staging-migrate, mobile-build, apps-script-push,
  //     direct-orders-sweeps, synthetic-journeys, migration-drift-check's test_alert) is untouched in
  //     normal use, and a legitimate retry after a real fix still goes through.
  //
  // FAIL OPEN, ALWAYS. No session id, no state directory, an unreadable or corrupt or wrong-version
  // state file: all of them count as ZERO dispatches and allow. The deny can only ever come from a
  // record that parsed. A counter that cannot be read must never block a command — and a fail-closed
  // read would refuse a legitimate first dispatch during an outage, which is exactly when it is
  // needed. State lives under HOME keyed by session id, not beside this hook, because a session's
  // project dir can move mid-session (EnterWorktree) and a repo-relative counter would silently
  // reset on every hop.
  const DISPATCH_SHAPED = /\bworkflow\s+run\b|\/dispatches\b/i;
  const DISPATCH_STAND_DOWN = /(?:^|[\s;&|(])\s*(?:\$env:)?PHX_DISPATCH_OK\s*=\s*['"]?1['"]?(?![\w.])/i;
  if (DISPATCH_SHAPED.test(cmd)) {
    const DISPATCH_STATE_VERSION = 1;
    const DISPATCH_MAX_AGE_DAYS = 7;
    const DISPATCH_MAX_ENTRIES = 20;
    const DISPATCH_PER_TARGET_CAP = 2;

    // Flags that CONSUME the next token, so `--ref main ci.yml` never reads `main` as the workflow.
    const VALUE_FLAGS =
      /^(?:-r|--ref|-f|-F|--field|--raw-field|-R|--repo|-X|--method|-H|--header|-q|--jq|--input|--hostname|-d|--data|-o|--output|-u|--user|-w|--write-out)$/i;
    const positionals = (tokens) => {
      const out = [];
      for (let i = 0; i < tokens.length; i += 1) {
        if (VALUE_FLAGS.test(tokens[i])) {
          i += 1;
          continue;
        }
        if (tokens[i].startsWith('-')) continue;
        out.push(tokens[i]);
      }
      return out;
    };
    const flagValue = (tokens, names) => {
      for (let i = 0; i < tokens.length; i += 1) {
        for (const name of names) {
          if (tokens[i] === name) return tokens[i + 1] ?? null;
          if (tokens[i].startsWith(name + '=')) return tokens[i].slice(name.length + 1);
        }
      }
      return null;
    };
    const DISPATCH_URL = /(?:repos\/([^/\s"']+\/[^/\s"']+)\/)?actions\/workflows\/([^/\s"']+)\/dispatches/i;
    // ci.yml, .github/workflows/ci.yml, CI and ci are ONE workflow. A NUMERIC id stays its own key:
    // resolving it needs a network call, which a PreToolUse hook must never make.
    const workflowKey = (value) =>
      String(value ?? '')
        .replace(/^.*[\\/]/, '')
        .replace(/\.ya?ml$/i, '')
        .trim()
        .toLowerCase() || '(prompted)';

    const rawCommand = cmd;
    const readsAsDispatch = (text) => {
      const tokens = argvTokens(text);
      let i = 0;
      while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
      if (i >= tokens.length) return null;
      const bin = binName(tokens[i]);
      const rest = tokens.slice(i + 1);
      const words = positionals(rest);
      if (/^gh(?:\.exe)?$/.test(bin)) {
        // The VERB PAIR, so `gh workflow list|view|enable|disable` can never match.
        if (words[0] === 'workflow' && words[1] === 'run') {
          return {
            workflow: words[2] ?? '(prompted for)',
            ref: flagValue(rest, ['--ref', '-r']),
            how: 'gh workflow run',
          };
        }
        if (words[0] === 'api') {
          const hit = words.slice(1).map((w) => DISPATCH_URL.exec(w)).find(Boolean);
          if (hit) {
            const refField = rest.find((t) => /^ref=/.test(t));
            return { workflow: hit[2], ref: refField ? refField.slice(4) : null, how: 'gh api … /dispatches' };
          }
        }
        return null;
      }
      if (/^(?:curl(?:\.exe)?|wget(?:\.exe)?|invoke-restmethod|invoke-webrequest|irm|iwr)$/.test(bin)) {
        const hit = rest.map((w) => DISPATCH_URL.exec(w)).find(Boolean);
        if (hit) {
          // Read the ref from the RAW command, not from `text`: by the time a segment reaches here,
          // withoutHeredocBodies/withoutHereStringBodies have removed the very body that carries
          // {"ref":"main"} — so a heredoc-fed curl reported NO ref and silently lost the main
          // exemption. `-d @file.json` can never carry a readable ref at all (and per §2.1 that is
          // the only form that works on Windows), which is why an unreadable ref falls back to the
          // default branch rather than to a countable key.
          const inBody = /["']ref["']\s*:\s*["']([^"']+)["']/.exec(rawCommand) ?? /["']ref["']\s*:\s*["']([^"']+)["']/.exec(text);
          return { workflow: hit[2], ref: inBody ? inBody[1] : null, how: bin + ' … /dispatches' };
        }
      }
      return null;
    };

    // Both readings of each segment, as C8 does: unwrapped() strips a leading quote and so
    // unbalances a line whose first token is a quoted path — and on this machine it often is.
    let dispatch = null;
    for (const segment of commandSegments(withoutHereStringBodies(withoutHeredocBodies(cmd)))) {
      for (const text of [segment.trim(), unwrapped(segment)]) {
        const hit = readsAsDispatch(text);
        if (hit) {
          dispatch = { ...hit, segment: segment.trim() };
          break;
        }
      }
      if (dispatch) break;
    }

    // `main` is exempt before any state is touched: nothing about a main dispatch is countable.
    //
    // 🔴 AN ABSENT `--ref` IS MAIN, AND MISSING THAT DEFEATED THE WHOLE EXEMPTION. `gh workflow run
    // ci.yml` with no flag targets the repository's DEFAULT branch, which is `main` here — and that
    // bare form is exactly what a session already working on main types during an outage, because
    // there is no reason to pass a ref it is already on. The first version of this clause keyed it as
    // `ci@(default)`, counted it, and denied the third one: measured 2026-09-27, bare form
    // allow/allow/DENY while `--ref main` stayed allow/allow/allow. Since #4537 that denial would
    // land on a commit already serving production with no verdict — the exact case the exemption
    // exists for. The suite missed it because all fifteen of its cases passed an explicit --ref.
    const ref = dispatch ? (dispatch.ref ?? '(default)') : null;
    const exemptRef = ref === 'main' || ref === 'refs/heads/main' || ref === '(default)';
    const sessionId = String(input?.session_id ?? '').replace(/[^A-Za-z0-9_-]/g, '');
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const stateDir = process.env.PHX_DISPATCH_STATE_DIR
      ? process.env.PHX_DISPATCH_STATE_DIR
      : home
        ? join(home, '.claude', 'relay', 'state')
        : '';

    if (dispatch && !exemptRef && sessionId && stateDir) {
      const stateFile = join(stateDir, 'dispatch-' + sessionId + '.json');
      // Sweep, filtered on the `dispatch-` prefix: this directory is shared with trap-injector.mjs's
      // `traps-<session>.json`, and an unfiltered sweep would delete every session's cluster state.
      try {
        const cutoff = Date.now() - DISPATCH_MAX_AGE_DAYS * 86400000;
        for (const name of readdirSync(stateDir)) {
          if (!name.startsWith('dispatch-')) continue;
          const f = join(stateDir, name);
          if (statSync(f).mtimeMs < cutoff) rmSync(f, { force: true });
        }
      } catch {
        /* the directory does not exist yet — nothing to clean */
      }

      let state = null;
      try {
        const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
        // A version this clause did not write is not a count this clause would have made.
        if (parsed && parsed.version === DISPATCH_STATE_VERSION && Array.isArray(parsed.dispatches)) {
          state = parsed;
        }
      } catch {
        state = null; // absent, unreadable, corrupt, half-written — all mean "nothing recorded"
      }
      if (!state) state = { version: DISPATCH_STATE_VERSION, sessionId, dispatches: [] };

      const key = workflowKey(dispatch.workflow) + '@' + ref;
      const prior = state.dispatches.find((entry) => entry.key === key) ?? null;
      const already = prior ? Number(prior.count) || 0 : 0;
      const standDown = DISPATCH_STAND_DOWN.test(cmd) || process.env.PHX_DISPATCH_OK === '1';

      if (!standDown && already >= DISPATCH_PER_TARGET_CAP) {
        const once =
          input.tool_name === 'PowerShell'
            ? '$env:PHX_DISPATCH_OK=1; ' + dispatch.segment
            : 'PHX_DISPATCH_OK=1 ' + dispatch.segment;
        deny(
          'A repeat workflow_dispatch is refused - `' +
            dispatch.workflow +
            '` on `' +
            ref +
            '` has already been dispatched ' +
            already +
            ' time' +
            (already === 1 ? '' : 's') +
            ' in this session, and one more will not help.\n' +
            'A dispatch CANNOT unblock a PR: its check runs never enter the PR\'s statusCheckRollup, so ' +
            'branch protection ignores them however green they are - and ci.yml already triggers on push ' +
            'and pull_request, so the head has its own run.\n' +
            'On 2026-09-27 a session ran one of these 71 times between 07:04 and 10:11 and every run came ' +
            'back startup_failure: GitHub creates the run, refuses to compile the workflow, and returns no ' +
            'logs, no jobs and no workflow name, so there was nothing to read and retrying felt like ' +
            'progress. It was 58% of that day\'s failed runs, and the real cause was the repository losing ' +
            'its Pro entitlement - nothing a retry could reach.\n' +
            'Do this instead:\n' +
            '  gh api repos/Gawish-1997/phoenix-people-workforce/branches/main --jq .protected   # false = the gate is off, entitlement lapsed\n' +
            '  gh run list --workflow=ci.yml --branch <branch> --limit 5 --json databaseId,event,status,conclusion\n' +
            '  gh run rerun <id>   # the pull_request-sourced run: it keeps the event, so its checks reach the rollup\n' +
            'Then WAIT - dispatch lags 20-30 minutes during an Actions outage and events are not dropped. ' +
            'A dispatch on `main` is never refused here, because main is not gated by a PR and its CI run ' +
            'is the production deploy gate.\n' +
            'If this really is a different thing - a workflow meant to be fired by hand, or the same one ' +
            'again after a real fix - stand this guard down for that one command:\n' +
            '  ' +
            once,
        );
      }

      // Allowing. Record it on the allow path only: a denied command never ran, and counting it
      // would inflate the number the next deny quotes. A stood-down dispatch IS recorded, so the
      // count stays truthful for the moment the stand-down lapses.
      const now = new Date().toISOString();
      if (prior) {
        prior.count = already + 1;
        prior.lastAt = now;
      } else {
        state.dispatches.push({ key, workflow: dispatch.workflow, ref, how: dispatch.how, count: 1, firstAt: now, lastAt: now });
      }
      state.updatedAt = now;
      if (state.dispatches.length > DISPATCH_MAX_ENTRIES) {
        // Evict the LEAST RECENTLY TOUCHED, never by array position: a positional slice can drop the
        // entry that was just incremented, which silently resets that target's count to zero and
        // hands the loop back its third, fourth and fifth attempt.
        state.dispatches.sort((a, b) => String(a.lastAt).localeCompare(String(b.lastAt)));
        state.dispatches = state.dispatches.slice(-DISPATCH_MAX_ENTRIES);
      }
      try {
        mkdirSync(stateDir, { recursive: true });
        const tmp = stateFile + '.' + process.pid + '.tmp';
        writeFileSync(tmp, JSON.stringify(state), 'utf8');
        renameSync(tmp, stateFile);
      } catch {
        /* a counter that cannot be persisted must never block a command */
      }
    }
  }

  // C6 — pnpm inside a linked worktree. AGENTS.md §5 has said "never" since the junction layout
  // existed, and until now nothing enforced it: there is no .npmrc, no other hook reads pnpm, and
  // the user-level heavy-job gate classifies `pnpm install` as not heavy. Meanwhile the command is
  // AUTO-APPROVED from several directions — `Bash(pnpm run *)` and `Bash(pnpm exec *)` sit in the
  // gitignored .claude/settings.local.json that scripts/sync-worktree-env.mjs copies into every
  // new worktree, and ~/.claude/settings.json adds `Bash(pnpm run build)` and friends. Deleting
  // allow-rules cannot close this: a wildcard grant elsewhere still auto-approves, and a missing
  // prompt is not a refusal. Only a hook deny is a gate.
  //
  // What it costs when it goes wrong: a worktree's node_modules is a JUNCTION to the primary
  // checkout's. pnpm sees a lockfile that has "moved", so its deps check offers to delete
  // node_modules — deleting the PRIMARY's install and breaking every session on this machine.
  // CLAUDE.md records that prompt being answered `N` with one second to spare on 2026-09-05.
  //
  // Any of the session's candidate folders being a linked worktree is enough: the Bash tool's cwd
  // persists across calls, so a session that cd'd into a worktree runs there whatever
  // CLAUDE_PROJECT_DIR says, and CLAUDE_PROJECT_DIR answers when the cwd is somewhere unrelated
  // (a scratchpad). Erring toward the deny is the cheap direction — one round trip against an
  // install the whole machine shares.
  if (PNPM_AT_COMMAND_POSITION.test(withoutHeredocBodies(cmd))) {
    const seen = new Set();
    for (const candidate of [input?.cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()]) {
      if (!candidate || seen.has(normPath(candidate))) continue;
      seen.add(normPath(candidate));
      const dir = String(candidate);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const { linked, primary, root } = linkedWorktree(dir);
      if (!linked) continue;

      const advice = pnpmAdvice(withoutHeredocBodies(cmd), root || dir);
      // The placeholder below says `<file>`, never `<script>`: Semgrep's
      // unknown-value-with-script-tag rule reads any string holding "<script" as an HTML tag and
      // flags every value passed beside it as XSS — five false findings on 2026-09-16. This text
      // reaches the agent as JSON on stdout, never a web page.
      deny(
        'pnpm is refused inside a linked worktree (AGENTS.md §5). node_modules here is a JUNCTION ' +
          "to the primary checkout's, so pnpm sees the lockfile as moved and its deps check offers " +
          "to delete node_modules — which deletes the PRIMARY's install and breaks every session " +
          'on this machine. That prompt was answered `N` with one second to spare on 2026-09-05.\n' +
          `  worktree: ${dir.replace(/\\/g, '/')}\n` +
          (primary ? `  primary:  ${primary}\n` : '') +
          (advice?.run
            ? `Run instead:\n  ${advice.run}\n`
            : advice?.note
              ? `${advice.note}\n`
              : 'No node-direct equivalent is recorded for that one — invoke the script itself ' +
                '(`node scripts/<file>`, see package.json), or run it from the primary checkout.\n') +
          'Invoke node directly here; pnpm belongs in the primary folder only.',
      );
    }
  }

  // C5 — a command that looks like it removes a worktree. NOT a denial: hand the command to the
  // backup guard so the unpushed-commit check is written to .claude/worktree-exit.log while the
  // directory still exists. The SessionEnd guard cannot do this — by the time it runs, the worktree
  // (and the guard script inside it) may already be deleted, which is exactly how three weeks of
  // exits went unlogged. Measured 2026-08-23.
  //
  // The regex is only a cheap pre-filter so the common command pays nothing; the guard itself
  // decides whether a real registered worktree is actually targeted.
  // C12 — the secret scan moved OFF the pull request and onto this machine, at the owner's
  // instruction (2026-09-29). `secret-scan` took ~23s and billed a full minute on every one of ~186
  // PR runs a day, purely because GitHub rounds each job up; the scan itself was never the cost.
  //
  // Running it here is strictly EARLIER protection, not less: gitleaks fires before the push leaves
  // the machine, so a leaked key never reaches GitHub at all — where, once pushed, it is in the
  // remote history whatever the PR check then says. The daily scheduled scan over `main` stays as
  // the backstop for anything that arrives another way.
  //
  // 🔴 IT SCANS THE COMMITS THIS BRANCH ADDS, NOT THE WORKING TREE, AND THE DIFFERENCE IS THE WHOLE
  // CLAUSE. CI runs `gitleaks detect --source . --no-git`, which is correct THERE because a runner
  // has no env files. Locally it is useless: `new-session.mjs` copies `.env.local` and friends into
  // every worktree by design, and that same command reports 54 findings here — 16 in `.env.local`,
  // 16 in each dated copy, all of them real keys that are gitignored and can never be pushed. A
  // guard that fires on every push of every branch is one nobody keeps. `gitleaks git --log-opts
  // origin/main..HEAD` scans exactly what the push contributes: measured 0.85s over 3 commits here,
  // against 4.8s and 99 MB for the tree scan. `--redact` keeps the value out of this hook's own
  // output, which would otherwise become the leak.
  //
  // 🔴 IF GITLEAKS IS NOT INSTALLED THIS WARNS AND ALLOWS, it does not block. A guard that refuses
  // every push on a machine missing a tool is a guard that gets switched off within the hour — and
  // the daily scan still covers main. `scoop install gitleaks` is the fix, and the warning says so.
  //
  // `PHX_SECRETS_OK=1 <cmd>` pushes anyway — for a finding you have read and judged to be a fixture
  // or a test vector, which is the only honest reason to override a secret scanner.
  const SECRETS_STAND_DOWN =
    /(?:^|[\s;&|(])\s*(?:\$env:)?PHX_SECRETS_OK\s*=\s*['"]?1['"]?(?![\w.])/i;
  const GIT_PUSH =
    /(?:^|[\n|&;(])\s*(?:[A-Za-z_]\w*=\S+\s+)*git(?:\.exe)?\s+(?:-[^\s]+\s+|--[^\s]+\s+)*push(?:\s|$)/i;

  const pushText = withoutHeredocBodies(cmd);
  if (
    GIT_PUSH.test(pushText) &&
    !/--dry-run|--help|(?:^|\s)-h(?:\s|$)/.test(pushText) &&
    !SECRETS_STAND_DOWN.test(cmd) &&
    process.env.PHX_SECRETS_OK !== '1'
  ) {
    let scanRoot = '';
    for (const candidate of [input?.cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()]) {
      if (!candidate) continue;
      try {
        if (statSync(String(candidate)).isDirectory()) {
          scanRoot = String(candidate);
          break;
        }
      } catch {
        /* not a directory we can see */
      }
    }

    if (scanRoot && existsSync(join(scanRoot, '.gitleaks.toml'))) {
      // `.gitleaks.toml` at the root is what identifies THIS repo; the hook is global and must
      // not scan someone else's checkout.
      let output = '';
      let found = false;
      let missing = false;
      try {
        execFileSync('gitleaks', ['git', '.', '--log-opts=origin/main..HEAD', '--redact', '--no-banner'], {
          cwd: scanRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 120000,
          shell: process.platform === 'win32',
        });
      } catch (err) {
        const e = /** @type {{status?: number, code?: string, stderr?: string, stdout?: string}} */ (err);
        // gitleaks exits 1 when it finds something and 126/127/ENOENT when it is not installed.
        if (e && (e.code === 'ENOENT' || e.status === 127 || e.status === 126)) {
          missing = true;
        } else if (e && e.status === 1) {
          found = true;
          output = String(e.stderr || e.stdout || '').trim();
        }
        // any other exit (a timeout, a config error) falls through as neither: allow.
      }

      if (missing) {
        process.stdout.write(
          'gitleaks is not installed, so this push was NOT scanned for secrets. The per-PR ' +
            'secret-scan was moved onto this machine on 2026-09-29; install it with ' +
            '`scoop install gitleaks` to get that protection back. The daily scheduled scan over ' +
            'main still runs.\n',
        );
      } else if (found) {
        // Strip ANSI colour: this text is JSON on stdout for the agent, not a terminal.
        const lines = output
          .replace(/\u001b\[[0-9;]*m/g, '')
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .slice(-25)
          .join('\n');
        deny(
          'C12 — gitleaks found a secret in the commits this push would send, so it is refused.\n\n' +
            lines +
            '\n\nThis runs BEFORE the push, which is the whole point: once a key reaches GitHub it ' +
            'is in the remote history whatever any check says afterwards, and the fix is then ' +
            'rotation, not a revert.\n\n' +
            'Scanned: the commits this branch adds (origin/main..HEAD), which is exactly what the ' +
            'push contributes. The tree itself is NOT scanned locally \u2014 every worktree carries real ' +
            '.env files by design, and they are gitignored, so they can never be pushed.\n\n' +
            'If you have read the finding and it is a fixture or a test vector, push again as:\n  ' +
            (String(input?.tool_name ?? '').toLowerCase().includes('powershell')
              ? '$env:PHX_SECRETS_OK=1; <the same command>'
              : 'PHX_SECRETS_OK=1 <the same command>'),
        );
      }
    }
  }

  // C11 — `synthetic-journeys` is the production smoke suite, and its cadence is a COST decision
  // that was already taken: it ran hourly until 2026-08-29 (17 runs/day) and was deliberately cut to
  // every three hours (6 runs/day) to save Actions minutes, at the stated price of worst-case
  // detection latency going from ~1h to ~3h. The workflow file carries that reasoning in full.
  //
  // Measured 2026-09-29: it ran 21 times that day — 2 from its schedule and 19 fired BY HAND from
  // sessions. Each run is ~120s, so it bills 3 minutes: the manual ones alone were ~57 billable
  // minutes, roughly three times the whole schedule, quietly undoing the August decision.
  //
  // The existing C9 cannot see this: it counts dispatches PER SESSION and exempts `main` entirely,
  // and these are main dispatches spread across fifteen sessions. So this cap is MACHINE-WIDE and
  // per DAY, like the merge rule above — the same reason, that the volume comes from many windows
  // each behaving reasonably on its own.
  //
  // It caps the MANUAL ones only. The schedule is untouched, and so is any dispatch of any other
  // workflow. `PHX_SMOKE_OK=1 <cmd>` allows one through when production is actually suspect — which
  // is the case the suite exists for, and the case a hard block would break.
  //
  // FAILS OPEN: an unreadable or unwritable state file allows the dispatch.
  const SMOKE_STAND_DOWN =
    /(?:^|[\s;&|(])\s*(?:\$env:)?PHX_SMOKE_OK\s*=\s*['"]?1['"]?(?![\w.])/i;
  const SMOKE_DISPATCH =
    /(?:^|[\n|&;(])\s*(?:[A-Za-z_]\w*=\S+\s+)*gh(?:\.exe)?\s+workflow\s+run\s+\S*synthetic-journeys(?:\.yml)?/i;

  const smokeText = withoutHeredocBodies(cmd);
  if (
    SMOKE_DISPATCH.test(smokeText) &&
    !SMOKE_STAND_DOWN.test(cmd) &&
    process.env.PHX_SMOKE_OK !== '1'
  ) {
    const maxPerDay = Number(process.env.PHX_SMOKE_MAX_PER_DAY ?? 2);
    const smokeHome = process.env.USERPROFILE || process.env.HOME || '';
    const smokeDir = process.env.PHX_SMOKE_STATE_DIR
      ? process.env.PHX_SMOKE_STATE_DIR
      : smokeHome
        ? join(smokeHome, '.claude', 'relay', 'state')
        : '';

    if (smokeDir && Number.isFinite(maxPerDay) && maxPerDay >= 0) {
      const smokeFile = join(smokeDir, 'smoke-dispatch.json');
      const today = new Date().toISOString().slice(0, 10);
      let count = 0;
      try {
        const raw = JSON.parse(readFileSync(smokeFile, 'utf8'));
        if (raw && raw.day === today && Number.isFinite(Number(raw.count))) count = Number(raw.count);
      } catch {
        /* no state yet, or unreadable — today has no dispatches on record */
      }

      if (count >= maxPerDay) {
        deny(
          'C11 — `synthetic-journeys` has already been dispatched by hand ' +
            count +
            ' time' +
            (count === 1 ? '' : 's') +
            ' today, across all sessions on this machine. The cap is ' +
            maxPerDay +
            '.\n\n' +
            'Its cadence is a cost decision already taken: hourly until 2026-08-29 (17 runs/day), cut ' +
            'to every 3 hours (6/day) to save Actions minutes, accepting ~3h worst-case detection ' +
            'latency. Each run bills 3 minutes.\n\n' +
            'Measured 2026-09-29: 21 runs that day — 2 scheduled and 19 by hand, ~57 billable minutes ' +
            'of unplanned spend, about three times the entire schedule.\n\n' +
            'The scheduled runs are untouched and still cover production every 3 hours. If production ' +
            'is actually suspect right now — which is the case this suite exists for — run it again as:' +
            '\n  ' +
            (String(input?.tool_name ?? '').toLowerCase().includes('powershell')
              ? '$env:PHX_SMOKE_OK=1; <the same command>'
              : 'PHX_SMOKE_OK=1 <the same command>'),
        );
      }

      try {
        if (!existsSync(smokeDir)) mkdirSync(smokeDir, { recursive: true });
        writeFileSync(smokeFile, JSON.stringify({ day: today, count: count + 1 }), 'utf8');
      } catch {
        /* cannot record — allow anyway */
      }
    }
  }

  // C10 — a merge costs TWO full CI runs whatever its size: one on the PR, one on `main`. GitHub
  // rounds every JOB up to a whole minute, so a nine-second job bills a minute and a three-file
  // change costs almost exactly what a three-hundred-file change costs.
  //
  // Measured 2026-09-29 on this repository: 110 merges in a single day, 280 ci.yml runs (185
  // pull_request + 95 push), 634 runs across all workflows — and over the preceding week 41% of
  // merges touched 3 files or fewer. The owner's Actions spend that day was $65 by his own reading
  // of the invoice, on a month whose previous record was $300.88. No runner change reaches this:
  // where the jobs execute does not alter how many of them there are, which is why the self-hosted
  // pool was stood down the same evening having carried no CI at all.
  //
  // 🔴 THE RULE IS ABOUT SIZE, NOT TIMING, AND THAT IS THE OWNER'S OWN NARROWING (2026-09-29). A
  // cooldown between merges was built first and he cut it the same evening: merges must go through
  // when they are ready. So nothing here delays a merge, queues one, or counts how many have run —
  // a finished PR of any size merges the moment it is green. The only thing refused is shipping a
  // change too small to have been worth its own two CI runs.
  //
  // `PHX_MERGE_OK=1 <cmd>` (`$env:PHX_MERGE_OK=1; <cmd>` in PowerShell) allows one merge through —
  // for the urgent one-file fix, the locked file, the migration that needs its own approval, and
  // for a PR that is ALREADY open and green: its run is paid, closing refunds nothing, and a
  // rebuild later costs a second PR run on top of the same `main` run. The clause is about what
  // is OPENED, not about throwing away work that is already built.
  // That is why this denies rather than blocks outright: a guard with no way past it gets deleted
  // instead of used.
  //
  // FAILS OPEN in every direction: an unreachable `gh`, a PR number it cannot parse, a merge of the
  // CURRENT branch with no number at all — every one of them allows the merge. A guard that blocks
  // a real merge on its own blind spot costs more than the runs it saves.
  const MERGE_STAND_DOWN =
    /(?:^|[\s;&|(])\s*(?:\$env:)?PHX_MERGE_OK\s*=\s*['"]?1['"]?(?![\w.])/i;
  const GH_PR_MERGE =
    /(?:^|[\n|&;(])\s*(?:[A-Za-z_]\w*=\S+\s+)*gh(?:\.exe)?\s+pr\s+merge(?:\s|$)/i;
  const MERGE_HELP = /(?:^|\s)(?:--help|-h)(?:\s|$)/;

  const mergeText = withoutHeredocBodies(cmd);
  if (
    GH_PR_MERGE.test(mergeText) &&
    !MERGE_HELP.test(mergeText) &&
    !MERGE_STAND_DOWN.test(cmd) &&
    process.env.PHX_MERGE_OK !== '1'
  ) {
    const minFiles = Number(process.env.PHX_MERGE_MIN_FILES ?? 4);

    if (Number.isFinite(minFiles) && minFiles > 0) {
      // Take the first bare integer after `merge` — `gh pr merge 4790 --squash` and
      // `gh pr merge --squash 4790` both land on 4790, and a merge of the CURRENT branch (no
      // number at all) is allowed rather than guessed at.
      const after = mergeText.slice(mergeText.search(/gh(?:\.exe)?\s+pr\s+merge/i));
      const prNumber = (after.match(/(?:^|\s)(\d{1,7})(?=\s|$)/) || [])[1];
      if (prNumber) {
        let changedFiles = null;
        try {
          const out = execFileSync(
            'gh',
            ['pr', 'view', prNumber, '--json', 'changedFiles', '--jq', '.changedFiles'],
            {
              cwd: input?.cwd && existsSync(String(input.cwd)) ? String(input.cwd) : process.cwd(),
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
              timeout: 20000,
              // On Windows a PATH lookup without a shell resolves .exe but NOT .cmd, and gh ships
              // both. Every argument here is fixed text or the digits the regex above extracted,
              // so there is nothing for a shell to re-interpret.
              shell: process.platform === 'win32',
            },
          );
          const n = Number(String(out).trim());
          if (Number.isFinite(n) && n > 0) changedFiles = n;
        } catch {
          // gh missing, offline, or the PR not readable — allow. Never block on our own blind spot.
        }
        if (changedFiles !== null && changedFiles < minFiles) {
          deny(
            'C10 — PR #' +
              prNumber +
              ' changes ' +
              changedFiles +
              ' file' +
              (changedFiles === 1 ? '' : 's') +
              ', and a merge costs two full CI runs whatever its size (one on the PR, one on ' +
              '`main`, every job rounded up to a whole minute).\n\n' +
              'Measured 2026-09-29: 110 merges in one day, 634 workflow runs, and 41% of the ' +
              'week’s merges touching 3 files or fewer. That volume, not the pipeline, is the ' +
              'Actions bill — the pipeline is already cancelling superseded runs and skipping ' +
              'docs-only work.\n\n' +
              'Fold this into the branch carrying the rest of the task and merge once: the fix, ' +
              'its test, its doc, the follow-up already in view. Nothing here delays a merge — ' +
              'a finished PR of any real size goes the moment it is green.\n\n' +
              '🔴 BUT IF THIS PR IS ALREADY OPEN AND GREEN, MERGE IT WITH THE STAND-DOWN ' +
              'RATHER THAN CLOSING IT. Its PR run is already paid and closing refunds nothing: ' +
              'merging costs one more run on `main`, while closing and rebuilding the work later ' +
              'costs a fresh PR run AND that same `main` run. This clause is about what you OPEN, ' +
              'not about abandoning work already built and verified.\n\n' +
              'If this one genuinely has to ship alone (an urgent fix, a locked file, a migration ' +
              'needing its own approval), run it again as:\n  ' +
              (String(input?.tool_name ?? '').toLowerCase().includes('powershell')
                ? '$env:PHX_MERGE_OK=1; <the same command>'
                : 'PHX_MERGE_OK=1 <the same command>'),
          );
        }
      }
    }
  }

  // `rd`/`ri`/`del`/`erase` are PowerShell's Remove-Item aliases (and cmd's own verbs).
  const removalShaped =
    /worktree\s+remove|\brmdir\b|\bremove-item\b|(?:^|[\s|&;(])(?:rd|ri|del|erase)\s|(?:^|[\s|&;(])rm\s+-[a-zA-Z]*r/i;
  if (removalShaped.test(cmd)) {
    try {
      const guard = fileURLToPath(new URL('./worktree-exit-guard.mjs', import.meta.url));
      const report = execFileSync(process.execPath, [guard, '--pre-removal'], {
        input: cmd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 20000,
      });
      // Relay the guard's systemMessage as this hook's output so it surfaces in the session, not
      // only in the log. Empty when nothing registered was targeted.
      if (report && report.trim()) process.stdout.write(report.trim() + '\n');
    } catch {
      // A logging failure must never block a real command — same fail-open contract as the rest.
    }
  }

  process.exit(0);
} catch {
  process.exit(0); // fail open
}
