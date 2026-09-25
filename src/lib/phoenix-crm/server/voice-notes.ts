/**
 * Phoenix CRM — visit voice notes.
 *
 * A rep standing outside a clinic can say in twenty seconds what they will not type in two minutes,
 * and in Egyptian Arabic the keyboard is the slow part. This keeps the AUDIO. Nothing here transcribes,
 * and no speech service sees it — which is the whole difference from `dictation.ts`, where the audio
 * goes to Google or Apple and what saves is text. Both exist on the same form and they are not the
 * same feature.
 *
 * The upload takes the same slot shape as a photo: the phone asks for a slot when the recording stops
 * (not when the microphone opens, so an opened-and-abandoned microphone leaves nothing behind); the
 * server records the path and returns a signed upload URL for that one path; the phone PUTs the audio
 * straight into the private bucket; a save consumes the slot and refuses a path the server did not
 * issue to that person for that territory, one already used, one older than 2 hours, or one whose
 * object never arrived.
 *
 * TWO RULES SEPARATE IT FROM THE PHOTO SLOT, and both are the owner's ruling of 2026-09-25.
 *
 * 1. IT IS ITS OWN TABLE. The obvious move is to widen `phoenix_crm_photo_uploads.purpose` — it is
 *    already a check constraint over ('place','visit') and a third value costs one line. That is
 *    exactly what must not happen. Every consumer of that table treats a row in it as evidence of
 *    PRESENCE, and the strongest of them dates a visit by its `issued_at`. An audio row sitting in the
 *    same table is one forgotten `where purpose = …` away from being read as a photo, and the reading
 *    that matters is the one that decides when somebody was somewhere.
 *
 * 2. IT HAS NO DATING AUTHORITY. A photo is taken where the camera is; a recording can be made in a
 *    car, at home, a week later, and nothing in the audio says otherwise. So a voice slot's issue time
 *    must never date anything. That rule is kept STRUCTURALLY rather than by this comment: photos.ts
 *    exports `photoSlotIssuedAt()`, which `visits.ts` and `list.ts` call to date a visit and a place —
 *    and this module exports no such function. There is nothing here to import, so a later change
 *    cannot reach for it by habit. If one is ever added, this file is the wrong place for it and that
 *    is the whole of the reason.
 *
 * Display is batch-signed for ten minutes, for people who can read the territory.
 */

import crypto from "node:crypto";

import { ApiError, validationError } from "@/lib/http/api-errors";
import { readTestFlag, territoryForVisit, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import type { OrgSeat } from "@/lib/phoenix-crm/scope";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const PHOENIX_CRM_VOICE_BUCKET = "phoenix-crm-voice";

/** A rep records a handful of notes a day. Far above that, low enough to stop a loop. */
const SLOTS_PER_HOUR = 40;
const SIGNED_URL_SECONDS = 600;
const SIGN_BATCH_MAX = 60;

/**
 * The containers a browser actually produces, and the only extensions a path may carry.
 *
 * The photo slot hardcodes `.jpg` because a camera is made to give one format. A recorder is not:
 * Chrome and Firefox give webm/opus, Safari gives mp4/aac, and the slot is issued BEFORE the recording
 * exists, so the server cannot know which. The client therefore names the extension and the server
 * refuses anything outside this list — the same answer, reached the other way round.
 */
const EXTENSIONS: Record<string, string> = {
  ".webm": "audio/webm",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
};

/**
 * The stored object's media type, read from the path's own extension.
 *
 * Exported for the transcription path, which has to tell a speech service what container it is being
 * handed. It reads the SAME map the slot validates against, so a format the slot would refuse can never
 * be described to anything downstream as one of the four.
 */
export function voiceContentType(path: string): string | null {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? null : EXTENSIONS[path.slice(dot).toLowerCase()] ?? null;
}

function storageSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "territory";
}

export type VoiceSlot = { path: string; signedUrl: string; token: string; contentType: string };

/**
 * Deliberately NOT returning `issuedAt`.
 *
 * The photo slot returns it because a later save compares it against the phone's clock and dates the
 * visit by it. Handing the same field back here would put a timestamp with no authority into client
 * state, where the next person to need a capture time would find it already sitting in the payload.
 */
