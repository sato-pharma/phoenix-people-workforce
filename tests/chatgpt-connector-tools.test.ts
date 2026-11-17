import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  asPlainRefusal,
  capRows,
  cappedNote,
  daysBetween,
  formatEgp,
  formatRatio,
  latestCompleteQuarter,
  looseLatinWord,
  matchPeople,
  monthLabel,
  monthsBetween,
  monthsOfPublicationKeys,
  normalizeSearchText,
  parsePeriod,
  periodRangeLabel,
  pickFields,
  pickOnePerson,
  publicationGaps,
  resolveDateWindow,
  resolveLineCode,
  resolveMonthRange,
  scalarFields,
  scorePersonMatch,
} from "../src/lib/chatgpt-connector/tools/helpers.ts";
import {
  TABLE_EXPORT_MAX_ROWS,
  TABLE_PAGE_BUDGET_CHARS,
  TABLE_READ_MAX_ROWS,
  TABLE_TOOL_ROLES,
  isDeniedColumn,
  isDeniedTable,
  planTableRead,
  readableTables,
  rowsThatFit,
  schemaFromOpenApi,
} from "../src/lib/chatgpt-connector/tools/table-guard.ts";
import {
  CUSTOMER_LIST_COLUMNS,
  CUSTOMER_LIST_TYPES,
  cairoDay,
  nameCustomerRows,
  type CustomerRow,
} from "../src/lib/chatgpt-connector/tools/customer-list.ts";
import { ToolRefusal } from "../src/lib/chatgpt-connector/types.ts";
import { stripComments } from "./support/comment-strip.ts";

// The ChatGPT connector's domain tools (src/lib/chatgpt-connector/tools/). The tools themselves read
// the live database through the screens' own services, so this file pins what can be pinned without
// one: name search, period words, field projection, the publication gap, the raw-table guard, and —
// by reading the source — that every tool asks a permission, that nothing writes, and that the raw
// table tools are the owner's and the CEO's.

const TOOLS_DIR = path.resolve(process.cwd(), "src/lib/chatgpt-connector/tools");

function source(file: string): string {
  return stripComments(readFileSync(path.join(TOOLS_DIR, file), "utf8"));
}

function refuses(run: () => unknown, pattern: RegExp, why: string) {
  assert.throws(run, (error: unknown) => error instanceof ToolRefusal && pattern.test(error.message), why);
}

const LINES = [
  { code: "cns", label: "CNS" },
  { code: "pedia", label: "Pedia" },
  { code: "anti_infective", label: "Anti-infective" },
];

