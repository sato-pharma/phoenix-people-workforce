---
name: hr-ops-specialist-keeps-the-resignations-tab-export
description: "The HR Operations Specialist KEEPS the per-tab Export on Resignations — owner dropped the 20 Oct \"she exports nothing\" fix on 2026-10-23; never re-ship branch codex/hr-ops-specialist-jd commit f54b877aa"
metadata:
  node_type: memory
  type: project
  originSessionId: cc6af00c-47dd-405e-9408-8224e7fe4553
  modified: 2026-10-22T21:52:58.472Z
---

On 2026-10-20 a session committed `f54b877aa` on `codex/hr-ops-specialist-jd` ("the HR Operations
Specialist gets no tab Export" — a `canExportTab={!isSalaryBlindRole(...)}` prop on
`app/(admin)/resignations/page.tsx`). No PR was ever opened, so production still shows her the
per-tab Export (the money columns are already blank for her seat, server-side).

On 2026-10-23 (unfinished-work audit) the owner was asked and chose **"Drop it"**.

**Why:** his own decision; the export carries no salary figures for that seat.
**How to apply:** never re-ship that commit or rebuild the restriction from the old branch
(still on origin). The rest of that branch, the migration-inventory acknowledgement, is already on main.
