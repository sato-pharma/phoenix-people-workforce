import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext } from "@/lib/auth/permissions";
import {
  isReportItOverdue,
  nextReportItStatus,
  normalizeReportItStatus,
  REPORT_IT_DUE_DAYS,
  REPORT_IT_TRANSITIONS,
  reportItDueAt,
  reportItTransitionRefusal,
} from "@/lib/report-it/lifecycle";
import {
  buildNewReportEmail,
  deliverNewReportNotices,
  newReportEmailContent,
  newReportEmailKey,
  notifyOwnersOfNewReport,
  readReportItOwners,
  REPORT_IT_DESK_PATH,
  type NewReportNoticeFacts,
  type ReportItNoticeDeps,
  type ReportItOwnerReadClient,
} from "@/lib/report-it/notify";
import { changeReportStatus, type ReportStatusChangeDeps } from "@/lib/report-it/service";
import { REPORT_IT_STATUSES, reportItStatusLabel } from "@/lib/report-it/types";

import { noticePinsMissing } from "./notices-after-the-reply.test.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * REPORT IT — A SAFETY REPORT GETS A LIFECYCLE AND AN OWNER (audit REC-033, owner 13 Nov 2026).
 *
 * The owner of a new report is whoever holds `report_it_dashboard_access` (the QPPV today), read from
 * that table — never a hard-coded person. She is told by an in-app notice and an email, after the
 * reply, and NEITHER carries any patient data. A report moves received → under assessment → closed,
 * one step at a time, only by someone who reads every report, and every move writes its audit row in
 * the same transaction. Nothing here touches a database or sends anything: every database and
 * delivery half is a fake.
 */

const MIGRATION = "supabase/migrations/20261113202407_report_it_lifecycle.sql";

function code(path: string): string {
  return stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
}

/** A fake client for the owner read: each table answers its rows; every table read is recorded. */
function fakeOwnerClient(tables: Record<string, unknown[] | Error>, reads: string[]): ReportItOwnerReadClient {
  const answer = (table: string) => {
    const rows = tables[table];
    if (rows instanceof Error) return { data: null, error: { message: rows.message } };
    return { data: rows ?? [], error: null };
  };
  return {
    from(table: string) {
      reads.push(table);
      return {
        select() {
          const result = answer(table);
          return Object.assign(Promise.resolve(result), { in: async () => result });
        },
      };
    },
  };
}

/** A fixture report: the three facts a notice may carry, wrapped in distinctive patient data. */
const PATIENT_VALUES = [
  "ZQXW",
  "Purple-spotted tongue swelling",
  "Fictozapine 40 mg",
  "Glorbular rash outcome",
  "Congenital anomaly/birth defect",
  "Zanthoid disorder",
  "Yolanda Quixote-Brambleworth",
  "Wilberforce Reporterson",
  "Oral",
  "Batch QK-99812",
];

function fixtureReport(): NewReportNoticeFacts {
  const report = {
    reportId: "11111111-2222-4333-8444-555555555555",
    reportNumber: "RPT-2026-00042",
    submittedAt: "2026-11-13T08:30:00.000Z",
    // Everything below is patient or reporter data that must never reach a notice.
    is_serious: true,
    outcome_summary: "Glorbular rash outcome",
    patient_initials: "ZQXW",
    patient_sex: "Female",
    reactions_summary: ["Purple-spotted tongue swelling"],
    submitted_by_name: "Wilberforce Reporterson",
    suspected_medicines: ["Fictozapine 40 mg"],
    report_payload: {
      additionalComments: "Patient is Yolanda Quixote-Brambleworth",
      currentIllnesses: "Zanthoid disorder",
      medicines: [{ adminRoute: "Oral", batchNumber: "Batch QK-99812", name: "Fictozapine 40 mg" }],
      reactions: [{ isSerious: "Yes", seriousnessReasons: ["Congenital anomaly/birth defect"], symptom: "Purple-spotted tongue swelling" }],
    },
  };
  return report;
}

type Captured = {
  emails: Array<Parameters<ReportItNoticeDeps["sendEmail"]>>;
  inApp: Array<Parameters<ReportItNoticeDeps["notifyInApp"]>>;
};