function testNameSearch() {
  const people = [
    { hrId: "B-158", fullName: "Ibtissam Mohamed Ali", displayName: "Ibtissam Mohamed", nickname: null, nameAr: "إبتسام محمد علي" },
    { hrId: "B-201", fullName: "Mohamed Ibrahim Hassan", displayName: "Mohamed Ibrahim", nickname: "Hamada", nameAr: "محمد إبراهيم" },
    { hrId: "B-202", fullName: "Mohamed Ibrahim Saleh", displayName: "Mohamed Ibrahim Saleh", nickname: null, nameAr: null },
    { hrId: "AA", fullName: "Anwar Example", displayName: "Anwar Example", nickname: null, nameAr: null },
  ];

  assert.equal(scorePersonMatch("B-158", people[0]), 100, "an exact HR id wins outright");
  assert.equal(scorePersonMatch("b158", people[0]), 100, "an HR id typed without its hyphen still matches (hrIdsMatch)");
  assert.equal(scorePersonMatch("AAA", people[3]), 100, "the legacy AAA alias resolves to AA");
  assert.ok(scorePersonMatch("ibtissam", people[0]) >= 70, "a first name finds the person");
  assert.ok(scorePersonMatch("ابتسام", people[0]) >= 70, "Arabic finds the person with the hamza-alef folded (إ = ا)");
  assert.ok(scorePersonMatch("hamada", people[1]) >= 80, "the nickname is searched");
  assert.equal(scorePersonMatch("Ziad", people[0]), 0, "an unrelated name scores nothing");
  assert.equal(scorePersonMatch("   ", people[0]), 0, "a blank query matches nobody");

  // Another Latin spelling of the same Arabic name (owner, 17 Nov 2026: "Ibtissam" for Phoenix's "Ebtissam").
  const ebtissam = { hrId: "PD-0013", fullName: "Ebtissam Alaa ElDin Anwar", displayName: null, nickname: "Ebtissam Alaa", nameAr: null };
  assert.equal(scorePersonMatch("Ibtissam", ebtissam), 50, "Ibtissam finds Ebtissam, below every real spelling");
  assert.equal(scorePersonMatch("Ebtesam Alaa", ebtissam), 50, "single letters and e/i swaps fold too");
  assert.equal(scorePersonMatch("Ebtissam", ebtissam), 80, "the real spelling still scores as a real match");
  assert.equal(scorePersonMatch("Muhammad Ibrahim", people[1]), 50, "Muhammad = Mohamed");
  assert.equal(scorePersonMatch("Ziad", ebtissam), 0, "an unrelated name still scores nothing");
  assert.equal(scorePersonMatch("Ali", ebtissam), 0, "a word under five letters is never folded — Ali never reaches Alaa");
  assert.equal(scorePersonMatch("Ibtissam Ali", ebtissam), 0, "every word must fit, and the short one must be spelled as it is");
  assert.equal(looseLatinWord("youssef"), looseLatinWord("yousef"));
  assert.equal(looseLatinWord("إبتسام"), "", "Arabic is never folded this way");
  assert.equal(pickOnePerson([...people, ebtissam], "Ibtissam").hrId, "B-158", "a real spelling beats a loose one");
  assert.equal(pickOnePerson([people[1], ebtissam], "Ibtissam").hrId, "PD-0013", "with no real spelling, the loose one is found");
  assert.equal(normalizeSearchText("  Ibtissam—Mohamed!! "), "ibtissam mohamed", "punctuation folds to single spaces");

  const found = matchPeople(people, "mohamed ibrahim");
  assert.deepEqual(
    found.map((row) => row.hrId),
    ["B-201", "B-202"],
    "both Mohamed Ibrahims match; the exact display name ranks first",
  );

  assert.equal(pickOnePerson(people, "Ibtissam").hrId, "B-158", "a unique best match is returned");
  assert.equal(pickOnePerson(people, "B-202").hrId, "B-202", "an HR id always picks exactly one person");
  refuses(() => pickOnePerson(people, "Ziad"), /Nobody you can see matches/, "no match is a plain refusal, never a guess");
  const twins = [
    { hrId: "X-1", fullName: "Sara Adel", displayName: "Sara Adel" },
    { hrId: "X-2", fullName: "Sara Adel", displayName: "Sara Adel" },
  ];
  refuses(() => pickOnePerson(twins, "Sara Adel"), /more than one person.*X-1.*X-2/, "a tie names both people with their HR ids");
}

function testLines() {
  assert.equal(resolveLineCode("CNS", LINES), "cns");
  assert.equal(resolveLineCode("anti infective", LINES), "anti_infective", "spaces and hyphens are ignored");
  assert.equal(resolveLineCode("Anti-Infective", LINES), "anti_infective");
  assert.equal(resolveLineCode("anti_infective", LINES), "anti_infective", "the code itself is accepted");
  assert.equal(resolveLineCode("pedia", LINES), "pedia");
  assert.equal(resolveLineCode("Head Office", LINES), null, "Head Office is not a sales line");
  assert.equal(resolveLineCode("", LINES), null);
}

