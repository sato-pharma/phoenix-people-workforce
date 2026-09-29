// PreToolUse hook: deliver the §2.1 session traps AT THE MOMENT THEY APPLY, instead of
// paying for all 30 KB of them on every single request.
//
// WHY
// AGENTS.md §2.1 is 30,491 bytes (~8,470 tokens, 26% of the file) and auto-loads in full on
// every turn. Almost none of it is relevant to any given turn: the git traps matter when you
// touch git, the ExcelJS traps when you build a workbook, the browser traps when you drive a
// page. This hook watches what the session is actually about to run and injects only the
// matching cluster, once per session.
//
// WHERE THE TEXT LIVES
// `docs/agents-session-traps-clusters.md`. The trim landed 2026-09-12: §2.1 now holds only a
// pointer and the roster of memory slugs it was the sole reachable pointer for. The AGENTS.md
// fallback below is kept for a checkout that predates the trim, where §2.1 still holds the text.
//
// THE CLUSTER HEADING IS THE CONTRACT. A cluster is a bold run alone on a line. Rename one in
// the doc without renaming it in `RULES` and the hook silently delivers nothing — it fails open.
//
// THIS IS THE REPO-TRACKED COPY, and it stands down when a user-level copy is registered (see
// `machineCopyIsWired`). It exists so a cloud session, or any machine with no `~/.claude` hook,
// still gets the traps — §2.1 no longer carries them.
//
// FAILS SILENT AND FAILS OPEN. It can only ever ADD context. It never blocks a tool call,
// never writes into the repository, and exits 0 on every error path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.USERPROFILE || os.homedir();
const STATE_DIR = path.join(HOME, '.claude', 'relay', 'state');
// A cluster is injected WHOLE or not at all. There is deliberately no size cap: the three
// clusters worth the most (Validation 5.9 KB, Shell and tooling 5.0 KB, Worktrees 4.7 KB) are
// precisely the ones any cap drops, and a truncated trap is worse than none — it reads as the
// complete rule. The lifetime ceiling is the whole of §2.1, 30 KB, and only if one session
// touches all thirteen areas. That is what ONE turn costs today.
const MAX_CLUSTERS_PER_CALL = 2;

/**
 * command -> cluster names, in AGENTS.md §2.1's own wording.
 * Order matters: the first match wins for a given pattern, but a command may match several
 * rules and collect several clusters (a `gh pr` touching git AND CI, for instance).
 */
const RULES = [
  // most specific first
  // Parallel sessions had NO rule until 2026-09-17, so that cluster was never delivered to anyone —
  // including its "one approval can reach several sessions" trap, which matters most at a merge.
  // `tests/trap-injector-clusters.test.ts` now fails on any cluster no rule reaches.
  [/\bgh\s+pr\s+merge\b|session\.lock|\.autorun\b|list_sessions|session-census|claude-hygiene|find-worktree-holder|--strip-idle/i, 'Parallel sessions'],
  [/\bgh\s+(pr|run|workflow|api\s+repos)\b|\bactions\b|\bcheck-runs\b|secret-scan/i, 'CI and PRs'],
  [/\bgit\s|\bgh\s|rev-parse|cherry-pick|rerere|\bstash\b/i, 'Git'],
  [/worktree|_wt-|new-session\.mjs|repo-doctor|repo:doctor/i, 'Worktrees'],
  [/supabase|psql|pg_dump|pg_class|pg_proc|execute_sql|\brls\b|\bgrant\b|\bpolicy\b/i, 'Database, grants and RLS'],
  [/migration|apply_migration|list_migrations|db\s+push/i, 'Migrations'],
  [/pnpm\s+run\s+(test|typecheck|lint|ci)|tsc\b|node\s+--test|run-tests/i, 'Validation'],
  // `dev-server.mjs` since 2026-09-21: bash-guard C7 refuses a raw `next dev`, so the launcher is
  // how a session now starts the dev server — without it this cluster would never be delivered.
  [/next\s+dev|pnpm\s+run\s+dev|dev-server\.mjs|unstable_cache|turbopack/i, 'Next.js runtime'],
  // 🔴 `Claude_Browser` and `claude-in-chrome` are here because the TOOL NAME is now part of what
  // this matches (see the haystack below). Until 2026-09-29 the cluster about driving a browser was
  // reachable only from a SHELL command that happened to mention one of these words — so a session
  // driving the pane got nothing, which is the one session that needed it. The cost was measured:
  // the pane cannot set request headers, so a role-gated page could not be reached; line 205 of the
  // clusters doc says exactly how (`GET /api/dev-auth?role=…`), and a session concluded the
  // measurement was impossible and parked it for three days with the answer already written down.
  [/dev-auth|x-phoenix-role|localhost:300|browser|playwright|Claude_Browser|claude-in-chrome/i, 'Browser and dev-auth'],
  [/healthz|railway|cron-job|app_error_events|\bcurl\b.*https?:/i, 'Probing, attributing and reporting production'],
  // `claude-code-sessions`, `cleanupPeriodDays` and a walk of `~/.claude/projects`
  // are the cues of a session hunting for lost history — the trap it needs is that
  // the history lives in three stores, not the one it is looking at.
  [/MEMORY\.md|memory-index|consolidate-memory|cleanupPeriodDays|claude-code-sessions|file-history|\.claude[\/\\]+projects/i, 'Memory and this index'],
  [/Win32_Process|Get-NetTCPConnection|freemem|commit charge|mem-watchdog/i, 'Machine ceiling'],
  [/grep\s+-r|\brg\b|\bsed\b|ExcelJS|xlsx|MSYS|TZ=|\.env|settings(\.local)?\.json|autoMode/i, 'Shell and tooling'],
];

