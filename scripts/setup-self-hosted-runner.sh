#!/usr/bin/env bash
#
# Provision an Ubuntu host as a self-hosted GitHub Actions runner for
# Gawish-1997/phoenix-people-workforce.
#
# WHY THIS EXISTS
# ---------------
# GitHub bills GitHub-hosted runners per minute and charges $0/min for self-hosted ones.
# Measured September 2026: 37,610 billable minutes ($300.88) in one month, against a 3,000
# minute included allowance — ~158 CI runs a day at ~14 billable minutes each. A small VPS
# running the same work is a fixed ~$10-15/month instead of a metered ~$300 and climbing.
#
# RUN IT ON THE RUNNER HOST, NOT ON A DEV MACHINE:
#
#   export RUNNER_TOKEN=...      # from Settings -> Actions -> Runners -> New self-hosted runner
#   bash scripts/setup-self-hosted-runner.sh
#
# The token is short-lived (about an hour) and is NEVER written to disk by this script.
#
# 🔴 PRIVATE REPOSITORIES ONLY. A self-hosted runner executes whatever a workflow tells it to.
# On a PUBLIC repo, anyone opening a fork pull request can therefore run arbitrary code on this
# machine. phoenix-people-workforce is private, so only accounts with repository access can
# trigger it — that is the case GitHub's own guidance considers acceptable. If this repository
# is ever made public, REMOVE THE RUNNER FIRST.
#
# 🔴 DO NOT INSTALL THIS ON THE OWNER'S LAPTOP. AGENTS.md §5 records that the 16 GB machine
# already hard-freezes under a build plus a dev server; adding a CI runner guarantees it.
set -euo pipefail

REPO_URL="https://github.com/Gawish-1997/phoenix-people-workforce"
# This pin is the BOOTSTRAP version, not the running one: the Actions runner self-updates after
# registration, and this script passes no `--disableupdate` (verified 2026-09-28 — the flag appears
# nowhere in this file). So a pin drifting months behind GitHub's latest is harmless, and bumping it
# buys nothing but a slightly shorter first update. Do not "fix" it as though it pinned production.
RUNNER_VERSION="2.331.0"
RUNNER_DIR="${RUNNER_DIR:-$HOME/actions-runner}"
RUNNER_NAME="${RUNNER_NAME:-phoenix-ci-$(hostname -s)}"
# `self-hosted` is implicit. 🔴 THIS DEFAULT IS BYTE-IDENTICAL TO WHAT THE RAILWAY REPLICAS CARRY,
# and `runs-on: self-hosted` matches EVERY self-hosted runner on the repo — so a host registered with
# the default cannot be selected apart from them. Give a new host its OWN extra label and point
# `CI_RUNNER_LABEL` at THAT, never at `self-hosted`:
#   export RUNNER_LABELS=self-hosted,linux,x64,phoenix,hetzner
# A label that matches no ONLINE runner does not fall back to hosted — it QUEUES, for ever, with
# nothing red. See docs/ci-self-hosted-runner.md, "Turning it on". (Ported from PR #4583.)
RUNNER_LABELS="${RUNNER_LABELS:-self-hosted,linux,x64,phoenix}"
NODE_MAJOR="24"

die() { echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

# ── Preconditions ──────────────────────────────────────────────────────────────────────────
[ "$(id -u)" -ne 0 ] || die "do not run as root — the runner service refuses to configure as root. Use a normal sudo-capable user."
command -v sudo >/dev/null || die "sudo is required"
[ "$(uname -m)" = "x86_64" ] || die "this script assumes x86_64; adjust RUNNER_VERSION's asset for arm64"
[ -n "${RUNNER_TOKEN:-}" ] || die "RUNNER_TOKEN is not set. Get one from ${REPO_URL}/settings/actions/runners/new (valid ~1 hour)."

step "Host: $(. /etc/os-release && echo "$PRETTY_NAME") | user: $(whoami) | cores: $(nproc) | RAM: $(free -g | awk '/^Mem:/{print $2}')GB"
# The build step alone peaks around 4 GB; typecheck is configured for a 6 GB heap in ci.yml.
TOTAL_GB="$(free -g | awk '/^Mem:/{print $2}')"
[ "$TOTAL_GB" -ge 7 ] || echo "WARNING: ${TOTAL_GB}GB RAM. ci.yml runs typecheck with --max-old-space-size=6144; 8GB+ is strongly recommended."

# ── Toolchain ──────────────────────────────────────────────────────────────────────────────
step "Installing base packages"
sudo apt-get update -qq
sudo apt-get install -y -qq curl git ca-certificates jq unzip build-essential

step "Installing Node ${NODE_MAJOR} + corepack/pnpm"
# 🔴 NODESOURCE DOES NOT COVER EVERY UBUNTU RELEASE, AND ITS FAILURE IS NOT LOUD. `setup_24.x`
# writes an apt source for the host's codename; on a release it has never published for, the
# following `apt-get install nodejs` either installs the DISTRO's Node (a different major) or fails
# on a 404 that `set -e` turns into an abort halfway through provisioning, with the runner not yet
# registered. Measured 2026-09-30 on a fresh Hetzner CPX32: Ubuntu 26.04 "resolute" had no
# NodeSource repo at all, so the box came up with no Node and the script could not proceed.
# The official tarball has no such gap — it is one static file per version, published for every
# x86_64 Linux — so it is the fallback, and the version is resolved from nodejs.org rather than
# pinned here so this never becomes a second thing to bump.
if ! node --version 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - || true
  sudo apt-get install -y -qq nodejs || true
fi
if ! node --version 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  echo "NodeSource did not yield Node ${NODE_MAJOR} on $(. /etc/os-release && echo "$VERSION_CODENAME") — falling back to the official tarball"
  NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json \
    | jq -r "[.[] | select(.version | startswith(\"v${NODE_MAJOR}.\"))] | .[0].version")"
  [ -n "$NODE_VERSION" ] && [ "$NODE_VERSION" != "null" ] || die "could not resolve a Node ${NODE_MAJOR} release from nodejs.org"
  TMP_NODE="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" \
    | sudo tar -xJ -C "$TMP_NODE"
  sudo rm -rf /usr/local/lib/nodejs
  sudo mkdir -p /usr/local/lib/nodejs
  sudo mv "${TMP_NODE}/node-${NODE_VERSION}-linux-x64" /usr/local/lib/nodejs/node
  for bin in node npm npx corepack; do
    sudo ln -sf "/usr/local/lib/nodejs/node/bin/${bin}" "/usr/local/bin/${bin}"
  done
  rm -rf "$TMP_NODE"
fi
node --version | grep -q "^v${NODE_MAJOR}\." || die "Node ${NODE_MAJOR} is still not on PATH after both install paths"
sudo corepack enable
echo "node $(node --version) | corepack $(corepack --version)"

# Playwright's browsers are downloaded per-run by ci.yml (and cached); its SYSTEM libraries are
# not, and a missing one fails the login smoke test with a bare browser-launch error.
step "Installing Playwright system dependencies"
sudo npx --yes playwright install-deps chromium

# ── Runner ─────────────────────────────────────────────────────────────────────────────────
step "Downloading actions/runner ${RUNNER_VERSION} into ${RUNNER_DIR}"
mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"
TARBALL="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
if [ ! -f "./config.sh" ]; then
  curl -fsSLO "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${TARBALL}"
  tar xzf "./${TARBALL}"
  rm -f "./${TARBALL}"
fi

step "Registering with ${REPO_URL}"
# --replace makes re-running this script safe: it takes over the existing registration for this
# name instead of erroring or creating a duplicate runner.
./config.sh \
  --unattended \
  --replace \
  --url "$REPO_URL" \
  --token "$RUNNER_TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABELS" \
  --work "_work"

step "Installing as a systemd service (survives reboot)"
sudo ./svc.sh install "$(whoami)"
sudo ./svc.sh start
sleep 3
sudo ./svc.sh status || true

cat <<EOF

================================================================================
 RUNNER REGISTERED: ${RUNNER_NAME}
 labels: ${RUNNER_LABELS}

 It is now ONLINE but NOTHING USES IT YET — ci.yml still resolves to ubuntu-latest,
 by design, so a half-finished runner cannot wedge CI.

 TO SWITCH CI ONTO IT (one repository variable, instantly reversible) - name the label you gave
 this host above, NEVER 'self-hosted', which matches every self-hosted runner on the repo:
   gh variable set CI_RUNNER_LABEL --repo Gawish-1997/phoenix-people-workforce --body 'hetzner'

 That alone turns nothing on: only a same-repo PR from a ci-runner/<task> branch is eligible, and
 main is never self-hosted. Open such a PR to exercise it.

 TO ROLL BACK AT ANY TIME (jobs return to GitHub-hosted on the next run, or the next run ATTEMPT
 of a run already in flight - use gh run rerun --failed):
   gh variable set CI_SELF_HOSTED --repo Gawish-1997/phoenix-people-workforce --body off

 Verify it appears online first:
   ${REPO_URL}/settings/actions/runners

 Full runbook, including the security rules and what to do if the host dies:
   docs/ci-self-hosted-runner.md
================================================================================
EOF
