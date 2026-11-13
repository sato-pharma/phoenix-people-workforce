import { readJobHeartbeats } from "@/lib/observability/job-heartbeat";
import type { JobHeartbeatRow } from "@/lib/observability/job-heartbeat-assess";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  INTEGRATIONS,
  INTEGRATION_CATEGORIES,
  integrationConfiguration,
  type IntegrationCategory,
  type IntegrationConfiguration,
  type IntegrationEntry,
  type IntegrationHealthSource,
} from "./registry";

/**
 * What the Integrations page shows (integration audit, ISS-039 · INT-063). For each entry of the registry:
 * configured or not, read from variable names alone, and the last success and last failure, read from what
 * Phoenix ALREADY records. It writes nothing and calls no outside service.
 *
 * 🔴 A read that fails says "Unavailable" with the reason. It never becomes an empty cell or "none": a board
 * that shows nothing when it could not look reads as "nothing ever failed".
 * 🔴 No failure TEXT is shown, only its time. A stored error message can quote a request, and this page's one
 * promise is that it never shows a secret. The message is on the System Audit board.
 */

export type IntegrationHealthCell =
  | { kind: "time"; at: string }
  /** The source was read and holds no such event. */
  | { kind: "none-recorded" }
  /** Phoenix does not record this event for this integration. */
  | { kind: "not-recorded"; why: string }
  /** The source could not be read just now. */
  | { kind: "unavailable"; why: string };

export type IntegrationHealth = { lastSuccess: IntegrationHealthCell; lastFailure: IntegrationHealthCell };

export type IntegrationRow = {
  id: string;
  name: string;
  provider: string;
  usedFor: string;
  configuration: IntegrationConfiguration;
  health: IntegrationHealth;
  notes: string[];
};

export type IntegrationsBoard = {
  groups: { category: IntegrationCategory; rows: IntegrationRow[] }[];
  counts: { total: number; configured: number; notConfigured: number; partly: number };
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "the source did not answer";
}

function cell(at: string | null): IntegrationHealthCell {
  return at ? { kind: "time", at } : { kind: "none-recorded" };
}

function latest(values: (string | null)[]): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (value && (best === null || Date.parse(value) > Date.parse(best))) best = value;
  }
  return best;
}

/** What a one-row read answers, as far as this file needs it. */
type TimeRead = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;

/** The value of one timestamp column on the single newest row a query returns, or null when it returns none. */
async function newest(table: string, column: string, read: TimeRead): Promise<string | null> {
  const { data, error } = await read;
  if (error) throw new Error(`${table} could not be read: ${error.message}`);
  const row = (data ?? [])[0] as Record<string, unknown> | undefined;
  const value = row ? row[column] : null;
  return value === null || value === undefined ? null : String(value);
}

type Pair = { success: string | null; failure: string | null };

type RecordedSource = Exclude<IntegrationHealthSource, { kind: "heartbeat" } | { kind: "none" } | { kind: "ai-failures" }>;

async function readPair(source: RecordedSource): Promise<Pair> {
  const db = getSupabaseAdmin();
  const top = { ascending: false } as const;

  if (source.kind === "deliveries") {
    const table = "notification_deliveries";
    const of = (status: string) =>
      db.from(table).select("created_at").eq("channel", source.channel).eq("provider", source.provider).eq("status", status).order("created_at", top).limit(1);
    const [success, failure] = await Promise.all([newest(table, "created_at", of("sent")), newest(table, "created_at", of("failed"))]);
    return { success, failure };
  }
  if (source.kind === "email-events") {
    const table = "email_delivery_events";
    const of = (statuses: string[]) =>
      db.from(table).select("occurred_at").eq("provider", source.provider).in("status", statuses).order("occurred_at", top).limit(1);
    const [success, failure] = await Promise.all([
      newest(table, "occurred_at", of(["sent", "delivered"])),
      newest(table, "occurred_at", of(["failed"])),
    ]);
    return { success, failure };
  }
  if (source.kind === "whatsapp") {
    const table = "ats_whatsapp_outbound_messages";
    const [success, failure] = await Promise.all([
      newest(table, "created_at", db.from(table).select("created_at").eq("ok", true).order("created_at", top).limit(1)),
      newest(table, "created_at", db.from(table).select("created_at").eq("failure_reason", "failed").order("created_at", top).limit(1)),
    ]);
    return { success, failure };
  }
  const table = "ats_interview_bookings";
  const of = (status: string) => db.from(table).select("updated_at").eq("zoom_status", status).order("updated_at", top).limit(1);
  const [success, failure] = await Promise.all([newest(table, "updated_at", of("created")), newest(table, "updated_at", of("failed"))]);
  return { success, failure };
}

