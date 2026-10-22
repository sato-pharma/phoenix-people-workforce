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
 * is one capture slot, for minutes. The ingest re-reads the stored object's real size — never the
 * tablet's claim — the same discipline the CRM visit recording keeps.
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

/**
 * Whether one upload may be accepted. PURE — no I/O — so every refusal is proven without a database.
 * Caller supplies the row it read, the presented token, the clock, the byte count and the content type.
 */
export function recordingUploadDecision(input: {
  row: { status: string; requestedAtMs: number; uploadTokenHash: string | null } | null;
  presentedToken: string;
  nowMs: number;
  sizeBytes: number;
  contentType: string | null;
}): UploadDecision {
  const { row, presentedToken, nowMs, sizeBytes, contentType } = input;
  if (!row) return { ok: false, reason: "No such recording request.", status: 404 };
  if (row.status !== "requested") return { ok: false, reason: "This recording has already been handled.", status: 409 };
  if (!row.uploadTokenHash) return { ok: false, reason: "This recording slot is already closed.", status: 410 };
  if (nowMs > row.requestedAtMs + RECORDING_TOKEN_TTL_SECONDS * 1000) {
    return { ok: false, reason: "This recording slot has expired.", status: 410 };
  }
  if (!presentedToken || !tokensMatch(presentedToken, row.uploadTokenHash)) {
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

function toRecording(row: RecordingDbRow, playbackUrl: string | null): TabletRecording {
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
    status: (["requested", "ready", "failed", "expired"].includes(row.status) ? row.status : "failed") as RecordingStatus,
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
  const storagePath = `${target.deviceNumber}/${id}.mp4`;
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

  const uploadUrl = `${input.uploadBaseUrl.replace(/\/+$/, "")}/api/devices/recordings/upload`;
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
  const recordings = await Promise.all(
    rows.map(async (row) => {
      let playbackUrl: string | null = null;
      if (row.status === "ready" && row.storage_path) {
        const signed = await supabase.storage
          .from(TABLET_RECORDING_BUCKET)
          .createSignedUrl(row.storage_path, RECORDING_SIGNED_URL_TTL_SECONDS);
        playbackUrl = signed.data?.signedUrl ?? null;
      }
      return toRecording(row, playbackUrl);
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

  const contentType = normaliseContentType(input.contentType) || "video/mp4";
  const upload = await supabase.storage
    .from(TABLET_RECORDING_BUCKET)
    .upload(row!.storage_path, input.bytes, { contentType, upsert: true });
  if (upload.error) {
    await supabase
      .from(TABLET_RECORDING_TABLE)
      .update({ error: `storage: ${upload.error.message}`, status: "failed", upload_token_hash: null })
      .eq("id", id);
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
    .eq("id", id);
  if (update.error) return { body: { error: "update_failed" }, status: 500 };

  return { body: { ok: true }, status: 200 };
}

function normaliseCaptured(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 1) return null;
  return Math.min(600, rounded);
}
