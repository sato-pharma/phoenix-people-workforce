// Recruitment / ATS — the advertising channels a vacancy gets posted to, and what each one produced.
//
// A "channel" is one place an advert goes: a Facebook group, a page, a job board. Each carries a
// short tracking code that rides inside the apply link, comes back on the applicant's own first
// message, and is stamped onto the intake event. That chain is what turns "426 CVs from WhatsApp
// and email" into "these three groups produced every CV worth reading".

import type { AccessContext } from "@/lib/auth/permissions";
import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import { deriveChannelCode, isValidChannelCode, normalizeChannelCode } from "@/lib/recruitment/outreach/channel-code";
import { phoneDigitsTail, resolveForwarderChannelFromList } from "@/lib/recruitment/outreach/forwarder-match";
import { normalizeWhatsAppNumber } from "@/lib/recruitment/outreach/job-advert";
import { hrIdForStorage } from "@/lib/hr-id";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";

export const JOB_POST_CHANNEL_KINDS = [
  "facebook_group",
  "facebook_page",
  "whatsapp_group",
  "whatsapp_channel",
  "telegram_group",
  "telegram_channel",
  "job_board",
  "referral",
  "other",
] as const;
export type JobPostChannelKind = (typeof JOB_POST_CHANNEL_KINDS)[number];

/**
 * Kinds nobody outside their admin team can post into.
 *
 * A WhatsApp or Telegram *channel* is a broadcast feed: following it lets you read, never write.
 * Listing one beside a group you can actually post in — with no visible difference — is how an
 * afternoon disappears into trying to publish somewhere that will never accept a post. The panel
 * labels these, and they still earn a row and a tracking code, because the realistic move is to ask
 * the admin to carry the advert and you still want to know whether that produced anyone.
 */
const BROADCAST_ONLY_KINDS = new Set<JobPostChannelKind>(["whatsapp_channel", "telegram_channel"]);

export function isBroadcastOnly(kind: JobPostChannelKind): boolean {
  return BROADCAST_ONLY_KINDS.has(kind);
}

export type JobPostChannel = {
  id: string;
  name: string;
  code: string;
  url: string | null;
  kind: JobPostChannelKind;
  isActive: boolean;
  notes: string | null;
  createdAt: string | null;
  /**
   * Relay/forwarder WhatsApp numbers whose code-less forwarded CVs are attributed to this channel.
   * A relay is tied to one channel; the on-CV advert code always wins over this fallback.
   */
  forwarderIdentifiers: string[];
  /**
   * The WhatsApp apply line this channel's tracked link sends applicants to, in the form it was
   * typed. Null means the company-wide default. Normalised to a wa.me number at link-build time.
   */
  applyWhatsAppNumber: string | null;
};

export type CreateJobPostChannelInput = {
  name: string;
  url?: string | null;
  kind?: JobPostChannelKind | null;
  code?: string | null;
  notes?: string | null;
};

const TABLE = "ats_job_post_channels";

/**
 * The WhatsApp apply line a newly-added channel is born on.
 *
 * A new channel starts here rather than on the company-wide default, so a group added tomorrow
 * behaves like the 45 channels that were swept onto this line on 2026-09-24 instead of quietly
 * routing applicants back to the old number. The recruiter can still point any single channel
 * elsewhere afterwards from the Advertise tab. Stored in the same local form as the column's
 * existing rows; normalised to a wa.me number at link-build time.
 */
export const NEW_CHANNEL_APPLY_WHATSAPP_NUMBER = "01159888247";

/**
 * The row written for one new channel.
 *
 * Pure and DB-free on purpose: the born-on apply line above is the thing that silently regresses if
 * an insert forgets it, so it is pinned by a test that builds a row rather than by a database
 * round-trip.
 */
export function channelInsertRow(
  input: CreateJobPostChannelInput,
  resolved: { code: string; name: string; hrId: string | null },
): Record<string, unknown> {
  return {
    apply_whatsapp_number: NEW_CHANNEL_APPLY_WHATSAPP_NUMBER,
    code: resolved.code,
    created_by_hr_id: hrIdForStorage(resolved.hrId),
    kind: input.kind ?? "other",
    name: resolved.name,
    notes: textOrNull(input.notes),
    url: textOrNull(input.url),
  };
}

function asKind(value: unknown): JobPostChannelKind {
  const kind = String(value ?? "");
  return (JOB_POST_CHANNEL_KINDS as readonly string[]).includes(kind) ? (kind as JobPostChannelKind) : "other";
}

function mapChannel(row: Record<string, unknown>): JobPostChannel {
  return {
    applyWhatsAppNumber: textOrNull(row.apply_whatsapp_number),
    code: String(row.code ?? ""),
    createdAt: textOrNull(row.created_at),
    forwarderIdentifiers: Array.isArray(row.forwarder_identifiers)
      ? (row.forwarder_identifiers as unknown[]).map((value) => String(value)).filter((value) => value.length > 0)
      : [],
    id: String(row.id ?? ""),
    isActive: row.is_active !== false,
    kind: asKind(row.kind),
    name: String(row.name ?? ""),
    notes: textOrNull(row.notes),
    url: textOrNull(row.url),
  };
}

