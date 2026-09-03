import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { parseOutstationTypeFields } from "../app/api/outstation/request-body.ts";
import {
  INVALID_EXPENSE_TYPE,
  INVALID_TRANSPORTATION_TYPE,
  OUTSTATION_EXPENSE_TYPES,
  OUTSTATION_TRANSPORTATION_TYPES,
} from "../src/lib/outstation/manager-expense-input.ts";

// The employee half of the taxonomy check the admin routes got in #2953.
//
// submit, sync-offline and calculate each built their service input with a bare cast —
// String(body.expenseType ?? "traveling") as OutstationExpenseType — which is erased at build
// time and checks nothing at runtime. The CHECK constraints that shipped with #2953 stop a bad
// value reaching the table, but they are not a substitute for parsing it:
//
//   - a refused INSERT surfaces as 23514, which outstationSubmitStatus maps to an opaque 500;
//     the employee is told nothing about which field was wrong;
//   - /api/outstation/calculate never writes, so no constraint can reach it. An unrecognised
//     transportationType there matches neither the car branch nor the train/bus branch in
//     calculateOutstationExpense, so fuelAmount and ticketAmount are both 0 and the preview comes
//     back priced with no travel cost at all, under a 200;
//   - an unrecognised expenseType additionally switches OFF the campaign / double-visit evidence
//     rule, because outstationCampaignRuleOutcome returns null for anything that is not exactly
//     "traveling".
//
// The taxonomy itself is NOT restated here. Both the parser under test and this file import the
// guards, the value lists and the refusal payloads from manager-expense-input.ts, which is what
// the admin routes and the database constraints are pinned to — so the employee routes cannot
// drift away from them.

/** The three employee-facing routes: an omitted field falls back, an unrecognised one is refused. */
const EMPLOYEE_ROUTES = [
  "app/api/outstation/submit/route.ts",
  "app/api/outstation/sync-offline/route.ts",
  "app/api/outstation/calculate/route.ts",
];

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

function refusalPayload(result: ReturnType<typeof parseOutstationTypeFields>) {
  return result.ok === false ? { error: result.error, message: result.message } : null;
}

