/**
 * On-demand screen recording of ONE rep tablet, captured by the tablet and filed in Phoenix.
 *
 * WHAT THIS IS. The owner asked (2026-10-22) for screen RECORDING on the Tablet Dashboard, after live
 * view and control: the Super Admin presses Record on one tablet, the tablet records its own screen
 * for a set length and uploads the file here, and he plays it back in the dashboard whenever he likes,
 * with nobody watching live. Calls and messages are never recorded — they do not exist in this stack.
 *
 * WHERE THE CAPTURE HAPPENS, AND WHY NOT IN THE PHOENIX APP. The alarm and message actions push an
 * `intent` to `com.satopharma.phoenixworkforce`, the Expo app under `mobile/` — which is FROZEN, so it
 * cannot grow a screen-capture handler. The capture therefore belongs in the Phoenix RustDesk-fork
 * launcher, which already runs Android MediaProjection for live view and already holds the one-time
 * capture grant. So the record push is aimed at the RustDesk package, never the frozen app, and the
 * device-side handler is a contract this file documents, built in that fork's own repo.
 *
 * HOW THE UPLOAD IS AUTHENTICATED, WITHOUT A SHARED SECRET REACHING A DEVICE. A tablet's Headwind
 * configuration is world-readable (a known hole), so no long-lived secret may travel to it. Each
 * request instead mints a random token, stores only its SHA-256 on the row, and sends the plaintext to
 * the one tablet in the push payload. The upload endpoint matches the token against that hash, once,
 * inside a short window; the hash is cleared the moment the file lands. The worst a leaked token buys
 * is one capture slot, for minutes. The size filed is the byte count of the file that actually arrived
 * on the request — never a number the tablet sends (audit, 2026-10-26, point 24: this sentence used to
 * say the stored object was re-read, which it never was).
 *
 * ONE UPLOAD PER SLOT, EVEN WHEN TWO ARRIVE AT ONCE (same point). The token is claimed by a
 * compare-and-set — the hash is cleared on the one row that is still `requested` AND still holds that
 * hash — and only the request that cleared it may store a file, with `upsert: false`. It used to be a
 * read, then a store that overwrote, then an update by id alone, so two uploads with one token both
 * passed and the second silently replaced the first.
 *
 * THE SLOT IS FOUND BEFORE THE BODY IS READ (same point). The address the tablet is told to upload to
 * carries the recording's id (`?recordingId=`), so the door reads that one row and refuses an unknown,
 * handled, closed or expired slot before it buffers a byte of a video of up to 256 MB. Without it, a
 * caller with no token at all could make the server hold 256 MB per request, ten a minute per address.
 *
 * THE SECURITY BOUNDARY IS THE ROUTE, NOT THIS MODULE. `requestRecording` and `listRecordings` run
 * only behind `company_devices:approve` in their route handlers; `ingestRecording` is the device's
 * door and is guarded solely by the per-recording token checked here.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { callHeadwind } from "@/lib/devices/headwind/client";
import { HeadwindCommandInputError, resolveHeadwindActionTarget } from "@/lib/devices/headwind/target";
import { rustDeskPackageName } from "@/lib/devices/rustdesk/config";
import { isUuid } from "@/lib/http/uuid";
import { logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const TABLET_RECORDING_BUCKET = "device-screen-recordings";
export const TABLET_RECORDING_TABLE = "device_screen_recordings";

export const RECORDING_DEFAULT_SECONDS = 60;
export const RECORDING_MIN_SECONDS = 5;
export const RECORDING_MAX_SECONDS = 300;
/** How long a minted upload token is honoured. A capture plus its upload fits comfortably inside. */
export const RECORDING_TOKEN_TTL_SECONDS = 15 * 60;
/** How long a playback link the dashboard hands the browser stays valid. */
export const RECORDING_SIGNED_URL_TTL_SECONDS = 60 * 60;
/** The bucket's own ceiling, matched here so an oversize upload is refused before it is stored. */
export const RECORDING_MAX_BYTES = 268_435_456;
export const RECORDING_ALLOWED_MIME = ["video/mp4", "video/webm"] as const;
/**
 * The largest REQUEST the upload door reads: the file's own cap plus room for the multipart framing
 * and the three small form fields. Judged on `Content-Length` before a byte of the body is read
 * (point 24), and the reason this one route is left out of the proxy matcher: the proxy copies a
 * matched body only up to 10 MB, so every recording longer than a few seconds used to arrive cut off.
 * Pinned against the proxy in tests/proxy-upload-body-limit.test.ts.
 */
