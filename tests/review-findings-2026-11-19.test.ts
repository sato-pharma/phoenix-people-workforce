import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { withoutPasswordHash } from "../src/lib/admin/access-control.ts";
import { bulkDecideApprovals, orderLeaveIdsByStart, type BulkDecisionDeps } from "../src/lib/approvals-hub/bulk-decide.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";
import { foldPhoenixWorkEvidence } from "../src/lib/crm/phoenix-work-evidence.ts";
import { selectNoRecordsDrafts, type NoRecordsDay } from "../src/lib/daily-deductions/no-records-select.ts";
import { compactDeductionsHrId } from "../src/lib/deductions/candidate-key.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";
import { dedupeRecipientsByPerson } from "../src/lib/notifications/role-recipients.ts";
import { withoutPendingMailboxes } from "../src/lib/offers/new-joiner-announcement.ts";
import {
  interviewHalfDaysFromAttendances,
  interviewProofRefusal,
  mapInterviewToPrivateCalendarItem,
} from "../src/lib/private-calendar/interview-items.ts";
import type { PrivateCalendarInterviewRow } from "../src/lib/recruitment/interview-calendar.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The fixes from the 19 Nov 2026 review of the last 50 merged pull requests. A rule a pure function
 * holds is pinned by calling it; a rule that sits inside a database read is pinned by reading the
 * source, the way the rest of this suite does. Each RED line is the one that fails if its fix is undone.
 */

const ROOT = process.cwd();
const REPORT_MIGRATION = "supabase/migrations/20261119023448_phoenix_crm_report_credits_every_companion.sql";
const SCRUB_MIGRATION = "supabase/migrations/20261119023449_scrub_password_hash_from_audit_old_values.sql";

function raw(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
}

function code(file: string): string {
  return stripComments(raw(file));
}

function interviewRow(overrides: Partial<PrivateCalendarInterviewRow> = {}): PrivateCalendarInterviewRow {
  return {
    area: null,
    candidateName: "Test Candidate",
    durationMinutes: 30,
    id: "iv-1",
    jobTitle: "Medical Representative",
    leadDeclined: false,
    leadHrId: "DM-0007",
    line: null,
    panelHrIds: [],
    platform: "zoom",
    // 09:00 in Cairo on a Wednesday: a morning interview.
    startsAt: "2026-11-04T07:00:00.000Z",
    ...overrides,
  };
}

async function leaveIsDecidedEarliestStartFirst(): Promise<void> {
  assert.deepEqual(
    orderLeaveIdsByStart(
      ["dec", "nov", "unknown", "nov-2"],
      new Map<string, string | null>([
        ["dec", "2026-12-07"],
        ["nov", "2026-11-23"],
        ["unknown", null],
        ["nov-2", "2026-11-23"],
      ]),
    ),
    ["nov", "nov-2", "dec", "unknown"],
    "earliest start first; the same start keeps the ticked order; an unknown start goes last",
  );

  const calls: string[] = [];
  const deps: BulkDecisionDeps = {
    decideExcuse: async (_access, id) => {
      calls.push(`excuse:${id}`);
    },
    decideLeave: async (_access, id) => {
      calls.push(`leave:${id}`);
    },
    leaveStartDates: async () =>
      new Map<string, string | null>([
        ["dec", "2026-12-07"],
        ["nov", "2026-11-23"],
      ]),
  };
  const access = { hrId: "TEST", role: "Super Admin" } as unknown as AccessContext;
  await bulkDecideApprovals(access, { comment: null, decision: "approve", ids: ["dec", "nov"], module: "leave" }, deps);
  assert.deepEqual(
    calls,
    ["leave:nov", "leave:dec"],
    "RED November is priced against the balance before December can take it, whatever order the cards were ticked in",
  );

  calls.length = 0;
  await bulkDecideApprovals(access, { comment: null, decision: "approve", ids: ["e2", "e1"], module: "excuse" }, deps);
  assert.deepEqual(calls, ["excuse:e2", "excuse:e1"], "an excuse touches no balance and keeps the ticked order");

  calls.length = 0;
  await assert.rejects(
    bulkDecideApprovals(
      access,
      { comment: null, decision: "approve", ids: ["dec", "nov"], module: "leave" },
      {
        ...deps,
        leaveStartDates: async () => {
          throw new Error("the start dates could not be read");
        },
      },
    ),
    /could not be read/,
    "a start date that cannot be read stops the batch",
  );
  assert.deepEqual(calls, [], "before anything is decided");
}

