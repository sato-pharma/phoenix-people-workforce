/**
 * What an admin is allowed to send when they type an outstation expense in on an employee's
 * behalf, or edit one afterwards.
 *
 * This exists because the two admin write paths validated differently. The POST route
 * (`/api/admin/outstation/manager-expenses`) rejected anything outside the two taxonomies. The
 * PATCH route beside it built its service input as `{ ...body, ...overrides }` — it spread the
 * raw request body straight through and never looked at `expenseType` or `transportationType` at
 * all. There is no CHECK constraint behind either column, so an edit could write any string it
 * liked into `outstation_expense_requests.expense_type` and `.transportation_type`.
 *
 * Two things happen when it does, neither of them loud:
 *
 *   1. `updateManagerExpenseAsAdmin` branches the fuel line on `transportationType === "car"`.
 *      An unrecognised mode is not "car", so the fuel amount silently becomes 0 — the trip is
 *      simply paid less, with no error and nothing on screen saying why.
 *   2. `normalizeExpenseType` (expense-taxonomy.ts) title-cases whatever it is handed, so a junk
 *      value becomes its own bucket in the dashboard breakdowns, the filters and the exports —
 *      money that quietly stops being counted with the trips it belongs to.
 *
 * So both routes now come through here. The lists below are the single source of truth for the
 * app half; the matching CHECK constraints in
 * supabase/migrations/20260903143000_outstation_expense_taxonomy_check_constraints.sql are the
 * database half, and tests/outstation-manager-expense-edit-validation.test.ts pins the two
 * together so they cannot drift apart again.
 */

import { readCapturedPosition } from "@/lib/outstation/captured-coordinates";
import type {
  ManagerExpenseAdminInput,
  ManagerExpenseDestination,
  OutstationExpenseType,
  OutstationTransportationType,
} from "@/lib/outstation/types";

/**
 * Exhaustive by type: adding a member to OutstationExpenseType without listing it here fails the
 * build, so the union and the accepted values can never disagree. Insertion order is the order
 * the admin reads back in the refusal message.
 */
const EXPENSE_TYPES: Record<OutstationExpenseType, true> = {
  traveling: true,
  meeting: true,
  other: true,
};

/** Same contract for the transportation mode. */
const TRANSPORTATION_TYPES: Record<OutstationTransportationType, true> = {
  car: true,
  train: true,
  bus: true,
  other: true,
  no_ticket: true,
};

export const OUTSTATION_EXPENSE_TYPES = Object.keys(EXPENSE_TYPES) as readonly OutstationExpenseType[];

export const OUTSTATION_TRANSPORTATION_TYPES = Object.keys(
  TRANSPORTATION_TYPES,
) as readonly OutstationTransportationType[];

/**
 * Case-sensitive on purpose. "Car" reads like a harmless variant, but the stored value is what
 * the dashboard groups on and what the CHECK constraint compares, so accepting it would trade a
 * silent wrong bucket for a hard database error. The admin UI only ever sends the canonical
 * lowercase form; anything else is a client that is out of step, and it should be told so.
 */
export function isOutstationExpenseType(value: unknown): value is OutstationExpenseType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(EXPENSE_TYPES, value);
}

export function isOutstationTransportationType(
  value: unknown,
): value is OutstationTransportationType {
  return (
    typeof value === "string" && Object.prototype.hasOwnProperty.call(TRANSPORTATION_TYPES, value)
  );
}

/** "traveling, meeting, or other" — the refusal message names every value that would be accepted. */
function listPhrase(values: readonly string[]): string {
  if (values.length <= 1) return values.join("");
  return `${values.slice(0, -1).join(", ")}, or ${values[values.length - 1]}`;
}

export type ManagerExpenseInputRejection = {
  error: string;
  message: string;
};

export const INVALID_EXPENSE_TYPE: ManagerExpenseInputRejection = {
  error: "invalid_expense_type",
  message: `expenseType must be ${listPhrase(OUTSTATION_EXPENSE_TYPES)}.`,
};

export const INVALID_TRANSPORTATION_TYPE: ManagerExpenseInputRejection = {
  error: "invalid_transportation_type",
  message: `transportationType must be ${listPhrase(OUTSTATION_TRANSPORTATION_TYPES)}.`,
};

export type ManagerExpenseAdminPatchResult =
  | { input: Partial<ManagerExpenseAdminInput>; ok: true }
  | (ManagerExpenseInputRejection & { ok: false });