export const RECORDING_UPLOAD_MAX_REQUEST_BYTES = RECORDING_MAX_BYTES + 64 * 1024;
/** Upload attempts one address may make a minute. A tablet makes one per recording. */
export const RECORDING_UPLOAD_RATE_LIMIT = 10;
export const RECORDING_UPLOAD_RATE_WINDOW_MS = 60_000;
/** The query parameter on the upload address that names the slot, read before the body is. */
export const RECORDING_UPLOAD_ID_PARAM = "recordingId";

/**
 * The intent the Phoenix RustDesk-fork launcher handles to start a capture.
 *
 * 🔴 NOT the `com.satopharma.phoenixworkforce.*` namespace — that is the FROZEN Expo app. This is a
 * distinct action, delivered to the RustDesk package, so no capture code is ever added to `mobile/`.
 */
export const PHOENIX_RECORD_INTENT = "com.satopharma.phoenix.tablet.RECORD_SCREEN";

export type RecordingStatus = "requested" | "ready" | "failed" | "expired";

export type TabletRecording = {
  id: string;
  deviceNumber: string;
  assetTag: string | null;
  requestedByHrId: string;
  status: RecordingStatus;
  /** ISO-8601; the console formats it in Cairo time. */
  requestedAt: string;
  durationRequestedS: number;
  capturedSeconds: number | null;
  sizeBytes: number | null;
  uploadedAt: string | null;
  error: string | null;
  /** A short-lived signed link, only for a `ready` recording; null otherwise. */
  playbackUrl: string | null;
};

type RecordingDbRow = {
  id: string;
  device_number: string;
  asset_tag: string | null;
  requested_by_hr_id: string;
  status: string;
  requested_at: string;
  duration_requested_s: number;
  captured_seconds: number | null;
  size_bytes: number | null;
  uploaded_at: string | null;
  error: string | null;
  storage_path: string;
};

const RECORDING_COLUMNS =
  "id, device_number, asset_tag, requested_by_hr_id, status, requested_at, duration_requested_s, captured_seconds, size_bytes, uploaded_at, error, storage_path";

/** Parse and clamp the asked length to the allowed window, defaulting a missing or junk value. */
export function clampRecordingDuration(input: unknown): number {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n)) return RECORDING_DEFAULT_SECONDS;
  return Math.min(RECORDING_MAX_SECONDS, Math.max(RECORDING_MIN_SECONDS, Math.round(n)));
}

