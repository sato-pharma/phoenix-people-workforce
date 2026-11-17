---
name: picomatch-advisory-wait-for-a-fix
description: "Owner chose \"Wait for a fix\" (2026-11-17 ~20:30 Cairo) for the HIGH picomatch advisory GHSA-fc5q-39xc-vjpf that turns every PR's dependency audit red — never add an audit ignore for it, never ask again"
metadata:
  node_type: memory
  type: project
  originSessionId: b860e70b-fa60-486d-a052-cc46a55412cc
  modified: 2026-11-17T18:29:04.614Z
---

On 2026-11-17 (~20:30 Cairo) the required `checks` job (via `static` → "Dependency audit") went red on every PR because of
GHSA-fc5q-39xc-vjpf: picomatch `<= 4.0.7`, ReDoS through repeated extglobs, HIGH, **no patched version exists**
(npm `latest` is 4.0.7). The only prod paths are `@sentry/nextjs > @rollup/plugin-commonjs (> @rollup/pluginutils | > fdir) > picomatch`,
a build-time bundling plugin; app code never imports picomatch.

Asked as an MCQ ("Accept it, in 514" vs "Wait for a fix"), the owner chose **"Wait for a fix"**: no `auditConfig`
ignore, no override, nothing changed. PR #514 (production schema baseline refresh, branch `codex/schema-baseline-refresh`,
worktree `F:\Phoenix Workforce\_wt-schema-baseline-refresh`) stays open; his "merge 514 when green" stands for when it can go green.

**Why:** his decision on a security gate — every accepted advisory in `docs/security/open-dependency-alerts.md` is his word.

**How to apply:** do not re-ask him or add an ignore for this advisory. Once picomatch publishes a fix (>= 4.0.8),
re-resolve it in the lockfile (`^4.0.2` already allows it; the Sunday 10:00 Cairo dependency refresh would pick it up)
— that unblocks every PR and the release gate. The standing decisions on other advisories are in
`docs/security/open-dependency-alerts.md`.
