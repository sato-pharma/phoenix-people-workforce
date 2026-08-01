import assert from "node:assert/strict";

import { indexCheckinsByAgentContactDay, pickCheckinForVisit, type CheckinForMatch } from "../src/lib/crm/checkin-match.ts";

type TestCheckin = CheckinForMatch & { id: string };

function checkin(id: string, overrides: Partial<CheckinForMatch> = {}): TestCheckin {
  return {
    agent_crm_id: 100,
    contact_crm_id: 555,
    check_date: "2026-07-01T09:00:00Z",
    id,
    ...overrides,
  };
}

export function runCrmCheckinMatchTests() {
  // ── Basic match: same agent + contact + day ──────────────────────────────────────
  {
    const index = indexCheckinsByAgentContactDay([checkin("c1")]);
    const result = pickCheckinForVisit(
      { agentCrmId: 100, contactCrmId: 555, visitDay: "2026-07-01", crmSaveDate: "2026-07-01T09:05:00Z" },
      index,
    );
    assert.equal(result?.id, "c1", "same agent+contact+day must match");
  }

  // ── A visit's contact_crm_id 0 (Campaign/Meeting/Vacation) never matches ─────────
  {
    const index = indexCheckinsByAgentContactDay([checkin("c1")]);
    const result = pickCheckinForVisit(
      { agentCrmId: 100, contactCrmId: 0, visitDay: "2026-07-01", crmSaveDate: "2026-07-01T09:05:00Z" },
      index,
    );
    assert.equal(result, null, "contact_crm_id 0 means no real contact — must never match a check-in");
  }

  // ── A check-in with no real contact is excluded from the index entirely ─────────
  {
    const index = indexCheckinsByAgentContactDay([
      checkin("no-contact", { contact_crm_id: null }),
      checkin("c2"),
    ]);
    assert.equal(index.size, 1, "checkin with null contact_crm_id must not be indexed");
    const result = pickCheckinForVisit(
      { agentCrmId: 100, contactCrmId: 555, visitDay: "2026-07-01", crmSaveDate: null },
      index,
    );
    assert.equal(result?.id, "c2");
  }

  // ── Different agent or different day never match ────────────────────────────────
  {
    const index = indexCheckinsByAgentContactDay([checkin("c1")]);
    assert.equal(
      pickCheckinForVisit({ agentCrmId: 200, contactCrmId: 555, visitDay: "2026-07-01", crmSaveDate: null }, index),
      null,
      "different agent must not match",
    );
    assert.equal(
      pickCheckinForVisit({ agentCrmId: 100, contactCrmId: 555, visitDay: "2026-07-02", crmSaveDate: null }, index),
      null,
      "different day must not match",
    );
  }

  // ── Tie-break: nearest to crmSaveDate wins, not the earliest check-in of the day ─
  {
    const index = indexCheckinsByAgentContactDay([
      checkin("morning", { check_date: "2026-07-01T08:00:00Z" }),
      checkin("afternoon", { check_date: "2026-07-01T15:00:00Z" }),
    ]);
    const result = pickCheckinForVisit(
      { agentCrmId: 100, contactCrmId: 555, visitDay: "2026-07-01", crmSaveDate: "2026-07-01T14:50:00Z" },
      index,
    );
    assert.equal(result?.id, "afternoon", "tie-break must pick the check-in nearest crmSaveDate, never the earliest of the day");
  }

  // ── No usable anchor falls back to the day's EARLIEST check-in ──────────────────
  // Regression for #1520. The fallback used to be `candidates[0]` — whichever row happened to
  // arrive first from the database — so the same visit could resolve to a different check-in
  // between two renders purely because the row order changed. The candidates below are indexed
  // AFTERNOON-FIRST on purpose: with `candidates[0]` every assertion here returns "afternoon".
  {
    const index = indexCheckinsByAgentContactDay([
      checkin("afternoon", { check_date: "2026-07-01T15:00:00Z" }),
      checkin("morning", { check_date: "2026-07-01T08:00:00Z" }),
    ]);
    assert.equal(
      pickCheckinForVisit({ agentCrmId: 100, contactCrmId: 555, visitDay: "2026-07-01", crmSaveDate: null }, index)?.id,
      "morning",
      "null crmSaveDate must fall back to the EARLIEST check-in, not whichever row arrived first",
    );
    assert.equal(
      pickCheckinForVisit({ agentCrmId: 100, contactCrmId: 555, visitDay: "2026-07-01", crmSaveDate: "not-a-date" }, index)?.id,
      "morning",
      "unparseable crmSaveDate must also fall back to the earliest check-in",
    );
    assert.equal(
      pickCheckinForVisit({ agentCrmId: 100, contactCrmId: 555, visitDay: "2026-07-01", crmSaveDate: "2026-07-01 00:00:00+00" }, index)?.id,
      "morning",
      "a midnight crm_save_date is a date-only placeholder — it must fall back like no anchor at all",
    );
  }

  // ── A midnight crm_save_date must never be anchored on ──────────────────────────
  // The other half of #1520: `crm_save_date` is a midnight placeholder on ~3% of visits, and
  // `new Date("…T00:00:00").getTime()` is perfectly finite, so the old truthiness check accepted
  // midnight as a real save time. On the SAME day that is harmless (nearest-to-midnight is the
  // earliest check-in anyway, which is what the fallback returns) — the case that actually
  // diverges is a placeholder dated to an ADJACENT day, which drags "nearest in time" toward the
  // wrong end of the day. Here midnight-of-the-2nd is 9h from the afternoon check-in but 16h from
  // the morning one, so anchoring on it picks "afternoon"; the visit really has no usable time.
  {
    const index = indexCheckinsByAgentContactDay([
      checkin("morning", { check_date: "2026-07-01T08:00:00Z" }),
      checkin("afternoon", { check_date: "2026-07-01T15:00:00Z" }),
    ]);
    assert.equal(
      pickCheckinForVisit({ agentCrmId: 100, contactCrmId: 555, visitDay: "2026-07-01", crmSaveDate: "2026-07-02 00:00:00+00" }, index)?.id,
      "morning",
      "a next-day midnight placeholder must not anchor the match — it is not a real save time",
    );
    // Contrast: the SAME timestamp carrying a real clock is a legitimate anchor and does win.
    assert.equal(
      pickCheckinForVisit({ agentCrmId: 100, contactCrmId: 555, visitDay: "2026-07-01", crmSaveDate: "2026-07-02 00:30:00+00" }, index)?.id,
      "afternoon",
      "a real (non-midnight) next-day save time is still a usable anchor",
    );
  }

  // ── Day-key uses only the date portion of check_date ────────────────────────────
  {
    const index = indexCheckinsByAgentContactDay([checkin("c1", { check_date: "2026-07-01T23:59:59Z" })]);
    const result = pickCheckinForVisit(
      { agentCrmId: 100, contactCrmId: 555, visitDay: "2026-07-01", crmSaveDate: null },
      index,
    );
    assert.equal(result?.id, "c1", "checkin day-key must use only the date portion of check_date");
  }

  // ── No candidates at all ─────────────────────────────────────────────────────────
  {
    const index = indexCheckinsByAgentContactDay([]);
    assert.equal(
      pickCheckinForVisit({ agentCrmId: 100, contactCrmId: 555, visitDay: "2026-07-01", crmSaveDate: null }, index),
      null,
    );
  }
}
