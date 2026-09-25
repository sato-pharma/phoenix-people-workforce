---
name: field-force-provisioning-live-and-guard-relaxed-2026-08-14
description: "DSM/Medical Rep titles auto-provision their real role (LIVE on prod, #2139); the title-governance guard was DELIBERATELY relaxed for exactly those two — do not restore the blanket-Employee assertion."
metadata: 
  node_type: memory
  type: project
  originSessionId: ab789891-3bf2-4236-876d-b9e9aa59d10d
  modified: 2026-08-14T18:03:47.005Z
---

PR #2139 (`codex/fix-provisioning-role-default`) merged to prod **2026-08-14**
(squash `4a93d8f6`, confirmed live at healthz 18:00Z). `resolveEmployeeAccessRole`
in `src/lib/employees/access-role.ts` now maps a **CLOSED two-title allowlist** to a
real starting access role:
- `district sales manager` / `district manager` / `dsm` → **District Manager**
- `medical representative` / `medical rep` → **Medical Rep**
- every other title → **Employee** (no fallback to `normalizeRole`/`resolveJobFunctionRole`)

Both mapped roles are privilege rank 100 (identical to Employee) → **no privilege
widening**. Regional & National Sales Manager are deliberately NOT mapped (broad
scope, hand-assigned). Fixes six accounts that sat stranded on Employee for weeks:
PD-0004, PD-0006, PD-0008, PD-0009, PD-0010, CN-0005.

**Why / DON'T-FIX-BACK:** `tests/title-permission-governance.test.ts` was
deliberately narrowed (owner-approved 2026-08-14) to permit exactly those two
mappings via an `APPROVED_FIELD_FORCE_PROVISIONING` map. Do NOT "restore" the old
blanket `resolveEmployeeAccessRole(...) === "Employee"` loop or the
`District Sales Manager → Employee` assertion — that IS the fix being reverted, not a
security regression to repair.

**How to apply:** if a future session sees the two-title exception in that guard test
and reads it as a title→role privilege leak, STOP. The security property is still
enforced — the **general role parser `normalizeRole` still maps NONE of these titles**
to a role (every `normalizeRole("District Sales Manager"|"DSM"|"Medical Representative")
=== "Employee"` assertion is intact), and the blanket guard still holds for all 18 other
company titles. A title seeds a starting role ONLY through the explicit provisioning
allowlist, never through role parsing. Related: [[account-creation-defaults-role-to-employee]],
[[changing-a-user-role-needs-four-writes]].
