import type {
  OutstationExpenseType,
  OutstationTransportationType,
} from "./types";

// The two enum-shaped fields every outstation request carries, and the one place their allowed
// values are stated. Nothing below this layer refuses a bad one:
//
//   - there is no database CHECK constraint behind either column (verified on production
//     2026-09-03 — outstation_expense_requests constrains only evidence_gate_status,
//     workload_gate_status, workload_match_status and workload_source);
//   - an unrecognised transportationType matches NEITHER the `car` branch nor the `train`/`bus`
//     branch in calculateOutstationExpense, so fuelAmount and ticketAmount are both 0 and the
//     trip is priced with no travel cost at all;
//   - an unrecognised expenseType additionally switches OFF the campaign / double-visit evidence
//     rule, because outstationCampaignRuleOutcome returns null for anything that is not exactly
//     "traveling".
//
// All three failures are silent — a wrong value produces a plausible request, not an error — so
// the route layer is the only place they can be caught. Every route that builds an outstation
// service input parses through parseOutstationTypeFields.

// Written as Records so TypeScript refuses a list that has drifted from the union in ./types.ts.
// A Record alone does NOT gate the build here (next.config's ignoreBuildErrors lets a missing key
// compile and deploy), so tests/outstation-request-type-validation.test.ts asserts the same
// exhaustiveness at runtime against the union declared in the source.
const EXPENSE_TYPES: Record<OutstationExpenseType, true> = {
  traveling: true,
  meeting: true,
  other: true,
};

const TRANSPORTATION_TYPES: Record<OutstationTransportationType, true> = {
  car: true,
  train: true,
  bus: true,
  other: true,
};

export const OUTSTATION_EXPENSE_TYPES = Object.keys(
  EXPENSE_TYPES,
) as OutstationExpenseType[];

export const OUTSTATION_TRANSPORTATION_TYPES = Object.keys(
  TRANSPORTATION_TYPES,
) as OutstationTransportationType[];

export const DEFAULT_OUTSTATION_EXPENSE_TYPE: OutstationExpenseType = "traveling";

export const DEFAULT_OUTSTATION_TRANSPORTATION_TYPE: OutstationTransportationType = "car";

// Object.hasOwn, never `in`: `"constructor" in EXPENSE_TYPES` is true through the prototype, so
// `in` would wave a handful of real strings straight past the check.
export function isOutstationExpenseType(
  value: unknown,
): value is OutstationExpenseType {
  return typeof value === "string" && Object.hasOwn(EXPENSE_TYPES, value);
}

export function isOutstationTransportationType(
  value: unknown,
): value is OutstationTransportationType {
  return typeof value === "string" && Object.hasOwn(TRANSPORTATION_TYPES, value);
}

function humanList(values: readonly string[]) {
  if (values.length <= 1) return values.join("");
  return `${values.slice(0, -1).join(", ")}, or ${values[values.length - 1]}`;
}

// Absence, for a body that is CREATING a request: nothing usable was supplied, so the route's
// historic default applies. An empty string counts, because it is what an untouched form control
// sends.
function isAbsent(value: unknown) {
  return value === null || value === undefined || value === "";
}

// Absence, for a body that is PATCHING one, is a narrower thing: only null and undefined mean
// "leave the stored value alone", because updateManagerExpenseAsAdmin coalesces exactly those two
// with `input.expenseType ?? existing.expenseType`. An empty string is NOT absent there —
// `"" ?? existing` is `""`, which would be written to the row — so it falls through to the
// guard below and is refused like any other unrecognised value.
function isPatchAbsent(value: unknown) {
  return value === null || value === undefined;
}

type OutstationTypeRefusal = {
  ok: false;
  error: "invalid_expense_type" | "invalid_transportation_type";
  message: string;
};

const EXPENSE_TYPE_REFUSAL: OutstationTypeRefusal = {
  ok: false,
  error: "invalid_expense_type",
  message: `expenseType must be ${humanList(OUTSTATION_EXPENSE_TYPES)}.`,
};

const TRANSPORTATION_TYPE_REFUSAL: OutstationTypeRefusal = {
  ok: false,
  error: "invalid_transportation_type",
  message: `transportationType must be ${humanList(OUTSTATION_TRANSPORTATION_TYPES)}.`,
};

export type OutstationTypeFieldsResult =
  | {
      ok: true;
      expenseType: OutstationExpenseType;
      transportationType: OutstationTransportationType;
    }
  | OutstationTypeRefusal;

/**
 * Parse the expenseType / transportationType pair off a request body.
 *
 * `onMissing: "default"` keeps the employee routes' historic fallbacks (traveling / car) for a
 * body that omits the field; `onMissing: "reject"` is the admin create route, which has always
 * required both to be stated. Either way an unrecognised value is refused rather than cast —
 * that is the whole point of this function.
 *
 * expenseType is checked first so a body wrong in both fields reports the same error the admin
 * route has always reported.
 */
export function parseOutstationTypeFields(
  body: { expenseType?: unknown; transportationType?: unknown },
  options: { onMissing: "default" | "reject" },
): OutstationTypeFieldsResult {
  const useDefaults = options.onMissing === "default";

  const expenseType =
    useDefaults && isAbsent(body.expenseType)
      ? DEFAULT_OUTSTATION_EXPENSE_TYPE
      : body.expenseType;

  if (!isOutstationExpenseType(expenseType)) return EXPENSE_TYPE_REFUSAL;

  const transportationType =
    useDefaults && isAbsent(body.transportationType)
      ? DEFAULT_OUTSTATION_TRANSPORTATION_TYPE
      : body.transportationType;

  if (!isOutstationTransportationType(transportationType)) {
    return TRANSPORTATION_TYPE_REFUSAL;
  }

  return { ok: true, expenseType, transportationType };
}

export type OutstationTypeFieldsPatch = {
  expenseType?: OutstationExpenseType;
  transportationType?: OutstationTransportationType;
};

export type OutstationTypeFieldsPatchResult =
  | { ok: true; fields: OutstationTypeFieldsPatch }
  | OutstationTypeRefusal;

/**
 * The partial-update variant, for PATCH /api/admin/outstation/manager-expenses/[id].
 *
 * A field the body does not carry is left out of the result entirely — that is what a partial
 * update means, and the caller spreads `fields` so an omitted one cannot overwrite the stored
 * value with undefined. A field the body DOES carry must be a value the system recognises:
 * updateManagerExpenseAsAdmin writes both straight to the row (expense_type /
 * transportation_type) with no CHECK constraint behind either column, so an unrecognised value
 * persists and every later read of that row — the fuel branch, the train/bus ticket-evidence
 * requirement, the campaign rule — silently matches nothing.
 */
export function parseOutstationTypeFieldsPatch(body: {
  expenseType?: unknown;
  transportationType?: unknown;
}): OutstationTypeFieldsPatchResult {
  const fields: OutstationTypeFieldsPatch = {};

  const rawExpenseType = body.expenseType;
  if (!isPatchAbsent(rawExpenseType)) {
    if (!isOutstationExpenseType(rawExpenseType)) return EXPENSE_TYPE_REFUSAL;
    fields.expenseType = rawExpenseType;
  }

  const rawTransportationType = body.transportationType;
  if (!isPatchAbsent(rawTransportationType)) {
    if (!isOutstationTransportationType(rawTransportationType)) {
      return TRANSPORTATION_TYPE_REFUSAL;
    }
    fields.transportationType = rawTransportationType;
  }

  return { ok: true, fields };
}
