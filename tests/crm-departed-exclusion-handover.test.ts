import assert from "node:assert/strict";

import { CRM_RESIGNED_AGENT_CRM_IDS, resolveLiveDepartedExclusion } from "../src/lib/crm/reads.ts";

/**
 * Production incident, 2026-08-05: CRM slot 1399 belonged to B-97 (Nada Elsharkawy) from
 * 2026-01-01 until her resignation (last working date 2026-06-28). Per the resignation flow's own
 * rule, her `employees.crm_id` was cleared so the slot could be inherited — and it was: AI-0006
 * (Mohamed Yasser, hired 2026-08-02) now holds crm_id 1399 and is actively logging visits under it.
 *
 * But the live departed-agent exclusion scans `ireports360_visits.agent_hr_id` ALL-TIME, unscoped
 * by date, for any row that ever belonged to a now-departed employee. B-97's 1,229 historical rows
 * on crm_id 1399 (correctly attributed to her while she was employed) permanently marked that
 * crm_id as "departed" — so once she resigned, EVERY row on crm_id 1399, including AI-0006's own
 * current, correctly-attributed visits, vanished from every company-wide CRM read: the employee
 * portal, admin CRM reports, Double Visit Analytics, and the Field Workforce Compliance matrix
 * that feeds automated payroll's no-activity deduction detector. Verified against production: all
 * 23 of AI-0006's visits (2026-08-02 through today) matched the live-scanned exclusion set.
 *
 * resolveLiveDepartedExclusion is the fix: it drops a scanned crm_id from the live exclusion
 * whenever a currently ACTIVE/on_leave employee now owns it (employees.crm_id), so a handed-over
 * slot stops being blanket-hidden the moment it is reassigned — without touching the separate,
 * hand-maintained static list (CRM_RESIGNED_AGENT_CRM_IDS), which deliberately keeps some ACTIVE
 * employees excluded on purpose (e.g. the CEO) and must never be silently overridden by this.
 */
export function runCrmDepartedExclusionHandoverTests() {
  // ── The exact production case: crm_id 1399 scanned as departed (via B-97's old rows), but ─────
  // ── AI-0006 now actively owns it — the slot must NOT stay excluded. ─────────────────────────
  const handedOver = resolveLiveDepartedExclusion({
    scannedCrmIds: [1399],
    activeEmployeeCrmIds: new Set(["1399"]),
  });
  assert.deepEqual(
    handedOver,
    [],
    "a crm_id reassigned to a currently active employee must be dropped from the live exclusion, or the successor's own visits vanish everywhere",
  );

  // ── The STATIC list outranks employment status, so a handed-over slot left on it stays hidden ─
  // ── no matter what the roster says. 1166 carries AI-0018 (Samah Ashraf, active) since ────────
  // ── 2026-09-05 (owner decision 2026-09-13); the CEO's owner exclusion must survive. ─────────
  assert.ok(
    !CRM_RESIGNED_AGENT_CRM_IDS.includes(1166),
    "crm_id 1166 is an active rep's handed-over slot and must not sit on the static resigned list, or her visits stay invisible to Field Workforce Compliance and the no-activity detector",
  );
  // 1437 (AI-0023, Mariam Younan) and 1303 (AI-0025, Norhan Gamal) — both reseated on 2026-10-01
  // hires; left here, her visits and her District Manager's double visits with her vanished.
  for (const reseated of [1437, 1303]) {
    assert.ok(
      !CRM_RESIGNED_AGENT_CRM_IDS.includes(reseated),
      `crm_id ${reseated} is an active rep's handed-over slot and must not sit on the static resigned list, or her visits and her manager's double visits with her stay invisible`,
    );
  }
  assert.ok(
    CRM_RESIGNED_AGENT_CRM_IDS.includes(1474),
    "the owner's deliberate exclusions (the CEO, 1474) must stay on the static list",
  );

  // ── A genuinely still-departed slot (no current active owner) stays excluded ────────────────
  const stillDeparted = resolveLiveDepartedExclusion({
    scannedCrmIds: [1477],
    activeEmployeeCrmIds: new Set(),
  });
  assert.deepEqual(
    stillDeparted,
    [1477],
    "a crm_id nobody active currently owns is a genuine departed/placeholder slot and must remain excluded",
  );

  // ── Mixed input: only the actively-owned ids are dropped, the rest survive unchanged ────────
  const mixed = resolveLiveDepartedExclusion({
    scannedCrmIds: [1102, 1395, 1399, 1477, 1521],
    activeEmployeeCrmIds: new Set(["1395", "1399", "1521"]),
  });
  assert.deepEqual(
    mixed,
    [1102, 1477],
    "only crm ids with a current active owner are removed; ids with no active owner keep their position and are never invented or dropped by mistake",
  );

  // ── Empty scan input is a no-op regardless of who currently holds which crm_id ───────────────
  assert.deepEqual(
    resolveLiveDepartedExclusion({ scannedCrmIds: [], activeEmployeeCrmIds: new Set(["1399"]) }),
    [],
    "nothing was scanned as departed, so there is nothing to carve an exception out of",
  );
}
