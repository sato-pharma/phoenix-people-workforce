import assert from "node:assert/strict";

import {
  KNOWN_FLAGS,
  appErrorRowsFromCsv,
  assertOffPeakCairo,
  cairoDateOf,
  issuesToMarkAfterHistory,
  parseCsv,
  parseHistoricalArgs,
} from "../scripts/system-audit-historical.ts";

/**
 * The historical runner's guards, without running it. Importing the script must run NOTHING (no
 * database read, no file written) — this file importing it at all is that check. An unknown flag is
 * refused rather than ignored; a dry run needs its errors snapshot; the working day (09:00–17:00
 * Cairo) is refused; and the snapshot CSV is read exactly, quotes and line breaks included.
 */

const NOW = new Date("2026-10-23T01:00:00.000Z"); // 04:00 Cairo

function refuses(argv: string[], pattern: RegExp, why?: string) {
  assert.throws(() => parseHistoricalArgs(argv, NOW), pattern, why);
}

function testArguments() {
  refuses(["--app-errors", "x.csv", "--dry"], /Unknown flag --dry/, "An unknown flag is refused, never ignored");
  refuses(["--app-errors", "x.csv", "--form", "2026-10-01"], /Unknown flag --form/, "A misspelt flag is refused");
  refuses([], /pass --app-errors/, "A dry run reads its errors from a snapshot");
  refuses(["--app-errors"], /--app-errors needs a value/);
  refuses(["--app-errors", "--apply"], /--app-errors needs a value/, "A flag is never taken as another flag's value");
  refuses(["--app-errors", "x.csv", "--from", "2026-13-40"], /--from must be a date/);
  refuses(["--app-errors", "x.csv", "--from", "1 Oct"], /--from must be a date/);
  refuses(["--app-errors", "x.csv", "--from", "2026-10-20", "--to", "2026-10-01"], /is after --to/);

  const defaults = parseHistoricalArgs(["--app-errors", "snap.csv"], NOW);
  assert.equal(defaults.to, "2026-10-23", "The window ends today, Cairo");
  assert.equal(defaults.from, "2026-07-25", "…and starts ninety days back — the error table's retention");
  assert.equal(defaults.apply, false, "Without --apply nothing is written to the database");
  assert.equal(defaults.out, null);

  const inline = parseHistoricalArgs(["--app-errors=snap.csv", "--from=2026-10-01", "--to=2026-10-10", "--out=here", "--apply"], NOW);
  assert.deepEqual(inline, { apply: true, appErrors: "snap.csv", from: "2026-10-01", to: "2026-10-10", out: "here", help: false });
  assert.equal(parseHistoricalArgs(["--apply"], NOW).appErrors, null, "--apply may read the live error table");
  assert.equal(parseHistoricalArgs(["--help"], NOW).help, true);
  assert.deepEqual([...KNOWN_FLAGS].sort(), ["--app-errors", "--apply", "--from", "--help", "--out", "--to"]);
}

function testOffPeak() {
  const at = (iso: string) => () => assertOffPeakCairo(new Date(iso));
  assert.throws(at("2026-10-23T06:00:00.000Z"), /Refused: it is 09:00 Cairo/, "09:00 Cairo is the start of the working day");
  assert.throws(at("2026-10-23T13:59:00.000Z"), /16:59 Cairo/);
  assert.doesNotThrow(at("2026-10-23T05:59:00.000Z"), "08:59 Cairo is still off-peak");
  assert.doesNotThrow(at("2026-10-23T14:00:00.000Z"), "17:00 Cairo is off-peak again");
  assert.doesNotThrow(at("2026-10-23T01:00:00.000Z"));
  assert.equal(cairoDateOf(new Date("2026-10-22T22:30:00.000Z")), "2026-10-23", "Dates are Cairo days, not UTC days");
}

function testCsv() {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n"line\none",\n'), [
    ["a", "b"],
    ["x, y", 'he said "hi"'],
    ["line\none", ""],
  ]);
  assert.deepEqual(parseCsv("a,b\nc,d"), [["a", "b"], ["c", "d"]], "A last line with no line break is kept");
  assert.throws(() => parseCsv('a,"unfinished\n'), /ends inside a quoted field/, "A truncated snapshot is refused, never half-read");

  const snapshot = [
    "id,created_at,source,hr_id,route,message,stack,environment,login_id,module_label",
    'e1,2026-10-20T08:00:00.000Z,client,B-77,/employee-portals/field-crm,"Cannot read properties of undefined (reading \'items\')",,production,mona.adel,Phoenix CRM',
    "e2,2026-10-20T09:00:00.000Z,server,,/api/crm/visits,boom,at x,production,,",
  ].join("\n");
  const rows = appErrorRowsFromCsv(snapshot);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].hr_id, "B-77");
  assert.equal(rows[0].message, "Cannot read properties of undefined (reading 'items')");
  assert.equal(rows[0].stack, null, "An empty cell is null, never an empty string");
  assert.equal(rows[0].login_id, "mona.adel");
  assert.equal(rows[0].module_label, "Phoenix CRM");
  assert.equal(rows[1].hr_id, null);
  assert.equal(rows[1].login_id, null);
  assert.equal(rows[1].digest, null, "An optional column the snapshot lacks is null");

  assert.throws(() => appErrorRowsFromCsv("id,created_at,source\ne1,2026-10-20T08:00:00Z,client"), /missing the column\(s\) route, message, stack, environment/);
  assert.throws(
    () => appErrorRowsFromCsv("id,created_at,source,route,message,stack,environment\ne1,yesterday,client,,,,"),
    /Snapshot row 2 has no usable id or created_at/,
  );
  assert.deepEqual(appErrorRowsFromCsv(""), []);
}

/**
 * 23 Oct 2026: by noon the sweep had already run four times on production and three live findings
 * were waiting for the next daily message. --apply used to mark EVERY waiting issue as told, which
 * would have swallowed those three; it marks only what the historical run itself made waiting.
 */
function testMarksOnlyHistory() {
  const waitingBefore = ["live-visit-missing", "live-auth-error", "live-detector-failed"];
  const waitingAfter = [
    { issueId: "live-visit-missing" },
    { issueId: "history-1" },
    { issueId: "live-auth-error" },
    { issueId: "history-2" },
    { issueId: "live-detector-failed" },
  ];
  assert.deepEqual(
    issuesToMarkAfterHistory(waitingBefore, waitingAfter),
    ["history-1", "history-2"],
    "Only the issues the historical run made waiting are marked as told; the live ones stay for the daily message",
  );
  assert.deepEqual(issuesToMarkAfterHistory([], waitingAfter).length, 5, "On an empty ledger every waiting issue is history");
  assert.deepEqual(issuesToMarkAfterHistory(waitingBefore, []), [], "Nothing waiting, nothing marked");
}

export async function runSystemAuditHistoricalRunnerTests() {
  testArguments();
  testOffPeak();
  testCsv();
  testMarksOnlyHistory();
}