function fromHeartbeats(source: Extract<IntegrationHealthSource, { kind: "heartbeat" }>, rows: JobHeartbeatRow[]): IntegrationHealth {
  const wanted = source.slugs === "*" ? rows : rows.filter((row) => (source.slugs as readonly string[]).includes(row.slug));
  return {
    lastSuccess: cell(latest(wanted.map((row) => row.lastSuccessAt))),
    lastFailure: cell(latest(wanted.map((row) => row.lastFailAt))),
  };
}

async function healthOf(entry: IntegrationEntry, heartbeats: { rows: JobHeartbeatRow[] | null; error: string | null }): Promise<IntegrationHealth> {
  const source = entry.health;
  if (source.kind === "none") {
    const none: IntegrationHealthCell = { kind: "not-recorded", why: source.why };
    return { lastSuccess: none, lastFailure: none };
  }
  if (source.kind === "heartbeat") {
    if (!heartbeats.rows) {
      const down: IntegrationHealthCell = { kind: "unavailable", why: heartbeats.error ?? "the job register did not answer" };
      return { lastSuccess: down, lastFailure: down };
    }
    return fromHeartbeats(source, heartbeats.rows);
  }
  try {
    if (source.kind === "ai-failures") {
      const failure = await newest(
        "app_error_events",
        "created_at",
        getSupabaseAdmin()
          .from("app_error_events")
          .select("created_at")
          .eq("module_key", "ai")
          .eq("route_type", "server-ai")
          .like("route", `${source.routePrefix}%`)
          .order("created_at", { ascending: false })
          .limit(1),
      );
      return {
        lastSuccess: { kind: "not-recorded", why: "A successful AI call writes no record. Only failures are kept." },
        lastFailure: cell(failure),
      };
    }
    const pair = await readPair(source);
    return { lastSuccess: cell(pair.success), lastFailure: cell(pair.failure) };
  } catch (error) {
    const down: IntegrationHealthCell = { kind: "unavailable", why: describe(error) };
    return { lastSuccess: down, lastFailure: down };
  }
}

export async function loadIntegrationsBoard(env: Record<string, string | undefined> = process.env): Promise<IntegrationsBoard> {
  let heartbeats: { rows: JobHeartbeatRow[] | null; error: string | null };
  try {
    heartbeats = { rows: await readJobHeartbeats(), error: null };
  } catch (error) {
    heartbeats = { rows: null, error: describe(error) };
  }

  const built = await Promise.all(
    INTEGRATIONS.map(async (entry): Promise<{ category: IntegrationCategory; row: IntegrationRow }> => ({
      category: entry.category,
      row: {
        id: entry.id,
        name: entry.name,
        provider: entry.provider,
        usedFor: entry.usedFor,
        configuration: integrationConfiguration(entry, env),
        health: await healthOf(entry, heartbeats),
        notes: [...(entry.notes ?? [])],
      },
    })),
  );
  const rows = built.map((item) => item.row);

  const groups = INTEGRATION_CATEGORIES.map((category) => ({
    category,
    rows: built.filter((item) => item.category === category).map((item) => item.row),
  })).filter((group) => group.rows.length > 0);

  const states = rows.map((row) => row.configuration.state);
  return {
    groups,
    counts: {
      total: rows.length,
      configured: states.filter((state) => state === "configured" || state === "on").length,
      notConfigured: states.filter((state) => state === "not-configured" || state === "off").length,
      partly: states.filter((state) => state === "partly").length,
    },
  };
}
