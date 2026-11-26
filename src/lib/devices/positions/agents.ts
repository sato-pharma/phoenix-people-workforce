/**
 * The Phoenix Position agent — the small Android app on a rep tablet that tells Phoenix where the
 * tablet is, without going through the tablet server at all.
 *
 * Owner, 26 Nov 2026: *"why dont we create an apk that is connected to the server and since the apk
 * in on tablet then i can be connected easily and normally 2 server"* — then **"both"**, then
 * **"Build the app"**. #801 shipped the first half (the tablet server now receives what the launcher
 * uploads, which the missing premium plugin had been answering 404). This is the second half, and it
 * depends on nothing: not the launcher's version, not a premium plugin, not the tablet server being
 * up. The app posts here; Phoenix keeps the trail.
 *
 * 🔴 AN INSTALL IS NOT A TABLET, AND THAT IS THE WHOLE SECURITY MODEL. A tablet's Headwind
 * configuration is world-readable — its sync endpoint is public by design — so no long-lived
 * credential may travel through it (the same rule the screen-recording upload lives by,
 * `recordings.ts`). So nothing is provisioned INTO the app. It mints an install id of its own on
 * first run, says hello, and Phoenix hands back a token ONCE; the token lives only in that app's
 * private storage. An install Phoenix has not bound to a tablet is INERT: its positions are kept,
 * but they belong to no tablet and to no rep until someone who can see the tablet binds it
 * (`bindPositionAgent`, from the code — `docs/owner-operations-recipes.md`). A stranger who posts
 * positions therefore claims nothing and appears nowhere near a rep's trail.
 *
 * 🔴 THE POSITIONS ARE KEPT BEFORE THE BIND, AND THE BIND FILLS THEM IN. A tablet that reports for a
 * week before anyone binds it must not lose that week, so `bindPositionAgent` stamps the tablet's
 * number onto the rows already stored.
 *
 * 🔴 A RE-SENT BATCH IS FREE. The agent cannot always tell whether a batch arrived (a reply lost on a
 * dropping connection reads exactly like a refusal), so it sends again — and the unique key
 * `(install_id, recorded_at, latitude, longitude)` makes the second copy a no-op rather than a
 * doubled trail.
 *
 * 🔴 NO PERMISSION IS NOT NO MOVEMENT. An agent with no location permission says so in every call,
 * and that word reaches the tablet page as itself. An agent reporting nothing because Android never
 * granted it the permission must never read as a tablet that did not move.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** One row per install of the agent. */
export const POSITION_AGENT_TABLE = "device_position_agents";

/** One row per fix an install reported. */
export const POSITION_TABLE = "device_positions";

/** The most fixes one call may carry. A tablet out of coverage for a day holds far fewer than this. */
export const POSITION_BATCH_MAX = 240;

/** How many fixes a tablet page reads back by default. */
export const POSITION_HISTORY_LIMIT = 200;

/** A fix older than this is not stored: it is the tablet's clock, not Phoenix's, and it can be wrong. */
export const POSITION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** How far into the future a tablet's clock may be and still be believed. */
export const POSITION_MAX_SKEW_MS = 10 * 60 * 1000;

/** What the agent says about its own location permission. Never guessed from an empty batch. */
export type AgentLocationPermission = "fine" | "coarse" | "background" | "none";

const PERMISSIONS: readonly AgentLocationPermission[] = ["fine", "coarse", "background", "none"];

export class PositionAgentError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PositionAgentError";
    this.status = status;
  }
}

/** The hash stored on the row — the token itself is never written down. */
export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokensMatch(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashAgentToken(presented), "hex");
  const b = Buffer.from(storedHash ?? "", "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** PURE. An install id the agent minted, lower-cased, or null when it is not an id at all. */
export function readInstallId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return UUID.test(id) ? id : null;
}

/** PURE. A short free-text fact the agent reports about itself, trimmed and capped. */
export function readAgentText(value: unknown, max = 80): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ").slice(0, max);
  return text || null;
}

