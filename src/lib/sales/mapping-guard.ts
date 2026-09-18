// The mapping guard — telling the owner what was held, once per batch.
//
// The database half lives in supabase/migrations/20260910230000_sos_mapping_guard.sql: a trigger on
// source_of_sales_customer_map, source_of_sales_bricks and source_of_sales_areas records every
// change that MOVES something and refuses to apply the risky ones, parking them in
// public.sos_map_change_holds instead.
//
// This half is the message. Owner, 2026-09-10, asked for three things and chose each explicitly:
// quarantine the risky ones rather than merely reporting them, reach him on Telegram AND in the
// app, and speak ONCE PER BATCH. That last one is why this is a sweep rather than a per-row hook:
// the day he asked, 144 rows were re-pointed in five batches, and a per-row alert would have been
// 144 messages.
//
// NEVER EMAIL. House rule for operational alerts since 2026-07-25, and the same shape as the
// distributor-upload nudge this is modelled on. Every automated email in this system also mirrors
// to his Telegram, so email here would double the noise it is trying to reduce.

import { createSystemNotification, logNotificationSendFailure } from "@/lib/notifications/system";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { logError } from "@/lib/observability/log";
import { parseBrickSalesMove, type BrickSalesMove } from "@/lib/sales/master-data/brick-move-result";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Exported so a test can assert the absence of email out loud rather than by inspection. */
export const MAPPING_GUARD_CHANNELS = ["in_app", "telegram", "push"] as const;

export const MAPPING_GUARD_EVENT_TYPE = "sos_mapping_guard_held";

/** Editable at /admin/notification-recipients, so the audience moves without a deploy. */
export const MAPPING_GUARD_AUDIENCE = "sos_mapping_guard_alert" as const;

/**
 * Where the message lands: the review screen, which is the only place a hold can be released.
 *
 * Deliberately NOT the Mapping Database editor. That screen shows what the map says now, which for
 * a held change is precisely the thing that did not happen.
 */
export const MAPPING_GUARD_URL = "/sales/mapping-guard";

/**
 * How wide a batch is.
 *
 * A batch is one writer's run, and a run is a burst: the five on 2026-09-10 took seconds each and
 * were minutes apart. Ten minutes groups a slow script into one message without ever merging two
 * separate sittings, and the writer is part of the key so two people working at once never share a
 * message that names only one of them.
 */
export const MAPPING_GUARD_BATCH_MINUTES = 10;

