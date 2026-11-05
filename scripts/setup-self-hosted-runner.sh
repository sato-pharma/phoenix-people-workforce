#!/usr/bin/env bash
#
# Provision an Oracle Cloud "Always Free" Ampere A1 VM (Ubuntu 24.04, ARM64) as the self-hosted
# GitHub Actions runner for Omar-3-xx/phoenix-people-workforce.
#
# WHY THIS EXISTS (2026-11-05)
# ----------------------------
# The repository is on GitHub's FREE plan. November's 2,000 included Actions minutes were spent by the
# 5th, the spending limit is $0 and there is no money to raise it, so GitHub refuses to START every
# hosted job — and the release gate holds every production deploy until ci.yml's `checks` passes.
# Minutes on a self-hosted runner are not billed. The owner decided (2026-11-05) to run CI on a free
# Oracle Cloud ARM64 VM: 4 OCPU / 24 GB, which costs nothing. This reverses the 2026-10-19 retirement
# of the Hetzner box only because GitHub-hosted minutes are no longer affordable.
#
# RUN IT ON THE VM, AS THE NORMAL `ubuntu` USER (never root, never on the owner's laptop):
#
#    bash setup-self-hosted-runner.sh https://github.com/Omar-3-xx/phoenix-people-workforce
#
# It then asks for the registration token without echoing it (Settings -> Actions -> Runners ->
# New self-hosted runner; the token is valid about an hour and registers any number of runners in that
# hour). You may pass it as the second argument instead, but then it sits in your shell history —
# start the command with a space, or prefer the prompt. The token is NEVER printed and NEVER written to
# disk by this script.
#
# WHAT IT DOES: base packages, gh, Node 24 (.nvmrc) with corepack (pnpm comes from package.json's
# `packageManager`), Playwright's Chromium system libraries, PostgreSQL client (the release gate's psql),
# a swap file, then RUNNER_COUNT runner services (default 2), each its own systemd service, all labelled
# `self-hosted,linux,arm64,phoenix-ci`. Re-running it is safe: `--replace` takes over the same names.
#
# NO DOCKER: no job that the switch moves here uses `services:`, `container:` or Docker. The jobs that
# build or pull the amd64 production image stay on GitHub's runners (HOSTED_ONLY in
# tests/ci-runner-switch.test.ts).
#
# NOTHING MOVES UNTIL THE VARIABLE IS SET. After the runners show "Idle" on
#   https://github.com/Omar-3-xx/phoenix-people-workforce/settings/actions/runners
# set the repository variable CI_RUNNER_LABEL to `phoenix-ci` (the closing banner prints the command).
# Delete the variable and every job is GitHub-hosted again on its next run.
#
# 🔴 PRIVATE REPOSITORIES ONLY. A self-hosted runner executes whatever a workflow tells it to. On a
# PUBLIC repository anyone opening a fork pull request could run code on this VM. phoenix-people-workforce
# is private. If it is ever made public, REMOVE THE RUNNERS FIRST.
set -euo pipefail
set +x # never trace: the token passes through this shell

REPO_URL="${1:-}"
RUNNER_TOKEN="${2:-${RUNNER_TOKEN:-}}"

# The BOOTSTRAP version, not the running one: the runner updates itself after registering (no
# --disableupdate here), so a pin some weeks behind GitHub's latest is harmless. The checksum is the
# one GitHub publishes in the release notes for actions-runner-linux-arm64-<version>.tar.gz.
RUNNER_VERSION="2.338.0"
RUNNER_SHA256="628b4a7258487b80c1d3c221095a7ded349f5ae0175fd3dfab708d07428f041b"
# Two services on 4 OCPU / 24 GB: the production build peaks near 7 GB, so two at once fit with swap,
# and a pull request's five jobs finish in about half the time one runner would take.
RUNNER_COUNT="${RUNNER_COUNT:-2}"
RUNNER_LABELS="self-hosted,linux,arm64,phoenix-ci"
RUNNER_BASE="${RUNNER_BASE:-$HOME/actions-runner}"
NODE_MAJOR="24"                # .nvmrc and ci.yml's CI_NODE_VERSION
PLAYWRIGHT_VERSION="1.64.1"    # package.json's playwright / @playwright/test
SWAP_GB="${SWAP_GB:-8}"
TOOL_CACHE="/opt/hostedtoolcache"

die() { echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

# ── Preconditions ──────────────────────────────────────────────────────────────────────────
[ -n "$REPO_URL" ] || die "usage: bash setup-self-hosted-runner.sh <repo-url> [registration-token]
  e.g. bash setup-self-hosted-runner.sh https://github.com/Omar-3-xx/phoenix-people-workforce"
[[ "$REPO_URL" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "the repo URL must look like https://github.com/<owner>/<repo>"
[ "$(id -u)" -ne 0 ] || die "do not run as root — the runner refuses to configure as root. Use the normal 'ubuntu' user."
command -v sudo >/dev/null || die "sudo is required"
# The workflows call sudo themselves (extra build swap, Playwright's install-deps, the psql fallback);
# under a service there is no terminal to type a password into, so it must be passwordless.
sudo -n true 2>/dev/null || die "this user needs passwordless sudo (Oracle's 'ubuntu' user has it by default)"
[ "$(uname -m)" = "aarch64" ] || die "this script is for ARM64 (aarch64); this machine is $(uname -m)"
[[ "$RUNNER_COUNT" =~ ^[1-8]$ ]] || die "RUNNER_COUNT must be 1-8"
. /etc/os-release
[ "${VERSION_ID:-}" = "24.04" ] || echo "WARNING: written for Ubuntu 24.04; this is ${PRETTY_NAME:-unknown}"

if [ -z "$RUNNER_TOKEN" ]; then
  read -rsp "Registration token (input hidden): " RUNNER_TOKEN
  echo
fi
[ -n "$RUNNER_TOKEN" ] || die "no registration token given"

step "Host: ${PRETTY_NAME:-?} | user: $(whoami) | cores: $(nproc) | RAM: $(free -g | awk '/^Mem:/{print $2}') GB | disk free: $(df -h / | awk 'NR==2{print $4}')"

# ── Base packages ──────────────────────────────────────────────────────────────────────────
step "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq curl git ca-certificates gnupg jq unzip zip xz-utils build-essential \
  python3 python3-venv postgresql-client dnsutils

# gh: GitHub's hosted runners ship it and many workflows call `gh api`. Ubuntu's own package lags far
# behind, so it comes from GitHub's apt repository, which publishes arm64.
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
  echo "NodeSource did not yield Node ${NODE_MAJOR} — falling back to the official linux-arm64 tarball"
  NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json \
    | jq -r "[.[] | select(.version | startswith(\"v${NODE_MAJOR}.\"))] | .[0].version")"
  [ -n "$NODE_VERSION" ] && [ "$NODE_VERSION" != "null" ] || die "could not resolve a Node ${NODE_MAJOR} release from nodejs.org"
  TMP_NODE="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-arm64.tar.xz" | tar -xJ -C "$TMP_NODE"
  sudo rm -rf /usr/local/lib/nodejs
  sudo mkdir -p /usr/local/lib/nodejs
  sudo mv "${TMP_NODE}/node-${NODE_VERSION}-linux-arm64" /usr/local/lib/nodejs/node
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
# needs are installed once here. Chromium is published for linux-arm64.
step "Installing Playwright ${PLAYWRIGHT_VERSION} system dependencies for Chromium"
sudo npx --yes "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium

# ── Swap ───────────────────────────────────────────────────────────────────────────────────
step "Swap"
if [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
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
TARBALL="actions-runner-linux-arm64-${RUNNER_VERSION}.tar.gz"
DL_DIR="$(mktemp -d)"
step "Downloading actions/runner ${RUNNER_VERSION} (linux-arm64)"
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

OWNER_REPO="${REPO_URL#https://github.com/}"
cat <<EOF

================================================================================
 ${RUNNER_COUNT} RUNNER(S) REGISTERED — labels: ${RUNNER_LABELS}

 They are ONLINE but NOTHING USES THEM YET: every workflow reads
   runs-on: \${{ vars.CI_RUNNER_LABEL || 'ubuntu-latest' }}
 and the variable is not set.

 1. Check they read "Idle":  ${REPO_URL}/settings/actions/runners

 2. Switch CI onto this machine (one repository variable):
      gh variable set CI_RUNNER_LABEL --repo ${OWNER_REPO} --body phoenix-ci

 3. Roll back at any time (the next run is GitHub-hosted again):
      gh variable delete CI_RUNNER_LABEL --repo ${OWNER_REPO}

 🔴 While the variable is set and this VM is off, jobs QUEUE — they do not fall back.
 Runbook: docs/ci-self-hosted-runner.md
================================================================================
EOF