function testPeriods() {
  assert.deepEqual(parsePeriod("2026-07"), { year: 2026, month: 7 });
  assert.equal(parsePeriod("2026-13"), null);
  assert.equal(parsePeriod("July"), null);
  assert.deepEqual(monthsBetween("2026-11", "2027-02"), ["2026-11", "2026-12", "2027-01", "2027-02"], "a range crosses the year");
  assert.deepEqual(monthsBetween("2026-09", "2026-07"), [], "a backwards range is empty");
  assert.equal(monthLabel("2026-07"), "July 2026");
  assert.equal(periodRangeLabel("2026-07", "2026-09"), "July–September 2026", "a quarter reads in words, never codes");
  assert.equal(periodRangeLabel("2025-12", "2026-02"), "December 2025–February 2026");
  assert.equal(periodRangeLabel("2026-08", "2026-08"), "August 2026");

  assert.deepEqual(
    latestCompleteQuarter(["2026-07", "2026-08", "2026-09", "2026-10"]),
    { from: "2026-07", to: "2026-09" },
    "'last quarter' is the newest quarter whose three months are all published — October alone does not make Q4",
  );
  assert.equal(latestCompleteQuarter(["2026-07", "2026-08"]), null, "two months are not a quarter");
  assert.deepEqual(monthsOfPublicationKeys(["cns|2026-08", "pedia|2026-08", "cns|2026-07", "junk"]), ["2026-07", "2026-08"]);

  const published = ["2026-07", "2026-08", "2026-09", "2026-10"];
  const options = { floor: "2026-07", maxMonths: 24 };
  assert.deepEqual(resolveMonthRange(undefined, undefined, published, options), { from: "2026-07", to: "2026-09" });
  assert.deepEqual(resolveMonthRange(undefined, undefined, ["2026-07", "2026-08"], options), { from: "2026-08", to: "2026-08" }, "no full quarter: the newest month");
  assert.deepEqual(resolveMonthRange("2026-08", undefined, published, options), { from: "2026-08", to: "2026-08" }, "one end alone is that month");
  refuses(() => resolveMonthRange("2026-06", "2026-07", published, options), /Figures start in July 2026/, "nothing before the first published closing");
  refuses(() => resolveMonthRange("2026-09", "2026-07", published, options), /ends .* before it starts/, "a backwards range is refused");
  refuses(() => resolveMonthRange("2026/07", undefined, published, options), /YYYY-MM/, "a malformed month is refused in plain words");
  refuses(() => resolveMonthRange("2026-07", "2028-12", published, options), /at most 24 months/, "the loader's own 24-month cap");
  refuses(() => resolveMonthRange(undefined, undefined, [], options), /No Monthly Closing has been published/, "nothing published is said, never zeros");

  assert.equal(daysBetween("2026-10-01", "2026-10-31"), 31);
  assert.deepEqual(resolveDateWindow(undefined, undefined, "2026-11-17"), { from: "2026-11-01", to: "2026-11-17" }, "default: this month to today");
  refuses(() => resolveDateWindow("2026-02-30", undefined, "2026-11-17"), /YYYY-MM-DD/, "an impossible date is refused");
  refuses(() => resolveDateWindow("2026-11-10", "2026-11-01", "2026-11-17"), /before it starts/, "a backwards window is refused");
}

function testPublicationGate() {
  const rows = [
    { period: "2026-08", lineCode: "cns" },
    { period: "2026-08", lineCode: "pedia" },
    { period: "2026-09", lineCode: "cns" },
    { period: "2026-09", lineCode: "pedia" },
    { period: "2026-10", lineCode: "cns" },
  ];
  const published = new Set(["cns|2026-08", "pedia|2026-08", "cns|2026-09"]);
  const gaps = publicationGaps(rows, ["2026-08", "2026-09", "2026-10", "2026-11"], published, ["cns", "pedia", "anti_infective"]);
  assert.deepEqual(gaps.withheld, ["2026-10", "2026-11"], "a month with no published line in scope is withheld, never zero");
  assert.deepEqual(
    gaps.partial,
    [{ period: "2026-09", unpublishedLineCodes: ["pedia"] }],
    "a month with some lines published counts only those and names the rest",
  );
}

