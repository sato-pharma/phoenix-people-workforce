import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { sparedDaysFromDisputes, spareAcceptedDailyDisputeDays } from "../src/lib/daily-deductions/accepted-dispute-days.ts";
import type { DeductionsCandidateDraft } from "../src/lib/deductions/types.ts";
import { selectAcceptedDailyDisputeCorrections } from "../src/lib/dispute-center/accepted-deduction-days.ts";
import { resolveParticipant } from "../src/lib/dispute-center/participants.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A RELEASED DAILY DEDUCTION CAN BE DISPUTED, AND AN ACCEPTED DISPUTE IS NEVER CHARGED AGAIN.
 *
 * Owner, 2026-11-13: "IN DEDUCTION MODULE IN EMPLOYEE PORTAL NO DISPUTE OR COMMENT BUTTON". The
 * "Released during the month" lines on the employee's Deductions page had no Dispute box — 4 of the
 * 7 employees holding one that day had nothing else on the page. Asked what accepting one does, he
 * chose "Withdraw + never charge": the line is withdrawn, the days are verified on the calendar, and
 * month-end collection never charges those days for that type again.
 */

function draft(overrides: Partial<DeductionsCandidateDraft>): DeductionsCandidateDraft {
  return {
    calculationStatus: "calculated",
    category: "fingerprint",
    dates: ["2026-11-02", "2026-11-03", "2026-11-04"],
    employeeHrId: "OF-0006",
    employeeName: "Test Employee",
    estimatedAmount: 900,
    evidence: {},
    hierarchySnapshot: {},
    month: 11,
    monthKey: "2026-11",
    rawValue: 3,
    reason: "No fingerprint",
    severity: "medium",
    sourceRecordId: null,
    sourceSystem: "fingerprint",
    unit: "days",
    year: 2026,
    ...overrides,
  } as DeductionsCandidateDraft;
}