/** The hash stored on the row — the token itself is never written down. */
export function hashRecordingToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokensMatch(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashRecordingToken(presented), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function normaliseContentType(value: string | null): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

export type UploadDecision = { ok: true } | { ok: false; status: number; reason: string };

type SlotRow = { status: string; requestedAtMs: number; uploadTokenHash: string | null } | null;

/**
 * Whether a slot's upload window has run out. PURE. An unreadable request time counts as run out —
 * a slot whose age cannot be told is never left open for ever.
 */
export function recordingSlotExpired(requestedAtMs: number, nowMs: number): boolean {
  return !Number.isFinite(requestedAtMs) || nowMs > requestedAtMs + RECORDING_TOKEN_TTL_SECONDS * 1000;
}

/**
 * The status a person is shown. PURE.
 *
 * 🔴 NOTHING EVER WRITES `expired`, SO IT IS READ (audit, 9 Nov 2026, F13b). A slot the tablet never
 * filled stays `requested` on its row; without this the list said "Recording…" beside it for ever.
 * Past `RECORDING_TOKEN_TTL_SECONDS` it is expired — the same clock the upload door refuses it on.
 */
export function recordingDisplayStatus(status: string, requestedAtMs: number, nowMs: number): RecordingStatus {
  if (status === "requested") return recordingSlotExpired(requestedAtMs, nowMs) ? "expired" : "requested";
  return (["ready", "failed", "expired"].includes(status) ? status : "failed") as RecordingStatus;
}

/**
 * Whether a slot can still take an upload, judged on its row alone — before any token or body. PURE.
 * These are the first four refusals of `recordingUploadDecision`, which calls this.
 */
export function recordingSlotOpenDecision(row: SlotRow, nowMs: number): UploadDecision {
  if (!row) return { ok: false, reason: "No such recording request.", status: 404 };
  if (row.status !== "requested") return { ok: false, reason: "This recording has already been handled.", status: 409 };
  if (!row.uploadTokenHash) return { ok: false, reason: "This recording slot is already closed.", status: 410 };
  if (recordingSlotExpired(row.requestedAtMs, nowMs)) {
    return { ok: false, reason: "This recording slot has expired.", status: 410 };
  }
  return { ok: true };
}

/**
 * Where one capture is stored in the bucket. PURE.
 *
 * 🔴 THE TABLET'S NUMBER IS MADE SAFE FOR A STORAGE KEY (audit, 9 Nov 2026). It is whatever an admin
 * typed into Headwind, so a `/` would add a folder, a `..` would climb one, and a character Storage
 * refuses (Arabic, `%`, `#`) would fail the upload AFTER the tablet had recorded. Only letters, digits,
 * `-` and `_` survive; the recording's own id keeps every path unique whatever the number folds to.
 */
export function recordingStoragePath(deviceNumber: string, recordingId: string): string {
  const folder = deviceNumber.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "tablet";
  return `${folder}/${recordingId}.mp4`;
}

/** The ISO-BMFF (mp4) box types a file can open with. An mp4 writer puts `ftyp` first; the rest are legal openers. */
const MP4_FIRST_BOXES = new Set(["ftyp", "styp", "free", "skip", "wide", "mdat", "moov"]);
const WEBM_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

/**
 * Whether the bytes are the container the upload says they are. PURE.
 *
 * 🔴 THE TYPE WAS THE TABLET'S OWN WORD (audit, 9 Nov 2026). The door checked only the declared
 * `video/mp4` or `video/webm`, so a holder of a token — and a token rides a push any long-poll on that
 * device number can read — could file any bytes at all as a "recording" the Super Admin later opens.
 * An mp4 opens with an ISO-BMFF box (size, then a four-letter type); a webm with the EBML magic.
 */
export function recordingContainerMatches(bytes: Uint8Array, contentType: string | null): boolean {
  const type = normaliseContentType(contentType);
  if (type === "video/webm") return bytes.length >= 4 && WEBM_MAGIC.every((byte, index) => bytes[index] === byte);
  if (type === "video/mp4") {
    if (bytes.length < 8) return false;
    return MP4_FIRST_BOXES.has(String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!));
  }
  return false;
}

/**
 * Whether one upload may be accepted. PURE — no I/O — so every refusal is proven without a database.
 * Caller supplies the row it read, the presented token, the clock, the byte count and the content type.
 */
export function recordingUploadDecision(input: {
  row: SlotRow;
  presentedToken: string;
  nowMs: number;
  sizeBytes: number;
  contentType: string | null;
}): UploadDecision {
  const { row, presentedToken, nowMs, sizeBytes, contentType } = input;
  const open = recordingSlotOpenDecision(row, nowMs);
  if (!open.ok) return open;
  const storedHash = row?.uploadTokenHash ?? "";
  if (!presentedToken || !storedHash || !tokensMatch(presentedToken, storedHash)) {
    return { ok: false, reason: "The upload token does not match.", status: 403 };
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes < 1) return { ok: false, reason: "The upload is empty.", status: 400 };
  if (sizeBytes > RECORDING_MAX_BYTES) return { ok: false, reason: "The recording is larger than the limit.", status: 413 };
  const type = normaliseContentType(contentType);
  if (!RECORDING_ALLOWED_MIME.includes(type as (typeof RECORDING_ALLOWED_MIME)[number])) {
    return { ok: false, reason: "Only mp4 or webm video is accepted.", status: 415 };
  }
  return { ok: true };
}