function testMoneyAndRows() {
  assert.equal(formatEgp(1234567), "EGP 1,234,567");
  assert.equal(formatEgp(1234.5), "EGP 1,234.50");
  assert.equal(formatEgp(null), "no figure");
  assert.equal(formatRatio(0.8734), "87.3%");
  assert.equal(formatRatio(null), "no target", "no target is never printed as 0%");

  const capped = capRows([1, 2, 3, 4, 5], 3);
  assert.deepEqual(capped, { rows: [1, 2, 3], total: 5, capped: true });
  assert.match(cappedNote(5, 3), /first 3 of 5/, "a capped answer says so");
  assert.equal(cappedNote(3, 3), "");

  const projected = pickFields({ hrId: "B-1", fullName: "A", baseSalary: 9000, nationalId: "x" }, ["hrId", "fullName"] as const);
  assert.deepEqual(projected, { hrId: "B-1", fullName: "A" }, "projection keeps only the named fields — pay and ID never ride along");
  assert.deepEqual(
    scalarFields({ a: 1, b: "x", c: null, d: [1], e: { f: 1 }, g: Number.NaN, h: true }),
    { a: 1, b: "x", c: null, h: true },
    "arrays, objects and non-finite numbers are dropped from a summary",
  );

  const forbidden = asPlainRefusal(new Error("Forbidden: CEO cannot read employees."));
  assert.ok(forbidden instanceof ToolRefusal, "a domain gate's Forbidden becomes a plain refusal");
  const crash = new Error("connection reset");
  assert.equal(asPlainRefusal(crash), crash, "any other failure passes through unchanged");
}

