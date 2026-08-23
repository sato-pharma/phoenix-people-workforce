import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { hrIdsMatch } from "../src/lib/hr-id.ts";
import { scopeAuOrganogramRows } from "../src/lib/reports/organogram-au-source.ts";
import {
  ORGANOGRAM_EXPORT_COLUMNS,
  buildOrganogramExportRows,
} from "../src/lib/reports/organogram-audience.ts";
import type { OrganogramReportRow } from "../src/lib/reports/vacancies.ts";

/**
 * The WhatsApp button's GATE, and the privacy boundary that justifies its design.
 *
 * tests/organogram-whatsapp-number.test.ts covers the NUMBER — that a stored value is
 * read correctly or refused. This file covers the two claims that make the feature safe,
 * neither of which that one touches:
 *
 *   1. WHO you may resolve a number for — a line-scoped viewer must not be able to open
 *      a chat with someone off their chart, and the refusal must be 404 rather than 403.
 *   2. That the chart never CARRIES the number. OrganogramWorkFields ships to every
 *      viewer's browser, so a mobile placed there would be a standing bulk disclosure to
 *      everyone with organogram access, all day, whether or not anyone ever exports.
 *
 * The SHEET does have a Mobile column — the owner asked for one on 2026-08-23. That is
 * not a hole in claim 2, it is the reason claim 2 has to be pinned: the numbers are
 * fetched from the server when Export is pressed and handed to buildOrganogramExportRows
 * as a SEPARATE argument, so the sheet can carry them while the page never does. The
 * assertions below hold those two facts apart.
 *
 * Claim 2 is the one most likely to be undone by accident: the mobile is already visible
 * one click away in the node popup's Contact section, and now in the sheet as well, so
 * adding it to the row reads like a harmless simplification. It is not.
 */

const SENTINEL_MOBILE = "01000000009";

/**
 * Rows carry an EXTRA mobileNumber property the row type does not declare. That is the
 * point: if a future change widens OrganogramWorkFields with the number and the export
 * starts spreading the row instead of picking named fields, the sentinel surfaces and
 * the export assertion below fires.
 */
function row(partial: Partial<OrganogramReportRow> & { hrId: string }): OrganogramReportRow {
  return {
    type: "employee",
    status: "active",
    hasWhatsApp: true,
    displayName: "Person " + partial.hrId,
    fullName: "Person " + partial.hrId,
    mobileNumber: SENTINEL_MOBILE,
    ...partial,
  } as unknown as OrganogramReportRow;
}

const CHART: OrganogramReportRow[] = [
  // The CEO holds no line. scopeAuOrganogramRows keeps line-less leadership on every
  // scoped chart, so a district manager CAN message the CEO. Deliberate, and pinned
  // here so nobody "fixes" it into a leak or into an unintended block.
  row({ hrId: "CEO-1", jobTitle: "CEO", lineName: null }),
  row({ hrId: "PD-DM-1", jobTitle: "District Sales Manager", lineName: "Pedia" }),
  row({ hrId: "PD-REP-1", jobTitle: "Medical Representative", lineName: "Pedia" }),
  row({ hrId: "CN-REP-9", jobTitle: "Medical Representative", lineName: "CNS" }),
  row({
    hasWhatsApp: false,
    hrId: "SEAT-VACANT-1",
    lineName: "Pedia",
    status: "open",
    type: "vacancy",
  }),
];

/**
 * Mirrors the route's own predicate, app/api/reports/organogram/whatsapp/[hrId]/route.ts:
 *
 *     report.organogramRows.some((row) => row.type === "employee" && hrIdsMatch(row.hrId, hrId))
 *
 * against rows produced by the same scoping function the route reaches through
 * getOrganogramReport (organogram.ts:369). The clause checks at the end of this file keep
 * the mirror honest — if the route's predicate or its 404 changes, they go red.
 */
function isOnViewerChart(rows: OrganogramReportRow[], hrId: string): boolean {
  return rows.some((candidate) => candidate.type === "employee" && hrIdsMatch(candidate.hrId, hrId));
}