/**
 * Whether the upload door may read this request's body at all, judged on its `Content-Length` alone.
 * PURE. A body with no declared length (chunked) is refused 411 — the door would otherwise have to read
 * it to learn how big it is, which is the buffering this check exists to prevent. Node frames the body
 * by that header, so a declared length is the most it can carry.
 */
export function recordingUploadLengthDecision(contentLength: string | null): UploadDecision {
  const raw = (contentLength ?? "").trim();
  if (!raw) return { ok: false, reason: "Send the file with a Content-Length.", status: 411 };
  if (!/^\d+$/.test(raw)) return { ok: false, reason: "The Content-Length is not a number.", status: 400 };
  const length = Number(raw);
  if (length < 1) return { ok: false, reason: "The upload is empty.", status: 400 };
  if (length > RECORDING_UPLOAD_MAX_REQUEST_BYTES) {
    return { ok: false, reason: "The recording is larger than the limit.", status: 413 };
  }
  return { ok: true };
}

/**
 * Whether the slot named on the upload address can still take an upload — one row read, before the
 * door reads the body. A missing or malformed id is refused without a read (every id is a v4 UUID);
 * a read that fails answers 503, so the tablet retries rather than being told the slot is gone.
 */
export async function checkRecordingSlotOpen(recordingId: string): Promise<UploadDecision> {
  const id = recordingId.trim();
  if (!id) return { ok: false, reason: "Upload to the address the recording request gave, with its recordingId.", status: 400 };
  if (!isUuid(id)) return { ok: false, reason: "The recordingId is not a recording id.", status: 400 };
  const read = await getSupabaseAdmin()
    .from(TABLET_RECORDING_TABLE)
    .select("status, requested_at, upload_token_hash")
    .eq("id", id)
    .maybeSingle();
  if (read.error) return { ok: false, reason: "The recording slot could not be read.", status: 503 };
  const row = read.data as { status: string; requested_at: string; upload_token_hash: string | null } | null;
  return recordingSlotOpenDecision(
    row ? { requestedAtMs: new Date(row.requested_at).getTime(), status: row.status, uploadTokenHash: row.upload_token_hash } : null,
    Date.now(),
  );
}

/** The address one tablet uploads one recording to; it names the slot so the door can check it first. */
export function recordingUploadUrl(uploadBaseUrl: string, recordingId: string): string {
  const base = `${uploadBaseUrl.replace(/\/+$/, "")}/api/devices/recordings/upload`;
  return `${base}?${RECORDING_UPLOAD_ID_PARAM}=${encodeURIComponent(recordingId)}`;
}

function toRecording(row: RecordingDbRow, playbackUrl: string | null, nowMs: number): TabletRecording {
  const requestedAtMs = new Date(row.requested_at).getTime();
  return {
    assetTag: row.asset_tag,
    capturedSeconds: row.captured_seconds,
    deviceNumber: row.device_number,
    durationRequestedS: Number(row.duration_requested_s),
    error: row.error,
    id: row.id,
    playbackUrl,
    requestedAt: typeof row.requested_at === "string" ? row.requested_at : new Date(row.requested_at).toISOString(),
    requestedByHrId: row.requested_by_hr_id,
    sizeBytes: row.size_bytes,
    status: recordingDisplayStatus(row.status, requestedAtMs, nowMs),
    uploadedAt: row.uploaded_at,
  };
}

/**
 * Open a recording slot for one tablet and tell the tablet to start.
 *
 * Resolves the tablet against the LIVE fleet first (a capture cannot be aimed at a tablet that is gone,
 * and the audit names the real one by its custody asset tag), mints a single-use token, writes the
 * `requested` row, pushes the record intent to the tablet's RustDesk-fork launcher, and audits it.
 */
