---
name: nsm-title-is-held-once-per-line-not-company-wide
description: "\"National Sales Manager\" is held by three people, one per product line — so a same-line default silently confines each one, which is why probation SCORING was widened to national on 2026-08-20."
metadata:
  type: project
---

There are **three active National Sales Managers**, one per product line (confirmed against
production 2026-08-20):

| Person | HR_ID | line_id | Line |
| --- | --- | --- | --- |
| Amr Naguib Elsabey | B-122 | 3 | CNS |
| Magdy El Senosey | AI-0008 | 1 | Anti Infective |
| Ali Mohamed Ali | A-12 | 2 | Pedia |

All three have `app_auth_users.line_scope_override = NULL`, so any rule that falls back to "same
line as the viewer" confines each of them to one line — despite the title reading "National".

**Owner ruling 2026-08-20 (PR #2233, live on prod as `d217173e`): for probation SCORING, national
means national.** `filterProbationScorableHrIds` in `src/lib/probation/service.ts` lets an NSM open
a scorecard for **any** probationer. A per-user `line_scope_override` still wins, so setting one is
how to narrow an NSM back down with no code change.

**Why:** `probation_config.requirements.nsm = 1` demands an NSM component on every case, and a
score can only be filed by the evaluator named on a DV-Day. With each NSM boxed into his own line —
and DV-Days only ever created by the CRM — the NSM slot was unfillable for most cases and
decision-readiness was blocked company-wide. The owner's words: *"no everyone to his scope not cns
only"*.

**How to apply:** do not "fix" NSM probation scoring back to a line filter. Note the widening is
**scoring only** — the probation tracker, its exports and every other probation read still use
`canReadProbationEmployee` unchanged, and a test pins that separation. Before assuming any other
role is company-wide, check the same way (`app_auth_users.role` + `employees.line_id`); PM/GPM are
genuinely line-scoped by explicit overrides. Related:
[[employees-line-name-column-is-null-in-production]],
[[ahmed-sharaf-is-the-cross-line-product-manager]].