export type MappingGuardHold = {
  id: number;
  tableName: string;
  entityKey: string;
  reasons: string[];
  writer: string;
  createdAt: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

export type MappingGuardBatch = {
  writer: string;
  holds: MappingGuardHold[];
  /** Distinct reasons across the batch, most common first — what the message leads with. */
  reasonCounts: Array<{ reason: string; count: number }>;
  firstAt: string;
  lastAt: string;
};

/**
 * Group holds into one batch per writer per window. Pure, so the grouping is testable without a
 * database — the rule that decides how many messages he gets is worth pinning.
 */
export function groupHoldsIntoBatches(
  holds: readonly MappingGuardHold[],
  windowMinutes = MAPPING_GUARD_BATCH_MINUTES,
): MappingGuardBatch[] {
  const windowMs = Math.max(1, windowMinutes) * 60_000;
  const byWriter = new Map<string, MappingGuardHold[]>();
  for (const hold of holds) {
    byWriter.set(hold.writer, [...(byWriter.get(hold.writer) ?? []), hold]);
  }

  const batches: MappingGuardBatch[] = [];
  for (const [writer, writerHolds] of byWriter) {
    const ordered = [...writerHolds].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let current: MappingGuardHold[] = [];
    const flush = () => {
      if (current.length === 0) return;
      batches.push(buildBatch(writer, current));
      current = [];
    };
    for (const hold of ordered) {
      const last = current[current.length - 1];
      if (last && Date.parse(hold.createdAt) - Date.parse(last.createdAt) > windowMs) flush();
      current.push(hold);
    }
    flush();
  }
  return batches.sort((a, b) => a.firstAt.localeCompare(b.firstAt));
}

function buildBatch(writer: string, holds: MappingGuardHold[]): MappingGuardBatch {
  const counts = new Map<string, number>();
  for (const hold of holds) {
    for (const reason of hold.reasons) {
      // A region reason names the two regions, so the raw string is unique per pair and would
      // produce a list as long as the batch. Group on the shape, keep the detail on the row.
      const key = reason.startsWith("moves the customer from region") ? "moves the customer to another region" : reason;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return {
    firstAt: holds[0].createdAt,
    holds,
    lastAt: holds[holds.length - 1].createdAt,
    reasonCounts: [...counts].map(([reason, count]) => ({ count, reason })).sort((a, b) => b.count - a.count),
    writer,
  };
}

const TABLE_LABEL: Record<string, string> = {
  source_of_sales_areas: "area",
  source_of_sales_bricks: "brick",
  source_of_sales_customer_map: "customer mapping",
};

/** Human wording, never a table name or a raw code. Standing owner rule. */
export function describeBatch(batch: MappingGuardBatch): { title: string; message: string } {
  const total = batch.holds.length;
  const kinds = new Map<string, number>();
  for (const hold of batch.holds) {
    const label = TABLE_LABEL[hold.tableName] ?? hold.tableName;
    kinds.set(label, (kinds.get(label) ?? 0) + 1);
  }
  const what = [...kinds]
    .map(([label, count]) => `${count} ${label}${count === 1 ? "" : "s"}`)
    .join(" and ");

  const lines = [
    `${what} were about to be re-pointed and are waiting for you.`,
    "",
    "Why they were stopped:",
    ...batch.reasonCounts.map((entry) => `  ${entry.count} ${entry.reason}`),
    "",
    `Changed by: ${batch.writer}`,
    "",
    "Examples:",
    ...batch.holds.slice(0, 5).map((hold) => `  ${hold.entityKey} — ${hold.reasons.join("; ")}`),
  ];
  if (total > 5) lines.push(`  and ${total - 5} more`);
  lines.push("", "Nothing has been changed. Open the review screen to approve or reject them.");

  return {
    message: lines.join("\n"),
    title: total === 1 ? "A mapping change is waiting for you" : `${total} mapping changes are waiting for you`,
  };
}

type HoldRow = {
  app_actor: string | null;
  created_at: string;
  db_role: string;
  entity_key: string;
  id: number;
  reasons: string[] | null;
  table_name: string;
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
};

/**
 * Pending holds nobody has been told about yet.
 *
 * Ordered and page-limited: `.select()` stops at 1000 rows with no marker, and a brick move can
 * hold hundreds at once, so the cap is explicit rather than discovered.
 */
async function loadUnnotifiedHolds(limit: number): Promise<MappingGuardHold[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sos_map_change_holds")
    .select("id,table_name,entity_key,reasons,db_role,app_actor,created_at,before_json,after_json")
    .eq("status", "pending")
    .is("notified_at", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((row) => {
    const hold = row as unknown as HoldRow;
    return {
      after: hold.after_json ?? {},
      before: hold.before_json ?? {},
      createdAt: hold.created_at,
      entityKey: hold.entity_key,
      id: hold.id,
      reasons: hold.reasons ?? [],
      tableName: hold.table_name,
      // A direct SQL session names no application actor, and that absence is itself worth showing.
      writer: hold.app_actor ?? `${hold.db_role} (direct database access)`,
    };
  });
}

export type MappingGuardSweepResult = {
  batches: number;
  held: number;
  notified: number;
  skipped: number;
  warnings: string[];
};

export async function runMappingGuardNotify(options?: { limit?: number }): Promise<MappingGuardSweepResult> {
  const holds = await loadUnnotifiedHolds(Math.min(Math.max(options?.limit ?? 500, 1), 2000));
  const empty: MappingGuardSweepResult = { batches: 0, held: 0, notified: 0, skipped: 0, warnings: [] };
  if (holds.length === 0) return empty;

  const batches = groupHoldsIntoBatches(holds);
  const { recipients, warnings } = await resolveNotificationPersonRecipients(
    MAPPING_GUARD_AUDIENCE,
    "Mapping guard — recipients",
  );

  // An audience that resolves to nobody looks exactly like a quiet day. Held changes would then sit
  // unseen while the map silently stopped accepting them, which is the worst state this feature can
  // be in. Say it loudly rather than returning a clean result.
  if (recipients.length === 0) {
    logError("Mapping changes are held but the audience resolved to nobody", {
      labels: { event: "mapping_guard_no_recipient", job: "mapping-guard-notify" },
      error: new Error(`${holds.length} held mapping change(s) had no recipient. Warnings: ${warnings.join("; ") || "none"}`),
    });
    return { ...empty, batches: batches.length, held: holds.length, warnings };
  }

  const supabase = getSupabaseAdmin();
  let notified = 0;
  let skipped = 0;

  for (const batch of batches) {
    const { message, title } = describeBatch(batch);
    let delivered = false;
    for (const recipient of recipients) {
      try {
        await createSystemNotification({
          actionUrl: MAPPING_GUARD_URL,
          channels: [...MAPPING_GUARD_CHANNELS],
          eventType: MAPPING_GUARD_EVENT_TYPE,
          message,
          metadata: {
            firstAt: batch.firstAt,
            heldCount: batch.holds.length,
            holdIds: batch.holds.map((hold) => hold.id),
            // Keyed on the hold ids, so a re-run of the sweep cannot re-send the same batch, while
            // a later batch from the same writer still gets through.
            idempotencyKey: `sos-mapping-guard:${batch.holds[0].id}:${batch.holds[batch.holds.length - 1].id}:${recipient.hrId}`,
            writer: batch.writer,
          },
          module: "sales",
          priority: "high",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          subjectHrId: recipient.hrId,
          title,
        });
        notified += 1;
        delivered = true;
      } catch (error) {
        skipped += 1;
        logNotificationSendFailure("sales.runMappingGuardNotify", error);
      }
    }

    // Only stamp what somebody was actually told about. A batch that reached nobody stays unnotified
    // so the next sweep tries again, rather than going quiet forever after one bad minute.
    if (delivered) {
      const { error } = await supabase
        .from("sos_map_change_holds")
        .update({ notified_at: new Date().toISOString() })
        .in("id", batch.holds.map((hold) => hold.id));
      if (error) logNotificationSendFailure("sales.runMappingGuardNotify.stamp", error);
    }
  }

  return { batches: batches.length, held: holds.length, notified, skipped, warnings };
}

// ── The review screen ─────────────────────────────────────────────────────────────────────────

export type HeldMappingChange = {
  id: number;
  /** "customer mapping" | "brick" | "area", never a table name. */
  kind: string;
  /** The pharmacy, brick or area this is about, named the way he reads it. */
  subject: string;
  /** Where it sits today, and where the change wanted to put it. */
  from: string;
  to: string;
  reasons: string[];
  writer: string;
  createdAt: string;
  /**
   * Already formatted, Africa/Cairo, because the SERVER must decide how this reads.
   *
   * A client component asking the reader's own ICU build for a short month name renders "Sep" on
   * one browser and "Sept" on another — CLDR 42 changed it — and React throws away the server HTML
   * over that one character. That is hydration error #418, it was live on the visits page until
   * 2026-09-08, and it only ever appears in September. The month comes from a table that ships with
   * this code rather than from whichever ICU build the reader is holding.
   */
  when: string;
  notified: boolean;
};

const MONTH_ABBREVIATIONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Africa/Cairo always, never raw UTC. Standing owner rule. */
function formatCairo(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "numeric",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).formatToParts(new Date(parsed));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const month = MONTH_ABBREVIATIONS[Number(get("month")) - 1] ?? get("month");
  return `${get("day")} ${month} ${get("hour")}:${get("minute")}`;
}

/**
 * Turn one held row into something a person can decide from.
 *
 * Codes are resolved to names here rather than in the component, because the standing rule is that
 * a screen shows human-readable names and a component that receives a code has already lost.
 */
function describeSide(
  tableName: string,
  side: Record<string, unknown>,
  areaNames: ReadonlyMap<string, string>,
  brickNames: ReadonlyMap<string, string>,
): string {
  const text = (key: string) => String(side[key] ?? "").trim();
  if (tableName === "source_of_sales_customer_map") {
    const area = text("area_code");
    const brick = text("brick_id");
    if (!area && !brick) return "not mapped";
    // `||` rather than `??` throughout: a name recorded as an empty string has to fall through to
    // the code, and `??` would keep the blank and print a row that names nothing.
    const areaName = areaNames.get(area.toUpperCase()) || area;
    const brickName = brickNames.get(brick.toUpperCase()) || brick;
    return brickName ? `${areaName} · ${brickName}` : areaName;
  }
  if (tableName === "source_of_sales_bricks") {
    const area = text("area_code");
    return areaNames.get(area.toUpperCase()) || area || "—";
  }
  const region = text("region_code");
  return region || "—";
}

export async function listHeldMappingChanges(limit = 200): Promise<HeldMappingChange[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sos_map_change_holds")
    .select("id,table_name,entity_key,reasons,db_role,app_actor,created_at,notified_at,before_json,after_json")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500));
  if (error) throw error;

  const rows = (data ?? []) as unknown as Array<HoldRow & { notified_at: string | null }>;
  if (rows.length === 0) return [];

  const [areas, bricks] = await Promise.all([
    supabase.from("source_of_sales_areas").select("area_code,area_name"),
    supabase.from("source_of_sales_bricks").select("brick_id,brick_name"),
  ]);
  const areaNames = new Map<string, string>();
  for (const row of (areas.data ?? []) as Array<{ area_code: string; area_name: string | null }>) {
    areaNames.set(String(row.area_code).trim().toUpperCase(), String(row.area_name ?? "").trim());
  }
  const brickNames = new Map<string, string>();
  for (const row of (bricks.data ?? []) as Array<{ brick_id: string; brick_name: string | null }>) {
    brickNames.set(String(row.brick_id).trim().toUpperCase(), String(row.brick_name ?? "").trim());
  }

  return rows.map((row) => ({
    createdAt: row.created_at,
    from: describeSide(row.table_name, row.before_json ?? {}, areaNames, brickNames),
    id: row.id,
    kind: TABLE_LABEL[row.table_name] ?? row.table_name,
    notified: row.notified_at !== null,
    reasons: row.reasons ?? [],
    subject: row.entity_key,
    to: describeSide(row.table_name, row.after_json ?? {}, areaNames, brickNames),
    when: formatCairo(row.created_at),
    writer: row.app_actor ?? `${row.db_role} (direct database access)`,
  }));
}

export type MappingHoldDecision = "approved" | "rejected";

/**
 * Release or refuse one held change.
 *
 * The apply is done INSIDE the database function, because that function is the only thing permitted
 * to set the bypass. Doing the update from here would either be blocked by the guard or require
 * handing the application a way to switch the guard off, which is the same as not having one.
 *
 * sos_map_guard_decide_and_move_sales (20260918150200) wraps sos_map_guard_decide: when the approved
 * hold is a pharmacy a brick move held, that pharmacy's open-month sales move in the SAME
 * transaction (owner decision 2026-09-18, "Approving one there also moves its unlocked-month
 * sales"). `brickMove` says what moved; it is null for everything else. The moved files' totals are
 * rebuilt afterwards (brick-moves.ts).
 */
export async function decideMappingHold(input: {
  holdId: number;
  decision: MappingHoldDecision;
  actor: string;
}): Promise<{ ok: boolean; reason?: string; brickMove: BrickSalesMove | null }> {
  const { data, error } = await getSupabaseAdmin().rpc("sos_map_guard_decide_and_move_sales", {
    p_actor: input.actor,
    p_decision: input.decision,
    p_hold_id: input.holdId,
  });
  if (error) throw error;
  const result = (data ?? {}) as { ok?: boolean; reason?: string; brickMove?: unknown };
  return { brickMove: parseBrickSalesMove(result.brickMove), ok: result.ok === true, reason: result.reason };
}
