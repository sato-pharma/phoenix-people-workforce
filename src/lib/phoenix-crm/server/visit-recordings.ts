/**
 * Phoenix CRM — the visit recording, server side: who must record, the upload slot, the claim a save
 * makes, who may listen, and the Super Admin's own page.
 *
 * Owner, 2026-10-16 — the rule and his answers are in `../visit-recording-rules.ts`. In short: the Super
 * Admin switches a rep on, and from then on that rep records the conversation before any step of logging
 * a visit; nobody else's Add visit changes at all.
 *
 * THE SHAPE IS THE VOICE NOTE'S, IN ITS OWN TABLE AND ITS OWN BUCKET (`./voice-notes.ts` says why a
 * recording never shares the photo table). The phone asks for a slot when the recording STOPS, PUTs the
 * audio straight into the private bucket, and the save claims it with the visit's own client-made id —
 * BEFORE `phoenix_crm_save_visit`, so a visit of a rep on the list can never be written without one.
 *
 * NO DATING AUTHORITY. Nothing here returns an issue time, and `phoenix_crm_claim_visit_recording`
 * returns the stored size. A recording says nothing about where or when the visit was; it is what was
 * said, kept as audio, never transcribed.
 *
 * WHO HEARS IT (his answer 4, "a & b"): the Super Admin, the SFE managers, and the rep's own managers
 * above the territory — `managerChain`, which never reaches the CEO. The rep does not: the recording is
 * a check on the visit, and Golden Rule #1 keeps every check above him.
 *
 * WHO DOWNLOADS AND DELETES (his answer 7): the Super Admin, at any time. Nothing is deleted on its own.
 * A delete removes the file through the Storage API (never a delete on `storage.objects`, which the
 * database refuses) and stamps who and when on the row, which is kept.
 *
 * 🔴 THIS FILE OPENS THE RECORDINGS BUCKET AND NO OTHER, and no other file opens it —
 * `tests/phoenix-crm-boundary.test.ts` holds each server file to the one bucket it owns.
 */

import crypto from "node:crypto";