/** Walk up from cwd to the folder that holds AGENTS.md. */
function findProject(start) {
  let dir = path.resolve(start || process.cwd());
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'AGENTS.md'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Parse the trap clusters. Prefers the dedicated file that the §2.1 trim will create; falls
 * back to §2.1 inside AGENTS.md, which is where they live until that happens.
 */
function loadClusters(projectDir) {
  const dedicated = path.join(projectDir, 'docs', 'agents-session-traps-clusters.md');
  let body = null;
  try {
    body = fs.readFileSync(dedicated, 'utf8');
  } catch {
    try {
      const src = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8');
      const from = src.indexOf('### 2.1 Session-level traps');
      const to = src.indexOf('### 2.2', from + 1);
      if (from === -1) return null;
      body = src.slice(from, to === -1 ? undefined : to);
    } catch {
      return null;
    }
  }

  // Cluster headings are a bold run at the start of a line: **Git**, **Worktrees** (see also §5)
  const out = new Map();
  let current = null;
  let buf = [];
  for (const line of body.split(/\r?\n/)) {
    const h = /^\*\*([A-Z][^*]{2,60})\*\*\s*(\(.*\))?\s*$/.exec(line);
    if (h) {
      if (current && buf.length) out.set(current, buf.join('\n').trim());
      current = h[1].trim();
      buf = [];
      continue;
    }
    if (current) buf.push(line);
  }
  if (current && buf.length) out.set(current, buf.join('\n').trim());
  return out.size ? out : null;
}

function statePath(sessionId) {
  return path.join(STATE_DIR, `traps-${String(sessionId || 'nosession').slice(0, 36)}.json`);
}

function readState(sessionId) {
  try {
    return new Set(JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8')).seen);
  } catch {
    return new Set();
  }
}

function writeState(sessionId, seen) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const f = statePath(sessionId);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ seen: [...seen], at: Date.now() }), 'utf8');
    fs.renameSync(tmp, f);
  } catch {
    /* state is an optimisation, never a requirement */
  }
}

function commandOf(input) {
  const t = input?.tool_input || {};
  let cmd = String(t.command || '');
  // Strip heredoc BODIES before classifying. A `cat > notes.md <<'EOF' … worktree … EOF`
  // is writing prose that happens to contain the word, not doing worktree work — matching on
  // it fired a 4.9 KB cluster at nothing on this hook's very first live call.
  cmd = cmd.replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\s*\2\s*$/gm, ' ');
  return [cmd, t.file_path, t.path, t.pattern, t.url].filter(Boolean).join(' ');
}

// STAND DOWN when the machine-level copy is REGISTERED — both read and write the same
// per-session state file, so two copies firing on one PreToolUse can inject the same cluster
// twice. The check is on the REGISTRATION, not on the file: a copy sitting in ~/.claude/hooks
// that no settings file calls does nothing, and standing down for it would silence the trap
// everywhere. Cloud sessions and any machine with no user-level hook run this copy.
function machineCopyIsWired() {
  for (const f of ['settings.json', 'settings.local.json']) {
    try {
      if (fs.readFileSync(path.join(HOME, '.claude', f), 'utf8').includes('trap-injector')) return true;
    } catch {
      /* absent or unreadable is 'not wired' */
    }
  }
  return false;
}

try {
  if (machineCopyIsWired()) process.exit(0);
  const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
  const tool = input?.tool_name || '';
  // The browser-pane and Chrome-extension tools are in this list for the reason spelled out beside
  // the 'Browser and dev-auth' rule: without them, the cluster about driving a browser was gated
  // behind NOT driving a browser.
  if (!/^(Bash|PowerShell|Grep|Glob|Edit|Write|mcp__Claude_Browser__\w+|mcp__claude-in-chrome__\w+)$/.test(tool)) {
    process.exit(0);
  }

  // The TOOL NAME is part of the haystack, not just its arguments. A pane call often carries neither
  // a command nor a url — `javascript_tool`, `computer`, `resize_window` — so matching on arguments
  // alone let the first browser call of a session through with nothing delivered.
  const cmd = [tool, commandOf(input)].filter(Boolean).join(' ');
  if (!cmd) process.exit(0);

  const wanted = [];
  for (const [re, cluster] of RULES) {
    if (re.test(cmd) && !wanted.includes(cluster)) wanted.push(cluster);
  }
  if (!wanted.length) process.exit(0);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || findProject(input?.cwd);
  if (!projectDir) process.exit(0);
  const clusters = loadClusters(projectDir);
  if (!clusters) process.exit(0);

  const seen = readState(input?.session_id);
  const fresh = wanted.filter((c) => clusters.has(c) && !seen.has(c)).slice(0, MAX_CLUSTERS_PER_CALL);
  if (!fresh.length) process.exit(0);

  const parts = [];
  for (const c of fresh) {
    parts.push(`**${c}**\n${clusters.get(c)}`);
    seen.add(c);
  }
  writeState(input?.session_id, seen);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: [
          `AGENTS.md §2.1 traps for what you are about to do (delivered once per session, not on every turn).`,
          `Each line is a cue, not the fact — the full account is in docs/agents-session-traps.md.`,
          '',
          parts.join('\n\n'),
        ].join('\n'),
      },
    }),
  );
} catch {
  /* never break a tool call over this */
}

process.exit(0);