function anInterviewThatDidNotHappenProvesNothing(): void {
  assert.equal(interviewProofRefusal(interviewRow({ outcome: "attended" }), "DM-0007"), null, "an interview that took place can prove a half");
  for (const outcome of ["did_not_come", "will_reschedule", "no_answer", "withdrew"] as const) {
    assert.match(interviewProofRefusal(interviewRow({ outcome }), "DM-0007") ?? "", /did not come/, `RED ${outcome}: no interview took place`);
  }
  assert.match(
    interviewProofRefusal(interviewRow({ bookedLateByHrId: "dm-0007" }), "DM-0007") ?? "",
    /put on the calendar by this person after it had started/,
    "RED nobody proves his own day with an interview he put on the calendar himself after it had started",
  );
  assert.equal(
    interviewProofRefusal(interviewRow({ bookedLateByHrId: "HR-0003" }), "DM-0007"),
    null,
    "HR's back-dated booking for him still counts (owner, 8 Nov 2026: \"don't block anything\")",
  );

  const refused = mapInterviewToPrivateCalendarItem({ hrId: "DM-0007", interview: interviewRow({ outcome: "did_not_come" }), isLead: true });
  assert.equal("interviewHalf" in refused, false, "a no-show stays on the calendar but covers no half");
  assert.match(String(refused.approvalImpact ?? ""), /did not come/, "and the calendar says why");
  const counted = mapInterviewToPrivateCalendarItem({ hrId: "DM-0007", interview: interviewRow(), isLead: true });
  assert.equal(counted.interviewHalf, "AM", "an interview that took place still carries its half");

  const second = interviewRow({ id: "iv-2", startsAt: "2026-11-04T08:00:00.000Z" });
  assert.equal(
    interviewHalfDaysFromAttendances([
      { hrId: "DM-0007", interview: interviewRow(), isLead: true },
      { hrId: "DM-0007", interview: second, isLead: true },
    ]).length,
    1,
    "two morning interviews that took place are the morning worked",
  );
  assert.deepEqual(
    interviewHalfDaysFromAttendances([
      { hrId: "DM-0007", interview: interviewRow(), isLead: true },
      { hrId: "DM-0007", interview: { ...second, outcome: "no_answer" }, isLead: true },
    ]),
    [],
    "RED with one of the two a no-show, one interview took place, and one is not a half day",
  );

  const calendar = code("src/lib/recruitment/interview-calendar.ts");
  assert.ok(
    calendar.includes("bookedLateByHrId: Date.parse(row.created_at) > Date.parse(row.starts_at) ? (row.created_by_hr_id ?? null) : null"),
    "a booking made after the interview started names who made it",
  );
}

function aMailboxStillWaitingIsNeverMailed(): void {
  const audience = [{ hrId: "B-10" }, { hrId: "PD-0042" }, { hrId: "HR-0003" }];
  assert.deepEqual(
    withoutPendingMailboxes(audience, new Set([canonicalHrIdKey("pd-0042") ?? ""])).map((row) => row.hrId),
    ["B-10", "HR-0003"],
    "RED a person whose company mailbox is still waiting to be created is left out: the address hard-bounces and the block stops every later email",
  );
  const copy = withoutPendingMailboxes(audience, new Set());
  assert.deepEqual(copy, audience, "nobody waiting leaves the audience as it is");
  assert.notEqual(copy, audience, "as a copy");

  const announcer = code("src/lib/offers/new-joiner-announcement.ts");
  assert.ok(announcer.includes("withoutPendingMailboxes(audience, pendingMailboxes)"), "the welcome's recipients are built from the audience without those mailboxes");
  assert.ok(announcer.includes('.eq("status", "pending")'), "only a task still pending holds an address back");
}

function theAuditCopyKeepsNoPasswordHash(): void {
  assert.deepEqual(
    withoutPasswordHash({ full_name: "Test Person", password_hash: "$2b$12$abcdefghijklmnopqrstuv" }),
    { full_name: "Test Person", password_hash: "[managed]" },
    "RED the audit keeps only that a hash existed, never the hash",
  );
  assert.deepEqual(withoutPasswordHash({ password_hash: "" }), { password_hash: null }, "no hash reads as none");
  const plain = { full_name: "Test Person" };
  assert.equal(withoutPasswordHash(plain), plain, "a row without the key passes untouched");
  assert.equal(withoutPasswordHash(null), null);
  assert.equal(withoutPasswordHash(undefined), undefined);
  assert.ok(code("src/lib/admin/access-control.ts").includes("oldValues: withoutPasswordHash(input.oldValues)"), "every account edit's audit copy goes through it");

  const scrub = raw(SCRUB_MIGRATION);
  assert.ok(
    scrub.includes("set old_values = jsonb_set(old_values, '{password_hash}', to_jsonb('[managed]'::text))"),
    "the copies already written are replaced by the same placeholder",
  );
  assert.ok(scrub.includes("raise exception"), "and the scrub proves itself inside its own transaction");
}

