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

  // ── Null or unparseable crmSaveDate falls back to the first indexed candidate ───
  {
    const index = indexCheckinsByAgentContactDay([
      checkin("first", { check_date: "2026-07-01T08:00:00Z" }),
      checkin("second", { check_date: "2026-07-01T15:00:00Z" }),
    ]);
    assert.equal(
      pickCheckinForVisit({ agentCrmId: 100, contactCrmId: 555, visitDay: "2026-07-01", crmSaveDate: null }, index)?.id,
      "first",
      "null crmSaveDate must fall back to the first candidate",
    );
    assert.equal(
      pickCheckinForVisit({ agentCrmId: 100, contactCrmId: 555, visitDay: "2026-07-01", crmSaveDate: "not-a-date" }, index)?.id,
      "first",
      "unparseable crmSaveDate must also fall back to the first candidate",
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