export function runOutstationRequestTypeValidationTests() {
  // ── The two headline cases, on the employee submit path ────────────────────────

  {
    const unknownExpenseType = parseOutstationTypeFields({ expenseType: "campaign" });
    assert.equal(
      unknownExpenseType.ok,
      false,
      "an unrecognised expenseType must be refused — cast through, it silently switches OFF the campaign / double-visit evidence rule, because outstationCampaignRuleOutcome returns null for anything that is not exactly traveling",
    );
    assert.equal(
      unknownExpenseType.ok === false && unknownExpenseType.error,
      "invalid_expense_type",
      "the refusal must carry the error code the admin routes already return",
    );
  }

  {
    const unknownTransportationType = parseOutstationTypeFields({
      transportationType: "helicopter",
    });
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
    const bothWrong = parseOutstationTypeFields({
      expenseType: "campaign",
      transportationType: "helicopter",
    });
    assert.equal(
      bothWrong.ok === false && bothWrong.error,
      "invalid_expense_type",
      "expenseType is checked first, matching the order the admin create route has always used",
    );
  }

  // ── One taxonomy, one refusal, across the employee and admin routes ────────────

  assert.deepEqual(
    refusalPayload(parseOutstationTypeFields({ expenseType: "campaign" })),
    { error: INVALID_EXPENSE_TYPE.error, message: INVALID_EXPENSE_TYPE.message },
    "an employee route must refuse with the exact payload manager-expense-input.ts defines — one client-side handler then covers all five outstation write paths, and a second copy of the wording is a second thing to forget",
  );

  assert.deepEqual(
    refusalPayload(parseOutstationTypeFields({ transportationType: "helicopter" })),
    { error: INVALID_TRANSPORTATION_TYPE.error, message: INVALID_TRANSPORTATION_TYPE.message },
    "the transportation refusal must likewise be the shared one",
  );

  for (const cased of ["Traveling", "Meeting"]) {
    assert.equal(
      parseOutstationTypeFields({ expenseType: cased }).ok,
      false,
      `${cased} must be refused on the employee routes exactly as it is on the admin routes — the stored value is what the dashboard groups on and what the CHECK constraint compares, so a case variant would split one bucket into two`,
    );
  }

  for (const cased of ["Car", "TRAIN"]) {
    assert.equal(
      parseOutstationTypeFields({ transportationType: cased }).ok,
      false,
      `${cased} must be refused for the same reason a cased expense type is`,
    );
  }

  // ── Every valid value still passes ─────────────────────────────────────────────

  for (const expenseType of OUTSTATION_EXPENSE_TYPES) {
    for (const transportationType of OUTSTATION_TRANSPORTATION_TYPES) {
      const parsed = parseOutstationTypeFields({ expenseType, transportationType });
      assert.equal(
        parsed.ok,
        true,
        `${expenseType} / ${transportationType} is a real combination employees file and must not be refused — a validation fix that rejects live traffic is worse than the gap it closes`,
      );
      assert.equal(parsed.ok === true && parsed.expenseType, expenseType);
      assert.equal(parsed.ok === true && parsed.transportationType, transportationType);
    }
  }

  // ── Defaults, preserved exactly as the three routes had them ───────────────────

  const absentShapes = [
    {},
    { expenseType: null },
    { transportationType: undefined },
    { expenseType: "" },
    { transportationType: "" },
  ];

  for (const absent of absentShapes) {
    const parsed = parseOutstationTypeFields(absent);
    assert.equal(
      parsed.ok,
      true,
      "an omitted field must keep falling back — the mobile wizard has always been allowed to leave these off, and turning that into a 400 would break submission for everyone",
    );
    assert.equal(
      parsed.ok === true && parsed.expenseType,
      "traveling",
      "the historic employee-route default",
    );
    assert.equal(
      parsed.ok === true && parsed.transportationType,
      "car",
      "the historic employee-route default",
    );
  }

  // ── Values that are not strings, and strings that live only on the prototype ───

  for (const value of [0, 1, true, {}, ["car"], [], () => "car"]) {
    assert.equal(
      parseOutstationTypeFields({ transportationType: value }).ok,
      false,
      `a non-string transportationType (${typeof value}) must be refused, not String()-coerced into something that matches no branch`,
    );
  }

  for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    assert.equal(
      parseOutstationTypeFields({ expenseType: inherited }).ok,
      false,
      `${inherited} reaches Object.prototype, so a membership test written with the in operator rather than a hasOwnProperty call would wave it through as a valid expense type`,
    );
    assert.equal(
      parseOutstationTypeFields({ transportationType: inherited }).ok,
      false,
      `${inherited} must not pass as a transportation type either`,
    );
  }

  // ── The shared sets must equal the unions they claim to police ─────────────────
  //
  // manager-expense-input.ts states them as Record<Union, true>, which TypeScript checks in both
  // directions — but next.config sets ignoreBuildErrors, so a missing key would still compile,
  // build and deploy. This is the runtime half of that guard.

  {
    const typesSource = readFileSync("src/lib/outstation/types.ts", "utf8");

    assert.deepEqual(
      [...OUTSTATION_EXPENSE_TYPES].sort(),
      unionMembers(typesSource, "OutstationExpenseType"),
      "the shared expense-type set must match the OutstationExpenseType union exactly — a member added to the union but not there would be refused at the door despite being valid, and one removed from the union but left there would keep being accepted",
    );

    assert.deepEqual(
      [...OUTSTATION_TRANSPORTATION_TYPES].sort(),
      unionMembers(typesSource, "OutstationTransportationType"),
      "the shared transportation-type set must match the OutstationTransportationType union exactly",
    );
  }

  // ── Every employee route goes through the parser and answers 400 ──────────────

  for (const route of EMPLOYEE_ROUTES) {
    const source = readFileSync(route, "utf8");

    assert.ok(
      source.includes("parseOutstationTypeFields(body)"),
      `${route} must parse both fields through the shared parser — a CHECK constraint can only turn a bad value into an opaque 500, and it cannot reach the calculate route at all`,
    );
    assert.ok(
      /if \(!outstationTypes\.ok\) \{[\s\S]{0,200}status: 400/.test(source),
      `${route} must answer 400 when the parser refuses — parsing and then ignoring the verdict is the same gap in a longer form`,
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
