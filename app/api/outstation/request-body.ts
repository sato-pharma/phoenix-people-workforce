import {
  INVALID_EXPENSE_TYPE,
  INVALID_TRANSPORTATION_TYPE,
  isOutstationExpenseType,
  isOutstationTransportationType,
  type ManagerExpenseInputRejection,
} from "@/lib/outstation/manager-expense-input";
import type {
  OutstationCarEvidenceMetadata,
  OutstationExpenseType,
  OutstationTransportationType,
} from "@/lib/outstation/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseCarEvidenceMetadata(body: Record<string, unknown>) {
  const raw = body.carEvidenceMetadata;
  if (!isRecord(raw)) return undefined;

  // Parsed permissively, authorized strictly. This accepts both sources; whether `upload` is
  // ALLOWED for the trip in hand is validateLiveArrivalEvidence's call, and it still refuses
  // anything but `live_camera` on a car trip. Widening the parser is not widening the rule.
  const source =
    raw.source === "live_camera" || raw.source === "upload" ? raw.source : null;
  const capturedAt = typeof raw.capturedAt === "string" ? raw.capturedAt : null;
  const capturedLatitude = Number(raw.capturedLatitude);
  const capturedLocationLabel =
    typeof raw.capturedLocationLabel === "string" ? raw.capturedLocationLabel : null;
  const capturedLongitude = Number(raw.capturedLongitude);
  const employeeHrId = typeof raw.employeeHrId === "string" ? raw.employeeHrId : "";
  const requestDraftId =
    typeof raw.requestDraftId === "string" ? raw.requestDraftId : null;
  const requestId = typeof raw.requestId === "string" ? raw.requestId : null;

  if (!source || !capturedAt) return undefined;

  return {
    capturedAt,
    capturedLatitude,
    capturedLocationLabel,
    capturedLongitude,
    employeeHrId,
    requestDraftId,
    requestId,
    source,
  } satisfies OutstationCarEvidenceMetadata;
}

export function parseCarEvidenceImageDataUrl(body: Record<string, unknown>) {
  const raw = body.carEvidenceImageDataUrl;
  if (typeof raw !== "string") return undefined;

  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

// The employee half of the taxonomy check the admin routes got in #2953.
//
// submit, sync-offline and calculate all built their service input with a bare cast —
// String(body.expenseType ?? "traveling") cast straight to the union type, which is erased at
// build time and checks nothing. The CHECK constraints added with #2953 mean a bad value can no
// longer reach the table, but they turn it into a 23514 the employee sees as an opaque 500, and
// they cannot help /api/outstation/calculate at all, which never writes: an unrecognised
// transportationType there matches neither the car branch nor the train/bus branch in
// calculateOutstationExpense, so the preview comes back priced with no travel cost and a 200.
// An unrecognised expenseType additionally switches off the campaign / double-visit evidence
// rule, because outstationCampaignRuleOutcome returns null for anything that is not exactly
// "traveling".
//
// The taxonomy, the guards and the refusal wording are all imported rather than restated, so the
// employee routes, the admin routes and the database constraints cannot drift apart. The only
// thing that is employee-specific is the DEFAULTING below.

/** What these three routes have always fallen back to when the body omits the field. */
const DEFAULT_EXPENSE_TYPE: OutstationExpenseType = "traveling";
const DEFAULT_TRANSPORTATION_TYPE: OutstationTransportationType = "car";

export type OutstationTypeFieldsResult =
  | {
      expenseType: OutstationExpenseType;
      ok: true;
      transportationType: OutstationTransportationType;
    }
  | (ManagerExpenseInputRejection & { ok: false });

// null, undefined and "" all mean "the client did not choose", so the route default applies. An
// empty string is included deliberately: it is what an untouched form control sends, and it is
// the shape the old `?? "traveling"` cast let through as an empty expense type.
function isUnset(value: unknown) {
  return value === null || value === undefined || value === "";
}

/**
 * Read expenseType / transportationType off an employee request body.
 *
 * An omitted field falls back to the route default — the mobile wizard has always been allowed to
 * leave these out. Anything else must be a value the system recognises; the caller answers 400
 * with the returned error and message, which are the same pair the admin routes return.
 */
export function parseOutstationTypeFields(
  body: Record<string, unknown>,
): OutstationTypeFieldsResult {
  const expenseType = isUnset(body.expenseType) ? DEFAULT_EXPENSE_TYPE : body.expenseType;
  if (!isOutstationExpenseType(expenseType)) {
    return { ...INVALID_EXPENSE_TYPE, ok: false };
  }

  const transportationType = isUnset(body.transportationType)
    ? DEFAULT_TRANSPORTATION_TYPE
    : body.transportationType;
  if (!isOutstationTransportationType(transportationType)) {
    return { ...INVALID_TRANSPORTATION_TYPE, ok: false };
  }

  return { expenseType, ok: true, transportationType };
}
