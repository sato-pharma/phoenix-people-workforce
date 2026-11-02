/**
 * The Phoenix field set, as an ADMIN report may print it.
 *
 * Owner, 2026-10-07, asked directly: the old CRM reports get "everything, GPS and evidence included"
 * from Phoenix CRM. A report that shows a vendor visit in full and a Phoenix visit in outline is the
 * same drop he asked us to remove — so every column the rep's app records reaches the admin reports,
 * through `crm_visits_unified` (migration 20261008010000).
 *
 * 🔴 WHAT EACH READER MAY SEE IS DECIDED HERE, ONCE, AND IT IS NOT THE SAME FOR EVERYONE. Phoenix CRM
 * golden rule #1 is that every integrity signal is readable only ABOVE the rep, in three tiers the
 * owner set on 2026-10-02, and "everything on the admin reports" does not reopen a sight he narrowed
 * himself six days earlier:
 *
 *   - `full`     — the Super Admin and the SFE Manager: the accuracy behind a reading, the raw point,
 *                  the photo's own fix, the phone-clock warning, the capture timings and the dwell.
 *   - `distance` — every other admin reader (a District Manager, an RSM, the NSM, the CEO): the
 *                  distance and the far / at-the-place wording, and nothing about the reading behind
 *                  it. A weak reading reads as its plain distance, never as a doubt.
 *   - `none`     — a reader looking at his OWN row as its rep: no distance, no flag, no check, and no
 *                  capture timing either. The rep's own portal does not call this file at all
 *                  (`src/lib/employee-portal/my-crm-visits.ts` selects none of these columns); this
 *                  tier is the backstop for an admin report a rep's own row can reach.
 *
 * The WORK half — products, samples, the pharmacy's stock, the objection the doctor raised, the next
 * step, an off-plan visit — is his own work and never an integrity signal, so every admin reader
 * reads it whole, at every tier.
 *
 * The door carries every measurement and decides none of this: hiding a column in the view would
 * blind the Super Admin too, which is not what he ruled.
 */
// 🔴 FROM THE CLIENT-SAFE MODULE, never `server/visits.ts`. That file reaches `getSupabaseAdmin`, and
// this shaper is reachable from an admin report whose renderer is a client component — importing it
// there would put the service-role client in a browser bundle. The wording is the same one copy.
import { visitLocationFor, type VisitLocationFlag } from "@/lib/phoenix-crm/visit-location-words";
import { isUnplannedKind, unplannedKindLabel } from "@/lib/phoenix-crm/unplanned-rules";
import { phoenixVisitKindLabel } from "@/lib/phoenix-crm/visit-kind-labels";
import { isVisitNextStep, isVisitObjection, visitNextStepLabel, visitObjectionLabel } from "@/lib/phoenix-crm/visit-outcome";

/**
 * The 29 appended columns, as one select list.
 *
 * 🔴 A SELECT IS A STRING, so a reader that prints one of these and forgets to ask for it reads
 * `undefined` and prints a blank — the exact shape of the defect this whole change exists to remove.
 * Every admin report adds this constant to its own column list rather than naming the columns again.
 */
export const PHOENIX_VISIT_DETAIL_COLUMNS =
  "visit_kind, entered_by_hr_id, products, samples_given, product_availability, objection, objection_note, " +
  "next_step, next_step_on, visit_pharmacy_name, is_unplanned, unplanned_kind, photo_path, voice_note_path, " +
  "voice_note_seconds, lat, lon, accuracy_meters, distance_meters, location_flag, photo_lat, photo_lon, " +
  "photo_accuracy_meters, dwell_seconds, form_open_seconds, capture_source, offline_seconds, " +
  "device_skew_minutes, phoenix_synced_at";

/** A door row's Phoenix half. Every field is optional: a vendor row and a day activity carry none. */
export type PhoenixVisitDetailRow = {
  visit_kind?: string | null;
  entered_by_hr_id?: string | null;
  products?: string[] | null;
  samples_given?: Record<string, unknown> | null;
  product_availability?: Record<string, unknown> | null;
  objection?: string | null;
  objection_note?: string | null;
  next_step?: string | null;
  next_step_on?: string | null;
  visit_pharmacy_name?: string | null;
  is_unplanned?: boolean | null;
  unplanned_kind?: string | null;
  photo_path?: string | null;
  voice_note_path?: string | null;
  voice_note_seconds?: number | null;
  lat?: number | null;
  lon?: number | null;
  accuracy_meters?: number | string | null;
  distance_meters?: number | null;
  location_flag?: string | null;
  photo_lat?: number | null;
  photo_lon?: number | null;
  photo_accuracy_meters?: number | string | null;
  dwell_seconds?: number | null;
  form_open_seconds?: number | null;
  capture_source?: string | null;
  offline_seconds?: number | null;
  device_skew_minutes?: number | null;
  phoenix_synced_at?: string | null;
};

