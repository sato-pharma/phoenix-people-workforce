import assert from "node:assert/strict";

import {
  SYSTEM_AUDIT_ARRAY_CAP,
  SYSTEM_AUDIT_MAX_OFFSET,
  SYSTEM_AUDIT_PAGE_SIZE,
  SYSTEM_AUDIT_SCREEN_ROW_CAP,
  SYSTEM_AUDIT_SEARCH_MAX,
  SystemAuditQueryError,
  auditActorId,
  describeSystemAuditFilters,
  isAuditId,
  isSystemAuditQueryError,
  parseStatusChange,
  parseSystemAuditQuery,
  parseTriage,
  systemAuditQueryToParams,
} from "../src/lib/system-audit/page-query.ts";

// The System Error & Data Integrity Audit's query string, parsed in ONE place for the page, its
// JSON route and the export — so the export can never carry different rows from the screen.
// A value the parser does not recognise is REFUSED with a sentence (a 400), never dropped: a
// dropped filter widens the list, and a widened list reads as "these are the errors you asked for".

function refuses(input: Parameters<typeof parseSystemAuditQuery>[0], pattern: RegExp, why: string) {
  assert.throws(
    () => parseSystemAuditQuery(input),
    (error: unknown) => isSystemAuditQueryError(error) && error.status === 400 && pattern.test(error.message),
    why,
  );
}

function defaultsTests() {
  const query = parseSystemAuditQuery({});
  assert.equal(query.limit, SYSTEM_AUDIT_PAGE_SIZE, "a screen page is 50 rows");
  assert.equal(query.offset, 0);
  assert.equal(query.sort, "occurred_desc", "newest first by default");
  assert.equal(query.filters.includeSilent, true, "silent data findings are shown by default");
  assert.equal(query.filters.includeTest, false, "test accounts are hidden by default");
  assert.equal(query.filters.from, null);
  assert.equal(query.filters.to, null);
  assert.deepEqual(query.filters.modules, []);
  assert.equal(SYSTEM_AUDIT_SCREEN_ROW_CAP, 10_000);
  assert.equal(SYSTEM_AUDIT_MAX_OFFSET, 9_950, "the last whole page inside the 10,000-row screen cap");

  // Unknown parameter NAMES are ignored on purpose: the page carries `tab`, the export `format`.
  assert.doesNotThrow(() => parseSystemAuditQuery({ tab: "integrity", format: "xlsx" }));
}

function parsingTests() {
  const params = new URLSearchParams();
  params.set("from", "2026-10-01");
  params.set("to", "2026-10-22");
  params.append("hrKey", " B-10 ");
  params.append("hrKey", "b-10");
  params.append("module", "Payroll Management");
  params.append("module", "Monthly Closing");
  params.append("status", "not_fixed");
  params.append("why", "probable");
  params.append("family", "reconciliation");
  params.set("scope", "shared");
  params.set("q", "  timeout  ");
  params.set("silent", "0");
  params.set("test", "1");
  params.set("sort", "person_ops");
  params.set("offset", "100");
  params.set("tab", "incidents");

  const query = parseSystemAuditQuery(params);
  assert.equal(query.filters.from, "2026-10-01");
  assert.equal(query.filters.to, "2026-10-22");
  assert.deepEqual(query.filters.hrKeys, ["b-10"], "an HR ID is canonicalised and de-duplicated");
  assert.deepEqual(query.filters.modules, ["Payroll Management", "Monthly Closing"]);
  assert.deepEqual(query.filters.statuses, ["not_fixed"]);
  assert.deepEqual(query.filters.rootCauseLevels, ["probable"]);
  assert.deepEqual(query.filters.families, ["reconciliation"]);
  assert.equal(query.filters.scope, "shared");
  assert.equal(query.filters.search, "timeout", "the search is trimmed");
  assert.equal(query.filters.includeSilent, false);
  assert.equal(query.filters.includeTest, true);
  assert.equal(query.sort, "person_ops");
  assert.equal(query.offset, 100);

  // A record (Next.js searchParams) reads the same as URLSearchParams.
  const fromRecord = parseSystemAuditQuery({
    from: "2026-10-01",
    to: "2026-10-22",
    hrKey: [" B-10 ", "b-10"],
    module: ["Payroll Management", "Monthly Closing"],
    status: "not_fixed",
    why: "probable",
    family: "reconciliation",
    scope: "shared",
    q: "  timeout  ",
    silent: "0",
    test: "1",
    sort: "person_ops",
    offset: "100",
  });
  assert.deepEqual(fromRecord, query, "a searchParams record and a URLSearchParams parse identically");

  // The round trip: the client's query string reproduces exactly what the server parsed.
  assert.deepEqual(parseSystemAuditQuery(systemAuditQueryToParams(query)), query, "toParams then parse is the identity");
  const plain = parseSystemAuditQuery({});
  assert.equal(systemAuditQueryToParams(plain).toString(), "", "a plain visit keeps a plain URL");
}

