#!/usr/bin/env node
// PreToolUse(Bash|PowerShell) guard — deterministic, zero-cost.
// Blocks the commands the memory documents as silent traps in THIS repo:
//   C1  recursive grep  — ~346k path entries make `grep -r` hang 10-40s+. Use rg / git grep.
//   C6  pnpm inside a LINKED WORKTREE — its deps check offers to delete the PRIMARY's
//       node_modules, which every worktree's node_modules is only a junction to.
//   C7  a raw `next dev` — it skips scripts/dev-server.mjs, so Next hands the server half of RAM
//       (8,086 MB here) instead of the launcher's 4,096, and nothing refuses a second server.
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
import { existsSync, readFileSync, statSync } from 'node:fs';
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