export async function issueVoiceSlot(input: {
  hrId: string;
  seat: OrgSeat;
  isTest: boolean;
  extension: string;
  cairoToday: string;
}): Promise<VoiceSlot> {
  const contentType = EXTENSIONS[input.extension];
  if (!contentType) throw validationError("That recording format is not one Phoenix accepts. Record the note again.");

  const supabase = getSupabaseAdmin();
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await supabase
    .from("phoenix_crm_voice_uploads")
    .select("path", { count: "exact", head: true })
    .eq("issued_to_hr_id", input.hrId)
    .gte("issued_at", since);
  throwIfError(recent.error);
  if ((recent.count ?? 0) >= SLOTS_PER_HOUR) {
    throw new ApiError(429, "rate_limited", "You recorded many notes in the last hour. Wait a few minutes and try again.");
  }

  const [year, month] = input.cairoToday.split("-");
  const path = `${input.isTest ? "test/" : ""}${storageSegment(input.seat.seatId)}/${year}/${month}/${crypto.randomUUID()}${input.extension}`;
  const { error: slotError } = await supabase.from("phoenix_crm_voice_uploads").insert({
    path,
    issued_to_hr_id: input.hrId,
    seat_id: input.seat.seatId,
    is_test: input.isTest,
  });
  throwIfError(slotError);

  const { data, error } = await supabase.storage.from(PHOENIX_CRM_VOICE_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw error ?? new Error("The voice note upload could not be prepared.");
  return { path, signedUrl: data.signedUrl, token: data.token, contentType };
}

/**
 * A slot for the person about to record.
 *
 * Gated on `territoryForVisit` — whoever may enter this territory's visits — and on nothing else.
 * There is no `place` counterpart on purpose: a voice note belongs to a visit, and a purpose argument
 * is the seam the photo table's own `purpose` column already shows leads somewhere unwanted.
 */
export async function requestVoiceSlot(viewer: PhoenixCrmViewer, raw: unknown): Promise<VoiceSlot> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const extension = String(body.extension ?? "").toLowerCase();
  const test = readTestFlag(body.test);
  const { seat, isTest } = territoryForVisit(viewer, body.seatId, test);
  return issueVoiceSlot({ hrId: viewer.hrId, seat, isTest, extension, cairoToday: viewer.cairoToday });
}

/** The territory a stored voice path belongs to, and whether it is a test note. */
export function voicePathTerritory(path: string): { seatSegment: string; isTest: boolean } | null {
  const parts = path.split("/");
  const isTest = parts[0] === "test";
  const rest = isTest ? parts.slice(1) : parts;
  if (rest.length !== 4 || !/^\d{4}$/.test(rest[1]) || !/^\d{2}$/.test(rest[2])) return null;
  if (!/^[0-9a-f-]{36}(\.webm|\.m4a|\.ogg|\.mp3)$/.test(rest[3])) return null;
  return { seatSegment: rest[0], isTest };
}

/** Ten-minute playback URLs for the notes a viewer may hear. Paths outside their scope are refused. */
export async function signVoicePaths(viewer: PhoenixCrmViewer, rawPaths: unknown): Promise<Record<string, string>> {
  const paths = [...new Set((Array.isArray(rawPaths) ? rawPaths : []).map((value) => String(value ?? "").trim()).filter(Boolean))];
  if (paths.length === 0) return {};
  if (paths.length > SIGN_BATCH_MAX) throw validationError(`Ask for at most ${SIGN_BATCH_MAX} voice notes at a time.`);

  const readable = new Set(
    (viewer.isSuperAdmin ? viewer.org.territories : [...viewer.scopeTerritories, ...viewer.ownTerritories]).map((seat) =>
      storageSegment(seat.seatId),
    ),
  );
  for (const path of paths) {
    const owner = voicePathTerritory(path);
    if (!owner || (owner.isTest && !viewer.isSuperAdmin) || !readable.has(owner.seatSegment)) {
      throw new ApiError(403, "forbidden", "A voice note you asked for is outside your scope.");
    }
  }

  const { data, error } = await getSupabaseAdmin().storage.from(PHOENIX_CRM_VOICE_BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS);
  if (error) throw error;
  const signed: Record<string, string> = {};
  for (const entry of data ?? []) {
    if (entry.path && entry.signedUrl && !entry.error) signed[entry.path] = entry.signedUrl;
  }
  return signed;
}

/**
 * The stored bytes of one recording, for a caller that has already decided it may have them.
 *
 * THIS FILE OPENS THE BUCKET; ITS CALLERS DO NOT. `tests/phoenix-crm-boundary.test.ts` allows each
 * server file exactly one bucket and names the owner by filename, so the module's storage access stays
 * in one place a reviewer can read in full — and adding a second file that opens this bucket is the
 * thing that rule exists to stop, not a detail to widen it for. `./voice-transcribe.ts` therefore asks
 * here instead of reaching for `.storage` itself.
 *
 * It authorises NOTHING. Scope, ownership and freshness are the caller's to prove before it calls —
 * `signVoicePaths` above proves scope for playback, and the transcription service proves the much
 * narrower "his own note, just now". A bare path handed straight to this function is a hole; that is
 * why it takes no viewer and can therefore never look like it checked one.
 */
export async function downloadVoiceNote(path: string): Promise<Uint8Array | null> {
  const { data, error } = await getSupabaseAdmin().storage.from(PHOENIX_CRM_VOICE_BUCKET).download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}
