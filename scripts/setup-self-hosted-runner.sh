#!/usr/bin/env bash
#
# Provision a Linux machine as the self-hosted GitHub Actions runner for
# Omar-3-xx/phoenix-people-workforce. Two supported hosts:
#
#   - the owner's spare laptop: WSL2 Ubuntu 24.04 on Windows, x86_64, 8 GB RAM (the current target);
#   - an Oracle Cloud "Always Free" Ampere A1 VM: Ubuntu 24.04, aarch64, 24 GB (the alternative).
#
# WHY THIS EXISTS (2026-11-05)
# ----------------------------
# The repository is on GitHub's FREE plan. November's 2,000 included Actions minutes were spent by the
# 5th, the spending limit is $0 and there is no money to raise it, so GitHub refuses to START every
# hosted job — and the release gate holds every production deploy until ci.yml's `checks` passes.
# Minutes on a self-hosted runner are not billed. This reverses the 2026-10-19 retirement of the Hetzner
# box only because GitHub-hosted minutes are no longer affordable.
#
# RUN IT AS YOUR NORMAL LINUX USER (never root):
#
#    bash setup-self-hosted-runner.sh https://github.com/Omar-3-xx/phoenix-people-workforce [token]
#
# THE REGISTRATION TOKEN, in this order:
#   1. the second argument, or the RUNNER_TOKEN environment variable (it then sits in shell history);
#   2. otherwise the script asks GitHub for one itself through `gh` — `gh auth login --web` shows a short
#      code to type on github.com if gh is not signed in yet — so nothing secret is ever pasted;
#   3. if that fails, a hidden prompt (Settings -> Actions -> Runners -> New self-hosted runner).
# The token is NEVER printed and NEVER written to disk by this script.
#
# WHAT IT DOES: base packages, gh, Node 24 (.nvmrc) with corepack (pnpm comes from package.json's
# `packageManager`), Playwright's Chromium system libraries, the PostgreSQL client (the release gate's
# psql), passwordless sudo for this user (the workflows call sudo with no one to type a password), a swap
# file (not under WSL: there .wslconfig sets it), then RUNNER_COUNT runner services (1 under WSL, else 2),
# each a systemd service labelled `self-hosted,linux,<x64|arm64>,phoenix-ci`. Re-running it is safe.
#
# NO DOCKER: no job that the switch moves here uses `services:`, `container:` or Docker. The jobs that
# build or pull the amd64 production image stay on GitHub's runners (HOSTED_ONLY in
# tests/ci-runner-switch.test.ts).
#
# NOTHING MOVES UNTIL THE VARIABLE IS SET. After the runner shows "Idle" on
#   https://github.com/Omar-3-xx/phoenix-people-workforce/settings/actions/runners
# set the repository variable CI_RUNNER_LABEL to `phoenix-ci` (the closing banner prints the command).
#
# 🔴 PRIVATE REPOSITORIES ONLY. A self-hosted runner executes whatever a workflow tells it to. On a
# PUBLIC repository anyone opening a fork pull request could run code on this machine. If the
# repository is ever made public, REMOVE THE RUNNERS FIRST.
set -euo pipefail
set +x # never trace: the token passes through this shell

REPO_URL="${1:-}"
RUNNER_TOKEN="${2:-${RUNNER_TOKEN:-}}"

# The BOOTSTRAP version, not the running one: the runner updates itself after registering (no
# --disableupdate here), so a pin some weeks behind GitHub's latest is harmless. Each checksum is the one
# GitHub publishes in the v2.338.0 release notes for actions-runner-linux-<arch>-2.338.0.tar.gz.
RUNNER_VERSION="2.338.0"
case "$(uname -m)" in
  x86_64)  RUNNER_ARCH_NAME=x64;   RUNNER_SHA256="af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32" ;;
  aarch64) RUNNER_ARCH_NAME=arm64; RUNNER_SHA256="628b4a7258487b80c1d3c221095a7ded349f5ae0175fd3dfab708d07428f041b" ;;
  *) echo "ERROR: unsupported CPU $(uname -m) — this script knows x86_64 and aarch64" >&2; exit 1 ;;
esac
# Node's tarballs use the same two names (node-<v>-linux-x64 / node-<v>-linux-arm64).
NODE_ARCH="$RUNNER_ARCH_NAME"