import { ApiError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import {
  readTestFlag,
  territoryForVisit,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, numberOrNull, selectByIds, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { managerChain, personKey, TERRITORY_TIER, type OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  recordingDownloadName,
  type RecordingListRow,
  type RecordingRepRow,
  type VisitRecordingAdminView,
  VISIT_RECORDING_MAX_SECONDS,
  VISIT_RECORDING_MIN_SECONDS,
  VISIT_RECORDING_REQUIRED_CODE,
} from "@/lib/phoenix-crm/visit-recording-rules";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const PHOENIX_CRM_RECORDING_BUCKET = "phoenix-crm-recordings";

/** A rep records one conversation per visit; far above a day's visits, low enough to stop a loop. */
const SLOTS_PER_HOUR = 30;
const SIGNED_URL_SECONDS = 600;

/** The containers a browser records, and the only extensions a recording's path may carry. */
const EXTENSIONS: Record<string, string> = {
  ".webm": "audio/webm",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
};

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

function storageSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "territory";
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? ".webm" : path.slice(dot).toLowerCase();
}

// ── Who must record ────────────────────────────────────────────────────────────────────────────

/**
 * Whether this person is on the Super Admin's list. A failed read THROWS rather than answering no: the
 * list is his decision, and a quiet "no" would let a chosen rep log a visit with nothing recorded.
 */
export async function isRecordingRequired(hrId: string): Promise<boolean> {
  const key = personKey(hrId);
  if (!key) return false;
  const { data, error } = await getSupabaseAdmin().from("phoenix_crm_recording_required").select("hr_id").eq("hr_id", key).limit(1);
  throwIfError(error);
  return (data ?? []).length > 0;
}

// ── The upload slot ────────────────────────────────────────────────────────────────────────────

export type RecordingSlot = { path: string; signedUrl: string; token: string; contentType: string };

/**
 * A slot for the rep about to send a finished recording. Only the territory's own rep records — a
 * manager entering a visit, or the Super Admin recording a missed one, is never asked for one.
 */
export async function requestRecordingSlot(viewer: PhoenixCrmViewer, raw: unknown): Promise<RecordingSlot> {
  const body = record(raw);
  const extension = String(body.extension ?? "").toLowerCase();
  const contentType = EXTENSIONS[extension];
  if (!contentType) throw validationError("That recording format is not one Phoenix accepts. Record the visit again.");
  const { seat, isTest, enteredAs } = territoryForVisit(viewer, body.seatId, readTestFlag(body.test));
  if (enteredAs !== "rep") throw forbiddenError("A visit recording is made by the territory's own rep.");

  const supabase = getSupabaseAdmin();
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await supabase
    .from("phoenix_crm_visit_recordings")
    .select("path", { count: "exact", head: true })
    .eq("issued_to_hr_id", viewer.hrId)
    .eq("is_test", isTest)
    .gte("issued_at", since);
  throwIfError(recent.error);
  if ((recent.count ?? 0) >= SLOTS_PER_HOUR) {
    throw new ApiError(429, "rate_limited", "Many recordings were sent in the last hour. Wait a few minutes and try again.");
  }

  const [year, month] = viewer.cairoToday.split("-");
  const path = `${isTest ? "test/" : ""}${storageSegment(seat.seatId)}/${year}/${month}/${crypto.randomUUID()}${extension}`;
  const { error: slotError } = await supabase.from("phoenix_crm_visit_recordings").insert({
    path,
    issued_to_hr_id: viewer.hrId,
    seat_id: seat.seatId,
    is_test: isTest,
  });
  throwIfError(slotError);

  const { data, error } = await supabase.storage.from(PHOENIX_CRM_RECORDING_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw error ?? new Error("The recording upload could not be prepared.");
  return { path, signedUrl: data.signedUrl, token: data.token, contentType };
}

// ── The claim a save makes ─────────────────────────────────────────────────────────────────────

export type RecordingClaim = { path: string; seconds: number };

/** The recording the save body carries, shaped; null when it carries none. */
export function readRecordingClaim(raw: unknown): RecordingClaim | null {
  const body = record(raw);
  const path = textOrNull(body.recordingPath);
  const seconds = numberOrNull(body.recordingSeconds);
  if (!path || seconds === null) return null;
  return { path, seconds: Math.round(seconds) };
}

/**
 * The gate `saveVisit` asks before it writes anything: a rep on the list must carry a recording, and the
 * recording must stand on THIS visit. Returns nothing — it refuses or it lets the save go on.
 *
 * Asked only when the territory's own rep is saving (`enteredAs === "rep"`).
 */
export async function claimRequiredRecording(input: {
  viewer: PhoenixCrmViewer;
  seat: OrgSeat;
  isTest: boolean;
  visitId: string;
  raw: unknown;
}): Promise<void> {
  if (!(await isRecordingRequired(input.viewer.hrId))) return;
  const claim = readRecordingClaim(input.raw);
  if (!claim) {
    throw new ApiError(409, VISIT_RECORDING_REQUIRED_CODE, "Record the visit first. The visit can be logged once the recording is sent.");
  }
  if (claim.seconds < VISIT_RECORDING_MIN_SECONDS) {
    throw new ApiError(409, "phoenix_crm_recording_too_short", "A visit recording is at least 30 seconds long. Record the visit again.");
  }
  await callPhoenixCrm<number>("phoenix_crm_claim_visit_recording", {
    p_path: claim.path,
    p_hr_id: input.viewer.hrId,
    p_seat_id: input.seat.seatId,
    p_is_test: input.isTest,
    p_visit_id: input.visitId,
    // The recorder stops itself at fifteen minutes; a minute of slack covers a slow last chunk.
    p_seconds: Math.min(claim.seconds, VISIT_RECORDING_MAX_SECONDS + 60),
  });
}

// ── Who hears it ───────────────────────────────────────────────────────────────────────────────

/** The Super Admin, an SFE manager, or a manager on this territory's own chain. Never the rep himself. */
export function hearsVisitRecording(viewer: PhoenixCrmViewer, seat: OrgSeat): boolean {
  if (viewer.isSuperAdmin || viewer.isSfeManager) return true;
  return managerChain(viewer.org, seat.seatId).some((member) => member.hrId === viewer.hrId);
}

/** The length of each visit's recording, for the visits a viewer may hear. Deleted recordings are absent. */
export async function loadRecordingSecondsByVisit(visitIds: ReadonlyArray<string>): Promise<Map<string, number>> {
  const rows = await selectByIds<Row>("phoenix_crm_visit_recordings", "path, visit_id, seconds, deleted_at", "visit_id", visitIds);
  const out = new Map<string, number>();
  for (const row of rows) {
    const visitId = textOrNull(row.visit_id);
    const seconds = numberOrNull(row.seconds);
    if (visitId && seconds !== null && row.deleted_at === null) out.set(visitId, seconds);
  }
  return out;
}

async function recordingOfVisit(visitId: string): Promise<Row | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_visit_recordings")
    .select("path, seat_id, is_test, seconds, bytes, deleted_at, visit_id")
    .eq("visit_id", visitId)
    .limit(1);
  throwIfError(error);
  const row = ((data ?? []) as Row[])[0];
  return row && row.deleted_at === null ? row : null;
}

function seatOf(viewer: PhoenixCrmViewer, seatId: unknown): OrgSeat | null {
  const seat = typeof seatId === "string" ? viewer.org.seats.get(seatId) : undefined;
  return seat && seat.tier === TERRITORY_TIER ? seat : null;
}

/**
 * A ten-minute playback link for one visit's recording. Anything the viewer may not hear answers as if
 * there were no recording — a refusal that named it would tell a reader it exists.
 */
export async function signVisitRecording(viewer: PhoenixCrmViewer, rawVisitId: unknown): Promise<{ url: string; seconds: number | null }> {
  const visitId = String(rawVisitId ?? "").trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(visitId)) throw validationError("Open the visit again.");
  const row = await recordingOfVisit(visitId);
  const seat = row ? seatOf(viewer, row.seat_id) : null;
  const sameWorld = row ? row.is_test === viewer.isTestPersona : false;
  if (!row || !seat || !sameWorld || !hearsVisitRecording(viewer, seat)) {
    throw notFoundError("This visit has no recording to play.");
  }
  const { data, error } = await getSupabaseAdmin()
    .storage.from(PHOENIX_CRM_RECORDING_BUCKET)
    .createSignedUrl(String(row.path), SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) throw notFoundError("This visit has no recording to play.");
  return { url: data.signedUrl, seconds: numberOrNull(row.seconds) };
}