export async function requestRecording(input: {
  deviceNumber: string;
  durationSeconds?: unknown;
  actor: string;
  /** The origin the tablet uploads back to, e.g. the production domain. */
  uploadBaseUrl: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): Promise<TabletRecording> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const env = input.env ?? process.env;
  const deviceNumber = input.deviceNumber.trim();
  if (!deviceNumber) throw new HeadwindCommandInputError("Say which tablet to record.");

  const target = await resolveHeadwindActionTarget(deviceNumber, fetchImpl, env);
  const durationRequestedS = clampRecordingDuration(input.durationSeconds);
  const id = randomUUID();
  const token = randomBytes(32).toString("hex");
  const storagePath = recordingStoragePath(target.deviceNumber, id);
  const requestedAt = new Date().toISOString();

  const supabase = getSupabaseAdmin();
  const insert = await supabase.from(TABLET_RECORDING_TABLE).insert({
    asset_tag: target.assetTag,
    device_number: target.deviceNumber,
    duration_requested_s: durationRequestedS,
    id,
    requested_at: requestedAt,
    requested_by_hr_id: input.actor,
    status: "requested",
    storage_path: storagePath,
    upload_token_hash: hashRecordingToken(token),
  });
  if (insert.error) throw new Error(`Could not open a recording slot: ${insert.error.message}`);

  const uploadUrl = recordingUploadUrl(input.uploadBaseUrl, id);
  try {
    await callHeadwind(
      "/rest/private/push",
      {
        body: JSON.stringify({
          broadcast: false,
          deviceNumbers: [target.deviceNumber],
          messageType: "intent",
          payload: JSON.stringify({
            action: PHOENIX_RECORD_INTENT,
            extra: { durationSeconds: durationRequestedS, recordingId: id, token, uploadUrl },
            pkg: rustDeskPackageName(env),
          }),
        }),
        method: "POST",
      },
      fetchImpl,
      env,
    );
  } catch (error) {
    // 🔴 A PUSH THAT FAILED CLOSES ITS SLOT (audit, 9 Nov 2026, F13c). The row was written first, so a
    // refused or timed-out push used to leave a `requested` slot with a live token behind it, listed as
    // "Recording…". It is marked failed with the reason and its token is spent, so even a push that did
    // land behind a lost reply cannot file a capture nobody was told had started.
    await closeRecordingSlot(id, `The record request did not reach the tablet: ${errorText(error)}`);
    throw error;
  }

  await writeRequiredAuditLog({
    actorLoginId: input.actor,
    entityId: target.deviceNumber,
    entityType: "headwind_device_command",
    newValues: { assetTag: target.assetTag, command: "START_RECORDING", durationSeconds: durationRequestedS, recordingId: id },
    oldValues: null,
    summary: `Started a screen recording on ${target.subject}`,
  });

  return {
    assetTag: target.assetTag,
    capturedSeconds: null,
    deviceNumber: target.deviceNumber,
    durationRequestedS,
    error: null,
    id,
    playbackUrl: null,
    requestedAt,
    requestedByHrId: input.actor,
    sizeBytes: null,
    status: "requested",
    uploadedAt: null,
  };
}

function errorText(error: unknown): string {
  const text = error instanceof Error && error.message ? error.message : String(error);
  return text.slice(0, 500);
}

/** Mark a still-open slot failed, with the reason, and spend its token. Never throws: it runs on a failure path. */
async function closeRecordingSlot(id: string, reason: string): Promise<void> {
  try {
    const closed = await getSupabaseAdmin()
      .from(TABLET_RECORDING_TABLE)
      .update({ error: reason, status: "failed", upload_token_hash: null })
      .eq("id", id)
      .eq("status", "requested");
    if (closed.error) throw new Error(closed.error.message);
  } catch (error) {
    // The slot still expires on its own clock (`recordingSlotExpired`); this only says it is not closed yet.
    logWarning("A tablet recording slot could not be marked failed", {
      error,
      labels: { event: "tablet_recording_slot_close_failed", job: "devices/recordings" },
    });
  }
}

/** The recordings for one tablet, newest first, each ready one carrying a short-lived playback link. */
export async function listRecordings(deviceNumber: string, limit = 50): Promise<{ recordings: TabletRecording[] }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(TABLET_RECORDING_TABLE)
    .select(RECORDING_COLUMNS)
    .eq("device_number", deviceNumber.trim())
    .order("requested_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not read the recordings: ${error.message}`);
  const rows = (data ?? []) as RecordingDbRow[];
  const nowMs = Date.now();
  const recordings = await Promise.all(
    rows.map(async (row) => {
      let playbackUrl: string | null = null;
      if (row.status === "ready" && row.storage_path) {
        const signed = await supabase.storage
          .from(TABLET_RECORDING_BUCKET)
          .createSignedUrl(row.storage_path, RECORDING_SIGNED_URL_TTL_SECONDS);
        playbackUrl = signed.data?.signedUrl ?? null;
      }
      return toRecording(row, playbackUrl, nowMs);
    }),
  );
  return { recordings };
}