IS_WSL=false
if [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || uname -r | grep -qi microsoft; then IS_WSL=true; fi

# One runner on the 8 GB laptop (WSL is capped at 5 GB, and the production build alone peaks near 7 GB
# with swap); two on the 24 GB VM.
if $IS_WSL; then RUNNER_COUNT="${RUNNER_COUNT:-1}"; else RUNNER_COUNT="${RUNNER_COUNT:-2}"; fi
RUNNER_LABELS="self-hosted,linux,${RUNNER_ARCH_NAME},phoenix-ci"
RUNNER_BASE="${RUNNER_BASE:-$HOME/actions-runner}"
NODE_MAJOR="24"                # .nvmrc and ci.yml's CI_NODE_VERSION
PLAYWRIGHT_VERSION="1.64.1"    # package.json's playwright / @playwright/test
SWAP_GB="${SWAP_GB:-8}"
TOOL_CACHE="/opt/hostedtoolcache"

die() { echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

# Set <key>=<value> under [<section>] of /etc/wsl.conf, keeping every other line. WSL reads the file
# only when it starts, so a change takes effect after `wsl --shutdown`.
wslconf_set() {
  local tmp
  tmp="$(mktemp)"
  sudo touch /etc/wsl.conf
  awk -v s="$1" -v k="$2" -v v="$3" '
    function flush() { if (insec && !done) { print k "=" v; done = 1 } }
    /^[[:space:]]*\[/ { flush(); insec = ($0 ~ ("^[[:space:]]*\\[" s "\\]")); print; next }
    insec && $0 ~ ("^[[:space:]]*" k "[[:space:]]*=") { if (!done) { print k "=" v; done = 1 }; next }
    { print }
    END { flush(); if (!done) { print ""; print "[" s "]"; print k "=" v } }
  ' /etc/wsl.conf > "$tmp"
  sudo cp "$tmp" /etc/wsl.conf
  rm -f "$tmp"
}

# ── Preconditions ──────────────────────────────────────────────────────────────────────────
[ -n "$REPO_URL" ] || die "usage: bash setup-self-hosted-runner.sh <repo-url> [registration-token]
  e.g. bash setup-self-hosted-runner.sh https://github.com/Omar-3-xx/phoenix-people-workforce"
[[ "$REPO_URL" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "the repo URL must look like https://github.com/<owner>/<repo>"
OWNER_REPO="${REPO_URL#https://github.com/}"
[ "$(id -u)" -ne 0 ] || die "do not run as root — the runner refuses to configure as root. Use your normal Linux user."
command -v sudo >/dev/null || die "sudo is required"
[[ "$RUNNER_COUNT" =~ ^[1-8]$ ]] || die "RUNNER_COUNT must be 1-8"
. /etc/os-release
[ "${VERSION_ID:-}" = "24.04" ] || echo "WARNING: written for Ubuntu 24.04; this is ${PRETTY_NAME:-unknown}"

# Under WSL the runner is a systemd service, so systemd must be PID 1. Ubuntu 24.04 on WSL turns it on
# by default; if it is off, switch it on in /etc/wsl.conf and stop — it only takes effect after WSL restarts.
if $IS_WSL && [ "$(ps -p 1 -o comm= 2>/dev/null)" != "systemd" ]; then
  wslconf_set boot systemd true
  cat <<'EOF'

================================================================================
 systemd is now switched on for this Ubuntu, but it starts only after WSL restarts.
   1. In Windows, open PowerShell and run:   wsl --shutdown
   2. Open the Ubuntu window again.
   3. Run this same command again (press the Up arrow, then Enter).
================================================================================
EOF
  exit 2
fi

# Under WSL, keep CI away from Windows: the Windows drives are not mounted inside this Ubuntu (so no job
# can reach C:, D: or anything on them), and Windows' PATH is not appended (so a Windows node or pnpm can
# never shadow the Linux ones). Both apply from the next WSL restart, which the Windows step performs.
if $IS_WSL; then
  wslconf_set automount enabled false
  wslconf_set interop appendWindowsPath false
  echo "WSL: Windows drives will not be mounted in this Ubuntu, and Windows' PATH is not used (after the next 'wsl --shutdown')."
fi

# The workflows call sudo themselves (extra build swap, Playwright's install-deps, the psql fallback);
# under a service there is no one to type a password, so this user needs passwordless sudo. Oracle's
# `ubuntu` user already has it; a WSL user does not, so it is granted here, once, after one password.
if ! sudo -n true 2>/dev/null; then
  step "Granting $(whoami) passwordless sudo (the runner cannot type a password) — enter your Linux password once"
  sudo -v || die "sudo refused"
  SUDOERS_FILE="/etc/sudoers.d/90-phoenix-ci-runner"
  echo "$(whoami) ALL=(ALL) NOPASSWD:ALL" | sudo tee "$SUDOERS_FILE" >/dev/null
  sudo chmod 440 "$SUDOERS_FILE"
  sudo visudo -cf "$SUDOERS_FILE" >/dev/null || { sudo rm -f "$SUDOERS_FILE"; die "the sudoers entry did not validate; nothing was changed"; }
fi

step "Host: ${PRETTY_NAME:-?} | WSL: ${IS_WSL} | cpu: $(uname -m) | user: $(whoami) | cores: $(nproc) | RAM: $(free -g | awk '/^Mem:/{print $2}') GB | disk free: $(df -h / | awk 'NR==2{print $4}')"

# ── Base packages ──────────────────────────────────────────────────────────────────────────
step "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq curl git ca-certificates gnupg jq unzip zip xz-utils build-essential \
  python3 python3-venv postgresql-client postgresql dnsutils
# postgresql: phoenix-mcp.yml's fixture runs its own initdb; the cluster the package starts is not used.
sudo systemctl disable --now postgresql >/dev/null 2>&1 || true

# gh: GitHub's hosted runners ship it and many workflows call `gh api`. Ubuntu 24.04's own `gh`
# (universe) is fine if it is already installed; otherwise it comes from GitHub's apt repository.
step "Installing gh (GitHub CLI)"
if ! command -v gh >/dev/null; then
  sudo mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq gh
fi
gh --version | head -1

# ── The registration token ─────────────────────────────────────────────────────────────────
# Asked of GitHub through gh, so nothing secret is pasted. The token lands in a variable only; the
# command's own output is captured, never shown, and an error message from gh carries no token.
if [ -z "$RUNNER_TOKEN" ]; then
  step "Getting a registration token from GitHub through gh"
  gh auth status --hostname github.com >/dev/null 2>&1 \
    || gh auth login --hostname github.com --git-protocol https --web \
    || echo "WARNING: gh sign-in did not finish"
  RUNNER_TOKEN="$(gh api -X POST "repos/${OWNER_REPO}/actions/runners/registration-token" --jq .token 2>/dev/null || true)"
  if [ -n "$RUNNER_TOKEN" ]; then
    echo "registration token received (not shown)"
  fi
fi
if [ -z "$RUNNER_TOKEN" ]; then
  echo "gh could not fetch a token (the signed-in account must be an admin of ${OWNER_REPO})."
  read -rsp "Paste a registration token instead (input hidden): " RUNNER_TOKEN
  echo
fi
[ -n "$RUNNER_TOKEN" ] || die "no registration token"

# ── Node + corepack ────────────────────────────────────────────────────────────────────────
# setup-node downloads its own Node into the tool cache for the CI jobs; this system Node is for the
# jobs that use none, and for Playwright's install-deps below. NodeSource first; the official tarball
# if NodeSource has no repository for this release (its failure is quiet, so the version is re-checked).
step "Installing Node ${NODE_MAJOR} + corepack"
if ! node --version 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - || true
  sudo apt-get install -y -qq nodejs || true
fi
if ! node --version 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  echo "NodeSource did not yield Node ${NODE_MAJOR} — falling back to the official linux-${NODE_ARCH} tarball"
  NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json \
    | jq -r "[.[] | select(.version | startswith(\"v${NODE_MAJOR}.\"))] | .[0].version")"
  [ -n "$NODE_VERSION" ] && [ "$NODE_VERSION" != "null" ] || die "could not resolve a Node ${NODE_MAJOR} release from nodejs.org"
  TMP_NODE="$(mktemp -d)"
  NODE_TARBALL="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  curl -fsSL -o "${TMP_NODE}/${NODE_TARBALL}" "https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}"
  # nodejs.org publishes SHASUMS256.txt beside every release; the tarball must match it.
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" | grep " ${NODE_TARBALL}\$" > "${TMP_NODE}/SHASUMS256.txt" \
    || die "no checksum published for ${NODE_TARBALL}"
  (cd "$TMP_NODE" && sha256sum -c SHASUMS256.txt >/dev/null) || die "Node tarball checksum mismatch"
  tar -xJ -C "$TMP_NODE" -f "${TMP_NODE}/${NODE_TARBALL}"
  sudo rm -rf /usr/local/lib/nodejs
  sudo mkdir -p /usr/local/lib/nodejs
  sudo mv "${TMP_NODE}/node-${NODE_VERSION}-linux-${NODE_ARCH}" /usr/local/lib/nodejs/node
  for bin in node npm npx corepack; do
    sudo ln -sf "/usr/local/lib/nodejs/node/bin/${bin}" "/usr/local/bin/${bin}"
  done
  rm -rf "$TMP_NODE"
fi
node --version | grep -q "^v${NODE_MAJOR}\." || die "Node ${NODE_MAJOR} is still not on PATH after both install paths"
# corepack ships with Node 24 today; install it from npm if a later Node drops it.
command -v corepack >/dev/null || sudo npm install -g corepack
sudo corepack enable
echo "node $(node --version) | corepack $(corepack --version)"

# ── Playwright's system libraries ──────────────────────────────────────────────────────────
# ci.yml downloads the Chromium build itself (and caches it per architecture); the OS libraries it
# needs are installed once here.
step "Installing Playwright ${PLAYWRIGHT_VERSION} system dependencies for Chromium"
sudo npx --yes "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium

# ── Swap ───────────────────────────────────────────────────────────────────────────────────
# Under WSL the swap is the `swap=` line of Windows' %UserProfile%\.wslconfig
# (scripts/setup-spare-laptop-windows.ps1 writes it); a swap file inside the distro is not used.
step "Swap"
if $IS_WSL; then
  echo "WSL: swap comes from .wslconfig on the Windows side; current:"; swapon --show || true
elif [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
  sudo fallocate -l "${SWAP_GB}G" /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo "added ${SWAP_GB} GB swap at /swapfile"
else
  echo "swap already present:"; swapon --show
fi

# ── Tool cache ─────────────────────────────────────────────────────────────────────────────
# actions/setup-python's prebuilt Pythons only work from /opt/hostedtoolcache (its self-hosted
# guidance), so every runner points its tool cache there, owned by this user.
sudo mkdir -p "$TOOL_CACHE"
sudo chown "$(whoami)":"$(id -gn)" "$TOOL_CACHE"

# ── Runners ────────────────────────────────────────────────────────────────────────────────
TARBALL="actions-runner-linux-${RUNNER_ARCH_NAME}-${RUNNER_VERSION}.tar.gz"
DL_DIR="$(mktemp -d)"
step "Downloading actions/runner ${RUNNER_VERSION} (linux-${RUNNER_ARCH_NAME})"
curl -fsSL -o "${DL_DIR}/${TARBALL}" "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${TARBALL}"
echo "${RUNNER_SHA256}  ${DL_DIR}/${TARBALL}" | sha256sum -c - >/dev/null || die "runner tarball checksum mismatch"

for i in $(seq 1 "$RUNNER_COUNT"); do
  dir="${RUNNER_BASE}-${i}"
  name="phoenix-ci-$(hostname -s)-${i}"
  step "Runner ${i}/${RUNNER_COUNT}: ${name} in ${dir}"
  mkdir -p "$dir"
  cd "$dir"
  if [ ! -f ./config.sh ]; then
    tar xzf "${DL_DIR}/${TARBALL}"
  fi
  if [ -f ./.service ] && [ -f ./svc.sh ]; then
    sudo ./svc.sh stop >/dev/null 2>&1 || true
    sudo ./svc.sh uninstall >/dev/null 2>&1 || true
  fi
  # The runner reads this file at start. AGENT_TOOLSDIRECTORY is the tool cache above;
  # the corepack line stops a pnpm download prompt from ever waiting on a job.
  printf 'LANG=C.UTF-8\nAGENT_TOOLSDIRECTORY=%s\nCOREPACK_ENABLE_DOWNLOAD_PROMPT=0\n' "$TOOL_CACHE" > ./.env
  # --replace makes a re-run take over this name instead of failing or duplicating it.
  ./config.sh \
    --unattended \
    --replace \
    --url "$REPO_URL" \
    --token "$RUNNER_TOKEN" \
    --name "$name" \
    --labels "$RUNNER_LABELS" \
    --work "_work" >/dev/null
  sudo ./svc.sh install "$(whoami)" >/dev/null
  sudo ./svc.sh start >/dev/null
  echo "registered and started: ${name}"
done
rm -rf "$DL_DIR"
unset RUNNER_TOKEN

sleep 3
step "Service status"
systemctl list-units --type=service --no-pager 'actions.runner.*' || true

WSL_NOTE=""
if $IS_WSL; then
  WSL_NOTE="
 THIS IS WSL. Next, in a normal Windows PowerShell window, paste the Windows block from
 docs/ci-self-hosted-runner.md: it caps WSL at 5 GB with 8 GB swap, keeps the laptop awake
 while plugged in, and starts WSL (and so this runner) every time you sign in to Windows.
"
fi

cat <<EOF

================================================================================
 ${RUNNER_COUNT} RUNNER(S) REGISTERED — labels: ${RUNNER_LABELS}
${WSL_NOTE}
 They are ONLINE but NOTHING USES THEM YET: every workflow reads
   runs-on: \${{ vars.CI_RUNNER_LABEL || 'ubuntu-latest' }}
 and the variable is not set.

 1. Check they read "Idle":  ${REPO_URL}/settings/actions/runners

 2. Switch CI onto this machine (one repository variable):
      gh variable set CI_RUNNER_LABEL --repo ${OWNER_REPO} --body phoenix-ci

 3. Roll back at any time (the next run is GitHub-hosted again):
      gh variable delete CI_RUNNER_LABEL --repo ${OWNER_REPO}

 🔴 While the variable is set and this machine is off or asleep, jobs QUEUE — they do not fall back.
 Runbook: docs/ci-self-hosted-runner.md
================================================================================
EOF