function reject(rejection: ManagerExpenseInputRejection): ManagerExpenseAdminPatchResult {
  return { error: rejection.error, message: rejection.message, ok: false };
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDestination(value: unknown): ManagerExpenseDestination | null {
  if (!isRecord(value)) return null;
  // Never `Number(value.latitude)`: `Number(null)`, `Number("")` and `Number(" ")` are 0, which is
  // finite, so an edit posting a destination with no coordinates passed the check below and
  // updateManagerExpenseAsAdmin wrote 0,0 into the trip's captured_latitude/captured_longitude.
  // The shared reader also drops half a pair and the exact pair 0,0, the same as every other
  // outstation route; either way the result is null and the edit is refused exactly as before.
  const position = readCapturedPosition(value.latitude, value.longitude);
  if (!position) return null;
  return {
    area: optionalText(value.area),
    city: optionalText(value.city),
    country: optionalText(value.country),
    label: typeof value.label === "string" ? value.label : "",
    latitude: position.latitude,
    longitude: position.longitude,
    placeId: typeof value.placeId === "string" ? value.placeId : "",
  };
}

/**
 * Build the service input for an admin edit from a request body.
 *
 * Every field is copied across by name. The body is never spread: an edit may only change the
 * fields this function knows about, so a caller cannot reach a column simply by naming it — and
 * whatever it does reach has been through the same checks the create path applies.
 *
 * A key is present in the result only when the body actually supplied it, because
 * updateManagerExpenseAsAdmin reads several fields with `"x" in input` and falls back to the
 * stored row when the key is absent. Forwarding an explicit null for a field nobody edited is how
 * an optional field gets silently erased.
 */
export function buildManagerExpenseAdminPatch(body: unknown): ManagerExpenseAdminPatchResult {
  const source = isRecord(body) ? body : {};
  const input: Partial<ManagerExpenseAdminInput> = {};

  if (source.expenseType !== undefined) {
    if (!isOutstationExpenseType(source.expenseType)) return reject(INVALID_EXPENSE_TYPE);
    input.expenseType = source.expenseType;
  }

  if (source.transportationType !== undefined) {
    if (!isOutstationTransportationType(source.transportationType)) {
      return reject(INVALID_TRANSPORTATION_TYPE);
    }
    input.transportationType = source.transportationType;
  }

  if (source.destination !== undefined) {
    const destination = readDestination(source.destination);
    if (!destination) {
      return reject({
        error: "invalid_destination",
        message: "Provided destination must have valid coordinates.",
      });
    }
    input.destination = destination;
  }

  if (source.distanceKm !== undefined) {
    const distanceKm = optionalNumber(source.distanceKm);
    // A Meeting entry never prices travel, so zero is a valid distance for it — every other
    // expense type still needs a real, positive one. The modal always sends expenseType
    // alongside distanceKm, so it is available here to decide which rule applies.
    const isMeetingExpense = source.expenseType === "meeting";
    if (distanceKm == null || distanceKm < 0 || (!isMeetingExpense && distanceKm <= 0)) {
      return reject({
        error: "invalid_distance",
        message: "distanceKm must be a positive number.",
      });
    }
    input.distanceKm = distanceKm;
  }

  // A blank date used to be forwarded verbatim and hit the date column as "", which is a 500 the
  // admin cannot act on. Refusing it here says what is actually wrong.
  for (const field of ["tripStartDate", "tripEndDate"] as const) {
    if (source[field] === undefined) continue;
    const value = optionalText(source[field]);
    if (!value) {
      return reject({
        error: "invalid_dates",
        message: "tripStartDate and tripEndDate must be dates when provided.",
      });
    }
    input[field] = value;
  }

  if (source.amWorkload !== undefined) input.amWorkload = optionalNumber(source.amWorkload);
  if (source.claimedTotalAmount !== undefined) {
    input.claimedTotalAmount = Number(source.claimedTotalAmount ?? 0);
  }
  if (source.durationMinutes !== undefined) {
    input.durationMinutes = optionalNumber(source.durationMinutes);
  }
  if (source.meetingAmount !== undefined) input.meetingAmount = optionalNumber(source.meetingAmount);

  // A data URL leaving the field alone is the common case (undefined — most edits touch nothing
  // about the invoice); null is an explicit removal; anything else must be an uploaded file.
  // updateManagerExpenseAsAdmin reads `"meetingInvoiceDataUrl" in input` to tell "untouched" apart
  // from "clear it", so the key must only appear here when the caller actually sent it.
  if (source.meetingInvoiceDataUrl !== undefined) {
    const raw = source.meetingInvoiceDataUrl;
    if (raw === null) {
      input.meetingInvoiceDataUrl = null;
    } else if (typeof raw === "string" && raw.startsWith("data:")) {
      input.meetingInvoiceDataUrl = raw;
    } else {
      return reject({
        error: "invalid_meeting_invoice",
        message: "meetingInvoiceDataUrl must be an uploaded PDF, JPG, or PNG file.",
      });
    }
  }
  if (source.meetingInvoiceFileName !== undefined) {
    input.meetingInvoiceFileName = optionalText(source.meetingInvoiceFileName);
  }

  if (source.notes !== undefined) input.notes = optionalText(source.notes);
  if (source.otherAmount !== undefined) input.otherAmount = optionalNumber(source.otherAmount);
  if (source.pmWorkload !== undefined) input.pmWorkload = optionalNumber(source.pmWorkload);
  if (source.routePolyline !== undefined) {
    input.routePolyline = typeof source.routePolyline === "string" ? source.routePolyline : null;
  }
  if (source.travelCostAmount !== undefined) {
    input.travelCostAmount = optionalNumber(source.travelCostAmount);
  }
  if (source.tripType !== undefined) input.tripType = optionalText(source.tripType);

  // employeeHrId is deliberately NOT forwarded. The edit modal posts the whole input object, so
  // it arrives on every PATCH, but updateManagerExpenseAsAdmin reads the employee from the stored
  // row and always has — an edit reprices a trip, it never moves it to another person.

  return { input, ok: true };
}