function everyCompanionIsCreditedOnce(): void {
  const days = foldPhoenixWorkEvidence({
    activities: [],
    starts: [],
    visits: [
      {
        visit_date: "2026-11-17",
        rep_hr_id: "MR-0101",
        manager_hr_id: "DM-0007",
        senior_hr_id: "RM-0002",
        product_manager_hr_id: null,
        companions: [{ hr_id: "DM-0007" }, { hr_id: "rm-0002" }, { hr_id: "NSM-0001" }, { hr_id: null }],
      },
    ],
  });
  assert.deepEqual(
    days.map((day) => `${day.hrId}:${day.visits}`).sort(),
    ["DM-0007:1", "MR-0101:1", "NSM-0001:1", "RM-0002:1"],
    "RED the chain's manager above the district and regional managers is credited, and nobody twice",
  );
  assert.ok(code("src/lib/crm/phoenix-work-evidence.ts").includes("companions:phoenix_crm_visit_companions(hr_id)"), "the work-evidence loader reads the companions with each visit");

  const dayMaps = code("src/lib/attendance/crm-day-maps.ts");
  assert.ok(dayMaps.includes("...(visit.companion_hr_ids ?? [])"), "RED the attendance day map credits a companion who stands in neither partner slot");
  assert.ok(dayMaps.includes("double2_hr_id,companion_hr_ids"), "and its read selects them");
  assert.ok(code("src/lib/crm/visit-workload.ts").includes("participantHrIds: [hrId],"), "the trip workload always asks by hr id, the half that searches the companions");
  const trip = code("src/lib/outstation/crm-trip-evidence-reader.ts");
  assert.ok(trip.includes('read("product_manager_hr_id")'), "the trip evidence reads the visits he joined as the product manager");
  assert.ok(
    trip.includes("companion:phoenix_crm_visit_companions!inner(hr_id)") && trip.includes('.eq("companion.hr_id", hrId)'),
    "and every visit he joined as a companion",
  );
  assert.ok(
    code("src/lib/phoenix-crm/server/manager-visit-details.ts").includes("const wentWith = stored.length > 0 ? stored : planned.map((person) => person.hrId);"),
    "RED who he ticked under Who went with you is who went; the half-day's plan is only the fallback",
  );

  const report = raw(REPORT_MIGRATION);
  assert.ok(
    report.includes("join public.phoenix_crm_visit_companions vc on vc.hr_id = pe.hr_id and vc.visit_id is not null"),
    "RED the manager-visits report reads every companion",
  );
  for (const column of ["manager_hr_id", "senior_hr_id", "product_manager_hr_id"]) {
    assert.ok(report.includes(`and vc.hr_id is distinct from upper(btrim(v.${column}))`), `someone already counted as ${column} is not counted twice`);
  }
  assert.ok(
    report.includes("(case when vc.side = 'product' then 'product_manager' else 'senior' end)::text"),
    "a product-side companion counts as a product manager, a manager-side one where a senior does",
  );
  assert.ok(
    report.includes("revoke execute on function public.phoenix_crm_report_manager_visits(text[], date, date, boolean) from public, anon, authenticated;"),
    "and the report stays the server's alone",
  );
  const latest = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter((file) => file.endsWith(".sql") && file >= "20261031160000")
    .sort()
    .filter((file) => raw(`supabase/migrations/${file}`).includes("function public.phoenix_crm_report_manager_visits("))
    .pop();
  assert.equal(latest, path.basename(REPORT_MIGRATION), "no later migration redefines the report without the companions");
}

