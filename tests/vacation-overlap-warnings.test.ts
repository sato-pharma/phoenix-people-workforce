import assert from "node:assert/strict";

import { buildVacationOverlapWarnings } from "../src/lib/vacation/service.ts";
import type { VacationRequestRecord } from "../src/lib/vacation/types.ts";

function baseRequest(overrides: Partial<VacationRequestRecord> & Pick<VacationRequestRecord, "id" | "employeeHrId" | "startDate" | "endDate">): VacationRequestRecord {
  return {
    balanceAfterDays: 10,
    balanceBeforeDays: 15,
    entitlementDays: 21,
    paymentStatus: "paid",
    paidDurationDays: 3,
    periodEnd: null,
    periodStart: null,
    unpaidReason: null,
    unpaidDurationDays: 0,
    usedPaidDays: 5,
    canDecide: false,
    createdAt: "2026-01-01T00:00:00Z",
    dayPart: "full_day",
    departmentName: null,
    durationDays: 3,
    employeeHireDate: null,
    employeeName: "Test Employee",
    employeeWorkEmail: null,
    compensatoryAttachmentBucket: null,
    compensatoryAttachmentContentType: null,
    compensatoryAttachmentObjectPath: null,
    compensatoryAttachmentOriginalName: null,
    compensatoryAttachmentSizeBytes: 0,
    compensatoryAttachmentUploadedAt: null,
    compensatoryEventDate: null,
    compensatoryEventLocation: null,
    compensatoryEventName: null,
    compensatoryManager1: null,
    compensatoryManager2: null,
    sickAttachmentBucket: null,
    sickAttachmentContentType: null,
    sickAttachmentObjectPath: null,
    sickAttachmentOriginalName: null,
    sickAttachmentSizeBytes: 0,
    sickAttachmentUploadedAt: null,
    lineName: null,
    hrDecision: null,
    hrDecisionAt: null,
    hrDecisionByHrId: null,
    hrDecisionComment: null,
    managerDecision: null,
    managerDecisionAt: null,
    managerDecisionByHrId: null,
    managerDecisionComment: null,
    managerHrId: null,
    managerName: null,
    managerOfManagerHrId: null,
    managerOfManagerName: null,
    employeeNote: null,
    notes: null,
    status: "pending_manager",
    submittedByHrId: null,
    vacationType: "annual",
    evidenceReviews: [],
    overlapWarnings: [],
    slaStatus: {
      businessDaysPending: 0,
      dueAt: null,
      isOverdue: false,
      lastEscalatedAt: null,
      lastRemindedAt: null,
      stage: "manager",
    },
    timelineEventCount: 0,
    weeklyOffPolicySnapshot: null,
    ...overrides,
  };
}

function codesFor(warnings: ReturnType<typeof buildVacationOverlapWarnings>, id: string) {
  return (warnings.get(id) ?? []).map((w) => w.code).sort();
}