/**
 * The field set's own keys, lifted off a door row and nothing else.
 *
 * Every report's row mapper calls this instead of naming the 29 columns a second time: a second list is
 * a second place for one to go missing, and a missing one reads `undefined` and prints a blank — which
 * on this screen is indistinguishable from a visit that recorded nothing. Derived from
 * `PHOENIX_VISIT_DETAIL_COLUMNS`, so the select list and the pick can never disagree.
 */
const DETAIL_KEYS = PHOENIX_VISIT_DETAIL_COLUMNS.split(",").map((part) => part.trim());

export function pickPhoenixVisitDetailRow(row: Record<string, unknown>): PhoenixVisitDetailRow {
  const picked: Record<string, unknown> = {};
  for (const key of DETAIL_KEYS) {
    if (key in row) picked[key] = row[key];
  }
  return picked as PhoenixVisitDetailRow;
}

export type PhoenixDetailSight = "none" | "distance" | "full";

/** The two roles that read the measurement BEHIND a reading (`readsLocationDetail`, same two roles). */
const FULL_SIGHT_ROLES = new Set(["Super Admin", "SFE Manager"]);

/**
 * How much of a Phoenix visit's integrity half this admin reader may see.
 *
 * 🔴 It asks the ROLE and nothing else, deliberately: the Phoenix CRM module answers the same question
 * through `locationSight(viewer, seat)`, which needs the org tree and a seat, and an admin report has
 * neither. The two agree where they overlap — `readsLocationDetail` is these same two roles — and the
 * own-row tier is passed in by the caller, because only the report knows whose row it is drawing.
 */
export function phoenixDetailSight(role: string | null | undefined, options: { ownRow?: boolean } = {}): PhoenixDetailSight {
  if (role && FULL_SIGHT_ROLES.has(role)) return "full";
  return options.ownRow ? "none" : "distance";
}

/** A report's reader: the tier his role earns, and who he is — because his OWN rows are blind. */
export type PhoenixDetailViewer = { sight: PhoenixDetailSight; ownHrIdKey: string | null };

export function phoenixDetailViewer(role: string | null | undefined, hrId: string | null | undefined): PhoenixDetailViewer {
  return { sight: phoenixDetailSight(role), ownHrIdKey: hrIdKey(hrId) };
}

