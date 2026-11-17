---
name: picomatch-advisory-wait-for-a-fix
description: "Owner ACCEPTED the HIGH picomatch advisory GHSA-fc5q-39xc-vjpf (2026-11-17 ~21:40 Cairo, \"accept the picomatch advisory in 515\") after first choosing to wait — ignored in pnpm-workspace.yaml auditConfig until picomatch 4.0.8 exists; remove the ignore that day"
metadata:
  node_type: memory
  type: project
  originSessionId: 0a8a71f8-717c-4ecb-84f3-697188bd99c3
  modified: 2026-11-17T19:07:03.914Z
---

On 2026-11-17 (~20:30 Cairo) the required `checks` job (via `static` → "Dependency audit") went red on every PR because of
GHSA-fc5q-39xc-vjpf: picomatch `<= 4.0.7`, ReDoS through repeated extglobs, HIGH, **no patched version exists**
(npm `latest` is 4.0.7). The only prod paths are `@sentry/nextjs > @rollup/plugin-commonjs (> @rollup/pluginutils | > fdir) > picomatch`,
a build-time bundling plugin; app code never imports picomatch.

First decision (~20:30, another session, MCQ): **"Wait for a fix"**. Superseded the same evening (~21:40 Cairo) when he
asked why everything was failing and then said, in his own words: **"accept the picomatch advisory in 515"**. PR 515
(branch `claude/chatgpt-connector-read-everything`) adds `auditConfig.ignoreGhsas: [GHSA-fc5q-39xc-vjpf]` to
`pnpm-workspace.yaml`, the record row in `docs/security/open-dependency-alerts.md`, and the ci.yml comment.

**Why:** his decision on a security gate — every accepted advisory is his word. Once 515 merges, every other open PR
(514 included) goes green on its next run.

**How to apply:** do not add any other ignore on the strength of this one. The day picomatch publishes 4.0.8+, re-resolve
it in the lockfile (`^4.0.2` already allows it; the Sunday 10:00 Cairo dependency refresh picks it up), delete the
`ignoreGhsas` line and the doc row in the same PR, and see the audit pass without it. The owner pre-approved that
removal PR on 2026-11-17 (MCQ "Do it when 4.0.8 ships"): open it without asking again once 4.0.8 is really on npm
— check `dist-tags.latest` first; never remove the ignore while no fix exists. Related: [[brace-expansion-audit-fix-trap]].