export function runVacationOverlapWarningsTests() {
  // Same employee, overlapping dates -> employee_overlap on both, referencing each other.
  {
    const a = baseRequest({ id: "a", employeeHrId: "B-1", managerHrId: "B-9", startDate: "2026-07-10", endDate: "2026-07-12" });
    const b = baseRequest({ id: "b", employeeHrId: "B-1", managerHrId: "B-9", startDate: "2026-07-11", endDate: "2026-07-13" });
    const warnings = buildVacationOverlapWarnings({ holidays: [], rows: [a, b] });
    assert.deepEqual(codesFor(warnings, "a"), ["employee_overlap"]);
    assert.deepEqual(codesFor(warnings, "b"), ["employee_overlap"]);
    assert.deepEqual(warnings.get("a")![0].relatedRequestIds, ["b"]);
    assert.deepEqual(warnings.get("b")![0].relatedRequestIds, ["a"]);
  }

  // Same employee, NON-overlapping dates -> no employee_overlap.
  {
    const a = baseRequest({ id: "a", employeeHrId: "B-1", startDate: "2026-07-10", endDate: "2026-07-12" });
    const b = baseRequest({ id: "b", employeeHrId: "B-1", startDate: "2026-08-01", endDate: "2026-08-03" });
    const warnings = buildVacationOverlapWarnings({ holidays: [], rows: [a, b] });
    assert.equal(warnings.has("a"), false);
    assert.equal(warnings.has("b"), false);
  }

  // Different employees, same manager, overlapping dates -> team_overlap on both.
  {
    const a = baseRequest({ id: "a", employeeHrId: "B-1", managerHrId: "B-9", startDate: "2026-07-10", endDate: "2026-07-12" });
    const b = baseRequest({ id: "b", employeeHrId: "B-2", managerHrId: "B-9", startDate: "2026-07-11", endDate: "2026-07-13" });
    const warnings = buildVacationOverlapWarnings({ holidays: [], rows: [a, b] });
    assert.deepEqual(codesFor(warnings, "a"), ["team_overlap"]);
    assert.deepEqual(codesFor(warnings, "b"), ["team_overlap"]);
  }

  // Employee's request overlaps their OWN manager's own leave request -> manager_absent.
  {
    const employee = baseRequest({ id: "emp", employeeHrId: "B-1", managerHrId: "B-9", startDate: "2026-07-10", endDate: "2026-07-12" });
    const manager = baseRequest({ id: "mgr", employeeHrId: "B-9", managerHrId: "B-99", startDate: "2026-07-11", endDate: "2026-07-13" });
    const warnings = buildVacationOverlapWarnings({ holidays: [], rows: [employee, manager] });
    assert.deepEqual(codesFor(warnings, "emp"), ["manager_absent"]);
    // The manager's own row has no manager-of-its-own overlapping, and B-99 has no request.
    assert.equal(warnings.has("mgr"), false);
  }

  // A rejected row must never contribute to another row's overlap warnings, and never
  // receives warnings itself (activeRows excludes status === "rejected").
  {
    const a = baseRequest({ id: "a", employeeHrId: "B-1", startDate: "2026-07-10", endDate: "2026-07-12" });
    const rejected = baseRequest({ id: "r", employeeHrId: "B-1", startDate: "2026-07-11", endDate: "2026-07-13", status: "rejected" });
    const warnings = buildVacationOverlapWarnings({ holidays: [], rows: [a, rejected] });
    assert.equal(warnings.has("a"), false);
    assert.equal(warnings.has("r"), false);
  }

  // Sick leave without an accepted evidence review -> evidence_required.
  {
    const sick = baseRequest({ id: "s", employeeHrId: "B-1", startDate: "2026-07-10", endDate: "2026-07-11", vacationType: "sick" });
    const warnings = buildVacationOverlapWarnings({ holidays: [], rows: [sick] });
    assert.deepEqual(codesFor(warnings, "s"), ["evidence_required"]);
  }

  // Sick leave WITH an accepted evidence review -> no evidence_required.
  {
    const sick = baseRequest({
      id: "s2",
      employeeHrId: "B-1",
      startDate: "2026-07-10",
      endDate: "2026-07-11",
      vacationType: "sick",
      evidenceReviews: [
        {
          createdAt: "2026-07-01T00:00:00Z",
          evidenceType: "sick",
          id: "ev-1",
          requestId: "s2",
          reviewNote: null,
          reviewedAt: "2026-07-02T00:00:00Z",
          reviewedByHrId: "HR-1",
          status: "accepted",
          updatedAt: "2026-07-02T00:00:00Z",
        },
      ],
    });
    const warnings = buildVacationOverlapWarnings({ holidays: [], rows: [sick] });
    assert.equal(warnings.has("s2"), false);
  }

  // A request adjacent to a national holiday -> holiday_adjacent.
  {
    const row = baseRequest({ id: "h", employeeHrId: "B-1", startDate: "2026-07-10", endDate: "2026-07-13" });
    const warnings = buildVacationOverlapWarnings({
      holidays: [{
        description: null,
        durationDays: 1,
        endDate: null,
        id: "holiday-1",
        name: "Test Holiday",
        source: "company",
        startDate: "2026-07-14",
      }],
      rows: [row],
    });
    assert.deepEqual(codesFor(warnings, "h"), ["holiday_adjacent"]);
  }

  // A row can accumulate MULTIPLE distinct warning codes at once (e.g. sick + no
  // evidence, overlapping with a teammate under the same manager).
  {
    const a = baseRequest({
      id: "a",
      employeeHrId: "B-1",
      managerHrId: "B-9",
      startDate: "2026-07-10",
      endDate: "2026-07-12",
      vacationType: "sick",
    });
    const b = baseRequest({ id: "b", employeeHrId: "B-2", managerHrId: "B-9", startDate: "2026-07-11", endDate: "2026-07-13" });
    const warnings = buildVacationOverlapWarnings({ holidays: [], rows: [a, b] });
    assert.deepEqual(codesFor(warnings, "a"), ["evidence_required", "team_overlap"]);
  }

  // Many employees under many different managers, with only ONE genuine overlapping
  // pair — exercises the Map-bucketing path with a larger, mostly-unrelated row set
  // (the case the O(n) rewrite specifically targets) and confirms unrelated rows never
  // leak into each other's warnings.
  {
    const rows: VacationRequestRecord[] = [];
    for (let i = 0; i < 30; i += 1) {
      rows.push(
        baseRequest({
          id: `bulk-${i}`,
          employeeHrId: `B-${100 + i}`,
          managerHrId: `M-${i}`, // unique manager per row — no legitimate team_overlap among these
          startDate: "2026-09-01",
          endDate: "2026-09-02",
        }),
      );
    }
    const overlapA = baseRequest({ id: "overlap-a", employeeHrId: "B-1", managerHrId: "B-9", startDate: "2026-07-10", endDate: "2026-07-12" });
    const overlapB = baseRequest({ id: "overlap-b", employeeHrId: "B-1", managerHrId: "B-9", startDate: "2026-07-11", endDate: "2026-07-13" });
    const warnings = buildVacationOverlapWarnings({ holidays: [], rows: [...rows, overlapA, overlapB] });
    for (const row of rows) {
      assert.equal(warnings.has(row.id), false, `unrelated bulk row ${row.id} must have no warnings`);
    }
    assert.deepEqual(codesFor(warnings, "overlap-a"), ["employee_overlap"]);
    assert.deepEqual(codesFor(warnings, "overlap-b"), ["employee_overlap"]);
  }
}