function hrIdKey(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The tier for ONE row — golden rule #1's own-row half, which no page-wide answer can give.
 *
 * A reader looking at a visit whose AGENT is himself reads no distance, no flag and no check: it is
 * his own work, and the rule is absolute (`isLocationBlind`, made so by the owner on 2026-09-29). A
 * visit he merely rode along on is the REP's row, not his, so he keeps the measurement — that is the
 * same boundary the Phoenix CRM module draws, and it is why this asks the agent column alone.
 *
 * The Super Admin and the SFE Manager are never blinded, including on their own rows: the measurement
 * is their job.
 */
export function phoenixRowSight(viewer: PhoenixDetailViewer, agentHrId: unknown): PhoenixDetailSight {
  if (viewer.sight === "full") return "full";
  const agent = hrIdKey(typeof agentHrId === "string" ? agentHrId : null);
  return agent !== null && agent === viewer.ownHrIdKey ? "none" : viewer.sight;
}

export type PhoenixVisitDetail = {
  /** "Single visit" · "Double visit" · "Chain visit" · the product-manager ask's own wording. */
  kindLabel: string | null;
  /** Whoever typed the row. An HR id, because only the report holds a name map (names, never codes). */
  enteredByHrId: string | null;
  products: string[];
  /** "Ivyronc ×1 · Guamusin ×2" — what he actually left behind. */
  samples: string | null;
  /** "Ivyronc in stock · Guamusin out of stock" — the pharmacy's shelf, as he found it. */
  availability: string | null;
  /** "Side effects or safety — <what was said>", the doctor's objection and never a mark on the rep. */
  objection: string | null;
  /** "Follow up next visit (12 Oct)". */
  nextStep: string | null;
  /** A pharmacy he named as FEEDBACK on a doctor's call. Never a pharmacy call — see the migration. */
  pharmacyFeedback: string | null;
  /** "Out of plan" · "Out of list", or null on a planned visit. */
  offPlan: string | null;
  /** Photo · voice note · how long he stood there. The dwell is `full` only — it is behaviour. */
  evidence: string | null;
  /** The distance sentence this reader may read, accuracy included at `full` only. */
  location: string | null;
  /** How the row was captured, offline for how long, the phone's clock, when it synced. `full` only. */
  capture: string | null;
};

const EMPTY: PhoenixVisitDetail = {
  kindLabel: null,
  enteredByHrId: null,
  products: [],
  samples: null,
  availability: null,
  objection: null,
  nextStep: null,
  pharmacyFeedback: null,
  offPlan: null,
  evidence: null,
  location: null,
  capture: null,
};

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function count(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function isLocationFlag(value: unknown): value is VisitLocationFlag {
  return value === "ok" || value === "far" || value === "weak_gps" || value === "no_place";
}

/** "2 min 10 sec", never a bare number of seconds a reader has to divide in his head. */
function duration(seconds: number | null): string | null {
  if (seconds === null || seconds < 0) return null;
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} sec`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} sec`;
}

/** A day, as the owner reads one: "12 Oct". Never an ISO string on a screen. */
function shortDay(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getUTCDate()} ${parsed.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;
}

/** Cairo wall clock, to the minute — every time this platform prints is Cairo local. */
function cairoMinute(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString("en-GB", {
    timeZone: "Africa/Cairo",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function join(parts: Array<string | null>): string | null {
  const kept = parts.filter((part): part is string => Boolean(part));
  return kept.length > 0 ? kept.join(" · ") : null;
}

function stringMap(value: unknown): Array<[string, unknown]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>);
}

/**
 * One Phoenix visit's detail, as this reader may read it.
 *
 * A row with no `visit_kind` is a vendor row or a day activity and returns EMPTY — the reports print
 * nothing there, never a zero, because iReports360 genuinely never carried any of this.
 */
export function phoenixVisitDetail(row: PhoenixVisitDetailRow, sight: PhoenixDetailSight): PhoenixVisitDetail {
  const kindLabel = phoenixVisitKindLabel(row.visit_kind);
  if (!kindLabel) return EMPTY;

  const objection = text(row.objection);
  const objectionNote = text(row.objection_note);
  const nextStep = text(row.next_step);
  const nextStepOn = shortDay(text(row.next_step_on));

  const samples = stringMap(row.samples_given)
    .map(([product, given]) => {
      const many = count(given);
      return many && many > 0 ? `${product} ×${many}` : null;
    })
    .filter((part): part is string => Boolean(part));

  const availability = stringMap(row.product_availability)
    .map(([product, state]) => (state === "has" ? `${product} in stock` : state === "missing" ? `${product} out of stock` : null))
    .filter((part): part is string => Boolean(part));

  const flag = isLocationFlag(row.location_flag) ? row.location_flag : null;
  // 🔴 NULL AT `none`, NOT `BLIND_LOCATION`. The Phoenix CRM app's own visit card has a location field
  // that must say something, so a blinded row there carries the words "Visit saved". A REPORT row has
  // no such field: an empty cell is the honest answer, and printing "Visit saved" would spend a line
  // of a merged cell saying nothing while reading, to anyone scanning the column, like a verdict.
  const location =
    flag && sight !== "none"
      ? visitLocationFor(sight, flag, count(row.distance_meters), count(row.accuracy_meters), false, count(row.lat) !== null && count(row.lon) !== null).locationLabel
      : null;

  // The photo's own fix and the dwell are the Super Admin's and SFE's (golden rule #1, tier 2): a
  // District Manager reads that a photo exists, never where the phone thought it was taken.
  const photoFix =
    sight === "full" && count(row.photo_lat) !== null && count(row.photo_lon) !== null
      ? `photo fix ${count(row.photo_lat)?.toFixed(5)}, ${count(row.photo_lon)?.toFixed(5)}`
      : null;

  return {
    kindLabel,
    enteredByHrId: text(row.entered_by_hr_id),
    products: Array.isArray(row.products) ? row.products.filter((entry): entry is string => typeof entry === "string") : [],
    samples: samples.length > 0 ? samples.join(" · ") : null,
    availability: availability.length > 0 ? availability.join(" · ") : null,
    // `none` is an ANSWER, not an empty row — the rep tapped "No objection" (visit-outcome.ts), so it
    // is printed as such rather than collapsed to a blank a manager would read as "he never filled it".
    objection: objection
      ? join([isVisitObjection(objection) ? visitObjectionLabel(objection) : objection, objectionNote])
      : null,
    nextStep: nextStep
      ? [isVisitNextStep(nextStep) ? visitNextStepLabel(nextStep) : nextStep, nextStepOn ? `(${nextStepOn})` : null]
          .filter(Boolean)
          .join(" ")
      : null,
    pharmacyFeedback: text(row.visit_pharmacy_name),
    offPlan: row.is_unplanned
      ? unplannedKindLabel(isUnplannedKind(row.unplanned_kind) ? row.unplanned_kind : "out_of_plan")
      : null,
    evidence: join([
      text(row.photo_path) ? "Photo" : null,
      text(row.voice_note_path) ? `Voice note ${duration(count(row.voice_note_seconds)) ?? ""}`.trim() : null,
      sight === "full" ? (duration(count(row.dwell_seconds)) ? `${duration(count(row.dwell_seconds))} at the door` : null) : null,
      photoFix,
    ]),
    location,
    capture:
      sight === "full"
        ? join([
            text(row.capture_source) === "server" ? "Entered on the server" : text(row.capture_source) ? "Captured on the phone" : null,
            count(row.offline_seconds) ? `offline ${duration(count(row.offline_seconds))}` : null,
            count(row.form_open_seconds) ? `form open ${duration(count(row.form_open_seconds))}` : null,
            count(row.device_skew_minutes) ? `phone clock ${count(row.device_skew_minutes)} min out` : null,
            cairoMinute(text(row.phoenix_synced_at)) ? `synced ${cairoMinute(text(row.phoenix_synced_at))}` : null,
          ])
        : null,
  };
}

/**
 * The same detail as ONE COLUMN EACH, for an XLSX export.
 *
 * A sheet has no viewport, so the fits-the-screen rule does not apply to it and nothing has to be
 * merged: a manager filtering a column wants the objection in its own cell. The tiers are identical —
 * a sheet is not a reason to widen anyone's sight, and a column this reader may not read is absent
 * rather than empty, so a blank never reads as "there was no reading".
 */
export function phoenixVisitDetailColumns(
  row: PhoenixVisitDetailRow,
  sight: PhoenixDetailSight,
): Record<string, string | number | null> {
  const detail = phoenixVisitDetail(row, sight);
  const base: Record<string, string | number | null> = {
    "Visit kind": detail.kindLabel,
    Products: detail.products.length > 0 ? detail.products.join(", ") : null,
    "Samples given": detail.samples,
    "Pharmacy stock": detail.availability,
    Objection: detail.objection,
    "Next step": detail.nextStep,
    "Pharmacy named": detail.pharmacyFeedback,
    "Off plan": detail.offPlan,
    Photo: text(row.photo_path) ? "Yes" : null,
    "Voice note": duration(count(row.voice_note_seconds)),
    Location: detail.location,
    "Distance (m)": sight === "none" ? null : count(row.distance_meters),
  };
  if (sight !== "full") return base;
  return {
    ...base,
    "Accuracy (m)": count(row.accuracy_meters),
    Latitude: count(row.lat),
    Longitude: count(row.lon),
    "Photo latitude": count(row.photo_lat),
    "Photo longitude": count(row.photo_lon),
    "Photo accuracy (m)": count(row.photo_accuracy_meters),
    "At the door": duration(count(row.dwell_seconds)),
    "Form open": duration(count(row.form_open_seconds)),
    "Captured by": detail.kindLabel === null ? null : text(row.capture_source) === "server" ? "Server" : "Phone",
    "Offline for": duration(count(row.offline_seconds)),
    "Phone clock out (min)": count(row.device_skew_minutes),
    Synced: cairoMinute(text(row.phoenix_synced_at)),
  };
}

/** The sheet's own header order, so every export writes the same columns in the same places. */
export function phoenixVisitDetailHeaders(sight: PhoenixDetailSight): string[] {
  return Object.keys(phoenixVisitDetailColumns({ visit_kind: "single" }, sight));
}