export async function listJobPostChannels(options?: { includeInactive?: boolean }): Promise<JobPostChannel[]> {
  const supabase = recruitmentDb();
  let query = supabase.from(TABLE).select("*").order("name", { ascending: true });
  if (options?.includeInactive !== true) query = query.eq("is_active", true);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((row) => mapChannel(row as Record<string, unknown>));
}

/**
 * Adds channels, deriving a free code for any that did not bring their own.
 *
 * Bulk by design: the realistic way this list gets built is one paste of twenty group links, not
 * twenty trips through a form. A name that already exists is SKIPPED rather than failing the whole
 * batch — re-pasting a list with three new groups in it should add three groups, not error.
 */
export async function createJobPostChannels(
  inputs: ReadonlyArray<CreateJobPostChannelInput>,
  access: AccessContext,
): Promise<{ created: JobPostChannel[]; skipped: Array<{ name: string; reason: string }> }> {
  const supabase = recruitmentDb();
  const existing = await listJobPostChannels({ includeInactive: true });
  const takenCodes = existing.map((channel) => channel.code);
  const takenNames = new Set(existing.map((channel) => channel.name.trim().toLowerCase()));

  const rows: Array<Record<string, unknown>> = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const input of inputs) {
    const name = String(input.name ?? "").trim();
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (takenNames.has(key)) {
      skipped.push({ name, reason: "already on the list" });
      continue;
    }

    const requested = normalizeChannelCode(input.code);
    if (requested && !isValidChannelCode(requested)) {
      skipped.push({ name, reason: "that code is not a valid PX- code" });
      continue;
    }
    if (requested && takenCodes.includes(requested)) {
      skipped.push({ name, reason: "that code is already used" });
      continue;
    }

    const code = requested ?? deriveChannelCode(name, takenCodes);
    // Reserve inside the loop, so two new groups in ONE paste cannot be handed the same code.
    takenCodes.push(code);
    takenNames.add(key);
    rows.push(channelInsertRow(input, { code, name, hrId: access.hrId }));
  }

  if (rows.length === 0) return { created: [], skipped };
  const { data, error } = await supabase.from(TABLE).insert(rows).select("*");
  if (error) throw error;
  return { created: (data ?? []).map((row) => mapChannel(row as Record<string, unknown>)), skipped };
}

/**
 * Renames a channel, retargets its URL, or retires it.
 *
 * Every field is optional and only the keys actually supplied are written — an omitted `url` must
 * leave the stored URL alone, never blank it. See the repo-wide rule about optional fields written
 * unconditionally being a silent erase.
 *
 * Retiring sets is_active=false and never deletes: the code stays resolvable, so CVs that arrived
 * from a group months ago keep their attribution after the group stops being used.
 */
export async function updateJobPostChannel(
  id: string,
  patch: {
    name?: string;
    url?: string | null;
    kind?: JobPostChannelKind;
    notes?: string | null;
    isActive?: boolean;
    applyWhatsAppNumber?: string | null;
  },
): Promise<JobPostChannel> {
  const supabase = recruitmentDb();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) update.name = String(patch.name).trim();
  if (patch.url !== undefined) update.url = textOrNull(patch.url);
  if (patch.kind !== undefined) update.kind = patch.kind;
  if (patch.notes !== undefined) update.notes = textOrNull(patch.notes);
  if (patch.isActive !== undefined) update.is_active = patch.isActive === true;
  if (patch.applyWhatsAppNumber !== undefined) {
    // A blank clears the override (fall back to the company default); anything else must be a
    // dialable number, or the channel would hand out a link that opens a chat with nobody.
    const trimmed = textOrNull(patch.applyWhatsAppNumber);
    if (trimmed && !normalizeWhatsAppNumber(trimmed)) {
      throw new Error("That is not a usable WhatsApp number.");
    }
    update.apply_whatsapp_number = trimmed;
  }

  const { data, error } = await supabase.from(TABLE).update(update).eq("id", id).select("*").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("That advertising channel no longer exists.");
  return mapChannel(data as Record<string, unknown>);
}

/**
 * The advert channel that owns a forwarding relay handset, resolved from the sender identifier of
 * an inbound CV — or null when there is no match (which is the ordinary case).
 *
 * Called by intake ONLY when the CV carried no advert code of its own, so a real per-group code
 * from the caption, filename or greeting always wins over a relay's blanket attribution. Returns
 * null immediately for anything with no usable phone tail (an email sender, a WhatsApp username
 * with no number), so email intake never runs a channel lookup it could not answer.
 *
 * Retired channels are included: a relay that fed a group months ago keeps attributing, exactly as
 * a tracking code does after its group is retired.
 */
export async function resolveForwarderChannelCode(senderIdentifier: string | null | undefined): Promise<string | null> {
  if (!phoneDigitsTail(senderIdentifier)) return null;
  const channels = await listJobPostChannels({ includeInactive: true });
  return resolveForwarderChannelFromList(channels, senderIdentifier);
}