/** PURE. The permission word, or null when the agent did not say — never defaulted to "none". */
export function readPermission(value: unknown): AgentLocationPermission | null {
  if (typeof value !== "string") return null;
  const word = value.trim().toLowerCase();
  return PERMISSIONS.find((permission) => permission === word) ?? null;
}

/** What the tablet says about itself. Every field is what IT claims, and is treated as such. */
export type AgentIntroduction = {
  installId: string;
  androidId: string | null;
  model: string | null;
  manufacturer: string | null;
  androidVersion: string | null;
  agentVersion: string | null;
  locationPermission: AgentLocationPermission | null;
};

/** PURE. The introduction in a hello or a report body, or the sentence refusing it. */
export function readIntroduction(body: unknown): AgentIntroduction {
  const record = (body ?? {}) as Record<string, unknown>;
  const installId = readInstallId(record.installId);
  if (!installId) throw new PositionAgentError("Say which install this is.", 400);
  return {
    agentVersion: readAgentText(record.agentVersion, 24),
    androidId: readAgentText(record.androidId, 32),
    androidVersion: readAgentText(record.androidVersion, 24),
    installId,
    locationPermission: readPermission(record.locationPermission),
    manufacturer: readAgentText(record.manufacturer, 48),
    model: readAgentText(record.model, 64),
  };
}

/** One position the agent reported. `recordedAt` is the TABLET's own time for the fix. */
export type ReportedFix = {
  latitude: number;
  longitude: number;
  recordedAt: string;
  accuracyM: number | null;
  batteryLevel: number | null;
  provider: string | null;
  mock: boolean;
};

function asFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * PURE. The fixes in a report body, and how many were thrown away.
 *
 * 🔴 EVERY REASON A FIX IS DROPPED IS A REASON PHOENIX WOULD OTHERWISE DRAW A LINE THROUGH A PLACE
 * THE TABLET NEVER WAS: a 0/0 pair is Null Island and not a place (the same rule as every other
 * source, `headwind/locations.ts`); a time the tablet's own clock puts in the future or a month back
 * cannot be placed in a trail; a mocked position is kept but MARKED, because the fake-location mark
 * is evidence in itself and deleting it hides what happened.
 */
export function parseReportedFixes(value: unknown, nowMs = Date.now()): { fixes: ReportedFix[]; rejected: number } {
  if (!Array.isArray(value)) return { fixes: [], rejected: 0 };
  const fixes: ReportedFix[] = [];
  let rejected = 0;
  for (const entry of value.slice(0, POSITION_BATCH_MAX)) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const latitude = asFiniteNumber(row.lat ?? row.latitude);
    const longitude = asFiniteNumber(row.lon ?? row.longitude);
    const ts = asFiniteNumber(row.ts ?? row.recordedAtMs);
    if (latitude === null || longitude === null || ts === null) {
      rejected += 1;
      continue;
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      rejected += 1;
      continue;
    }
    if (latitude === 0 && longitude === 0) {
      rejected += 1;
      continue;
    }
    const recordedMs = ts < 1_000_000_000_000 ? ts * 1000 : ts;
    if (recordedMs > nowMs + POSITION_MAX_SKEW_MS || recordedMs < nowMs - POSITION_MAX_AGE_MS) {
      rejected += 1;
      continue;
    }
    const accuracy = asFiniteNumber(row.accuracyM ?? row.accuracy);
    const battery = asFiniteNumber(row.batteryLevel ?? row.battery);
    fixes.push({
      accuracyM: accuracy !== null && accuracy >= 0 && accuracy <= 100_000 ? Math.round(accuracy) : null,
      batteryLevel: battery !== null && battery >= 0 && battery <= 100 ? Math.round(battery) : null,
      latitude,
      longitude,
      mock: row.mock === true,
      provider: readAgentText(row.provider, 16),
      recordedAt: new Date(recordedMs).toISOString(),
    });
  }
  if (Array.isArray(value) && value.length > POSITION_BATCH_MAX) rejected += value.length - POSITION_BATCH_MAX;
  return { fixes, rejected };
}

