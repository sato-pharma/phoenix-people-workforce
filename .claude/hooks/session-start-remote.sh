#!/usr/bin/env bash
# SessionStart hook — Claude Code on the WEB (cloud sessions) ONLY.
#
# A cloud session starts from a fresh clone with NOTHING installed: no node_modules, and Node 22 where
# package.json's `engines` asks for 24. Measured 2026-09-25 in the first cloud session that tried to run
# the app: `pnpm` could not even start (corepack had to fetch the pinned version), there was no
# dev server, no linter and no test runner, and the session spent its opening stretch finding that out.
# This hook makes the container ready before the first prompt:
#
#   1. Node   — the major version package.json's `engines.node` asks for, through the image's nvm.
#   2. pnpm   — the exact version package.json's `packageManager` pins, through corepack.
#   3. Deps   — `pnpm install --frozen-lockfile`. The lockfile is never rewritten here.
#   4. Env    — only what is MISSING: the STAGING project's public URL and anon key (the same pair
#               ci.yml's smoke test commits) and a per-container PHOENIX_AUTH_SECRET, so
#               `node scripts/dev-server.mjs` can boot. The service-role key is NEVER written by this
#               file: it comes from the environment's own settings, set by the owner. Production's
#               coordinates never come from here — pointing a cloud session at production stays a
#               deliberate act.
#
# LOCAL SESSIONS SKIP ALL OF IT. `CLAUDE_CODE_REMOTE` is unset on the owner's machine and the first
# check below exits. That matters: AGENTS.md §5 forbids `pnpm install` in a worktree, whose
# node_modules is a junction to the primary's.
#
# It NEVER fails the session and never floods it: installer output goes to a log file, one summary
# line goes to stdout (which becomes session context), and a failed step says why and moves on. The
# usual cause is the environment's network allowlist — registry.npmjs.org and nodejs.org — which only
# the owner can widen (cloud environment menu in the title bar → Edit → Network access).

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

set -uo pipefail

DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$DIR" || exit 0

LOG_DIR="${HOME:-/tmp}/.cache/phoenix-session-start"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/install.log"
: >"$LOG"

notes=()
note() { notes+=("$1"); printf '%s\n' "$1" >>"$LOG"; }

persist() {
  # Exports that must outlive this hook reach later Bash calls through CLAUDE_ENV_FILE.
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    printf '%s\n' "$1" >>"$CLAUDE_ENV_FILE"
  fi
}

# ── 1. Node ──────────────────────────────────────────────────────────────────────────────────────
want_major="$(node -e 'const r=(require("./package.json").engines||{}).node||"";const m=r.match(/\d+/);process.stdout.write(m?m[0]:"")' 2>/dev/null || true)"
have_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ -n "$want_major" ] && [ "$have_major" -lt "$want_major" ] && [ -s "${NVM_DIR:-/opt/nvm}/nvm.sh" ]; then
  export NVM_DIR="${NVM_DIR:-/opt/nvm}"
  # The download runs in a child bash so `timeout` can bound it — nvm is a shell FUNCTION, which
  # `timeout` cannot run directly. `nvm use` below needs no network.
  timeout 180 bash -c ". \"$NVM_DIR/nvm.sh\" && nvm install \"$want_major\"" >>"$LOG" 2>&1
  # nvm.sh reads unset variables; it must not run under `set -u`.
  set +u
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >>"$LOG" 2>&1
  if nvm use "$want_major" >>"$LOG" 2>&1; then
    node_bin="$(dirname "$(nvm which "$want_major" 2>/dev/null)")"
    export PATH="$node_bin:$PATH"
    persist "export PATH=\"$node_bin:\$PATH\""
    note "node: $(node -v) (engines asks for $want_major)"
  else
    note "node: could not install Node $want_major — is nodejs.org in the network allowlist? Continuing on $(node -v)."
  fi
  set -u
else
  note "node: $(node -v 2>/dev/null || echo missing)"
fi

# ── 2. pnpm, at the version package.json pins ────────────────────────────────────────────────────
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
persist "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
corepack enable >>"$LOG" 2>&1 || true
if pnpm_version="$(timeout 120 pnpm --version 2>>"$LOG")"; then
  note "pnpm: $pnpm_version"
else
  note "pnpm: unavailable — corepack could not fetch it (is registry.npmjs.org in the network allowlist?)."
fi

# ── 3. Dependencies ──────────────────────────────────────────────────────────────────────────────
if [ -n "${pnpm_version:-}" ]; then
  # CI=true keeps pnpm non-interactive: a modules-dir purge it would otherwise ASK about proceeds
  # instead of failing on the missing TTY.
  if CI=true timeout 900 pnpm install --frozen-lockfile --prefer-offline >>"$LOG" 2>&1; then
    note "deps: installed ($(find node_modules -maxdepth 1 -mindepth 1 2>/dev/null | wc -l | tr -d ' ') top-level entries)"
  else
    note "deps: pnpm install FAILED — last lines of $LOG explain why (a 'Host not in allowlist' line means the network allowlist)."
  fi
fi

# ── 4. Env the dev server needs, only where the environment set none ────────────────────────────
if [ -z "${NEXT_PUBLIC_SUPABASE_URL:-}" ]; then
  persist 'export NEXT_PUBLIC_SUPABASE_URL="https://cifwmndunmlxjhyjugxa.supabase.co"'
  # Public, RLS-protected anon key of the STAGING project — the value ci.yml's smoke test commits.
  persist 'export NEXT_PUBLIC_SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpZndtbmR1bm1seGpoeWp1Z3hhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3NzQxMzEsImV4cCI6MjA5OTM1MDEzMX0.2bWjOI1gH67H8Fj1wr2XheQjlDhM5pOQ6xPD8YLd5lc"' # gitleaks:allow (public anon key, RLS-protected)
  note "env: Supabase URL + anon key set to STAGING (none was configured)"
fi
if [ -z "${PHOENIX_AUTH_SECRET:-}" ]; then
  secret_file="$LOG_DIR/auth-secret"
  [ -s "$secret_file" ] || node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' >"$secret_file" 2>/dev/null
  persist "export PHOENIX_AUTH_SECRET=\"$(cat "$secret_file" 2>/dev/null)\""
fi
if [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  note "env: SUPABASE_SERVICE_ROLE_KEY is not set — pages that read data will fail until the owner adds the STAGING key in the environment's settings."
fi

summary=""
for line in "${notes[@]+"${notes[@]}"}"; do summary="${summary:+$summary · }$line"; done
printf '[cloud session setup] %s (full log: %s)\n' "$summary" "$LOG"
exit 0
