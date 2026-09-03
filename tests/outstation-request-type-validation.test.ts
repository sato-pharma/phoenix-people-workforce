import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import {
  DEFAULT_OUTSTATION_EXPENSE_TYPE,
  DEFAULT_OUTSTATION_TRANSPORTATION_TYPE,
  OUTSTATION_EXPENSE_TYPES,
  OUTSTATION_TRANSPORTATION_TYPES,
  parseOutstationTypeFields,
  parseOutstationTypeFieldsPatch,
} from "../src/lib/outstation/request-fields.ts";

// expenseType and transportationType reached the outstation service through a bare TypeScript
// cast — String(body.expenseType ?? "traveling") as OutstationExpenseType — which is erased at
// build time and checks nothing at runtime. Nothing downstream refuses a bad value either:
//
//   - neither column has a database CHECK constraint (verified on production ozucdzovmcqvepbozvqf
//     2026-09-03: outstation_expense_requests constrains only evidence_gate_status,
//     workload_gate_status, workload_match_status and workload_source);
//   - an unrecognised transportationType matches NEITHER branch in calculateOutstationExpense, so
//     fuelAmount and ticketAmount are both 0 and the trip is priced with no travel cost at all;
//   - an unrecognised expenseType additionally switches OFF the campaign / double-visit evidence
//     rule, because outstationCampaignRuleOutcome returns null unless the type is "traveling".
//
// The admin PATCH route arrived at the same place by a different road: it spread the request body
// wholesale into the service input, so both fields reached expense_type / transportation_type
// unexamined and STAYED there, wrong, on a stored row.
//
// Every failure is silent — a wrong value produces a plausible, cheap, un-gated claim rather than
// an error. Live data was clean when this was written (80 rows, only valid values), so these
// tests defend a closed gap rather than describing damage.

/** Employee-facing routes: an absent field falls back, an unrecognised one is refused. */
const DEFAULTING_ROUTES = [
  "app/api/outstation/submit/route.ts",
  "app/api/outstation/sync-offline/route.ts",
  "app/api/outstation/calculate/route.ts",
];

/** Admin create: both fields have always been required outright. */
const REJECTING_ROUTES = ["app/api/admin/outstation/manager-expenses/route.ts"];

const BODY_SPREAD = "...body,";
const PARSED_SPREAD = "...outstationTypes.fields,";

/** Admin partial update: a field the body omits is left alone, one it carries must be valid. */
const PATCHING_ROUTES = ["app/api/admin/outstation/manager-expenses/[id]/route.ts"];