type AgentRow = {
  install_id: string;
  token_hash: string;
  device_number: string | null;
  android_id: string | null;
  model: string | null;
  manufacturer: string | null;
  android_version: string | null;
  agent_version: string | null;
  location_permission: string | null;
  first_seen_at: string;
  last_seen_at: string;
  last_fix_at: string | null;
  fixes_received: number | string;
  bound_at: string | null;
  bound_by_hr_id: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
};

const AGENT_COLUMNS =
  "install_id, token_hash, device_number, android_id, model, manufacturer, android_version, agent_version, location_permission, first_seen_at, last_seen_at, last_fix_at, fixes_received, bound_at, bound_by_hr_id, revoked_at, revoked_reason";

/** One install, as a screen or a command reads it. The token is never part of this. */
export type PositionAgent = {
  installId: string;
  deviceNumber: string | null;
  androidId: string | null;
  model: string | null;
  manufacturer: string | null;
  androidVersion: string | null;
  agentVersion: string | null;
  locationPermission: AgentLocationPermission | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastFixAt: string | null;
  fixesReceived: number;
  boundAt: string | null;
  boundByHrId: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
};

export function toPositionAgent(row: AgentRow): PositionAgent {
  return {
    agentVersion: row.agent_version,
    androidId: row.android_id,
    androidVersion: row.android_version,
    boundAt: row.bound_at,
    boundByHrId: row.bound_by_hr_id,
    deviceNumber: row.device_number,
    firstSeenAt: row.first_seen_at,
    fixesReceived: Number(row.fixes_received) || 0,
    installId: row.install_id,
    lastFixAt: row.last_fix_at,
    lastSeenAt: row.last_seen_at,
    locationPermission: readPermission(row.location_permission),
    manufacturer: row.manufacturer,
    model: row.model,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}

// ---------------------------------------------------------------------------------------------
// The agent's two doors
// ---------------------------------------------------------------------------------------------

export type AgentHelloResult = {
  /** "enrolled" the first time, and then "known" — a second hello never mints a second token. */
  status: "enrolled" | "known" | "revoked";
  /** The token, handed over exactly once. Null afterwards. */
  token: string | null;
  deviceNumber: string | null;
  bound: boolean;
};

/**
 * The agent's first call: it says who it is, and Phoenix hands back a token once.
 *
 * 🔴 A SECOND HELLO FOR A KNOWN INSTALL MINTS NOTHING. If it did, anyone who learned an install id
 * could ask for that install's token and start writing a real tablet's trail. An agent that lost its
 * token lost its private storage with it, and comes back as a NEW install id — which lands unbound,
 * where it can do no harm.
 */
export async function greetPositionAgent(introduction: AgentIntroduction): Promise<AgentHelloResult> {
  const supabase = getSupabaseAdmin();
  const existing = await supabase
    .from(POSITION_AGENT_TABLE)
    .select("install_id, device_number, revoked_at")
    .eq("install_id", introduction.installId)
    .maybeSingle();
  if (existing.error) throw new PositionAgentError("The install could not be read.", 503);

  const known = existing.data as { device_number: string | null; revoked_at: string | null } | null;
  if (known) {
    const touch = await supabase
      .from(POSITION_AGENT_TABLE)
      .update({
        agent_version: introduction.agentVersion,
        last_seen_at: new Date().toISOString(),
        ...(introduction.locationPermission ? { location_permission: introduction.locationPermission } : {}),
      })
      .eq("install_id", introduction.installId);
    if (touch.error) throw new PositionAgentError("The install could not be updated.", 503);
    return {
      bound: Boolean(known.device_number) && !known.revoked_at,
      deviceNumber: known.device_number,
      status: known.revoked_at ? "revoked" : "known",
      token: null,
    };
  }

  const token = randomBytes(32).toString("hex");
  const insert = await supabase.from(POSITION_AGENT_TABLE).insert({
    agent_version: introduction.agentVersion,
    android_id: introduction.androidId,
    android_version: introduction.androidVersion,
    install_id: introduction.installId,
    location_permission: introduction.locationPermission,
    manufacturer: introduction.manufacturer,
    model: introduction.model,
    token_hash: hashAgentToken(token),
  });
  if (insert.error) throw new PositionAgentError("The install could not be recorded.", 503);
  return { bound: false, deviceNumber: null, status: "enrolled", token };
}

export type PositionReportResult = {
  stored: number;
  rejected: number;
  deviceNumber: string | null;
  bound: boolean;
};

/**
 * The agent's second door: a batch of fixes, authenticated by the token it was given.
 *
 * The fixes are stored whether or not the install is bound — see the file header. A revoked install
 * is refused outright: that is how a lost or replaced tablet is silenced.
 */
export async function recordAgentPositions(input: {
  introduction: AgentIntroduction;
  token: string;
  fixes: readonly ReportedFix[];
  rejected?: number;
}): Promise<PositionReportResult> {
  const supabase = getSupabaseAdmin();
  const read = await supabase
    .from(POSITION_AGENT_TABLE)
    .select("install_id, token_hash, device_number, revoked_at, fixes_received")
    .eq("install_id", input.introduction.installId)
    .maybeSingle();
  if (read.error) throw new PositionAgentError("The install could not be read.", 503);
  const row = read.data as {
    device_number: string | null;
    fixes_received: number | string;
    revoked_at: string | null;
    token_hash: string;
  } | null;
  // 🔴 AN UNKNOWN INSTALL AND A WRONG TOKEN ANSWER THE SAME 401 — a different answer would tell a
  // caller which install ids exist.
  if (!row || !tokensMatch(input.token, row.token_hash)) {
    throw new PositionAgentError("Say hello first.", 401);
  }
  if (row.revoked_at) throw new PositionAgentError("This install is no longer in service.", 403);

  const now = new Date().toISOString();
  let stored = 0;
  if (input.fixes.length > 0) {
    const insert = await supabase
      .from(POSITION_TABLE)
      .upsert(
        input.fixes.map((fix) => ({
          accuracy_m: fix.accuracyM,
          battery_level: fix.batteryLevel,
          device_number: row.device_number,
          install_id: input.introduction.installId,
          latitude: fix.latitude,
          longitude: fix.longitude,
          mock: fix.mock,
          provider: fix.provider,
          recorded_at: fix.recordedAt,
        })),
        { ignoreDuplicates: true, onConflict: "install_id,recorded_at,latitude,longitude" },
      )
      .select("id");
    if (insert.error) throw new PositionAgentError("The positions could not be stored.", 503);
    stored = Array.isArray(insert.data) ? insert.data.length : 0;
  }

  const newest = input.fixes.reduce<string | null>(
    (latest, fix) => (latest === null || fix.recordedAt > latest ? fix.recordedAt : latest),
    null,
  );
  const touch = await supabase
    .from(POSITION_AGENT_TABLE)
    .update({
      agent_version: input.introduction.agentVersion,
      fixes_received: (Number(row.fixes_received) || 0) + stored,
      last_seen_at: now,
      ...(newest ? { last_fix_at: newest } : {}),
      ...(input.introduction.locationPermission ? { location_permission: input.introduction.locationPermission } : {}),
    })
    .eq("install_id", input.introduction.installId);
  if (touch.error) throw new PositionAgentError("The install could not be updated.", 503);

  return {
    bound: Boolean(row.device_number),
    deviceNumber: row.device_number,
    rejected: input.rejected ?? 0,
    stored,
  };
}

// ---------------------------------------------------------------------------------------------
// What a person does with an install
// ---------------------------------------------------------------------------------------------

/** Every install Phoenix knows, newest first — the unbound ones are the ones waiting to be claimed. */
export async function listPositionAgents(): Promise<PositionAgent[]> {
  const read = await getSupabaseAdmin()
    .from(POSITION_AGENT_TABLE)
    .select(AGENT_COLUMNS)
    .order("last_seen_at", { ascending: false })
    .limit(200);
  if (read.error) throw new PositionAgentError(`The installs could not be read: ${read.error.message}`, 503);
  return ((read.data ?? []) as AgentRow[]).map(toPositionAgent);
}

/** One install by its id, or null. */
export async function getPositionAgent(installId: string): Promise<PositionAgent | null> {
  const id = readInstallId(installId);
  if (!id) throw new PositionAgentError("That is not an install id.", 400);
  const read = await getSupabaseAdmin().from(POSITION_AGENT_TABLE).select(AGENT_COLUMNS).eq("install_id", id).maybeSingle();
  if (read.error) throw new PositionAgentError(`The install could not be read: ${read.error.message}`, 503);
  return read.data ? toPositionAgent(read.data as AgentRow) : null;
}

/** The live install bound to a tablet, or null when that tablet has none. */
export async function getAgentForDevice(deviceNumber: string): Promise<PositionAgent | null> {
  const number = deviceNumber.trim();
  if (!number) return null;
  const read = await getSupabaseAdmin()
    .from(POSITION_AGENT_TABLE)
    .select(AGENT_COLUMNS)
    .eq("device_number", number)
    .is("revoked_at", null)
    .maybeSingle();
  if (read.error) throw new PositionAgentError(`The tablet's agent could not be read: ${read.error.message}`, 503);
  return read.data ? toPositionAgent(read.data as AgentRow) : null;
}

/**
 * Bind an install to a tablet: from here its positions are that tablet's, and so are the ones it
 * already sent.
 */
export async function bindPositionAgent(input: {
  installId: string;
  deviceNumber: string;
  actor: string;
}): Promise<PositionAgent> {
  const installId = readInstallId(input.installId);
  if (!installId) throw new PositionAgentError("That is not an install id.", 400);
  const number = input.deviceNumber.trim();
  if (!number) throw new PositionAgentError("Say which tablet this install is.", 400);

  const agent = await getPositionAgent(installId);
  if (!agent) throw new PositionAgentError("No install has said hello with that id.", 404);
  if (agent.revokedAt) throw new PositionAgentError("That install was taken out of service; it cannot be bound.", 409);

  const taken = await getAgentForDevice(number);
  if (taken && taken.installId !== installId) {
    throw new PositionAgentError(
      `${number} is already reporting through install ${taken.installId}. Take that one out of service first, or this tablet would have two trails.`,
      409,
    );
  }

  const supabase = getSupabaseAdmin();
  const boundAt = new Date().toISOString();
  const update = await supabase
    .from(POSITION_AGENT_TABLE)
    .update({ bound_at: boundAt, bound_by_hr_id: input.actor, device_number: number })
    .eq("install_id", installId)
    .select(AGENT_COLUMNS)
    .maybeSingle();
  if (update.error || !update.data) {
    throw new PositionAgentError(`The install could not be bound: ${update.error?.message ?? "it was not written"}`, 503);
  }

  // 🔴 THE TRAIL ALREADY SENT IS THAT TABLET'S TOO. Without this the week before the bind would read
  // as a tablet that reported nothing.
  const backfill = await supabase
    .from(POSITION_TABLE)
    .update({ device_number: number })
    .eq("install_id", installId)
    .is("device_number", null);
  if (backfill.error) {
    throw new PositionAgentError(`The install was bound, but its earlier positions could not be stamped: ${backfill.error.message}`, 503);
  }

  await writeRequiredAuditLog({
    actorLoginId: input.actor,
    entityId: number,
    entityType: "tablet_position_agent",
    newValues: { boundAt, deviceNumber: number, installId },
    oldValues: { deviceNumber: agent.deviceNumber },
    summary: `Bound the position agent install ${installId} to tablet ${number}`,
  });

  return toPositionAgent(update.data as AgentRow);
}

/** Take an install out of service: it is refused from the next call, and the tablet is free to re-bind. */
export async function revokePositionAgent(input: {
  installId: string;
  reason: string;
  actor: string;
}): Promise<PositionAgent> {
  const installId = readInstallId(input.installId);
  if (!installId) throw new PositionAgentError("That is not an install id.", 400);
  const reason = input.reason.trim();
  if (!reason) throw new PositionAgentError("Say why this install is being taken out of service.", 400);

  const agent = await getPositionAgent(installId);
  if (!agent) throw new PositionAgentError("No install has said hello with that id.", 404);

  const revokedAt = new Date().toISOString();
  const update = await getSupabaseAdmin()
    .from(POSITION_AGENT_TABLE)
    .update({ revoked_at: revokedAt, revoked_reason: reason.slice(0, 200) })
    .eq("install_id", installId)
    .select(AGENT_COLUMNS)
    .maybeSingle();
  if (update.error || !update.data) {
    throw new PositionAgentError(`The install could not be taken out of service: ${update.error?.message ?? "it was not written"}`, 503);
  }

  await writeRequiredAuditLog({
    actorLoginId: input.actor,
    entityId: agent.deviceNumber ?? installId,
    entityType: "tablet_position_agent",
    newValues: { installId, reason, revokedAt },
    oldValues: { deviceNumber: agent.deviceNumber },
    summary: `Took the position agent install ${installId} out of service`,
  });

  return toPositionAgent(update.data as AgentRow);
}

// ---------------------------------------------------------------------------------------------
// What the tablet page reads
// ---------------------------------------------------------------------------------------------

export type AgentFix = {
  latitude: number;
  longitude: number;
  recordedAt: string;
  accuracyM: number | null;
  batteryLevel: number | null;
  mock: boolean;
};

/**
 * What one tablet's own agent reported, newest first.
 *
 * 🔴 THE TABLES MAY NOT BE THERE YET. A deploy can serve this code minutes before its migration is
 * applied, and PostgREST answers a missing table `PGRST205` — so a caller is told the agent trail
 * could not be read, never that the tablet did not move.
 */
function readAgentFixRows(deviceNumber: string, limit: number) {
  return getSupabaseAdmin()
    .from(POSITION_TABLE)
    .select("latitude, longitude, recorded_at, accuracy_m, battery_level, mock")
    .eq("device_number", deviceNumber)
    .order("recorded_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 1000));
}

export async function listAgentFixes(
  deviceNumber: string,
  limit = POSITION_HISTORY_LIMIT,
): Promise<{ fixes: AgentFix[]; error: string | null }> {
  const number = deviceNumber.trim();
  if (!number) return { error: null, fixes: [] };
  let read: Awaited<ReturnType<typeof readAgentFixRows>>;
  try {
    read = await readAgentFixRows(number, limit);
  } catch (error) {
    // 🔴 A THROW IS STILL "COULD NOT BE READ", NEVER AN EMPTY TRAIL — a missing service-role key and a
    // dropped connection both reject rather than answer with `error`.
    return { error: error instanceof Error ? error.message : String(error), fixes: [] };
  }
  if (read.error) return { error: read.error.message, fixes: [] };
  const rows = (read.data ?? []) as Array<{
    accuracy_m: number | null;
    battery_level: number | null;
    latitude: number;
    longitude: number;
    mock: boolean | null;
    recorded_at: string;
  }>;
  return {
    error: null,
    fixes: rows.map((row) => ({
      accuracyM: row.accuracy_m,
      batteryLevel: row.battery_level,
      latitude: row.latitude,
      longitude: row.longitude,
      mock: row.mock === true,
      recordedAt: new Date(row.recorded_at).toISOString(),
    })),
  };
}