// ── The Super Admin's page ─────────────────────────────────────────────────────────────────────

/** The Super Admin, and never a test account — the same gate as the touch trail. */
export function canManageVisitRecording(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin && viewer.canUpdate && !viewer.isTestPersona;
}

function assertManager(viewer: PhoenixCrmViewer): void {
  if (!canManageVisitRecording(viewer)) throw forbiddenError("Only the Super Admin manages visit recording.");
}

export type { RecordingListRow, RecordingRepRow, VisitRecordingAdminView } from "@/lib/phoenix-crm/visit-recording-rules";

/** How far back the page lists recordings. Older ones stay stored; nothing here deletes them. */
const LIST_DAYS = 90;

export async function loadVisitRecordingAdmin(viewer: PhoenixCrmViewer): Promise<VisitRecordingAdminView> {
  assertManager(viewer);
  const supabase = getSupabaseAdmin();
  const sinceDate = new Date(Date.now() - LIST_DAYS * 24 * 60 * 60 * 1000);
  const since = sinceDate.toISOString();

  const [requiredRows, recordingRows] = await Promise.all([
    fetchAllRowsKeyset<Row>(() => supabase.from("phoenix_crm_recording_required").select("hr_id, set_by_hr_id, set_at"), {
      cursorColumn: "hr_id",
      cursorOf: (row) => String(row.hr_id),
    }),
    fetchAllRowsKeyset<Row>(
      () =>
        supabase
          .from("phoenix_crm_visit_recordings")
          .select("path, visit_id, seat_id, issued_to_hr_id, claimed_at, seconds, bytes")
          .eq("is_test", false)
          .is("deleted_at", null)
          .not("visit_id", "is", null)
          .gte("claimed_at", since),
      { cursorColumn: "path", cursorOf: (row) => String(row.path) },
    ),
  ]);

  const required = new Map(requiredRows.map((row) => [String(row.hr_id), row]));
  // Every occupied rep seat, one row per PERSON: a person on two territories is switched once.
  const seatsByPerson = new Map<string, OrgSeat[]>();
  for (const seat of viewer.org.territories) {
    if (!seat.occupantHrId) continue;
    const held = seatsByPerson.get(seat.occupantHrId) ?? [];
    held.push(seat);
    seatsByPerson.set(seat.occupantHrId, held);
  }

  const visits = await selectByIds<Row>(
    "phoenix_crm_visits",
    "id, visit_date, captured_at, rep_hr_id, customer:phoenix_crm_customers!customer_id(name)",
    "id",
    recordingRows.map((row) => textOrNull(row.visit_id)),
  );
  const visitById = new Map(visits.map((row) => [String(row.id), row]));

  const names = await loadPeopleNames([
    ...seatsByPerson.keys(),
    ...requiredRows.map((row) => textOrNull(row.set_by_hr_id)),
    ...recordingRows.map((row) => textOrNull(row.issued_to_hr_id)),
  ]);

  const joinDistinct = (values: Array<string | null | undefined>) => [...new Set(values.filter((value): value is string => Boolean(value)))].join(" · ");

  const reps: RecordingRepRow[] = [...seatsByPerson.entries()].map(([hrId, seats]) => {
    const switched = required.get(hrId);
    return {
      hrId,
      name: nameOf(names, hrId),
      lineName: joinDistinct(seats.map((seat) => seat.lineName)) || "No line",
      areaName: joinDistinct(seats.map((seat) => seat.areaName)) || "No area",
      regionName: joinDistinct(seats.map((seat) => seat.regionName)),
      required: Boolean(switched),
      setByName: switched ? nameOf(names, textOrNull(switched.set_by_hr_id)) : null,
      setAt: switched ? textOrNull(switched.set_at) : null,
    };
  });
  // A switched-on rep who no longer holds a seat is still on the list, so he can still be switched off.
  for (const [hrId, row] of required) {
    if (seatsByPerson.has(hrId)) continue;
    reps.push({
      hrId,
      name: nameOf(names, hrId),
      lineName: "No seat now",
      areaName: "No seat now",
      regionName: "",
      required: true,
      setByName: nameOf(names, textOrNull(row.set_by_hr_id)),
      setAt: textOrNull(row.set_at),
    });
  }
  reps.sort((left, right) => left.lineName.localeCompare(right.lineName) || left.areaName.localeCompare(right.areaName) || left.name.localeCompare(right.name));

  const recordings: RecordingListRow[] = recordingRows
    .map((row) => {
      const visitId = String(row.visit_id);
      const visit = visitById.get(visitId);
      // A claim whose visit was never written (the save failed after the claim) is not a visit's recording.
      if (!visit) return null;
      const seat = viewer.org.seats.get(String(row.seat_id));
      const customer = record(visit.customer);
      return {
        path: String(row.path),
        visitId,
        visitDate: String(visit.visit_date),
        capturedAt: String(visit.captured_at),
        repName: nameOf(names, textOrNull(row.issued_to_hr_id)),
        customerName: textOrNull(customer.name) ?? "Customer",
        lineName: seat?.lineName ?? "No line",
        areaName: seat?.areaName ?? "No area",
        seconds: numberOrNull(row.seconds),
        bytes: numberOrNull(row.bytes),
      };
    })
    .filter((row): row is RecordingListRow => row !== null)
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));

  return { reps, recordings, since: since.slice(0, 10) };
}

