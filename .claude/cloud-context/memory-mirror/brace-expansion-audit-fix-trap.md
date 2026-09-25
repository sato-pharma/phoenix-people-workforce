---
name: brace-expansion-audit-fix-trap
description: "GHSA-mh99-v99m-4gvg (brace-expansion DoS, patched >=5.0.8) — forcing an override to 5.x breaks minimatch@3.1.5, shared by eslint's config-array AND exceljs/archiver's zip handling (production xlsx export). Already fixed properly on main via pnpm.auditConfig.ignoreGhsas, not a version override."
metadata: 
  node_type: memory
  type: project
  originSessionId: 801b416b-a17f-45a9-b104-e823db5cb2ba
  modified: 2026-07-24T23:23:36.938Z
---

CI's `validate` job runs `pnpm audit --audit-level=high --prod`, which started failing 2026-07-24/25 on `brace-expansion` (GHSA-mh99-v99m-4gvg, vulnerable <=5.0.7, patched >=5.0.8). `pnpm-workspace.yaml`'s `overrides:` previously pinned `"brace-expansion@1": ^1.1.16` / `"brace-expansion@2": ^2.1.2` — both now considered vulnerable under this advisory.

**Do NOT fix this by overriding brace-expansion to 5.x** (scoped `@1`/`@2` selectors or unscoped). Confirmed by direct reproduction: `minimatch@3.1.5`'s `braceExpand()` calls brace-expansion's old callable-default export (`module.exports = expand`), which brace-expansion 5.x removed — throws `TypeError: expand is not a function`. This instantly breaks `pnpm run lint` (eslint's `@eslint/config-array` depends on `minimatch@3.1.5`), and — more seriously — the SAME deduped `minimatch@3.1.5` node is also required by **exceljs → archiver/unzipper → glob@7.2.3 → minimatch@3.1.5** (a production dependency, this is the library that generates every payroll/sales xlsx export in the app). An override "fix" here risks breaking XLSX export in production, not just CI.

**The actual fix (already landed on `main` by another session while this was being investigated):** `pnpm-workspace.yaml` gained a `pnpm.auditConfig.ignoreGhsas: [GHSA-mh99-v99m-4gvg]` entry with documented reasoning — brace-expansion's `expand()` is only reachable here via exceljs's *internal* zip-archive path handling during XLSX read/write, never a user-supplied glob pattern, so the DoS is not realistically exploitable in this app's usage. Revisit once eslint's config-array / Sentry's bundler-plugin-core / archiver's own chain bump to a brace-expansion-5.x-compatible minimatch.

**How to apply:** if `pnpm audit --audit-level=high --prod` (or CI's `validate` job) is red on brace-expansion again, check `pnpm-workspace.yaml` for this `ignoreGhsas` entry first — it may have been reverted or a new advisory ID needs adding — before attempting any version-override fix. If a genuinely different high-severity advisory shows up, don't force an override blind; run `pnpm why <pkg>` for ALL resolved paths (not just what `pnpm audit` truncates to 3), including prod chains through `exceljs`/`archiver`/`unzipper`, before touching `overrides:`.