function captureDeps(overrides: Partial<ReportItNoticeDeps> = {}): { captured: Captured; deps: ReportItNoticeDeps } {
  const captured: Captured = { emails: [], inApp: [] };
  const deps: ReportItNoticeDeps = {
    notifyInApp: async (...args) => {
      captured.inApp.push(args);
    },
    readOwners: async () => [{ email: "owner.person@example.test", hrId: "QA-77", name: "Owner Person" }],
    sendEmail: async (...args) => {
      captured.emails.push(args);
      return { id: "fake" };
    },
    ...overrides,
  };
  return { captured, deps };
}

function access(overrides: Partial<AccessContext> = {}): AccessContext {
  return { hrId: "qa-77", role: "Employee", scope: "self", source: "session", ...overrides } as unknown as AccessContext;
}

export async function runReportItLifecycleTests() {
  // ── 1. The owner is whoever holds dashboard access — read from the table ──────────────────────
  {
    const reads: string[] = [];
    const owners = await readReportItOwners(
      fakeOwnerClient(
        {
          employees: [
            { employment_status: "active", full_name: "Owner Person", hr_id: "QA-77", work_email: "owner.person@example.test" },
            { employment_status: "terminated", full_name: "Former Owner", hr_id: "ZZ-9", work_email: "former@example.test" },
            { employment_status: "active", full_name: "Not On The List", hr_id: "XX-1", work_email: "other@example.test" },
          ],
          report_it_dashboard_access: [{ hr_id: "qa-77" }, { hr_id: "zz-9" }],
        },
        reads,
      ),
    );
    assert.deepEqual(reads, ["report_it_dashboard_access", "employees"], "the owner is read from the access table, then the employee record");
    assert.deepEqual(
      owners,
      [{ email: "owner.person@example.test", hrId: "QA-77", name: "Owner Person" }],
      "only a current employee ON THE ACCESS LIST owns a report — a mixed-case id still matches",
    );

    const emptyReads: string[] = [];
    assert.deepEqual(
      await readReportItOwners(fakeOwnerClient({ report_it_dashboard_access: [] }, emptyReads)),
      [],
      "an empty access list owns nothing",
    );
    assert.deepEqual(emptyReads, ["report_it_dashboard_access"], "no employee read when nobody holds access");
    await assert.rejects(
      readReportItOwners(fakeOwnerClient({ report_it_dashboard_access: new Error("down") }, [])),
      /Failed to read the report owners/,
      "a failed access read is an error, never an empty owner list",
    );

    const notify = code("src/lib/report-it/notify.ts");
    assert.doesNotMatch(notify, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/, "no email address is hard-coded in the notice code");
    assert.doesNotMatch(notify, /["'`][A-Za-z]{1,6}-\d{1,5}["'`]/, "no HR id is hard-coded in the notice code");
    assert.match(notify, /from\("report_it_dashboard_access"\)/, "the owners come from report_it_dashboard_access");
  }

  // ── 2. The notice and the email reach the owner only, and carry no patient data ───────────────
  {
    const facts = fixtureReport();
    const { captured, deps } = captureDeps();
    await deliverNewReportNotices(facts, deps);

    assert.equal(captured.inApp.length, 1, "one in-app notice call");
    const [notice, recipients] = captured.inApp[0];
    assert.deepEqual(recipients, ["QA-77"], "the in-app notice goes to the owner and nobody else");
    assert.deepEqual(notice.channels, ["in_app"], "the notice is in-app only — the email is its own durable send");
    assert.equal(notice.actionUrl, REPORT_IT_DESK_PATH, "the notice opens the Report It desk");

    assert.equal(captured.emails.length, 1, "one email per owner");
    const [message, options] = captured.emails[0];
    assert.equal(message.sender, "phoenix", "a plain Phoenix email, not a policy template that could add recipients");
    const email = message.sender === "phoenix" ? message.input : null;
    assert.ok(email);
    assert.deepEqual(email.to, ["owner.person@example.test"], "the email goes to the owner and nobody else");
    assert.equal(email.cc, undefined, "no copy to anyone");
    assert.equal(email.bcc, undefined, "no blind copy to anyone");
    assert.equal(options.dedupeKey, newReportEmailKey(facts.reportId, "QA-77"), "a stable dedupe key per report and owner");
    assert.equal(options.dedupeKey, "report_it:new_report:11111111-2222-4333-8444-555555555555:qa-77");
    assert.equal(email.idempotencyKey, options.dedupeKey);
    assert.equal(email.origin?.recipientHrId, "QA-77", "the Recipient Assurance Guard checks the address against the owner");

    const outputs: Array<[string, string]> = [
      ["email subject", email.subject],
      ["email body (html)", email.html],
      ["email body (text)", email.text],
      ["in-app title", notice.title],
      ["in-app message", notice.message],
      ["in-app metadata", JSON.stringify(notice.metadata ?? {})],
    ];
    for (const [where, text] of outputs) {
      for (const value of PATIENT_VALUES) {
        assert.ok(!text.includes(value), `the ${where} carries patient data: "${value}"`);
      }
      assert.doesNotMatch(text, /serious/i, `the ${where} says nothing about seriousness`);
    }
    assert.match(email.subject, /RPT-2026-00042/, "the subject names the reference");
    assert.match(email.text, /RPT-2026-00042/, "the body names the reference");
    assert.match(email.text, /Nov 13, 2026, 10:30 AM \(Cairo time\)/, "the submit time is in Cairo time");
    assert.match(email.text, /\/admin\/report-it/, "the body links to the desk");

    // Everything the layout is handed — body, rows, button, preview — not only what a renderer
    // prints (the suite swaps the real layout for a stub that drops the rows).
    const content = newReportEmailContent({ deskUrl: "https://example.test/admin/report-it", reportNumber: facts.reportNumber, submittedAt: facts.submittedAt });
    const contentText = JSON.stringify(content);
    for (const value of PATIENT_VALUES) assert.ok(!contentText.includes(value), `the email content carries patient data: "${value}"`);
    assert.doesNotMatch(contentText, /serious/i);
    assert.deepEqual(content.metadataRows.map((row) => row.label), ["Reference", "Received"], "the email's facts are the reference and the time, nothing else");
    const built = buildNewReportEmail({ deskUrl: "https://example.test/admin/report-it", reportNumber: "RPT-2026-00042", submittedAt: facts.submittedAt });
    assert.equal(built.subject, "New safety report received: RPT-2026-00042");
  }

  // ── 3. A failure is logged, never thrown to the submitter ─────────────────────────────────────
  {
    const facts = fixtureReport();
    const noEmail = captureDeps({ readOwners: async () => [{ email: null, hrId: "QA-77", name: "Owner Person" }] });
    await deliverNewReportNotices(facts, noEmail.deps);
    assert.equal(noEmail.captured.inApp.length, 1, "an owner with no email still gets the in-app notice");
    assert.equal(noEmail.captured.emails.length, 0, "and no email is attempted");

    const noOwner = captureDeps({ readOwners: async () => [] });
    await deliverNewReportNotices(facts, noOwner.deps);
    assert.equal(noOwner.captured.inApp.length + noOwner.captured.emails.length, 0, "no owner → nobody else is told");

    const readFails = captureDeps({ readOwners: async () => { throw new Error("down"); } });
    await deliverNewReportNotices(facts, readFails.deps);
    assert.equal(readFails.captured.inApp.length + readFails.captured.emails.length, 0, "a failed owner read sends nothing");

    const inAppFails = captureDeps({ notifyInApp: async () => { throw new Error("bell down"); } });
    await deliverNewReportNotices(facts, inAppFails.deps);
    assert.equal(inAppFails.captured.emails.length, 1, "a failed in-app notice does not stop the email");

    const emailFails = captureDeps({ sendEmail: async () => { throw new Error("Queued for retry: provider down"); } });
    await deliverNewReportNotices(facts, emailFails.deps);
    assert.equal(emailFails.captured.inApp.length, 1, "a failed email is swallowed after the in-app notice went");
  }

  // ── 4. They fire AFTER the reply ──────────────────────────────────────────────────────────────
  {
    const notifySource = readFileSync("src/lib/report-it/notify.ts", "utf8").replace(/\r\n/g, "\n");
    assert.deepEqual(
      noticePinsMissing(notifySource, [{ fn: "notifyOwnersOfNewReport", wraps: "afterResponse" }]),
      [],
      "notifyOwnersOfNewReport hands the delivery to afterResponse",
    );
    assert.match(
      stripComments(notifySource),
      /return afterResponse\("report_it_notice:new_report", \(\) => deliverNewReportNotices\(facts, deps\)\)/,
      "the whole delivery is the deferred task",
    );
    const submit = code("app/api/report-it/submit/route.ts");
    const savedAt = submit.indexOf("await submitReport(");
    const noticeAt = submit.indexOf("notifyOwnersOfNewReport(");
    const replyAt = submit.indexOf("return NextResponse.json({ reportNumber: result.reportNumber");
    assert.ok(savedAt >= 0 && noticeAt > savedAt && replyAt > noticeAt, "the submit route raises the notice after the report is stored");
    assert.doesNotMatch(submit, /deliverNewReportNotices\(/, "the route never delivers inline");

    // Outside a request scope afterResponse simply awaits — the delivery still happens, once.
    const { captured, deps } = captureDeps();
    await notifyOwnersOfNewReport(fixtureReport(), deps);
    assert.equal(captured.inApp.length, 1);
    assert.equal(captured.emails.length, 1);
  }

  // ── 5. The statuses and the moves ─────────────────────────────────────────────────────────────
  assert.deepEqual([...REPORT_IT_STATUSES], ["received", "under_assessment", "closed"]);
  assert.equal(reportItStatusLabel("submitted"), "Received", "a pre-lifecycle row reads as received");
  assert.equal(reportItStatusLabel("under_assessment"), "Under assessment");
  assert.equal(normalizeReportItStatus("submitted"), "received");
  assert.equal(nextReportItStatus("received"), "under_assessment");
  assert.equal(nextReportItStatus("under_assessment"), "closed");
  assert.equal(nextReportItStatus("closed"), null, "there is no reopen");
  assert.equal(reportItTransitionRefusal("received", "under_assessment"), null);
  assert.equal(reportItTransitionRefusal("under_assessment", "closed"), null);
  assert.equal(reportItTransitionRefusal("submitted", "under_assessment"), null, "an old 'submitted' row can start its assessment");
  for (const [from, to] of [
    ["received", "closed"],
    ["closed", "under_assessment"],
    ["closed", "received"],
    ["under_assessment", "received"],
    ["received", "received"],
    ["received", "bogus"],
    ["bogus", "closed"],
  ]) {
    assert.notEqual(reportItTransitionRefusal(from, to), null, `${from} → ${to} is refused`);
  }
  assert.equal(reportItDueAt("2026-01-01T00:00:00.000Z", true), "2026-01-16T00:00:00.000Z", "a serious report is due in 15 calendar days");
  assert.equal(reportItDueAt("2026-01-01T00:00:00.000Z", false), "2026-04-01T00:00:00.000Z", "any other report in 90");
  assert.equal(isReportItOverdue("2026-01-16T00:00:00.000Z", new Date("2026-01-16T00:00:01.000Z")), true);
  assert.equal(isReportItOverdue("2026-01-16T00:00:00.000Z", new Date("2026-01-15T23:59:59.000Z")), false);
  assert.equal(isReportItOverdue(null), false);

  // ── 6. A status change: refused before any read or write unless the caller reads every report ─
  {
    const id = "11111111-2222-4333-8444-555555555555";
    const calls = { read: 0, set: [] as Array<Parameters<ReportStatusChangeDeps["setStatus"]>[0]> };
    const deps = (canViewAll: boolean, status = "received", setResult: string | null = "RPT-2026-00042"): ReportStatusChangeDeps => ({
      canViewAll: async () => canViewAll,
      readStatus: async () => {
        calls.read += 1;
        return { report_number: "RPT-2026-00042", status };
      },
      setStatus: async (input) => {
        calls.set.push(input);
        return setResult;
      },
    });

    await assert.rejects(
      changeReportStatus(access(), { reportId: id, to: "under_assessment" }, deps(false)),
      /^Error: Forbidden:/,
      "a caller who cannot read every report is refused",
    );
    assert.equal(calls.read, 0, "refused before the report is read");
    assert.equal(calls.set.length, 0, "refused before anything is written");

    const moved = await changeReportStatus(access({ role: "CEO" as AccessContext["role"] }), { reportId: id, to: "under_assessment" }, deps(true));
    assert.deepEqual(moved, { reportNumber: "RPT-2026-00042", status: "under_assessment" });
    assert.equal(calls.set.length, 1);
    assert.deepEqual(
      calls.set[0],
      { actorHrId: "QA-77", from: "received", metadata: { role: "CEO" }, reportId: id, to: "under_assessment" },
      "the move names who made it — that is what the audit row records",
    );

    calls.set.length = 0;
    await assert.rejects(changeReportStatus(access(), { reportId: id, to: "closed" }, deps(true, "received")), /Validation: A report moves one step/);
    await assert.rejects(changeReportStatus(access(), { reportId: id, to: "under_assessment" }, deps(true, "closed")), /Validation: A closed report cannot be changed/);
    await assert.rejects(changeReportStatus(access(), { reportId: id, to: "nonsense" }, deps(true)), /Validation: That is not a report status/);
    assert.equal(calls.set.length, 0, "a refused move writes nothing");
    await assert.rejects(
      changeReportStatus(access(), { reportId: id, to: "under_assessment" }, deps(true, "received", null)),
      /changed by someone else/,
      "a move that lost the race says so instead of claiming success",
    );
    const readsBefore = calls.read;
    await assert.rejects(changeReportStatus(access(), { reportId: "not-a-uuid", to: "closed" }, deps(true)), /Validation: choose a report/);
    assert.equal(calls.read, readsBefore, "a malformed id is refused before any read");

    const service = code("src/lib/report-it/service.ts");
    const body = service.slice(service.indexOf("export async function changeReportStatus"), service.indexOf("export async function getReportKpis"));
    assert.ok(body.indexOf("deps.canViewAll(access)") < body.indexOf("deps.readStatus("), "the gate runs before the read");
    assert.match(service, /rpc\("phx_report_it_set_status"/, "the move and its audit row are one database function");
    const openList = service.slice(service.indexOf("export async function listOpenReports"), service.indexOf("export type ReportStatusChangeDeps"));
    assert.ok(openList.indexOf("canViewAllReports(access)") >= 0 && openList.indexOf("canViewAllReports(access)") < openList.indexOf(".from(\"report_it_reports\")"), "the due-date view is for read-all viewers only, checked before the read");
    assert.match(openList, /logReportRead\(access, \{\s*action: "reports_listed"/, "the due-date view is a logged read");
    assert.doesNotMatch(openList, /patient_|reactions_summary|suspected_medicines|report_payload/, "the due-date view reads no patient field");
    const submitBody = service.slice(service.indexOf("export async function submitReport"), service.indexOf("export async function listReports"));
    assert.match(submitBody, /status: "received"/, "a new report starts received");
    assert.doesNotMatch(submitBody, /due_at/, "the insert names no new column, so filing works whichever of migration and deploy lands first");
  }

  // ── 7. The route: same-origin, signed in, permission, then the service ────────────────────────
  {
    const route = code("app/api/report-it/[id]/status/route.ts");
    const csrf = route.indexOf("assertSameOriginMutation(request)");
    const guest = route.indexOf("reportItSignedOut()");
    const gate = route.indexOf('assertPermission(access, "report_it", "read")');
    const call = route.indexOf("changeReportStatus(");
    assert.ok(csrf >= 0 && guest > csrf && gate > guest && call > gate, "CSRF, then sign-in, then permission, then the change");
  }

  // ── 8. The migration matches the code ─────────────────────────────────────────────────────────
  {
    const sql = stripSqlComments(readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n"));
    const check = sql.match(/add constraint report_it_reports_status_check\s+check \(status in \(([^)]*)\)\)/i);
    assert.ok(check, "the migration adds the status check");
    const allowed = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(allowed, [...REPORT_IT_STATUSES], "the database allows exactly the code's statuses");
    assert.match(sql, /alter column status set default 'received'/, "a new row defaults to received");

    const statusUpdates = [...sql.matchAll(/update public\.report_it_reports\s+set status\s*=\s*'([a-z_]+)'\s+where ([^;]+);/gi)];
    assert.equal(statusUpdates.length, 1, "exactly one status rewrite");
    assert.equal(statusUpdates[0][1], "received");
    assert.match(statusUpdates[0][2].trim(), /^status = 'submitted'$/, "only 'submitted' rows are rewritten — no other value changes");
    assert.match(sql, /raise exception 'report_it_lifecycle: % report\(s\) hold a status other than/, "an unknown status aborts the migration");

    const moves = [...sql.matchAll(/\(p_from = '([a-z_]+)' and p_to = '([a-z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`);
    const codeMoves = Object.entries(REPORT_IT_TRANSITIONS).filter(([, to]) => to).map(([from, to]) => `${from}>${to}`);
    assert.deepEqual(moves.sort(), codeMoves.sort(), "the database function allows exactly the code's moves");

    const dueRule = new RegExp(`interval '${REPORT_IT_DUE_DAYS.serious} days' else interval '${REPORT_IT_DUE_DAYS.nonSerious} days'`, "g");
    assert.equal([...sql.matchAll(dueRule)].length, 2, "the backfill and the insert trigger both use the code's due rule");
    const trigger = sql.slice(sql.indexOf("create or replace function public.report_it_lifecycle_defaults"), sql.indexOf("create trigger report_it_reports_lifecycle_defaults"));
    assert.match(trigger, /if new\.status is null or new\.status = 'submitted' then\s+new\.status := 'received';/, "an old 'submitted' insert becomes received, never refused by the check");
    assert.match(sql, /create trigger report_it_reports_lifecycle_defaults\s+before insert on public\.report_it_reports/, "the defaults run before insert, ahead of the check");

    const fn = sql.slice(sql.indexOf("create or replace function public.phx_report_it_set_status"), sql.indexOf("revoke execute on function public.phx_report_it_set_status"));
    const updateAt = fn.indexOf("update public.report_it_reports");
    const auditAt = fn.indexOf("insert into public.report_it_audit_logs");
    assert.ok(updateAt > 0 && auditAt > updateAt, "the function writes the audit row after the move, in the same transaction");
    assert.match(fn, /'status_changed'/, "the audit row is a status_changed row");
    assert.match(fn, /where id = p_report_id\s+and status = p_from/, "compare-and-set on the status read");
    assert.doesNotMatch(sql, /security definer/i, "the function runs as its caller");
    assert.match(sql, /revoke execute on function public\.phx_report_it_set_status\([^)]*\) from public, anon, authenticated/i);
    assert.match(sql, /grant execute on function public\.phx_report_it_set_status\([^)]*\) to service_role/i);
    assert.doesNotMatch(sql, /references public\.employees/i, "no hr_id column is FK'd to employees");
  }

  // ── 9. The desk view fits the screen and keeps the look ──────────────────────────────────────
  {
    const desk = code("src/components/report-it/report-it-due-desk.tsx");
    assert.match(desk, /table-fixed/, "a fixed-layout table");
    assert.match(desk, /<colgroup>/, "with its column widths declared");
    assert.match(desk, /md:hidden/, "and cards on a phone");
    assert.doesNotMatch(desk, /rounded/, "no round corners");
    assert.doesNotMatch(desk, /overflow-x-auto|min-w-\[|\btruncate\b|text-ellipsis|line-clamp/, "no sideways scroll, no ellipsis");
    assert.doesNotMatch(desk, /HrId|hr_id/, "no HR id is shown");
    for (const page of ["app/(admin)/admin/report-it/page.tsx", "app/employee-portals/report-it/page.tsx"]) {
      assert.match(code(page), /<ReportItDueDesk initial=\{openReports\} \/>/, `${page} shows the due-date view`);
    }
  }
}