function testTableGuard() {
  assert.deepEqual(
    [...TABLE_TOOL_ROLES],
    ["Super Admin", "CEO"],
    "the raw tables are open to the owner AND the CEO (owner, 17 Nov 2026: \"answer me or Dr. Anwar\")",
  );

  for (const table of [
    "app_auth_credentials",
    "app_auth_second_step",
    "app_auth_second_step_recovery_codes",
    "app_auth_trusted_devices",
    "app_auth_webauthn_challenges",
    "connector_oauth_clients",
    "connector_oauth_codes",
    "connector_oauth_tokens",
    "password_reset_codes",
    "password_setup_tokens",
    "v2_vacation_email_tokens",
    "weekly_plan_approval_tokens",
    "direct_order_report_share_links",
    "ats_cv_lifecycle_share_links",
    "ats_interview_ics_feed_tokens",
    "territory_preview_links",
    "push_subscriptions",
  ]) {
    assert.equal(isDeniedTable(table), true, `${table} holds sign-in or link secrets and must be denied`);
  }
  for (const table of [
    "employees",
    "app_auth_users",
    "salary_records",
    "vacation_requests",
    "phoenix_crm_shared_places",
    "photos",
    "phoenix_crm_customers",
    "crm_contacts",
    "activity_events",
    "app_sessions",
    "auth_login_attempts",
  ]) {
    assert.equal(isDeniedTable(table), false, `${table} is ordinary business data`);
  }

  for (const column of ["password_hash", "token", "token_hash", "secret_sealed", "code_hash", "otp", "otp_code", "api_key", "private_key", "sealed_password", "decision_nonce_hash", "key"]) {
    assert.equal(isDeniedColumn(column), true, `${column} is a credential column`);
  }
  for (const column of ["hr_id", "full_name", "base_salary", "bank_account", "national_id", "footprint", "area_key", "hire_date"]) {
    assert.equal(isDeniedColumn(column), false, `${column} is readable (owner decision: pay, bank and ID included)`);
  }

  const schema = schemaFromOpenApi({
    definitions: {
      employees: { properties: { hr_id: {}, full_name: {}, base_salary: {}, line_name: {} } },
      app_auth_users: { properties: { hr_id: {}, role: {}, password_hash: {} } },
      app_sessions: { properties: { id: {}, token_hash: {}, login_id: {}, last_seen_at: {} } },
      password_setup_tokens: { properties: { id: {}, login_id: {} } },
      "Bad-Name": { properties: { x: {} } },
      notATable: "garbage",
    },
  });
  assert.equal(schema.size, 5, "only definitions with properties are tables");
  assert.deepEqual(
    readableTables(schema).map((entry) => entry.table),
    ["app_auth_users", "app_sessions", "employees"],
    "the list drops deny-listed and malformed names",
  );
  assert.deepEqual(
    readableTables(schema).find((entry) => entry.table === "app_sessions")?.columns,
    ["login_id", "last_seen_at"],
    "the sign-in history is readable, without the session id a browser carries and without any hash",
  );
  refuses(() => planTableRead({ table: "app_sessions", columns: ["id"] }, schema), /security column/, "app_sessions.id is never selected");
  refuses(
    () => planTableRead({ table: "app_sessions", filters: [{ column: "id", op: "eq", value: "x" }] }, schema),
    /security column/,
    "nor filtered on",
  );
  assert.deepEqual(planTableRead({ table: "employees", columns: ["hr_id"] }, schema).columns, ["hr_id"], "an id column elsewhere stays readable");
  assert.deepEqual(
    readableTables(schema).find((entry) => entry.table === "app_auth_users")?.columns,
    ["hr_id", "role"],
    "app_auth_users is listed without its password hash",
  );

  const plan = planTableRead({ table: "app_auth_users" }, schema);
  assert.deepEqual(plan.columns, ["hr_id", "role"], "no columns asked = every readable column, never `*`");
  assert.equal(plan.limit, 200);
  assert.equal(plan.offset, 0, "a read starts at the first row unless told otherwise");
  assert.equal(planTableRead({ table: "employees", offset: 4000 }, schema).offset, 4000, "a later page starts at its offset");
  assert.equal(planTableRead({ table: "employees", offset: -3 }, schema).offset, 0, "a negative offset is the first row");

  const full = planTableRead(
    {
      table: "employees",
      columns: ["hr_id", "full_name"],
      filters: [
        { column: "line_name", op: "eq", value: "CNS" },
        { column: "hr_id", op: "in", value: ["B-1", "B-2"] },
        { column: "base_salary", op: "is", value: null },
      ],
      orderBy: { column: "full_name" },
      limit: 9999,
    },
    schema,
  );
  assert.equal(full.limit, TABLE_READ_MAX_ROWS, "one page is capped at 1,000 rows; offset reads the rest");
  assert.equal(TABLE_READ_MAX_ROWS, 1000);
  assert.equal(
    planTableRead({ table: "employees", limit: 99_999 }, schema, TABLE_EXPORT_MAX_ROWS).limit,
    TABLE_EXPORT_MAX_ROWS,
    "a whole-table export takes its own ceiling",
  );
  assert.deepEqual(full.orderBy, { column: "full_name", ascending: true });
  assert.equal(full.filters.length, 3);

  refuses(() => planTableRead({ table: "password_setup_tokens" }, schema), /never read/, "a denied table is refused even when it exists");

  // Every letter: a page that would not fit in one answer is shortened to WHOLE rows, never cut.
  const small = Array.from({ length: 50 }, (_, index) => ({ id: index, name: `Dr ${index}` }));
  assert.equal(rowsThatFit(small), 50, "a page that fits is sent whole");
  const wide = Array.from({ length: 100 }, (_, index) => ({ id: index, notes: "x".repeat(5_000) }));
  const fit = rowsThatFit(wide);
  assert.ok(fit > 0 && fit < 100, `a page too big for one answer is shortened (${fit} of 100 rows)`);
  const written = JSON.stringify({ rows: wide.slice(0, fit) }, null, 1).length;
  assert.ok(written <= TABLE_PAGE_BUDGET_CHARS, `the shortened page fits the budget (${written} characters)`);
  assert.equal(rowsThatFit([{ notes: "y".repeat(400_000) }]), 1, "one row bigger than the budget is still sent, never zero rows");
  const serverSource = readFileSync(path.resolve(process.cwd(), "src/lib/chatgpt-connector/server.ts"), "utf8");
  const answerCap = Number(/CONNECTOR_MAX_TEXT_CHARS = ([\d_]+)/.exec(serverSource)?.[1].replace(/_/g, ""));
  assert.ok(TABLE_PAGE_BUDGET_CHARS + 20_000 <= answerCap, "the page budget sits under the answer cap, so a page is never cut with a note");
  refuses(() => planTableRead({ table: "auth.users" }, schema), /not a table name/, "another schema cannot be named");
  refuses(() => planTableRead({ table: "employees; drop table x" }, schema), /not a table name/, "the name is a strict identifier");
  refuses(() => planTableRead({ table: "nothing_here" }, schema), /no table or view/, "an unknown table is refused before any query");
  refuses(
    () => planTableRead({ table: "app_auth_users", columns: ["password_hash"] }, schema),
    /security column/,
    "a secret column is never selected",
  );
  refuses(
    () => planTableRead({ table: "app_auth_users", filters: [{ column: "password_hash", op: "eq", value: "x" }] }, schema),
    /security column/,
    "a secret column is never filtered on — a filter would leak it one guess at a time",
  );
  refuses(
    () => planTableRead({ table: "app_auth_users", orderBy: { column: "password_hash" } }, schema),
    /security column/,
    "nor ordered by",
  );
  refuses(() => planTableRead({ table: "employees", columns: ["nope"] }, schema), /no readable column/, "an unknown column is refused");
  refuses(
    () => planTableRead({ table: "employees", filters: [{ column: "hr_id", op: "in", value: [] }] }, schema),
    /list of 1 to 200/,
    "an empty in-list is refused",
  );
  refuses(
    () => planTableRead({ table: "employees", filters: [{ column: "hr_id", op: "is", value: "x" }] }, schema),
    /null, true or false/,
    "is takes null, true or false",
  );
  refuses(
    () => planTableRead({ table: "employees", filters: [{ column: "hr_id", op: "eq", value: { a: 1 } }] }, schema),
    /one plain value/,
    "an object value is refused",
  );
}