function refusalTests() {
  refuses({ from: "2026-02-30" }, /not a real calendar day/, "a day that does not exist is refused, never rolled over");
  refuses({ from: "01/10/2026" }, /YYYY-MM-DD/, "a date in another format is refused");
  refuses({ from: "2026-10-22", to: "2026-10-01" }, /after the end date/, "a reversed range is refused");
  refuses({ from: ["2026-10-01", "2026-10-02"] }, /more than once/, "two different start dates are refused");
  refuses({ status: "fixed" }, /not a known fixed status/, "an unknown status is refused, never dropped");
  refuses({ why: "certain" }, /not a known root-cause level/, "an unknown root-cause level is refused");
  refuses({ family: "everything" }, /not a known source/, "an unknown source is refused");
  refuses({ scope: "everyone" }, /not a known scope/, "an unknown scope is refused");
  refuses({ sort: "random" }, /not a known sort/, "an unknown sort is refused");
  refuses({ silent: "maybe" }, /must be 1 or 0/, "a flag that is not 1 or 0 is refused");
  refuses({ offset: "-50" }, /whole number/, "a negative page position is refused");
  refuses({ offset: "ten" }, /whole number/, "a page position that is not a number is refused");
  refuses({ offset: String(SYSTEM_AUDIT_MAX_OFFSET + 1) }, /export them/, "paging past 10,000 rows points at the export");
  assert.equal(parseSystemAuditQuery({ offset: String(SYSTEM_AUDIT_MAX_OFFSET) }).offset, SYSTEM_AUDIT_MAX_OFFSET);
  refuses({ q: "x".repeat(SYSTEM_AUDIT_SEARCH_MAX + 1) }, /at most 200/, "an over-long search is refused");
  refuses({ q: ["a", "b"] }, /more than once/, "two searches are refused");
  refuses({ module: "m".repeat(201) }, /longer than 200/, "an over-long module label is refused");

  const tooMany = Array.from({ length: SYSTEM_AUDIT_ARRAY_CAP + 1 }, (_, index) => `Module ${index}`);
  refuses({ module: tooMany }, /at most 200/, "more than 200 module values at once are refused");
  assert.equal(
    parseSystemAuditQuery({ module: tooMany.slice(0, SYSTEM_AUDIT_ARRAY_CAP) }).filters.modules?.length,
    SYSTEM_AUDIT_ARRAY_CAP,
    "exactly 200 is allowed",
  );

  const error = new SystemAuditQueryError("x");
  assert.equal(error.status, 400);
  assert.equal(isSystemAuditQueryError(new Error("x")), false, "a plain error is not a 400 refusal");
}

function describeTests() {
  const line = describeSystemAuditFilters(parseSystemAuditQuery({ from: "2026-10-01", hrKey: "B-10", module: "Payroll Management" }).filters);
  assert.match(line, /dates 2026-10-01 to today \(Cairo\)/);
  assert.match(line, /1 person/);
  assert.match(line, /modules: Payroll Management/);
  assert.match(line, /silent findings included · test accounts excluded$/);
}

const SHA = "a5829c87d0123456789abcdef0123456789abcde";