/**
 * Ties one relay handset to one advert channel, or clears it (channelCode = null).
 *
 * A relay maps to exactly one channel, so the number is first stripped from every channel that
 * currently holds it (matched by 9-digit tail, tolerant of +20 / 20 / 0 forms) and then, if a
 * target is given, appended to that channel. The number is stored in the display form the caller
 * typed; matching always goes through the tail, so the stored form need not be canonical.
 */
export async function assignForwarderToChannel(
  identifier: string,
  channelCode: string | null,
): Promise<void> {
  const supabase = recruitmentDb();
  const tail = phoneDigitsTail(identifier);
  if (!tail) throw new Error("That is not a usable phone number.");
  const display = String(identifier).trim();
  const now = new Date().toISOString();

  const channels = await listJobPostChannels({ includeInactive: true });

  // Remove this relay from any channel that currently holds it (its move away from PX-FORWARDED, or
  // a plain clear). Only channels that actually change are written.
  for (const channel of channels) {
    const kept = channel.forwarderIdentifiers.filter((id) => phoneDigitsTail(id) !== tail);
    if (kept.length !== channel.forwarderIdentifiers.length) {
      const { error } = await supabase
        .from(TABLE)
        .update({ forwarder_identifiers: kept.length > 0 ? kept : null, updated_at: now })
        .eq("id", channel.id);
      if (error) throw error;
    }
  }

  if (channelCode === null) return;

  const wanted = normalizeChannelCode(channelCode);
  const target = channels.find((channel) => channel.code === wanted);
  if (!target) throw new Error("That advertising channel no longer exists.");
  const next = [...target.forwarderIdentifiers.filter((id) => phoneDigitsTail(id) !== tail), display];
  const { error } = await supabase
    .from(TABLE)
    .update({ forwarder_identifiers: next, updated_at: now })
    .eq("id", target.id);
  if (error) throw error;
}

export type ChannelAttributionRow = {
  code: string;
  name: string;
  isActive: boolean;
  /** Distinct candidates whose intake carried this code. */
  candidates: number;
  /** ISO timestamp of the most recent CV from this channel, or null. */
  lastCvAt: string | null;
};

export type ChannelAttribution = {
  rows: ChannelAttributionRow[];
  /** CVs that arrived with no code at all — everything posted before a link existed, plus walk-ins. */
  untracked: number;
  sinceDays: number;
};

/**
 * Candidates per advertising channel.
 *
 * Counts DISTINCT candidates, not intake events: one applicant who sends a CV three times is one
 * candidate, and counting events would flatter whichever group attracts the most re-senders.
 *
 * Aggregated in JS rather than SQL deliberately — this avoids adding an RPC and its grants for a
 * number that is read a few times a week. The intake log passed 1,000 rows long ago (about 5,000 on
 * 2026-11-07), so EVERY row of the window is read, walked by id: a single read stops at one
 * response's worth with no sign, and the newest channels would silently count fewer candidates.
 */
export async function getChannelAttribution(sinceDays = 90): Promise<ChannelAttribution> {
  const supabase = recruitmentDb();
  const since = new Date(Date.now() - Math.max(1, sinceDays) * 24 * 60 * 60 * 1000).toISOString();
  const channels = await listJobPostChannels({ includeInactive: true });

  const data = await fetchAllRowsKeyset<Record<string, unknown>>(
    () =>
      supabase
        .from("ats_cv_intake_events")
        .select("id,source_channel_code,candidate_id,created_at,outcome")
        .gte("created_at", since)
        .in("outcome", ["candidate_created", "candidate_matched"]),
    { cursorColumn: "id", cursorOf: (row) => (typeof row.id === "string" || typeof row.id === "number" ? row.id : null) },
  );

  const seenPerCode = new Map<string, Set<string>>();
  const lastPerCode = new Map<string, string>();
  let untracked = 0;

  for (const raw of data) {
    const row = raw as Record<string, unknown>;
    const code = normalizeChannelCode(textOrNull(row.source_channel_code));
    const candidateId = textOrNull(row.candidate_id);
    if (!candidateId) continue;
    if (!code) {
      untracked += 1;
      continue;
    }
    if (!seenPerCode.has(code)) seenPerCode.set(code, new Set());
    seenPerCode.get(code)?.add(candidateId);
    const createdAt = textOrNull(row.created_at);
    if (createdAt && (lastPerCode.get(code) ?? "") < createdAt) lastPerCode.set(code, createdAt);
  }

  const rows = channels
    .map((channel) => ({
      candidates: seenPerCode.get(channel.code)?.size ?? 0,
      code: channel.code,
      isActive: channel.isActive,
      lastCvAt: lastPerCode.get(channel.code) ?? null,
      name: channel.name,
    }))
    .sort((a, b) => b.candidates - a.candidates || a.name.localeCompare(b.name));

  return { rows, sinceDays, untracked };
}