function anInterviewOnlyDayIsChargedItsOtherHalf(): void {
  const hrId = "AC-0201";
  const compact = compactDeductionsHrId(hrId) ?? "";
  const key = `${compact}:2026-10-14`;
  const base = {
    baseSalaryByCompact: new Map<string, number | null>([[compact, 3100]]),
    jobTitleByCanonicalKey: new Map<string, string | null>([[canonicalHrIdKey(hrId) ?? "", "Accountant"]]),
    month: 10,
    outageDates: new Set<string>(),
    provenWorkedDayKeys: new Set([key]),
    year: 2026,
  };
  const day: NoRecordsDay = {
    coveredOnlyByInterviews: true,
    date: "2026-10-14",
    description: "No Activity Recorded",
    employeeHrId: hrId,
    employeeName: "Test Person",
  };
  const drafts = selectNoRecordsDrafts({ ...base, days: [day], interviewHalfOnly: new Map([[key, "AM" as const]]) });
  assert.equal(drafts.length, 1, "RED a day only one half of which his interviews cover is charged");
  assert.equal(drafts[0].rawValue, 0.5, "at its other half");
  assert.equal(drafts[0].estimatedAmount, 50, "half a day's pay: 3,100 / 31 days / 2");
  assert.match(String(drafts[0].reason ?? ""), /Interviews in the morning only — nothing recorded for the afternoon/, "and the line says which half was worked");
  assert.deepEqual(selectNoRecordsDrafts({ ...base, days: [day] }), [], "unless the interview fold agrees exactly one half is covered, nothing is charged");
  assert.deepEqual(
    selectNoRecordsDrafts({ ...base, days: [{ ...day, coveredOnlyByInterviews: undefined }] }),
    [],
    "a day another source proves is still never charged",
  );

  const halfDay = code("src/lib/deductions/connectors/half-day.ts");
  const readAt = halfDay.indexOf("const interviewHalf = provenWorked.interviewHalfOnly.get(key);");
  const gateAt = halfDay.indexOf("if (day < firstSignal && !interviewHalf) continue;");
  assert.ok(readAt > 0 && gateAt > readAt, "RED the Half Day tab reads the interview half before the first-record gate, which lets it through");
  assert.ok(!halfDay.includes("if (day < firstSignal) continue;"), "a day before his first record is no longer skipped when only interviews cover one half");
  assert.ok(halfDay.includes("if (!firstSignal) continue;"), "a month with no CRM record at all is still never judged");
  const service = code("src/lib/private-calendar/service.ts");
  assert.ok(service.includes('items.filter((item) => item.source !== "interview")'), "the No Activity pass is run again with the interviews taken out");
  assert.ok(service.includes("coveredOnlyByInterviews: true"), "and the days only they cover are marked");
  const noRecords = code("src/lib/daily-deductions/no-records.ts");
  assert.ok(
    noRecords.includes("interviewHalfDays: true") && noRecords.includes("interviewHalfOnly: provenWorked.interviewHalfOnly"),
    "the No Records tab asks for those days and hands over the interview fold",
  );
}

function theNewErrorAlertGoesOnlyWhereATelegramReaches(): void {
  const [person] = dedupeRecipientsByPerson([{ hasEmail: true, hasPush: false, hasTelegram: false, hrId: "B-10", userId: "B-10" }]);
  assert.equal(person?.hasTelegram, false, "the chosen account says whether a Telegram can reach the person");
  const alert = code("src/lib/error-monitor/new-error-alert.ts");
  assert.ok(alert.includes("recipients.filter((recipient) => recipient.hasTelegram !== false)"), "RED only the people a Telegram can reach are sent the alert");
  assert.ok(alert.includes("if (warnings.length > 0) seen.delete(signature);"), "a failed recipient read forgets the error, so its next occurrence retries");
  const system = code("src/lib/notifications/system.ts");
  assert.ok(system.includes("await releaseDeliveryClaim(eventId, idempotencyKey);"), "a Telegram link read that failed gives its claim back");
  assert.ok(system.includes('.delete().eq("idempotency_key", idempotencyKey).eq("status", "pending")'), "only a bare pending claim, never a recorded outcome");

  const milestones = code("src/components/milestones/milestones-workspace.tsx");
  assert.ok(
    !milestones.includes("fetch(upload.dataUri)") && milestones.includes("dataUrlToBlob(upload.dataUri)"),
    "RED a record photo is decoded in place: the page's security policy refuses a fetch of a data: address",
  );
}

export async function runReviewFindings20261119Tests(): Promise<void> {
  await leaveIsDecidedEarliestStartFirst();
  anInterviewThatDidNotHappenProvesNothing();
  aMailboxStillWaitingIsNeverMailed();
  theAuditCopyKeepsNoPasswordHash();
  everyCompanionIsCreditedOnce();
  anInterviewOnlyDayIsChargedItsOtherHalf();
  theNewErrorAlertGoesOnlyWhereATelegramReaches();
}
