import assert from "node:assert/strict";

import { hasRealVendorTime, resolveVisitTime } from "../src/lib/crm/reads.ts";

// The canonical visit-time waterfall (PR: CRM single-source visit time).
// iReports360 records no on-site visit time — visit_date_time is a 00:00 placeholder — so the one
// authoritative time is: GPS check-in → save time → none, and NEVER visit_date_time.

export function runCrmVisitTimeTests() {
  // ── hasRealVendorTime: only a real time-of-day counts ────────────────────────────
  assert.equal(hasRealVendorTime(null), false, "null → no time");
  assert.equal(hasRealVendorTime(undefined), false, "undefined → no time");
  assert.equal(hasRealVendorTime(""), false, "empty → no time");
  assert.equal(hasRealVendorTime("2026-07-16 00:00:00+00"), false, "midnight placeholder → no time");
  assert.equal(hasRealVendorTime("2026-07-16T00:00:00"), false, "midnight (ISO T) → no time");
  assert.equal(hasRealVendorTime("2026-07-16 18:13:18+00"), true, "real clock → has time");
  assert.equal(hasRealVendorTime("2026-07-16T18:13:18"), true, "real clock (ISO T) → has time");

  // ── Tier 1: a real GPS check-in wins ─────────────────────────────────────────────
  {
    const r = resolveVisitTime({ nearestCheckinTime: "2026-07-16 14:02:00+00", crmSaveDate: "2026-07-16 15:30:00+00" });
    assert.equal(r.source, "gps_checkin", "GPS check-in is authoritative when present");
    assert.equal(r.time, "2026-07-16 14:02:00+00");
  }

  // ── Tier 2: no GPS → save/submission time ────────────────────────────────────────
  {
    const r = resolveVisitTime({ nearestCheckinTime: null, crmSaveDate: "2026-07-16 15:30:00+00" });
    assert.equal(r.source, "save_time", "falls back to save time when no GPS");
    assert.equal(r.time, "2026-07-16 15:30:00+00");
  }

  // ── A midnight GPS value is not a real time → fall through to save time ───────────
  {
    const r = resolveVisitTime({ nearestCheckinTime: "2026-07-16 00:00:00+00", crmSaveDate: "2026-07-16 15:30:00+00" });
    assert.equal(r.source, "save_time", "midnight GPS placeholder is skipped");
    assert.equal(r.time, "2026-07-16 15:30:00+00");
  }

  // ── A midnight save time is not a real time → none ───────────────────────────────
  {
    const r = resolveVisitTime({ nearestCheckinTime: null, crmSaveDate: "2026-07-16 00:00:00+00" });
    assert.equal(r.source, "none", "midnight save placeholder yields no time");
    assert.equal(r.time, null);
  }

  // ── Nothing usable → none ────────────────────────────────────────────────────────
  {
    const r = resolveVisitTime({ nearestCheckinTime: null, crmSaveDate: null });
    assert.equal(r.source, "none", "no signals → none");
    assert.equal(r.time, null);
  }

  // ── visit_date_time is never consulted (not even in the row shape the resolver reads) ──
  {
    const r = resolveVisitTime({ nearestCheckinTime: null, crmSaveDate: null } as {
      nearestCheckinTime: string | null;
      crmSaveDate: string | null;
      // visit_date_time deliberately absent from the resolver's input contract
    });
    assert.equal(r.time, null, "resolver never manufactures a time from visit_date_time");
  }
}