/** Switch a rep on or off. Only a person who holds or held a rep seat can be switched on. */
export async function setRecordingRequired(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ hrId: string; required: boolean }> {
  assertManager(viewer);
  const body = record(raw);
  const hrId = personKey(textOrNull(body.hrId));
  if (!hrId) throw validationError("Choose a rep from the list.");
  const required = body.required === true;
  const supabase = getSupabaseAdmin();
  if (required) {
    const holdsSeat = viewer.org.territories.some((seat) => seat.occupantHrId === hrId);
    if (!holdsSeat) throw validationError("This person holds no rep seat now, so there is nothing to record. Reload the page.");
    const { error } = await supabase
      .from("phoenix_crm_recording_required")
      .upsert({ hr_id: hrId, set_by_hr_id: viewer.hrId, set_at: new Date().toISOString() }, { onConflict: "hr_id", ignoreDuplicates: true });
    throwIfError(error);
  } else {
    const { error } = await supabase.from("phoenix_crm_recording_required").delete().eq("hr_id", hrId);
    throwIfError(error);
  }
  return { hrId, required };
}

async function liveRecording(path: string): Promise<Row> {
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_visit_recordings")
    .select("path, visit_id, issued_to_hr_id, deleted_at, is_test")
    .eq("path", path)
    .limit(1);
  throwIfError(error);
  const row = ((data ?? []) as Row[])[0];
  if (!row || row.deleted_at !== null || row.is_test === true) throw notFoundError("This recording is no longer there. Reload the page.");
  return row;
}