export function runDailyDeductionsDisputesTests(): void {
  // ── 1. Only an ACCEPTED dispute spares a day ─────────────────────────────
  const spared = sparedDaysFromDisputes([
    { category: "fingerprint", dates: ["2026-11-03"], employee_hr_id_compact: "OF0006", status: "accepted" },
    { category: "fingerprint", dates: ["2026-11-04"], employee_hr_id_compact: "OF0006", status: "open" },
    { category: "fingerprint", dates: ["2026-11-02"], employee_hr_id_compact: "OF0006", status: "rejected" },
  ]);
  assert.deepEqual(
    [...spared.values()].flatMap((days) => [...days]),
    ["2026-11-03"],
    "an open or a rejected dispute spares nothing; only an accepted one does",
  );

  // ── 2. An exact line loses the won day and is re-priced ──────────────────
  {
    const { kept, notes } = spareAcceptedDailyDisputeDays([draft({})], spared);
    assert.equal(kept.length, 1);
    assert.deepEqual(kept[0]!.dates, ["2026-11-02", "2026-11-04"], "the won day is removed from the month-end line");
    assert.equal(kept[0]!.rawValue, 2, "and the line charges one day fewer");
    assert.equal(kept[0]!.estimatedAmount, 600, "priced for the days it still charges");
    assert.equal(notes.length, 1, "the collection screen is told why the day is missing");
  }

  // ── 3. A line whose every day was won is not written at all ──────────────
  {
    const { kept } = spareAcceptedDailyDisputeDays([draft({ dates: ["2026-11-03"], estimatedAmount: 300, rawValue: 1 })], spared);
    assert.equal(kept.length, 0, "a finding wholly on won days never reaches the month module");
  }

  // ── 4. Another type, another person, a non-day line: untouched ───────────
  {
    const other = [
      draft({ category: "crm" }),
      draft({ employeeHrId: "OF-0007" }),
      draft({ unit: "amount" }),
    ];
    const { kept, notes } = spareAcceptedDailyDisputeDays(other, spared);
    assert.deepEqual(kept, other, "the dispute argued with ONE finding of ONE person — nothing else moves");
    assert.equal(notes.length, 0);
  }

  // ── 5. A line that cannot be narrowed exactly is KEPT and named ──────────
  {
    const vacation = draft({ category: "fingerprint", dates: ["2026-11-02", "2026-11-03", "2026-11-04"], rawValue: 2 });
    const { kept, notes } = spareAcceptedDailyDisputeDays([vacation], spared);
    assert.deepEqual(kept, [vacation], "never re-priced by a guess: a line charging 2 days over 3 dates is kept as it is");
    assert.match(notes[0] ?? "", /cannot be removed exactly/, "…and the Super Admin is told to narrow it by hand");
  }

  // ── 6. A CRM Thursday keeps its half-day weight when a Monday is won ─────
  {
    const crmSpared = sparedDaysFromDisputes([
      { category: "crm", dates: ["2026-10-19"], employee_hr_id_compact: "PD0013", status: "accepted" },
    ]);
    const crm = draft({
      category: "crm",
      dates: ["2026-10-19", "2026-10-22"],
      employeeHrId: "PD-0013",
      estimatedAmount: 725.81,
      rawValue: 2,
    });
    const { kept } = spareAcceptedDailyDisputeDays([crm], crmSpared);
    assert.deepEqual(kept[0]!.dates, ["2026-10-22"]);
    assert.equal(kept[0]!.estimatedAmount, 241.94, "the kept Thursday is priced by its weight (half a day), never by the count");
  }

  // ── 7. Every collection door applies it, and the daily tally too ────────
  {
    const collect = stripComments(readFileSync("src/lib/deductions/collect.ts", "utf8"));
    assert.equal(
      collect.match(/await applyAcceptedDailyDisputes\(crossCycle\.drafts\)/g)?.length,
      2,
      "both month-end doors — the calendar month and the Head Office cycle — must drop the won days before writing",
    );
    const service = stripComments(readFileSync("src/lib/daily-deductions/service.ts", "utf8"));
    assert.match(service, /const spared = await loadSparedDailyDays\(\);/, "the daily tally must not raise a won day again");
    assert.match(service, /spareAcceptedDailyDisputeDays\(dropDeductionExemptDrafts\(drafts\)\.kept, spared\)/);
  }

  // ── 8. Who reads, who decides ───────────────────────────────────────────
  {
    const owner = resolveParticipant({ kind: "daily", ownerHrId: "OF0006", role: "Office Coordinator", viewerHrId: "OF-0006" });
    assert.equal(owner.isOwner, true, "the employee is matched on the compact hr id");
    assert.equal(owner.isReviewer, false);
    const admin = resolveParticipant({ kind: "daily", ownerHrId: "OF-0006", role: "Super Admin", viewerHrId: "B-10" });
    assert.equal(admin.isReviewer, true, "the Super Admin — who alone releases a daily line — decides its dispute");
    const ceo = resolveParticipant({ kind: "daily", ownerHrId: "OF-0006", role: "CEO", viewerHrId: "B-1" });
    assert.equal(ceo.canRead, true, "the Deductions module's readers read the case");
    assert.equal(ceo.isReviewer, false, "…and cannot decide it");
    const colleague = resolveParticipant({ kind: "daily", ownerHrId: "OF-0006", role: "District Manager", viewerHrId: "B-55" });
    assert.equal(colleague.canRead, false, "a colleague's deduction dispute is not theirs to read");
  }

  // ── 9. The page shows the box, and the decision has no Reduce ───────────
  {
    const section = stripComments(readFileSync("src/components/employee-portal/daily-deductions-section.tsx", "utf8"));
    assert.match(
      section,
      /<DailyDeductionDisputeBox dispute=\{disputes\[line\.id\] \?\? null\} lineId=\{line\.id\} \/>/,
      "every released daily line carries its own Dispute box",
    );
    const panel = stripComments(readFileSync("src/components/disputes/dispute-decision-panel.tsx", "utf8"));
    const daily = panel.slice(panel.indexOf('dispute.kind === "daily"'), panel.indexOf('dispute.kind === "digest"'));
    assert.match(daily, /value: "accept"/);
    assert.match(daily, /value: "reject"/);
    assert.doesNotMatch(daily, /reduce/, "a released daily line is withdrawn whole or it stands");
  }

  // ── 9b. An accepted dispute verifies its days on the calendar ───────────
  {
    const rows = [
      { category: "crm", dates: ["2026-11-03", "2026-11-30"], decision_note: "Visit found", employee_hr_id: "OF-0006", employee_name: "Test Employee", id: "d1", status: "accepted" },
      { category: "crm", dates: ["2026-11-04"], decision_note: null, employee_hr_id: "OF-0006", employee_name: "Test Employee", id: "d2", status: "open" },
      { category: "crm", dates: ["2026-11-05"], decision_note: null, employee_hr_id: "OF-0006", employee_name: "Test Employee", id: "d3", status: "rejected" },
      { category: "crm", dates: ["2026-11-06"], decision_note: null, employee_hr_id: "OF-0007", employee_name: "Someone Else", id: "d4", status: "accepted" },
    ];
    const corrections = selectAcceptedDailyDisputeCorrections({
      categoryLabel: () => "CRM",
      rows,
      scopeHrIds: ["OF0006"],
      window: { end: "2026-11-15", start: "2026-11-01" },
    });
    assert.deepEqual(
      corrections.map((item) => item.disputeDate),
      ["2026-11-03"],
      "only an ACCEPTED dispute's days, in the window, for the person in scope, show verified",
    );
    assert.equal(corrections[0]!.origin, "deduction_dispute");
    assert.equal(corrections[0]!.adminDecisionNote, "Visit found");
  }

  // ── 10. The migration: one dispute per line, and the shared tables know the kind ─
  {
    const migration = readFileSync("supabase/migrations/20261113181500_daily_deductions_disputes.sql", "utf8");
    assert.match(migration, /create unique index if not exists daily_deductions_disputes_line_uidx on public\.daily_deductions_disputes \(line_id\);/);
    for (const table of ["dispute_case_events", "dispute_attachments", "dispute_assist_entries"]) {
      assert.match(
        migration,
        new RegExp(`alter table public\\.${table} add constraint ${table}_kind_check[\\s\\S]{0,200}?'daily'::text`),
        `${table} must accept the daily kind, or the first decision fails`,
      );
    }
  }
}