export function runOrganogramWhatsAppGateTests() {
  // ---- 1. a line-scoped viewer reaches their own line, and nothing else ----
  const pediaChart = scopeAuOrganogramRows(CHART, { lineNames: ["Pedia"], mode: "line" });

  assert.equal(
    isOnViewerChart(pediaChart, "PD-REP-1"),
    true,
    "a Pedia viewer must be able to open a chat with their own rep",
  );
  assert.equal(
    isOnViewerChart(pediaChart, "CN-REP-9"),
    false,
    "a Pedia viewer must NOT resolve a CNS colleague's number — the route answers 404",
  );
  assert.equal(
    isOnViewerChart(pediaChart, "CEO-1"),
    true,
    "the line-less CEO stays on every scoped chart, so a line-scoped viewer may message him",
  );
  assert.equal(
    isOnViewerChart(pediaChart, "SEAT-VACANT-1"),
    false,
    "a vacant seat has nobody to message — the type guard, not hasWhatsApp, is what refuses it",
  );

  // A company-scope viewer sees the whole company, so the CNS rep IS reachable there.
  // Without this, the assertion above could pass simply because the fixture is broken.
  assert.equal(
    isOnViewerChart(scopeAuOrganogramRows(CHART, { mode: "company" }), "CN-REP-9"),
    true,
    "a company-scope viewer must reach the CNS rep the Pedia viewer cannot",
  );

  // ---- 2. the refusal must not be a CASING accident ----
  // HR ids are mixed case in this database. If the gate were a plain === it would 404
  // people the viewer can plainly see on screen, which reads as "the button is broken".
  assert.equal(
    isOnViewerChart(pediaChart, "pd-rep-1"),
    true,
    "a lowercase hrId must still match — otherwise the gate 404s someone the viewer CAN see",
  );

  // ---- 3. the number reaches the sheet ONLY from the server ----
  // Exactly one contact-number column, and no second one under another name.
  for (const column of ORGANOGRAM_EXPORT_COLUMNS) {
    for (const word of ["phone", "whatsapp", "msisdn", "telephone"]) {
      assert.ok(
        !column.key.toLowerCase().includes(word),
        "export column key \"" + column.key + "\" is a second phone column — the organogram sheet has one, keyed \"mobile\"",
      );
      assert.ok(
        !column.label.toLowerCase().includes(word),
        "export column label \"" + column.label + "\" is a second phone column — the organogram sheet has one, labelled \"Mobile\"",
      );
    }
  }

  const mobileColumns = ORGANOGRAM_EXPORT_COLUMNS.filter((column) =>
    column.key.toLowerCase().includes("mobile"),
  );
  assert.equal(
    mobileColumns.length,
    1,
    "the organogram export must declare exactly one mobile column",
  );
  assert.equal(
    mobileColumns[0].text,
    true,
    "the mobile column must be text-formatted — an Excel number cell eats the leading zero, which is how 124 of the 175 rows in employees.mobile_number were damaged before they ever reached this app",
  );

  // THE LOCK. Every fixture row carries a sentinel mobile the row type does not declare.
  // Build with no server map and the column must still come out empty: a value here means
  // the builder read the number off the row, which is the disclosure this file exists to
  // prevent.
  const exportedWithoutNumbers = buildOrganogramExportRows(CHART);
  assert.ok(
    !JSON.stringify(exportedWithoutNumbers).includes(SENTINEL_MOBILE),
    "buildOrganogramExportRows must pick named fields, never spread the row — a mobile on the row reached the sheet",
  );
  for (const exportedRow of exportedWithoutNumbers) {
    assert.equal(
      exportedRow.mobile,
      "",
      "with no server map every mobile cell must be empty — a number here came off the row",
    );
  }

  // With a map, the number lands in the mobile cell of the person the server named, and
  // in no other cell and on no other person.
  const numbersByHrId = new Map([
    ["pd-rep-1", "01111111111"],
    ["seat-vacant-1", "01222222222"],
  ]);
  const exportedWithNumbers = buildOrganogramExportRows(CHART, numbersByHrId);
  for (const exportedRow of exportedWithNumbers) {
    for (const [key, value] of Object.entries(exportedRow)) {
      if (key === "mobile") continue;
      assert.ok(
        !/[0-9]{10,}/u.test(String(value ?? "")),
        "a run of 10+ digits reached the organogram export column \"" + key + "\" — that shape is a phone number",
      );
    }
  }

  const pediaRep = exportedWithNumbers.find((exportedRow) => exportedRow.hrId === "PD-REP-1");
  assert.equal(
    pediaRep?.mobile,
    "01111111111",
    "the server's number must reach the row of the person it was answered for",
  );
  assert.equal(
    exportedWithNumbers.find((exportedRow) => exportedRow.hrId === "CEO-1")?.mobile,
    "",
    "a person the server did not answer for exports a blank mobile, never a borrowed one",
  );

  // An open seat has nobody to call. It stays blank even when the map holds its seat id.
  assert.equal(
    exportedWithNumbers.find((exportedRow) => exportedRow.type === "Vacancy")?.mobile,
    "",
    "an open seat must never export a phone number",
  );

  // ---- 4. the number never reaches the BROWSER either ----
  // Absent from the export is not enough: the row itself is serialized to every viewer.
  // Assert on field-declaration lines only — the type's own comment discusses the mobile
  // at length, so a naive search of the whole block would false-fail on the prose.
  const vacanciesSource = readFileSync(
    new URL("../src/lib/reports/vacancies.ts", import.meta.url),
    "utf8",
  );
  const typeStart = vacanciesSource.indexOf("export type OrganogramWorkFields");
  assert.ok(typeStart > 0, "OrganogramWorkFields must still exist in vacancies.ts");
  const typeBody = vacanciesSource.slice(typeStart, vacanciesSource.indexOf("\n};", typeStart));
  const declaredFields = typeBody
    .split("\n")
    .filter((line) => /^ {2}[A-Za-z][A-Za-z0-9]*\??:/u.test(line));

  assert.ok(
    declaredFields.some((line) => line.includes("hasWhatsApp")),
    "OrganogramWorkFields must still carry the hasWhatsApp flag the button renders off",
  );
  for (const line of declaredFields) {
    assert.ok(
      !/mobile|phone|whatsapp_?number/iu.test(line),
      "OrganogramWorkFields must never carry a number — found \"" +
        line.trim() +
        "\". It ships to every viewer's browser on every load; both the button and the export resolve numbers server-side, per press, instead.",
    );
  }

  // The seat source reads employees.mobile_number, and must reduce it to the boolean on
  // the spot rather than placing it on a row.
  const seatSource = readFileSync(
    new URL("../src/lib/reports/organogram-au-source.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    seatSource.includes("hasWhatsApp: hasWhatsAppNumber(employee.mobile_number)"),
    "the seat source must reduce mobile_number to a boolean where it reads it",
  );
  assert.ok(
    !/mobileNumber\s*:/u.test(seatSource),
    "the seat source must never place a mobileNumber field on an organogram row",
  );

  // ---- 5. the route still refuses off-chart people the way this file assumes ----
  const routeSource = readFileSync(
    new URL("../app/api/reports/organogram/whatsapp/[hrId]/route.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    routeSource.includes("row.type === \"employee\" && hrIdsMatch(row.hrId, hrId)"),
    "the route's chart-membership predicate changed — the mirror in this file is now testing nothing",
  );

  // A window anchored on the match, not a fixed byte offset, so this survives the
  // handler growing around it.
  const notFoundAt = routeSource.indexOf("error: \"not_found\"");
  assert.ok(notFoundAt > 0, "the off-chart branch must answer not_found");
  assert.ok(
    routeSource.slice(notFoundAt, notFoundAt + 200).includes("status: 404"),
    "the off-chart answer must be 404, never 403 — a 403 confirms that a person the viewer may not see exists",
  );

  assert.ok(
    routeSource.includes("NextResponse.redirect(whatsAppChatUrl(number), 302)"),
    "the route must redirect rather than return the number as JSON — returning it would put the mobile in the page",
  );

  // ---- 6. the EXPORT's number route is gated the same way, and is audited ----
  // This one does return numbers as JSON, in bulk, which is exactly why it must carry the
  // same chart-membership rule and leave a record of who pulled the list.
  const contactRouteSource = readFileSync(
    new URL("../app/api/reports/organogram/contact-numbers/route.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    contactRouteSource.includes("assertPermission(access, \"organogram\", \"read\")"),
    "the contact-numbers route must assert the organogram read permission server-side",
  );
  assert.ok(
    contactRouteSource.includes("if (row.type !== \"employee\") continue;"),
    "the contact-numbers route must build its allow-list from employees only — a vacant seat has nobody to answer for",
  );
  assert.ok(
    contactRouteSource.includes("allowed.has(key)"),
    "the contact-numbers route must filter the directory to the caller's own chart",
  );
  for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.ok(
      !new RegExp("export async function " + verb + "\b", "u").test(contactRouteSource),
      "the contact-numbers route must expose " + verb + " to nobody — it is a read",
    );
  }

  // The registry DECLARES the audit; only this call writes one. Checking the declaration
  // alone is how a route gets described as audited when nothing reaches audit_logs.
  //
  // This is a source check, so be clear about its reach: it catches the call being removed,
  // renamed, or left unawaited. It cannot catch a call that is still present but does not
  // run. Removal is the regression that actually happens.
  assert.ok(
    contactRouteSource.includes("await writeRequiredAuditLog({"),
    "the contact-numbers route must AWAIT its own audit write — a registry entry declares an audit, it never produces one, and an unawaited write races the response",
  );
  const auditAt = contactRouteSource.indexOf("await writeRequiredAuditLog({");
  const returnAt = contactRouteSource.indexOf("return NextResponse.json({ contacts })");
  assert.ok(returnAt > 0, "the contact-numbers route must still answer with the contacts payload");
  assert.ok(
    auditAt < returnAt,
    "the audit row must be written BEFORE the numbers are returned — numbers handed out that nobody can account for later are worse than a failed export",
  );

  const registrySource = readFileSync(
    new URL("../src/lib/security/access-registry.ts", import.meta.url),
    "utf8",
  );
  const contactEntryAt = registrySource.indexOf("/api/reports/organogram/contact-numbers");
  assert.ok(
    contactEntryAt > 0,
    "the contact-numbers route must have its OWN registry entry — the blanket /api/reports/** rule carries no audit classification",
  );
  const contactEntry = registrySource.slice(
    registrySource.lastIndexOf("sessionApi(", contactEntryAt),
    contactEntryAt,
  );
  assert.ok(
    contactEntry.includes("classification: \"export\"") && contactEntry.includes("required: true"),
    "pulling every colleague's number must be audited as an export",
  );

  // Ahead of the blanket rule, or it is never reached and the audit never fires.
  const blanketAt = registrySource.indexOf("pattern: \"/api/reports/**\"");
  assert.ok(blanketAt > 0, "the blanket /api/reports/** rule must still exist");
  assert.ok(
    contactEntryAt < blanketAt,
    "the contact-numbers entry must be listed BEFORE /api/reports/**, which would otherwise match first and swallow the audit",
  );
}
