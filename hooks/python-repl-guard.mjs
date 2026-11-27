#!/usr/bin/env node
/**
 * python-repl-guard.mjs — bash-guard clause C19, MACHINE-WIDE (2026-10-15).
 *
 *   PreToolUse (Bash|PowerShell)   node python-repl-guard.mjs
 *     - a command that would land in Python's INTERACTIVE REPL is DENIED: a bare
 *       `python`/`python3`/`py` with no script, no `-c`, no `-m` and nothing piped or redirected
 *       into it, or a `python - <<DELIM` whose closing delimiter never appears.
 *   node python-repl-guard.mjs selftest
 *     - the deny set and the allow set, each driven through this hook as a real subprocess with the
 *       real stdin payload. Expect "0 failed" after editing this file.
 *
 * WHY THIS FILE EXISTS AT THE USER LEVEL. The clause was written for phoenix-workforce
 * (`.claude/hooks/bash-guard.mjs` C19, PR 5924, pinned by `tests/python-repl-guard.test.ts`), and it
 * only ever answers inside that repo. A session started with NO project folder, or in any other
 * repository on this machine, could still send a bare `python` in a background Bash task — and the
 * cost is machine-wide, not repo-wide: it is C: filling up.
 *
 * WHAT IT COSTS. With no console attached, Python 3.13/3.14's _pyrepl dies inside
 * Lib/_pyrepl/windows_console.py `getheightwidth` with `OSError: [WinError 123]` and reprints that
 * traceback for ever. The harness writes a background task's output to `…/tasks/<id>.output`, so the
 * loop goes to disk. Measured on this box on 2026-10-15, both interpreters: 1,774,873 bytes in 3 s
 * and 3,948,442 in 6 s — about 640 KB/s, 2.2 GB an hour. Three background tasks did it on 9, 10 and
 * 15 Oct 2026 and left 12.5 GB, 5.4 GB and 2.4 GB behind; C: was down to 12 GB free before anyone
 * looked. Nothing alerts on it: the session has ended its turn, the task reads as "running", and
 * nobody opens the output file until the task exits, which it never does.
 *
 * ONLY THE ONE CLAUSE. Everything else in the repo's bash-guard — pnpm inside a worktree, a raw
 * `next dev`, the local typecheck, the merge and roll-up clauses, the gitleaks push scan — is about
 * THAT repo and would misfire anywhere else, so none of it is copied here.
 *
 * IDEMPOTENT. When the session's own project already wires a bash-guard carrying C19, this hook
 * returns silently and lets that one answer — two refusals for one command is noise.
 *
 * FAILS OPEN. Any parse or logic error exits 0 (allow). A hook bug must never block a real command.
 * Returns silently for any tool but Bash and PowerShell.
 *
 * STAND-DOWNS, both the repo clause's own:
 *   PHX_PYTHON_REPL_OK=1 <the same command>        ($env:PHX_PYTHON_REPL_OK=1; … in PowerShell)
 *   PYTHON_BASIC_REPL=1 <the same command>         (not a bypass — it turns _pyrepl off, and the
 *                                                   same command then writes 176 bytes and exits)
 *
 * Account: phoenix-workforce `docs/agents-session-traps.md` → "A bare python REPL wrote 20.3 GB into
 * three task logs and filled C:", and `.claude/rules/sessions.md`.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';

const mode = String(process.argv[2] ?? '');

// ── the clause's reading of a command (copied from bash-guard.mjs, C19 and its helpers only) ─────

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

/** A PowerShell here-string's body is data, like a heredoc's — its quote must not flip the tracking. */
function withoutHereStringBodies(text) {
  return String(text).replace(/@(["'])[ \t]*\r?\n[\s\S]*?\r?\n\1@/g, "''");
}

/**
 * Each segment, and whether a PIPE fed it: a `|` is the difference between a python with input and
 * one without, while `||` is not a pipe and the `&` of a redirect (`2>&1`, `&>f`) is not a separator.
 */
function pipedSegments(text) {
  const segments = [];
  let current = '';
  let quote = null;
  let piped = false;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        current += ch + (chars[i + 1] ?? '');
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '\\') {
      current += ch + (chars[i + 1] ?? '');
      i++;
    } else if (ch === '|') {
      segments.push({ text: current, piped });
      current = '';
      piped = chars[i + 1] !== '|';
      if (chars[i + 1] === '|' || chars[i + 1] === '&') i++;
    } else if (ch === '&' && (/[<>]/.test(chars[i - 1] ?? '') || chars[i + 1] === '>')) {
      current += ch;
    } else if ('\n;&()'.includes(ch)) {
      segments.push({ text: current, piped });
      current = '';
      piped = false;
      if (ch === '&' && chars[i + 1] === '&') i++;
    } else {
      current += ch;
    }
  }
  segments.push({ text: current, piped });
  return segments;
}

/** Words that can stand in front of a command in one segment without being the command. */
const SEGMENT_LEAD = /^(?:(?:then|do|else|elif|time|exec|command|nohup|!|\{)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)/;

const LAUNCH_WRAPPERS = [
  /^cmd(?:\.exe)?\s+\/[ck]\s+/i,
  /^(?:powershell|pwsh|bash|sh)(?:\.exe)?\s+(?:-{1,2}[\w-]+\s+)*/i,
  /^start\s+(?:"[^"]*"\s+)?(?:\/\w+\s+)*/i,
  /^(?:call|exec|nohup|env)\s+/i,
  /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/,
  /^["']/,
];

function unwrapped(segment) {
  let text = String(segment).trim();
  for (let pass = 0; pass < 8; pass++) {
    const before = text;
    for (const wrapper of LAUNCH_WRAPPERS) text = text.replace(wrapper, '').trim();
    if (text === before) break;
  }
  return text;
}

const binName = (token) =>
  String(token ?? '')
    .replace(/^.*[\\/]/, '')
    .toLowerCase();

/** argv for one segment, QUOTE-AWARE: every python on this machine sits under a path with a space. */
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

/** A Python interpreter, however the path to it was spelled: `python`, `python3`, `python3.13`, `py`. */
const PYTHON_BASENAME = /^(?:python(?:\d(?:\.\d+)?)?|py)(?:\.exe)?$/i;

/** Python flags that print and exit, reading nothing at all — there is no REPL to fall into. */
const PYTHON_EXITS = /^(?:-V|-VV|--version|-h|-\?|--help|--help-env|--help-xoptions|--help-all)$/;

/** Python flags that take the NEXT token as their value, so that token is not a script path. */
const PYTHON_FLAG_TAKES_VALUE = /^(?:-X|-W|--check-hash-based-pycs)$/;

/**
 * Every WELL-FORMED heredoc body swapped for a single ` <<HEREDOC ` token, with the `<<DELIM` of one
 * that never closes left standing — which is what this clause reads as the mangled-delimiter shape.
 *
 * Line-based, because bash's rule is about the LINE: `<<DELIM` needs the delimiter alone at column 0,
 * and only `<<-DELIM` allows leading TABS (not spaces). A regex that accepts any indentation reads an
 * indented `  PY` as closing a heredoc bash would have left open — exactly the shape that put a
 * session at the REPL on 15 Oct 2026.
 */
function markHeredocs(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    if (!open) {
      out.push(line);
      continue;
    }
    const dash = open[1];
    const delim = open[3];
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = dash ? lines[j].replace(/^\t+/, '') : lines[j];
      if (candidate.replace(/[ \t]+$/, '') === delim) {
        close = j;
        break;
      }
    }
    if (close < 0) {
      out.push(line); // never closed — the `<<DELIM` stays, and it is the evidence
      continue;
    }
    out.push(line.replace(open[0], ' <<HEREDOC '));
    i = close; // skip the body AND the delimiter line
  }
  return out.join('\n');
}

/**
 * The first python in a command that would land in the INTERACTIVE REPL, or null. Two shapes, both
 * measured on 2026-10-15: `bare` — nothing to run and nothing to read, so python starts its REPL;
 * and `heredoc` — a `<<DELIM` on the python segment whose closing delimiter never appears, which is
 * how one of the three started (bash passes an unterminated body, or nothing, and python falls into
 * the REPL anyway).
 *
 * NOT matched, deliberately: a `timeout N python …`, because that bounds the flood to N seconds and
 * is how the 640 KB/s rate was measured in the first place.
 */
function interactivePython(command) {
  const text = markHeredocs(withoutHereStringBodies(command));
  for (const segment of pipedSegments(text)) {
    let body = segment.text.trim();
    for (let pass = 0; pass < 8 && SEGMENT_LEAD.test(body); pass++) body = body.replace(SEGMENT_LEAD, '');
    // The quoted path FIRST: `unwrapped` strips the opening quote, after which
    // `"C:\Program Files\…\python.exe"` tokenizes as `C:\Program` and the interpreter is invisible.
    // Unwrapping is the second attempt, for `bash -c "python"` and `VAR=x python`.
    let tokens = null;
    for (const candidate of [body, unwrapped(body)]) {
      const argv = argvTokens(candidate);
      if (PYTHON_BASENAME.test(binName(argv[0]))) {
        tokens = argv;
        body = candidate;
        break;
      }
    }
    if (!tokens) continue;
    let fed = segment.piped;
    let runs = false;
    let exits = false;
    let unterminated = null;
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '<<HEREDOC' || /^<<</.test(token)) fed = true;
      else if (/^<</.test(token)) unterminated = token.replace(/^<<-?/, '') || '(unnamed)';
      else if (/^\d*</.test(token)) fed = true;
      // `>` / `2>` / `&>>` alone take the NEXT token as their target; `>f` and `2>&1` carry their own.
      else if (/^(?:\d*|&)>>?$/.test(token)) i++;
      else if (/^(?:\d*|&)>/.test(token)) continue;
      // `-c`, `-m` and a positional script all mean python RUNS something — but the scan carries on
      // rather than breaking, because an unterminated heredoc later in the same segment lands at the
      // REPL anyway: bash takes the `<<` for itself and python is handed nothing.
      else if (token === '-c' || token === '-m') runs = true;
      else if (PYTHON_EXITS.test(token)) exits = true;
      else if (PYTHON_FLAG_TAKES_VALUE.test(token)) i++;
      else if (token === '-') continue; // standard input, not a script
      else if (/^-/.test(token)) continue; // -u, -I, -E, -B, -q, py's -3 …
      else runs = true; // a positional: the script path
    }
    if (unterminated) return { kind: 'heredoc', segment: body, delimiter: unterminated };
    if (!runs && !exits && !fed) return { kind: 'bare', segment: body, delimiter: null };
  }
  return null;
}