function statusBodyTests() {
  assert.throws(
    () => parseStatusChange({ to: "fixed_verified" }),
    (error: unknown) => isSystemAuditQueryError(error) && /automatic verifier/.test(error.message),
    "FIXED — VERIFIED can never be set by a person",
  );
  assert.throws(() => parseStatusChange({ to: "closed" }), /not a status that can be set here/);
  assert.throws(() => parseStatusChange(null), /no status change/);
  assert.throws(() => parseStatusChange([]), /no status change/);
  assert.throws(
    () => parseStatusChange({ to: "fix_implemented" }),
    /full 40-character commit/,
    "FIX IMPLEMENTED needs the commit",
  );
  assert.throws(() => parseStatusChange({ to: "fix_implemented", fixSha: "a5829c87d" }), /full 40-character commit/, "a short sha is refused");
  assert.deepEqual(parseStatusChange({ to: "fix_implemented", fixSha: SHA.toUpperCase() }), {
    to: "fix_implemented",
    reason: null,
    fixSha: SHA,
    occurrenceId: null,
  });
  assert.throws(() => parseStatusChange({ to: "investigating", fixSha: SHA }), /only with FIX IMPLEMENTED/);
  assert.throws(() => parseStatusChange({ to: "no_defect" }), /expected business behaviour/, "NO DEFECT needs a reason");
  assert.throws(() => parseStatusChange({ to: "unknown", reason: "   " }), /evidence is missing/, "UNKNOWN needs a reason");
  assert.equal(parseStatusChange({ to: "no_defect", reason: " A weekend has no visits " }).reason, "A weekend has no visits");
  assert.throws(() => parseStatusChange({ to: "not_fixed", reason: "r".repeat(2001) }), /at most 2000/);
  assert.throws(() => parseStatusChange({ to: "not_fixed", reason: 5 }), /must be text/);
  assert.throws(() => parseStatusChange({ to: "not_fixed", occurrenceId: "not-an-id" }), /occurrence id is not valid/);
  assert.equal(
    parseStatusChange({ to: "not_fixed", occurrenceId: "0a1b2c3d-0000-4000-8000-000000000001" }).occurrenceId,
    "0a1b2c3d-0000-4000-8000-000000000001",
  );
}

function triageBodyTests() {
  assert.deepEqual(parseTriage({ override: null, reason: "ignored" }), { override: null, reason: null }, "clearing drops the reason");
  assert.deepEqual(parseTriage({ override: "no_defect", reason: "Expected" }), { override: "no_defect", reason: "Expected" });
  assert.throws(() => parseTriage({ override: "no_defect" }), /expected business behaviour/);
  assert.throws(() => parseTriage({ override: "unknown", reason: "" }), /evidence is missing/);
  assert.throws(() => parseTriage({ override: "fixed_verified", reason: "x" }), /no defect or unknown, or cleared/);
  assert.throws(() => parseTriage({ reason: "x" }), /no defect or unknown, or cleared/, "a missing override is refused, not read as clear");
  assert.throws(() => parseTriage("no_defect"), /no decision/);
}

function idAndActorTests() {
  assert.equal(isAuditId("0a1b2c3d-0000-4000-8000-000000000001"), true);
  assert.equal(isAuditId("0a1b2c3d"), false);
  assert.equal(isAuditId("'; drop table x; --"), false);
  assert.equal(isAuditId(null), false);

  assert.equal(auditActorId({ hrId: "b-10", loginId: "login-1" }), "B-10", "the HR ID, in its stored form, wins");
  assert.equal(auditActorId({ hrId: null, loginId: "login-1" }), "login-1", "the login when there is no HR ID");
  assert.equal(auditActorId({ hrId: " ", loginId: " " }), null, "no id at all is no actor");
  assert.equal(auditActorId({ hrId: null, loginId: "system:verifier" }), null, "a person can never act as the verifier");
  assert.equal(auditActorId({ hrId: null, loginId: "SEED:import" }), null, "a person can never act as a seed");
}

export function runSystemAuditPageQueryTests() {
  defaultsTests();
  parsingTests();
  refusalTests();
  describeTests();
  statusBodyTests();
  triageBodyTests();
  idAndActorTests();
}