function testCustomerList() {
  const base: CustomerRow = {
    id: "c1", seat_id: "SEAT-A", line_code: "pedia", list_type: "PM", name: "Dr Hany", full_name_held: null, speciality: "Pediatrics",
    grade: "A", potential_grade: null, status: "pending", origin: "ireports360", phone: "01001234567", primary_pharmacy_name: null,
    pharmacy_pin_address: null, pharmacy_pin_governorate: null, pharmacy_pin_area_name: null, pharmacy_pin_brick_name: null,
    validated_at: null, dropped_reason: null, dropped_note: null, created_at: "2026-11-16T23:30:00Z", status_changed_at: null,
  };
  const seats = [
    { seat_id: "SEAT-A", parent_seat_id: "SEAT-DM", occupant_hr_id: "s-1", line_name: "Pedia", area_name: "Cairo West", region_name: "Cairo" },
    { seat_id: "SEAT-B", parent_seat_id: "SEAT-DM", occupant_hr_id: null, line_name: "Pedia", area_name: "Alex West", region_name: "Alex-BHR" },
    { seat_id: "SEAT-H", parent_seat_id: "SEAT-DM", occupant_hr_id: "S-1", line_name: "CNS", area_name: "Giza", region_name: "Giza" },
    { seat_id: "SEAT-H", parent_seat_id: "SEAT-DM", occupant_hr_id: "S-2", line_name: "CNS", area_name: "Giza", region_name: "Giza" },
    { seat_id: "SEAT-DM", parent_seat_id: null, occupant_hr_id: "S-9", line_name: "Pedia", area_name: null, region_name: "Cairo" },
    { seat_id: "SEAT-X", parent_seat_id: null, occupant_hr_id: "S-404", line_name: "Pedia", area_name: "Nowhere", region_name: null },
  ];
  const people = [
    { hr_id: "S-1", full_name: "Mona Adel" },
    { hr_id: "S-2", full_name: "Karim Fathy" },
    { hr_id: "S-9", full_name: "Sahar Hani" },
  ];
  const rows = nameCustomerRows(
    [
      base,
      { ...base, id: "c2", seat_id: "SEAT-B", name: "Dr Amal", status: "dropped" },
      { ...base, id: "c3", seat_id: "SEAT-H", name: "Dr Omar", status: "active" },
      { ...base, id: "c4", seat_id: "SEAT-X", name: "Dr Lina", status: "outside" },
    ],
    seats,
    people,
  );
  const byName = new Map(rows.map((entry) => [String(entry.row.name), entry]));
  const hany = byName.get("Dr Hany")!.row;
  assert.equal(hany.rep, "Mona Adel", "the seat's holder is named, its HR id matched whatever its case");
  assert.equal(hany.manager, "Sahar Hani", "the district manager is the parent seat's holder, by name");
  assert.equal(hany.line, "Pedia", "the line is its name, not its code");
  assert.equal(hany.area, "Cairo West");
  assert.equal(hany.status, "Waiting to be validated", "the status is in words");
  assert.equal(hany.added_on, "17 Nov 2026", "dates are Cairo days — 23:30 UTC is the next day in Cairo");
  assert.equal(byName.get("Dr Amal")!.row.rep, "Vacant", "a seat with no holder reads Vacant");
  assert.equal(byName.get("Dr Amal")!.onList, false, "a dropped customer is off the list");
  assert.equal(byName.get("Dr Omar")!.row.rep, "Mona Adel / Karim Fathy", "a handover seat names both holders");
  assert.equal(byName.get("Dr Lina")!.row.rep, "Unknown employee", "an HR id with no employee row never prints the id");
  assert.equal(byName.get("Dr Lina")!.onList, true, "outside the list still counts as on the lists, not dropped");
  const printed = rows.flatMap((entry) => Object.values(entry.row)).map(String);
  for (const code of ["SEAT-A", "SEAT-B", "S-1", "S-9", "pedia"]) {
    assert.equal(printed.includes(code), false, `no seat id, HR id or line code (${code}) reaches the sheet`);
  }
  assert.deepEqual(rows.map((entry) => entry.row.name), ["Dr Omar", "Dr Amal", "Dr Hany", "Dr Lina"], "sorted by line, region, area, then name");
  assert.deepEqual([...CUSTOMER_LIST_TYPES.doctors], ["AM", "PM"], "doctors are the AM and PM lists");
  assert.deepEqual([...CUSTOMER_LIST_TYPES.pharmacies], ["Pharmacy"]);
  assert.equal(CUSTOMER_LIST_COLUMNS.find((column) => column.key === "phone")?.text, true, "a phone number stays text, so Excel never eats its leading zero");
  assert.equal(cairoDay(null), "");
}