const STAND_DOWN =
  /(?:^|[\s;&|(])\s*(?:\$env:)?(?:PHX_PYTHON_REPL_OK|PYTHON_BASIC_REPL)\s*=\s*['"]?1['"]?(?![\w.])/i;

/** The refusal, in the dialect of the tool that asked. */
export function replDenial(repl, toolName) {
  const standDown =
    String(toolName ?? '').toLowerCase() === 'powershell'
      ? '$env:PHX_PYTHON_REPL_OK=1; <the same command>'
      : 'PHX_PYTHON_REPL_OK=1 <the same command>';
  return (
    (repl.kind === 'heredoc'
      ? `C19 — this python heredoc never closes its \`${repl.delimiter}\` delimiter, so python gets no script ` +
        'and lands in the INTERACTIVE REPL, which no session here can type into:\n'
      : "C19 — this would land in Python's INTERACTIVE REPL — no script, no `-c`, no `-m` and nothing " +
        'piped or redirected into it — and no session here can type into one:\n') +
    `  ${repl.segment.length > 160 ? repl.segment.slice(0, 160) + ' …' : repl.segment}\n` +
    'With no console attached it does not wait quietly. 3.13/3.14 _pyrepl dies in ' +
    'windows_console.py getheightwidth (`OSError: [WinError 123]`) and reprints that traceback for ' +
    'ever: measured 2026-10-15, 1,774,873 bytes in 3 seconds — about 2.2 GB an hour. Three ' +
    'background tasks did exactly this into their own tasks/<id>.output on 9, 10 and 15 Oct 2026 and ' +
    'left 12.5 GB, 5.4 GB and 2.4 GB behind, which filled C:.\n\n' +
    'Give python something to run:\n' +
    '  python script.py                 (write the file first, then run it)\n' +
    '  python -c "print(1)"\n' +
    '  python -m <module> …\n' +
    "  python - <<'PY'   …   PY         (the closing PY on a line of its own)\n" +
    'or, if the REPL itself is what you want, PYTHON_BASIC_REPL=1 turns _pyrepl off — the same ' +
    'command then writes 176 bytes and exits.\n\n' +
    `If the owner asked for this, stand it down for one command: ${standDown}`
  );
}

// ── is a repo-level bash-guard already going to answer this call? ────────────────────────────────

/** The first 24 KB of a file, or '' — enough to reach a hook's header comment without reading 90 KB. */
function head(file) {
  let fd = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(24576);
    const read = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

const mentionsBashGuard = (file) => {
  try {
    return existsSync(file) && readFileSync(file, 'utf8').includes('bash-guard');
  } catch {
    return false;
  }
};

/**
 * True when this session's own project carries a bash-guard that holds C19 AND wires it. Both halves
 * matter: the hook FILE alone is not enforcement (a subfolder of the repo is not the project dir and
 * gets no project hooks at all), and a wiring entry alone is not the clause (an older checkout's
 * bash-guard predates C19). When both hold, this hook stays silent and the repo's one answers.
 */
export function repoGuardAnswers(startDirs) {
  for (const start of startDirs) {
    if (!start) continue;
    let dir = String(start).replace(/[\\/]+$/, '');
    for (let up = 0; up < 12 && dir; up++) {
      const guard = join(dir, '.claude', 'hooks', 'bash-guard.mjs');
      if (existsSync(guard) && /\bC19\b/.test(head(guard))) {
        const wired =
          mentionsBashGuard(join(dir, '.claude', 'hooks', 'dispatch.json')) ||
          mentionsBashGuard(join(dir, '.claude', 'settings.json')) ||
          mentionsBashGuard(join(dir, '.claude', 'settings.local.json'));
        if (wired) return true;
      }
      const parent = join(dir, '..').replace(/[\\/]+$/, '');
      if (parent === dir) break;
      dir = parent;
    }
  }
  return false;
}

// ── the hook ────────────────────────────────────────────────────────────────────────────────────

if (mode !== 'selftest') {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') process.exit(0);
    const cmd = String(input?.tool_input?.command ?? '');
    if (!cmd) process.exit(0);
    if (STAND_DOWN.test(cmd)) process.exit(0);
    if (process.env.PHX_PYTHON_REPL_OK === '1' || process.env.PYTHON_BASIC_REPL === '1') process.exit(0);
    if (repoGuardAnswers([input?.cwd, process.env.CLAUDE_PROJECT_DIR])) process.exit(0);
    const repl = interactivePython(cmd);
    if (repl) deny(replDenial(repl, input.tool_name));
    process.exit(0);
  } catch (e) {
    if (e?.[Symbol.for('phx.hook-exit')]) throw e; // a deny above ended this hook (hook-dispatch.mjs)
    process.exit(0); // fail open
  }
}

// ── selftest ────────────────────────────────────────────────────────────────────────────────────

if (mode === 'selftest') {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  let failed = 0;
  let checks = 0;
  const ok = (name, cond, detail = '') => {
    checks++;
    if (cond) console.log(`  pass  ${name}`);
    else {
      failed++;
      console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
  };

  // A cwd that is NOT a repository, with CLAUDE_PROJECT_DIR and both stand-down variables cleared
  // out of the environment — so nothing ambient can be the thing that answered.
  const cwd = mkdtempSync(join(tmpdir(), 'phx-python-repl-'));
  const decide = (command, tool = 'Bash', background = false, at = cwd) => {
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.PHX_PYTHON_REPL_OK;
    delete env.PYTHON_BASIC_REPL;
    const tool_input = background ? { command, run_in_background: true } : { command };
    const r = spawnSync(process.execPath, [process.argv[1]], {
      cwd: at,
      env,
      input: JSON.stringify({ tool_name: tool, cwd: at, tool_input, hook_event_name: 'PreToolUse' }),
      encoding: 'utf8',
    });
    const out = String(r.stdout ?? '').trim();
    if (!out) return { decision: 'allow', reason: '' };
    try {
      const j = JSON.parse(out);
      return {
        decision: j.hookSpecificOutput?.permissionDecision ?? 'allow',
        reason: String(j.hookSpecificOutput?.permissionDecisionReason ?? ''),
      };
    } catch {
      return { decision: 'allow', reason: out };
    }
  };

  const UNCLOSED_HEREDOC = ["python - <<'PY'", 'import json, pathlib', 'print(json.dumps({"rows": 3}))'].join('\n');
  const INDENTED_DELIMITER = ['python3 - <<PY', 'print(1)', '  PY'].join('\n');
  const CLOSED_HEREDOC = ["python - <<'PY'", 'import os', 'print(os.getcwd())', 'PY'].join('\n');
  const HEREDOC_NOTE = [
    "cat > note.md <<'EOF'",
    'Never send this in the background:',
    'python',
    "python - <<'PY' with no closing PY",
    'EOF',
  ].join('\n');
  const HERE_STRING_COMMIT = [
    "$msg = @'",
    "fix(hooks): a bare python's REPL floods the task log",
    'python with no script is refused now',
    "'@",
    'git commit -m $msg',
  ].join('\n');

  /** Lands in the REPL — must be refused, and the refusal must quote the python back. */
  const INTERACTIVE = [
    ['the bare interpreter', 'python', 'Bash', false, 'python'],
    ['python3', 'python3', 'Bash', false, 'python3'],
    ['the Windows launcher', 'py', 'Bash', false, 'py'],
    ['the launcher with a version flag', 'py -3', 'Bash', false, 'py -3'],
    ['a backgrounded bare python', 'python', 'Bash', true, 'python'],
    ['the PowerShell tool', 'python', 'PowerShell', false, 'python'],
    ['a full path with spaces in it', '"C:\\Program Files\\Python313\\python.exe" -u', 'PowerShell', false, 'python.exe'],
    ['stderr folded into stdout', 'python 2>&1', 'Bash', false, 'python 2>&1'],
    ['output redirected to a file — the 12.5 GB shape', 'python > out.log 2>&1', 'Bash', false, 'python > out.log'],
    ['an explicit stdin with nothing feeding it', 'python -', 'Bash', false, 'python -'],
    ['unbuffered and isolated, flags only', 'python -u -I -E', 'Bash', false, 'python -u -I -E'],
    ['an -X option whose value is not a script', 'python -X faulthandler', 'Bash', false, 'python -X faulthandler'],
    ['after a cd', 'cd "F:/Phoenix Workforce/_wt-x" && python', 'Bash', false, 'python'],
    ['after a successful probe', 'test -f data.json && python', 'Bash', false, 'python'],
    ['behind a variable assignment', 'LC_ALL=C python', 'Bash', false, 'python'],
    ['wrapped in bash -c', 'bash -c "python"', 'Bash', false, 'python'],
    ['the 15 Oct unclosed heredoc', UNCLOSED_HEREDOC, 'Bash', false, 'python -'],
    ['an indented closing delimiter', INDENTED_DELIMITER, 'Bash', false, 'python3 -'],
    ['an unclosed heredoc even with -c', "python -c 'print(1)' <<PY\nnothing closes this", 'Bash', false, 'python -c'],
  ];

  /** Runs something, reads something, or only talks about one — all must pass. */
  const NOT_INTERACTIVE = [
    ['a script file', 'python script.py', 'Bash', false],
    ['a script under a folder, backgrounded', 'python scripts/extract.py --rows 40', 'Bash', true],
    ['a script with flags in front of it', 'python -u -X utf8 scripts/extract.py', 'Bash', false],
    ['a one-liner', 'python -c "print(1)"', 'Bash', false],
    ['a one-liner that mentions no script', "python3 -c 'import sys; print(sys.version)'", 'Bash', false],
    ['a module', 'python -m json.tool x.json', 'Bash', false],
    ['pip through -m', 'python3 -m pip install --user openpyxl', 'Bash', false],
    ['venv through -m', 'py -3 -m venv .venv', 'Bash', false],
    ['--version, which reads nothing and exits', 'python --version', 'Bash', false],
    ['-V', 'python3 -V', 'Bash', false],
    ['--help', 'python --help', 'Bash', false],
    ['a quoted full path with --version', '"C:\\Program Files\\Python313\\python.exe" -u --version', 'PowerShell', false],
    ['a well-formed heredoc', CLOSED_HEREDOC, 'Bash', false],
    ['a well-formed heredoc, backgrounded', CLOSED_HEREDOC, 'Bash', true],
    ['a here-string', 'python <<< "print(1)"', 'Bash', false],
    ['an input redirect', 'python < s.py', 'Bash', false],
    ['a pipe into it', "printf 'print(1)' | python", 'Bash', false],
    ['the end of a pipeline', 'cat script.py | python -', 'Bash', false],
    ['a script whose output is piped onward', 'python extract.py | head -20', 'Bash', false],
    ['another program entirely', "git grep -n 'python -' docs", 'Bash', false],
    ['a mention inside quotes', 'echo "never run a bare python in the background"', 'Bash', false],
    ['a commit message about the rule', "git commit -m 'fix(hooks): refuse a bare python REPL'", 'Bash', false],
    ['a heredoc body documenting the trap', HEREDOC_NOTE, 'Bash', false],
    ['a PowerShell here-string documenting it', HERE_STRING_COMMIT, 'PowerShell', false],
    ['asking where python is', 'which python', 'Bash', false],
    ['a bounded run, which cannot flood', 'timeout 3 python', 'Bash', false],
    ['the stand-down', 'PHX_PYTHON_REPL_OK=1 python', 'Bash', false],
    ['the stand-down in PowerShell', '$env:PHX_PYTHON_REPL_OK=1; python', 'PowerShell', false],
    ['the fix the refusal names', 'PYTHON_BASIC_REPL=1 python', 'Bash', false],
    ['the fix, quoted', "PYTHON_BASIC_REPL='1' python", 'Bash', false],
    ['the fix in PowerShell', '$env:PYTHON_BASIC_REPL=1; python', 'PowerShell', false],
  ];

  try {
    console.log('the REPL set — every one must be REFUSED');
    for (const [what, command, tool, background, quotes] of INTERACTIVE) {
      const { decision, reason } = decide(command, tool, background);
      ok(what, decision === 'deny', `allowed:\n  ${command.replace(/\n/g, ' ⏎ ')}`);
      if (decision !== 'deny') continue;
      ok(`  ${what} — names its clause`, /^C19 /.test(reason), reason.slice(0, 80));
      ok(`  ${what} — quotes the python back`, reason.includes(quotes), `expected ${quotes}`);
      ok(`  ${what} — names the OSError`, /WinError 123/.test(reason));
      ok(`  ${what} — carries the measured rate`, /1,774,873 bytes in 3 seconds/.test(reason));
      ok(`  ${what} — says what it cost`, /12\.5 GB/.test(reason));
      ok(`  ${what} — names -c as a way out`, /python -c "print\(1\)"/.test(reason));
      ok(`  ${what} — names the REPL fix`, /PYTHON_BASIC_REPL=1/.test(reason));
      // The hatch it hands back must itself be allowed, in the dialect of the tool that asked.
      const advice = /stand it down for one command: (.+)$/m.exec(reason)?.[1]?.trim();
      ok(`  ${what} — ends with its stand-down`, Boolean(advice));
      if (!advice) continue;
      ok(
        `  ${what} — stand-down in the right dialect`,
        advice.startsWith('$env:') === (tool === 'PowerShell'),
        advice,
      );
      const stood = advice.replace('<the same command>', command);
      ok(`  ${what} — the stand-down is allowed`, decide(stood, tool, background).decision === 'allow', stood);
    }

    console.log('the allow set — every one must PASS');
    for (const [what, command, tool, background] of NOT_INTERACTIVE) {
      const { decision, reason } = decide(command, tool, background);
      ok(what, decision === 'allow', `refused:\n  ${command.replace(/\n/g, ' ⏎ ')}\n  ${reason.slice(0, 120)}`);
    }

    console.log('the wiring');
    ok('any other tool returns silently', decide('python', 'Read').decision === 'allow');
    ok('a plain folder is not mistaken for a guarded repo', repoGuardAnswers([cwd]) === false);

    // A synthetic project that carries C19 and wires it: this hook must stand aside. Built here
    // rather than pointed at a real checkout, because which branch a checkout holds changes daily.
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const repo = mkdtempSync(join(tmpdir(), 'phx-python-repl-repo-'));
    const sub = join(repo, 'src', 'deep');
    mkdirSync(join(repo, '.claude', 'hooks'), { recursive: true });
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(repo, '.claude', 'hooks', 'bash-guard.mjs'), '// C19 a bare python REPL\nprocess.exit(0);\n');
    try {
      ok('an UNWIRED repo guard does not silence this one', decide('python', 'Bash', false, repo).decision === 'deny');
      writeFileSync(
        join(repo, '.claude', 'hooks', 'dispatch.json'),
        JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'node ".claude/hooks/bash-guard.mjs"' }] }] } }),
      );
      ok('a wired repo guard answers instead', decide('python', 'Bash', false, repo).decision === 'allow');
      ok('and it covers a subfolder of that repo too', decide('python', 'Bash', false, sub).decision === 'allow');
      writeFileSync(join(repo, '.claude', 'hooks', 'bash-guard.mjs'), '// an older guard, no clause 19 here\n');
      ok('a repo guard WITHOUT C19 does not silence it', decide('python', 'Bash', false, repo).decision === 'deny');
    } finally {
      try {
        rmSync(repo, { recursive: true, force: true });
      } catch {}
    }
  } finally {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {}
  }

  console.log(
    `\n${checks} checks over ${INTERACTIVE.length + NOT_INTERACTIVE.length} commands, ${failed} failed`,
  );
  process.exit(failed ? 1 : 0);
}
