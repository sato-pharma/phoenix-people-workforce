---
name: git-to-github-is-pinned-to-the-france-edge
description: "Since 14 Nov 2026 this laptop's global git config sends github.com git traffic to GitHub's France entry point and makes a stalled git call give up after 30 s; why, proof, and how to undo it."
metadata:
  node_type: memory
  type: project
  originSessionId: ac517097-d518-4ed0-b0b9-0e513837266f
  modified: 2026-11-14T20:52:42.740Z
---

This laptop's `~/.gitconfig` holds three lines set on 14 Nov 2026 (~22:45 Cairo), on the owner's "fix those"
about hanging git calls and the bad route to GitHub:

- `http.curloptResolve = github.com:443:20.199.39.232,20.26.156.215,20.250.119.67,140.82.121.3` — git (HTTPS only)
  reaches GitHub through its France entry point, then UK, then Switzerland, then the Frankfurt one DNS gives.
- `http.lowSpeedLimit = 1` + `http.lowSpeedTime = 30` — a git network call that moves no bytes for 30 s fails
  with `Operation too slow` instead of hanging for minutes.

**Why:** on the home Wi-Fi (WE line) the Frankfurt address DNS hands out for github.com (140.82.121.x) lost about
20–30% of packets at ~230 ms, and page loads timed out at 15–30 s, while Google stayed at ~70 ms with no loss.
The route trace showed the loss on the overseas carrier between Egypt and Frankfurt. Other sessions'
`git ls-remote`/`git push` calls hung for 1–5 minutes. GitHub's status page showed no problem. Of nine GitHub
entry points from `gh api meta`, France measured 76 ms with 0/15 lost and every page load under 1 s.

**Proof:** against a local server that never answers, git with no limit was still waiting when an outside timer
killed it at 20 s; with the global setting alone it exited 128 after 30.5 s. With the pin, plain
`git ls-remote origin` connected to 20.199.39.232 and took 1.05–1.6 s (2,550 refs) in six runs. With a dead first
address, git moved to the next address and answered in 1.3 s.

**How to apply:**
- If git to GitHub suddenly fails with a certificate or connection error, check this pin first.
  `git config --global --unset http.curloptResolve` restores normal DNS. The stall limit can stay.
- `Operation too slow … last 30 seconds` is this limit working, not a GitHub fault: retry the call.
- The pin covers git only. The `gh` CLI (api.github.com) still goes through Frankfurt: api.github.com answered
  301 through the France address, so it cannot be moved there.
- The browser: `~/.claude/scripts/github-hosts-france.ps1` (handed to the owner 14 Nov 2026 ~22:55 Cairo; he runs
  it elevated, since Claude may not edit the hosts file) adds two hosts-file lines tagged `phoenix-github-france`
  (France 20.199.39.232, UK 20.26.156.215), keeps the file's read-only flag, and logs PASS/FAIL to
  `~/.claude/scripts/github-hosts-france.log`. **APPLIED 14 Nov 2026 22:51 Cairo, RESULT: PASS** (log read):
  github.com resolves to 20.199.39.232, 20.26.156.215; read-only flag restored; the 5 other active lines kept.
  Eight curl page loads afterwards: 0.55–0.98 s, against a 20 s Frankfurt load before. (The script's own
  2.5–5.4 s readings were Windows PowerShell's progress bar; fixed in the script with `$ProgressPreference`.)
  `-Undo` removes exactly those lines; the original is kept as `hosts.before-phoenix-github-france`.
  If the GitHub WEBSITE alone breaks (git fine), suspect these two hosts lines first.
- Related: the push-hang trap in `docs/agents-session-traps-clusters.md` ("`git push` hangs — kill at ~60s and
  retry") predates this; git now gives up by itself after 30 s.