function testToolSources() {
  const files = readdirSync(TOOLS_DIR).filter((file) => file.endsWith(".ts"));
  const all = files.map((file) => source(file)).join("\n");

  // Read-only: no write verb on any builder, no RPC, no raw SQL.
  for (const verb of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc(", "execute_sql", "apply_migration"]) {
    assert.equal(all.includes(verb), false, `no connector tool may call ${verb} — every tool is read-only`);
  }
  assert.equal(/select\(\s*["']\*["']\s*\)/.test(all), false, "no tool selects `*`; the table reader names its columns");

  // Every tool is registered, named phoenix_*, and the two table tools carry the owner-only roles.
  const index = source("index.ts");
  for (const tool of [
    "findPeopleTool",
    "personTool",
    "salesAchievementTool",
    "salesRankingsTool",
    "leaveTool",
    "attendanceTool",
    "payrollTool",
    "crmKpisTool",
    "orgChartTool",
    "listTablesTool",
    "readTableTool",
    "exportTableTool",
    "exportCustomerListTool",
  ]) {
    assert.ok(index.includes(tool), `${tool} is in DOMAIN_TOOLS`);
  }
  const names = [...all.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]).filter((name) => name.includes("_"));
  assert.equal(names.length, 13, "thirteen tools are defined");
  for (const name of names) assert.match(name, /^phoenix_[a-z_]+$/, `${name} is snake_case and starts with phoenix_`);

  const tables = source("tables.ts");
  assert.equal((tables.match(/roles:\s*TABLE_TOOL_ROLES/g) ?? []).length, 3, "all three table tools are the owner's and the CEO's alone");
  assert.equal((tables.match(/planTableRead\(/g) ?? []).length, 2, "the reader and the export both run only a guarded plan");
  assert.ok(tables.includes("rowsThatFit("), "the reader shortens a page to whole rows instead of letting the answer be cut");
  assert.ok(tables.includes("next_offset"), "the reader tells ChatGPT where the next page starts");
  assert.ok(tables.includes("planTableRead("), "the table reader runs only a guarded plan");
  assert.ok(tables.includes("phoenix_sales_achievement"), "the table tools send ChatGPT to the closing for any sales figure");
  assert.ok(tables.includes("phoenix_export_customer_list"), "the raw export sends ChatGPT to the named customer-list export for doctors and pharmacies");
  const customerList = source("customer-list.ts");
  assert.equal((customerList.match(/roles:\s*TABLE_TOOL_ROLES/g) ?? []).length, 1, "the named customer-list export is the owner's and the CEO's alone, like the raw tables");
  assert.ok(customerList.includes('.eq("is_test", false)'), "the customer-list export never carries a test row");
  assert.equal((customerList.match(/fetchAllRows</g) ?? []).length, 3, "all three reads are paged to the last row, never cut at 1,000");

  // Each screen's own gate is asked (see each tool's mirrored page).
  const sales = source("sales.ts");
  assert.equal((sales.match(/assertPermission\(ctx, "sales", "read"\)/g) ?? []).length, 2, "both sales tools assert sales:read like their pages");
  assert.ok(sales.includes("filterRowsForBound("), "rows are bounded to the viewer before any roll-up");
  assert.ok(sales.includes("isRowPublished("), "only published closings are figures");
  const hr = source("hr.ts");
  assert.ok(hr.includes('assertPermission(ctx, "attendance", "read")') && hr.includes("assertCanViewEmployeeAttendance("), "attendance mirrors its route's two gates");
  assert.ok(hr.includes("assertAttendanceMonthlySummaryPermission("), "the company attendance summary keeps its salary-blind gate");
  assert.ok(hr.includes('getPayrollScope(ctx) !== "COMPANY"') && hr.includes('assertPermission(ctx, "payroll", "export")'), "payroll mirrors the download route");
  const people = source("people.ts");
  assert.ok(people.includes('canAccess(ctx, "employees", "read")') && people.includes("filterEmployeeDirectoryForAccess("), "full records only through the directory's own filter");
  assert.ok(people.includes("resolveEmployee360VisibleRows(") && people.includes("canViewEmployee360Subject("), "everyone else through Employee 360's scope");
  const org = source("org.ts");
  assert.ok(org.includes("canSeeDoctorCoverage(") && org.includes('canAccess(ctx, "crm_visits", "read")'), "KPIs mirror the KPIs page's two gates");
  assert.ok(org.includes('canAccess(ctx, "organogram", "read")'), "the organogram asks organogram:read");
}

export async function runChatgptConnectorToolsTests() {
  testNameSearch();
  testLines();
  testPeriods();
  testPublicationGate();
  testMoneyAndRows();
  testTableGuard();
  testCustomerList();
  testToolSources();
}
