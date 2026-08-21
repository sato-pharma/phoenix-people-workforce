import assert from "node:assert/strict";

import { CRM_DAY_CLASSIFIED_VISIT_TYPES, crmDayVisitTypeStatus } from "../src/lib/attendance/crm-day-maps.ts";
import { selectUnrecognizedVisitTypeAlerts } from "../src/lib/crm/unrecognized-visit-type-alert.ts";

type Row = {
  agentCrmId: number | null;
  comment: string | null;
  visitDate: string | null;
  visitType: number | null;
  visitTypeDescription: string | null;
};

function row(overrides: Partial<Row>): Row {
  return {
    agentCrmId: 1399,
    comment: null,
    visitDate: "2026-08-20",
    visitType: -99,
    visitTypeDescription: "Unknown",
    ...overrides,
  };
}

/**
 * Every visit type production has ever produced, verified against the live database 2026-08-21:
 * type 0 plus fifteen negatives. If this list and CRM_DAY_CLASSIFIED_VISIT_TYPES ever disagree,
 * the alert would either cry wolf on a real code or stay silent on a new one.
 */
const PRODUCTION_VISIT_TYPES = [0, -1, -2, -4, -5, -6, -7, -8, -9, -11, -12, -15, -19, -20, -21, -30];

export function runCrmUnrecognizedVisitTypeAlertTests() {
  const recentSinceIso = "2026-08-07";

  // ── The whole point: a code nobody has classified must alert ─────────────────────────────────
  const fresh = selectUnrecognizedVisitTypeAlerts({
    recentSinceIso,
    recognizedTypes: CRM_DAY_CLASSIFIED_VISIT_TYPES,
    rows: [
      row({ comment: "زياره ادارية", visitDate: "2026-08-19" }),
      row({ visitDate: "2026-08-20", agentCrmId: 1402 }),
      row({ visitType: -8, visitDate: "2026-08-20" }),
    ],
  });
  assert.equal(
    fresh.length,
    1,
    "an unclassified visit type must raise exactly one alert — this is the whole tripwire; a classified code (-8) must not",
  );
  assert.equal(
    fresh[0].visitType,
    -99,
    "the alert must name the UNCLASSIFIED code — reporting a classified one instead means the recognized check is inverted and the real gap goes unreported",
  );
  assert.equal(fresh[0].visitCount, 2, "both rows of the unclassified code must be counted, so the alert shows real volume");
  assert.equal(fresh[0].agentCount, 2, "two distinct CRM accounts logged it — one rep's oddity reads differently from a fleet-wide change");
  assert.equal(fresh[0].firstDay, "2026-08-19", "firstDay must be the EARLIEST row's date, so the alert shows how long this has been happening");
  assert.equal(fresh[0].lastDay, "2026-08-20", "lastDay must be the LATEST row's date — the recency guard keys off it");
  assert.equal(fresh[0].sampleComment, "زياره ادارية", "the rep's own comment is how the previous seven codes were identified — it must reach the alert");
  assert.equal(fresh[0].sampleDescription, "Unknown", "the vendor's own description must be reported verbatim — 'Unknown' is itself the diagnostic signal");

  // ── No false alarm on any code production actually sends ─────────────────────────────────────
  // The failure this guards against is the opposite of a missed alert: a tripwire that fires every
  // single sync is one that gets muted, and then it protects nothing.
  const everyRealCode = selectUnrecognizedVisitTypeAlerts({
    recentSinceIso,
    recognizedTypes: CRM_DAY_CLASSIFIED_VISIT_TYPES,
    rows: PRODUCTION_VISIT_TYPES.map((visitType) => row({ visitType })),
  });
  assert.deepEqual(
    everyRealCode,
    [],
    `all ${PRODUCTION_VISIT_TYPES.length} visit types production has ever sent must stay silent — an alert here means the recognized set lost a code`,
  );

  // ── A null visit_type is a REGULAR visit, not a new code ─────────────────────────────────────
  // crm-day-maps.ts reads `Number(row.visit_type ?? 0)`, so null is already classified as type 0.
  // Alerting on it would report a phantom on every run.
  const nulls = selectUnrecognizedVisitTypeAlerts({
    recentSinceIso,
    recognizedTypes: CRM_DAY_CLASSIFIED_VISIT_TYPES,
    rows: [row({ visitType: null }), row({ visitType: null, agentCrmId: 77 })],
  });
  assert.deepEqual(nulls, [], "a null visit_type is treated as a regular visit by the classifier and must never alert");

  // ── Historical-only activity stays silent (the weekly reconcile re-scans 120-day windows) ────
  const historical = selectUnrecognizedVisitTypeAlerts({
    recentSinceIso,
    recognizedTypes: CRM_DAY_CLASSIFIED_VISIT_TYPES,
    rows: [row({ visitDate: "2026-06-01" }), row({ visitDate: "2026-06-02" })],
  });
  assert.deepEqual(historical, [], "a code last seen months ago must not re-alert every weekly reconcile");

  // ── A row with no date cannot be placed, so it cannot alert ──────────────────────────────────
  const undated = selectUnrecognizedVisitTypeAlerts({
    recentSinceIso,
    recognizedTypes: CRM_DAY_CLASSIFIED_VISIT_TYPES,
    rows: [row({ visitDate: null }), row({ visitDate: "" })],
  });
  assert.deepEqual(undated, [], "a visit with no date has no window to report and must be skipped, not dated to the epoch");

  // ── Two new codes rank by volume, so the capped notification shows the biggest first ─────────
  const ranked = selectUnrecognizedVisitTypeAlerts({
    recentSinceIso,
    recognizedTypes: CRM_DAY_CLASSIFIED_VISIT_TYPES,
    rows: [
      row({ visitType: -98 }),
      row({ visitType: -97 }),
      row({ visitType: -97, visitDate: "2026-08-19" }),
    ],
  });
  assert.deepEqual(
    ranked.map((alert) => alert.visitType),
    [-97, -98],
    "alerts must sort by visit count descending — the per-run cap keeps the first few, so the noisiest new code must not be the one dropped",
  );

  // ── The recognized set must stay DERIVED from the two Sets, never a hand-written fourth copy ──
  // This is the cross-copy pin. A fourth list that drifts is exactly what produced the 88-agent-day
  // gap; if someone replaces the derivation with a literal, these assertions go red.
  for (const visitType of PRODUCTION_VISIT_TYPES) {
    assert.ok(
      CRM_DAY_CLASSIFIED_VISIT_TYPES.has(visitType),
      `CRM_DAY_CLASSIFIED_VISIT_TYPES must contain every production visit type — ${visitType} is missing, so a real code would alert as unclassified`,
    );
  }
  for (const visitType of CRM_DAY_CLASSIFIED_VISIT_TYPES) {
    if (visitType === 0) continue; // regular visits are counted by regularCount, not via either Set
    assert.ok(
      crmDayVisitTypeStatus(visitType) !== undefined,
      `every non-regular code in CRM_DAY_CLASSIFIED_VISIT_TYPES must resolve to AV or CP — ${visitType} does not, so the set is no longer derived from the two Sets`,
    );
  }
  assert.equal(
    crmDayVisitTypeStatus(-99),
    undefined,
    "an unclassified code must still fall through crmDayVisitTypeStatus — the alert reports that fall-through, it must not mask it",
  );
  assert.equal(
    CRM_DAY_CLASSIFIED_VISIT_TYPES.has(-99),
    false,
    "an unclassified code must not be in the recognized set, or nothing would ever alert",
  );
}