/**
 * The tablet's door: store one captured file against its slot. Authenticated solely by the per-recording
 * token matched here — no session, no shared secret. Returns an HTTP status and a small JSON body.
 */
export async function ingestRecording(input: {
  recordingId: string;
  token: string;
  bytes: Uint8Array;
  contentType: string | null;
  capturedSeconds: number | null;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const id = input.recordingId.trim();
  if (!id) return { body: { error: "missing_recording_id" }, status: 400 };

  const supabase = getSupabaseAdmin();
  const read = await supabase
    .from(TABLET_RECORDING_TABLE)
    .select("id, status, requested_at, upload_token_hash, storage_path")
    .eq("id", id)
    .maybeSingle();
  // 🔴 A READ THAT FAILED IS NOT "NO SUCH RECORDING" (audit, 9 Nov 2026). It fell through to the 404,
  // which tells the tablet the slot is gone, so it stopped retrying a capture a moment's outage cost.
  // 503, the same answer `checkRecordingSlotOpen` gives, so the tablet tries again.
  if (read.error) return { body: { error: "The recording slot could not be read." }, status: 503 };
  const row = read.data as Pick<RecordingDbRow, "id" | "status" | "requested_at" | "storage_path"> & {
    upload_token_hash: string | null;
  } | null;

  const sizeBytes = input.bytes.byteLength;
  const decision = recordingUploadDecision({
    contentType: input.contentType,
    nowMs: Date.now(),
    presentedToken: input.token,
    row: row ? { requestedAtMs: new Date(row.requested_at).getTime(), status: row.status, uploadTokenHash: row.upload_token_hash } : null,
    sizeBytes,
  });
  if (!decision.ok) return { body: { error: decision.reason }, status: decision.status };
  // Before the claim, so bytes that are not a video never spend the slot the real capture needs.
  if (!recordingContainerMatches(input.bytes, input.contentType)) {
    return { body: { error: "The file is not the mp4 or webm video it says it is." }, status: 415 };
  }

  // CLAIM THE SLOT, ATOMICALLY: clear the hash on the one row still `requested` that still holds the
  // hash this token matched. Of two uploads racing on one token, exactly one gets the row back; the
  // other is refused here, before it can store anything (point 24).
  const claim = await supabase
    .from(TABLET_RECORDING_TABLE)
    .update({ upload_token_hash: null })
    .eq("id", id)
    .eq("status", "requested")
    .eq("upload_token_hash", row!.upload_token_hash!)
    .select("id");
  if (claim.error) return { body: { error: "claim_failed" }, status: 500 };
  if ((claim.data ?? []).length !== 1) {
    return { body: { error: "This recording has already been handled." }, status: 409 };
  }

  const contentType = normaliseContentType(input.contentType) || "video/mp4";
  // upsert: false — a file already at this path is never overwritten, whoever put it there.
  const upload = await supabase.storage
    .from(TABLET_RECORDING_BUCKET)
    .upload(row!.storage_path, input.bytes, { contentType, upsert: false });
  if (upload.error) {
    await supabase
      .from(TABLET_RECORDING_TABLE)
      .update({ error: `storage: ${upload.error.message}`, status: "failed" })
      .eq("id", id)
      .eq("status", "requested");
    return { body: { error: "storage_failed" }, status: 502 };
  }

  const captured = normaliseCaptured(input.capturedSeconds);
  const update = await supabase
    .from(TABLET_RECORDING_TABLE)
    .update({
      captured_seconds: captured,
      size_bytes: sizeBytes,
      status: "ready",
      upload_token_hash: null,
      uploaded_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "requested");
  if (update.error) return { body: { error: "update_failed" }, status: 500 };

  return { body: { ok: true }, status: 200 };
}

function normaliseCaptured(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 1) return null;
  return Math.min(600, rounded);
}