function apiRouteFiles() {
  return readdirSync("app/api", { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `${entry.parentPath}/${entry.name}`.replaceAll("\\", "/"));
}

function unionMembers(source: string, name: string) {
  const declaration = new RegExp(`export type ${name} =([^;]+);`).exec(source);
  if (!declaration) {
    // Thrown rather than asserted: assert.ok narrows nothing here, because TypeScript refuses to
    // treat an assertion signature reached through a default import as one (TS2775).
    throw new Error(`${name} must still be declared in src/lib/outstation/types.ts`);
  }
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
}

export function runOutstationRequestTypeValidationTests() {
  // ── The two headline cases: an unknown value on the employee submit route ──────

  {
    const unknownExpenseType = parseOutstationTypeFields(
      { expenseType: "campaign", transportationType: "car" },
      { onMissing: "default" },
    );
    assert.equal(
      unknownExpenseType.ok,
      false,
      "an unrecognised expenseType must be refused — cast through, it silently switches OFF the campaign / double-visit evidence rule, because outstationCampaignRuleOutcome returns null for anything that is not exactly traveling",
    );
    assert.equal(
      unknownExpenseType.ok === false && unknownExpenseType.error,
      "invalid_expense_type",
      "the refusal must carry the error code the admin route has always returned, so one client-side handler covers every outstation route",
    );
  }

  {
    const unknownTransportationType = parseOutstationTypeFields(
      { expenseType: "traveling", transportationType: "helicopter" },
      { onMissing: "default" },
    );
    assert.equal(
      unknownTransportationType.ok,
      false,
      "an unrecognised transportationType must be refused — cast through, it matches neither the car branch nor the train/bus branch in calculateOutstationExpense, so the trip is priced with NO travel cost at all",
    );
    assert.equal(
      unknownTransportationType.ok === false && unknownTransportationType.error,
      "invalid_transportation_type",
      "a bad transportationType must name the field it is complaining about",
    );
  }

  {
    const bothWrong = parseOutstationTypeFields(
      { expenseType: "campaign", transportationType: "helicopter" },
      { onMissing: "reject" },
    );
    assert.equal(
      bothWrong.ok === false && bothWrong.error,
      "invalid_expense_type",
      "expenseType is checked first — a body wrong in both fields must report exactly what the admin route reported before this parser existed",
    );
  }

  // ── Every valid value still passes ─────────────────────────────────────────────

  for (const expenseType of OUTSTATION_EXPENSE_TYPES) {
    for (const transportationType of OUTSTATION_TRANSPORTATION_TYPES) {
      const parsed = parseOutstationTypeFields(
        { expenseType, transportationType },
        { onMissing: "default" },
      );
      assert.equal(
        parsed.ok,
        true,
        `${expenseType} / ${transportationType} is a real combination employees file and must not be refused — a validation fix that rejects live traffic is worse than the gap it closes`,
      );
      assert.equal(parsed.ok === true && parsed.expenseType, expenseType);
      assert.equal(parsed.ok === true && parsed.transportationType, transportationType);
    }
  }

  // ── Defaults, preserved exactly as the employee routes had them ────────────────

  const absentShapes = [
    {},
    { expenseType: null },
    { transportationType: undefined },
    { expenseType: "" },
  ];

  for (const absent of absentShapes) {
    const parsed = parseOutstationTypeFields(absent, { onMissing: "default" });
    assert.equal(
      parsed.ok,
      true,
      "an omitted field must keep falling back on the employee routes — the mobile wizard has always been allowed to leave these off, and turning that into a 400 would break submission for everyone",
    );
    assert.equal(parsed.ok === true && parsed.expenseType, DEFAULT_OUTSTATION_EXPENSE_TYPE);
    assert.equal(
      parsed.ok === true && parsed.transportationType,
      DEFAULT_OUTSTATION_TRANSPORTATION_TYPE,
    );
  }

  assert.equal(DEFAULT_OUTSTATION_EXPENSE_TYPE, "traveling", "the historic employee-route default");
  assert.equal(DEFAULT_OUTSTATION_TRANSPORTATION_TYPE, "car", "the historic employee-route default");

  assert.equal(
    parseOutstationTypeFields({}, { onMissing: "reject" }).ok,
    false,
    "the admin create route has always required both fields outright — sharing a parser must not quietly hand it the employee defaults",
  );

  // ── Values that are not strings, and strings that live only on the prototype ───

  for (const value of [0, 1, true, {}, ["car"], [], () => "car"]) {
    assert.equal(
      parseOutstationTypeFields({ transportationType: value }, { onMissing: "default" }).ok,
      false,
      `a non-string transportationType (${typeof value}) must be refused, not String()-coerced into something that matches no branch`,
    );
  }

  for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    assert.equal(
      parseOutstationTypeFields({ expenseType: inherited }, { onMissing: "default" }).ok,
      false,
      `${inherited} reaches Object.prototype, so a membership test written with the in operator rather than Object.hasOwn would wave it through as a valid expense type`,
    );
    assert.equal(
      parseOutstationTypeFields({ transportationType: inherited }, { onMissing: "default" }).ok,
      false,
      `${inherited} must not pass as a transportation type either`,
    );
  }

  // ── The partial-update variant, for PATCH manager-expenses/[id] ────────────────

  {
    const unknownExpenseType = parseOutstationTypeFieldsPatch({ expenseType: "campaign" });
    assert.equal(
      unknownExpenseType.ok,
      false,
      "an unrecognised expenseType on a PATCH must be refused — updateManagerExpenseAsAdmin writes it straight to expense_type, where it persists with no CHECK constraint and reads as no-campaign-rule on every later pass over that row",
    );
    assert.equal(
      unknownExpenseType.ok === false && unknownExpenseType.error,
      "invalid_expense_type",
      "the PATCH route must refuse with the same error code as the create routes",
    );
  }

  {
    const unknownTransportationType = parseOutstationTypeFieldsPatch({
      transportationType: "helicopter",
    });
    assert.equal(
      unknownTransportationType.ok,
      false,
      "an unrecognised transportationType on a PATCH must be refused — once stored it stops BOTH the car fuel branch and the train/bus ticket-evidence requirement from ever firing on that row again",
    );
    assert.equal(
      unknownTransportationType.ok === false && unknownTransportationType.error,
      "invalid_transportation_type",
      "a bad transportationType must name the field it is complaining about",
    );
  }

  {
    const empty = parseOutstationTypeFieldsPatch({});
    assert.equal(empty.ok, true, "a PATCH carrying neither field is an ordinary partial update");
    assert.deepEqual(
      empty.ok === true && Object.keys(empty.fields),
      [],
      "an omitted field must be ABSENT from the result, never present-and-undefined — the route spreads these over the body, and a key holding undefined would erase what is stored",
    );
  }

  for (const untouched of [
    { expenseType: null },
    { expenseType: undefined },
    { transportationType: null },
  ]) {
    const parsed = parseOutstationTypeFieldsPatch(untouched);
    assert.equal(
      parsed.ok,
      true,
      "null and undefined mean leave-it-alone on a PATCH, because updateManagerExpenseAsAdmin coalesces exactly those two away with input.expenseType ?? existing.expenseType",
    );
    assert.deepEqual(
      parsed.ok === true && Object.keys(parsed.fields),
      [],
      "a field the caller did not mean to change must not appear in the result at all",
    );
  }

  for (const emptyString of [{ expenseType: "" }, { transportationType: "" }]) {
    assert.equal(
      parseOutstationTypeFieldsPatch(emptyString).ok,
      false,
      "an empty string is NOT absent on a PATCH — the service coalesces with ??, and an empty string is not nullish, so it would be written to the row. This is the one place the create routes and the patch route must disagree about what absent means",
    );
  }

  {
    const oneField = parseOutstationTypeFieldsPatch({ transportationType: "train" });
    assert.deepEqual(
      oneField.ok === true && oneField.fields,
      { transportationType: "train" },
      "a PATCH that mentions only transport must leave expenseType out — restating the other field would turn a partial update into a full one",
    );
  }

  {
    const both = parseOutstationTypeFieldsPatch({
      expenseType: "meeting",
      transportationType: "bus",
    });
    assert.deepEqual(both.ok === true && both.fields, {
      expenseType: "meeting",
      transportationType: "bus",
    });
  }

  for (const inherited of ["constructor", "__proto__", "toString"]) {
    assert.equal(
      parseOutstationTypeFieldsPatch({ expenseType: inherited }).ok,
      false,
      inherited + " must not pass the PATCH parser either",
    );
    assert.equal(
      parseOutstationTypeFieldsPatch({ transportationType: inherited }).ok,
      false,
      inherited + " must not pass as a transportation type on a PATCH",
    );
  }

  // ── The allowed sets must equal the unions they claim to police ────────────────
  //
  // The parser states its sets as Record<Union, true>, which TypeScript checks in both
  // directions — but next.config sets ignoreBuildErrors, so a missing key would still compile,
  // build and deploy. This is the runtime half of that guard.

  {
    const typesSource = readFileSync("src/lib/outstation/types.ts", "utf8");

    assert.deepEqual(
      [...OUTSTATION_EXPENSE_TYPES].sort(),
      unionMembers(typesSource, "OutstationExpenseType"),
      "the parser's expense-type set must match the OutstationExpenseType union exactly — a member added to the union but not here would be refused at the door despite being valid, and one removed from the union but left here would keep being accepted",
    );

    assert.deepEqual(
      [...OUTSTATION_TRANSPORTATION_TYPES].sort(),
      unionMembers(typesSource, "OutstationTransportationType"),
      "the parser's transportation-type set must match the OutstationTransportationType union exactly",
    );
  }

  // ── Every route that builds an outstation input goes through the parser ────────

  for (const route of [...DEFAULTING_ROUTES, ...REJECTING_ROUTES, ...PATCHING_ROUTES]) {
    const source = readFileSync(route, "utf8");

    assert.ok(
      source.includes("parseOutstationTypeFields"),
      `${route} must parse both fields through the shared parser — this is the only layer that can refuse a bad value, since there is no CHECK constraint and no downstream error`,
    );
    assert.ok(
      /if \(!outstationTypes\.ok\) \{[\s\S]{0,200}status: 400/.test(source),
      `${route} must answer 400 when the parser refuses — parsing and then ignoring the verdict is the same gap in a longer form`,
    );
  }

  for (const route of DEFAULTING_ROUTES) {
    assert.ok(
      /onMissing: "default"/.test(readFileSync(route, "utf8")),
      `${route} is employee-facing and must keep defaulting an omitted field rather than rejecting it`,
    );
  }

  for (const route of REJECTING_ROUTES) {
    assert.ok(
      /onMissing: "reject"/.test(readFileSync(route, "utf8")),
      `${route} must keep requiring both fields outright, as it did before the parser was shared`,
    );
  }

  for (const route of PATCHING_ROUTES) {
    const source = readFileSync(route, "utf8");

    assert.ok(
      source.includes("parseOutstationTypeFieldsPatch(body)"),
      `${route} must use the partial-update parser — the create parser would reject every PATCH that legitimately omits a field`,
    );
    const bodySpread = source.indexOf(BODY_SPREAD);
    const parsedSpread = source.indexOf(PARSED_SPREAD);
    assert.ok(
      bodySpread >= 0 && parsedSpread > bodySpread,
      `${route} must spread the parsed fields AFTER ...body — the raw body is spread wholesale, so without that line an empty string reaches the row untouched`,
    );
  }

  // ── The cast this file exists to remove must not come back anywhere in the API ─

  {
    const offenders = apiRouteFiles().filter((file) =>
      /as Outstation(Expense|Transportation)Type\b/.test(readFileSync(file, "utf8")),
    );
    assert.deepEqual(
      offenders,
      [],
      "no API route may cast a request body value to OutstationExpenseType or OutstationTransportationType — the cast is erased at build time, so it asserts a guarantee nothing enforces. Parse with parseOutstationTypeFields instead.",
    );
  }
}