/** A ten-minute link that saves the file, named after the rep, the customer and the day. */
export async function downloadVisitRecording(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ url: string }> {
  assertManager(viewer);
  const path = textOrNull(record(raw).path);
  if (!path) throw validationError("Choose a recording from the list.");
  const row = await liveRecording(path);
  const visitId = textOrNull(row.visit_id);
  const visits = visitId
    ? await selectByIds<Row>("phoenix_crm_visits", "id, visit_date, customer:phoenix_crm_customers!customer_id(name)", "id", [visitId])
    : [];
  const visit = visits[0];
  const names = await loadPeopleNames([textOrNull(row.issued_to_hr_id)]);
  const fileName = recordingDownloadName({
    repName: nameOf(names, textOrNull(row.issued_to_hr_id)),
    customerName: textOrNull(record(visit?.customer).name) ?? "Customer",
    visitDate: textOrNull(visit?.visit_date) ?? "",
    extension: extensionOf(path),
  });
  const { data, error } = await getSupabaseAdmin()
    .storage.from(PHOENIX_CRM_RECORDING_BUCKET)
    .createSignedUrl(path, SIGNED_URL_SECONDS, { download: fileName });
  if (error || !data?.signedUrl) throw notFoundError("This recording could not be opened. Reload the page.");
  return { url: data.signedUrl };
}

/**
 * Delete one recording: the file through the Storage API, then the row is stamped with who and when.
 * The row stays, so the visit still reads as recorded-and-deleted rather than never recorded.
 */
export async function deleteVisitRecording(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ path: string }> {
  assertManager(viewer);
  const path = textOrNull(record(raw).path);
  if (!path) throw validationError("Choose a recording from the list.");
  await liveRecording(path);
  const supabase = getSupabaseAdmin();
  const { error: removeError } = await supabase.storage.from(PHOENIX_CRM_RECORDING_BUCKET).remove([path]);
  if (removeError) throw removeError;
  const { error } = await supabase
    .from("phoenix_crm_visit_recordings")
    .update({ deleted_at: new Date().toISOString(), deleted_by_hr_id: viewer.hrId })
    .eq("path", path)
    .is("deleted_at", null);
  throwIfError(error);
  return { path };
}
