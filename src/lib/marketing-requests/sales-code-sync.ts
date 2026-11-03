// The nightly Sales -> Marketing pharmacy-code sync (owner, 2026-11-03). It calls the same function a
// person used to run by hand (scripts/sync-sales-pharmacy-codes-into-marketing.ts), which is additive,
// idempotent and keeps a merged vendor's codes. Each run's inserts carry their own batch id.
//
// WHAT CHANGES WITH NOBODY AT THE KEYBOARD.
//   * A vendor the Sales map names for the first time starts hidden until he allows it (the function,
//     20261103*_marketing_pharmacy_sync_hides_new_vendors.sql). He is told, by name.
//   * A broken Sales import empties the map and its codes then look retired. The run refuses above
//     SYNC_RETIRE_LIMIT and reads as failed: on 3 Nov the honest number was 0.
//   * Ambiguous pairs must stay 0. 44,244 of them is what the blind insert caused on 2026-08-19.
//
// A TIMEOUT READS AS UNKNOWN, NEVER AS NOTHING HAPPENED: the server may still finish after the client
// gives up. The next run is safe either way, because a repeat inserts nothing.
//
// Counts go in the heartbeat detail with no notification, so a healthy night reaches nobody. A failed
// run reaches a phone through the job register's sweep.

import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { createSystemNotification } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Above this the run stops and asks: the map almost certainly broke, rather than this many codes left. */
export const SYNC_RETIRE_LIMIT = 500;
const SYNC_REQUEST_TIMEOUT_MS = 120_000;
const AUDIENCE_KEY = "weekly_system_health_digest" as const;
const ACTOR = "marketing-pharmacy-code-sync";

export type SalesCodeSyncCounts = {
  distributorsCreated: number;
  referencesSynced: number;
  referencesSkippedExisting: number;
  referencesRetired: number;
  referencesRetainedLinked: number;
  referencesHeldHiddenVendor: number;
};

export type SalesCodeSyncResult = {
  dryRun: boolean;
  wouldRetire: number;
  ambiguousPairs: number;
  counts: SalesCodeSyncCounts | null;
  newHiddenVendors: string[];
  detail: string;
};

/** Pure: the refusal, or null when the run may go ahead. */
export function syncRetireRefusal(wouldRetire: number): string | null {
  if (wouldRetire <= SYNC_RETIRE_LIMIT) return null;
  return (
    `The pharmacy-code sync did not run: it would retire ${wouldRetire} codes, over its limit of ${SYNC_RETIRE_LIMIT}. ` +
    "The Sales customer map has probably lost rows, so check the last Sales import before running it."
  );
}

/** Pure: the heartbeat detail. */
export function salesCodeSyncDetail(counts: SalesCodeSyncCounts, ambiguousPairs: number): string {
  return [
    `vendors created ${counts.distributorsCreated}`,
    `codes added ${counts.referencesSynced}`,
    `already present ${counts.referencesSkippedExisting}`,
    `retired ${counts.referencesRetired}`,
    `stale but kept ${counts.referencesRetainedLinked}`,
    `held under a hidden vendor ${counts.referencesHeldHiddenVendor}`,
    `ambiguous pairs ${ambiguousPairs}`,
  ].join(", ");
}

/** Pure: what a person must be told. Null on a healthy night. */
export function salesCodeSyncNotice(input: {
  ambiguousPairs: number;
  newHiddenVendors: readonly string[];
}): { title: string; message: string } | null {
  const lines: string[] = [];
  if (input.newHiddenVendors.length > 0) {
    lines.push(
      `New vendor from the Sales map, hidden until allowed: ${input.newHiddenVendors.join(", ")}.`,
      "Its pharmacy codes stay out of the Vendor picker and wait. No screen allows a vendor yet, so allowing one is a database change, made on request.",
    );
  }
  if (input.ambiguousPairs > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `${input.ambiguousPairs} pharmacy code(s) now sit on more than one reference row under one vendor. Customer Validation reads those as ambiguous rather than matched, so they need clearing.`,
    );
  }
  if (lines.length === 0) return null;
  return {
    message: lines.join("\n"),
    title:
      input.ambiguousPairs > 0
        ? `Pharmacy codes turned ambiguous: ${input.ambiguousPairs}`
        : `New hidden vendor: ${input.newHiddenVendors.join(", ")}`,
  };
}

async function readPreflight(): Promise<{ ambiguousPairs: number; wouldRetire: number }> {
  const { data, error } = await getSupabaseAdmin({ requestTimeoutMs: SYNC_REQUEST_TIMEOUT_MS }).rpc(
    "phx_sales_pharmacy_code_sync_preflight",
  );
  if (error) throw new Error(`Could not read the pharmacy-code preflight: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { ambiguous_pairs?: number; would_retire?: number } | null;
  if (!row) throw new Error("The pharmacy-code preflight returned no row.");
  return { ambiguousPairs: Number(row.ambiguous_pairs ?? 0), wouldRetire: Number(row.would_retire ?? 0) };
}

async function readHiddenVendors(): Promise<Map<string, string>> {
  const { data, error } = await getSupabaseAdmin()
    .from("marketing_distributors")
    .select("id,display_name")
    .eq("active", false);
  if (error) throw new Error(`Could not read the hidden vendors: ${error.message}`);
  return new Map(((data ?? []) as Array<{ id: unknown; display_name: unknown }>).map((row) => [String(row.id), String(row.display_name ?? "")]));
}

async function callSync(): Promise<SalesCodeSyncCounts> {
  const { data, error } = await getSupabaseAdmin({ requestTimeoutMs: SYNC_REQUEST_TIMEOUT_MS }).rpc(
    "phx_sync_sales_pharmacy_codes_into_marketing",
  );
  if (error) {
    const aborted = /abort|timed? ?out|timeout/i.test(`${error.message} ${error.details ?? ""}`);
    throw new Error(
      aborted
        ? "The pharmacy-code sync did not answer in time. Its outcome is unknown: the database may still have finished. The next run is safe."
        : `The pharmacy-code sync failed: ${error.message}`,
    );
  }
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) throw new Error("The pharmacy-code sync returned no row.");
  return {
    distributorsCreated: Number(row.distributors_created ?? 0),
    referencesHeldHiddenVendor: Number(row.references_held_hidden_vendor ?? 0),
    referencesRetainedLinked: Number(row.references_retained_linked ?? 0),
    referencesRetired: Number(row.references_retired ?? 0),
    referencesSkippedExisting: Number(row.references_skipped_existing ?? 0),
    referencesSynced: Number(row.references_synced ?? 0),
  };
}

function cairoDayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

/** Never throws: the run's own result stands, and a lost notice is logged. */
async function tell(notice: { title: string; message: string }, keyPart: string): Promise<void> {
  try {
    const { recipients } = await resolveNotificationPersonRecipients(AUDIENCE_KEY, "Pharmacy-code sync recipients");
    await Promise.all(
      recipients.map((recipient) =>
        createSystemNotification({
          actionUrl: "/admin/marketing-requests/validation",
          actorId: ACTOR,
          channels: ["in_app", "telegram"],
          eventType: "marketing_pharmacy_code_sync_notice",
          message: notice.message,
          metadata: { idempotencyKey: `marketing-pharmacy-code-sync:${keyPart}:${recipient.hrId}` },
          // `system` is the module enabled for Telegram; an unknown module string fails closed.
          module: "system",
          priority: "normal",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          title: notice.title,
        }),
      ),
    );
  } catch (error) {
    logError("Pharmacy-code sync notice failed to dispatch", {
      error,
      labels: { event: "marketing_pharmacy_code_sync_notice_failed" },
    });
  }
}

export async function runSalesPharmacyCodeSync(options: { dryRun?: boolean } = {}): Promise<SalesCodeSyncResult> {
  const dryRun = options.dryRun === true;
  const before = await readPreflight();
  const refusal = syncRetireRefusal(before.wouldRetire);
  if (dryRun) {
    return {
      ambiguousPairs: before.ambiguousPairs,
      counts: null,
      detail: refusal ?? "dry run: nothing written",
      dryRun,
      newHiddenVendors: [],
      wouldRetire: before.wouldRetire,
    };
  }
  if (refusal) throw new Error(refusal);

  const hiddenBefore = await readHiddenVendors();
  const counts = await callSync();
  const after = await readPreflight();
  const hiddenAfter = await readHiddenVendors();
  const newHidden = [...hiddenAfter.entries()].filter(([id]) => !hiddenBefore.has(id));
  const newHiddenVendors = newHidden.map(([, name]) => name);

  const notice = salesCodeSyncNotice({ ambiguousPairs: after.ambiguousPairs, newHiddenVendors });
  if (notice) {
    const ids = newHidden.map(([id]) => id).sort().join(",");
    // A new vendor is told once, by its id. Ambiguous pairs repeat each night until they are cleared.
    await tell(notice, `${after.ambiguousPairs > 0 ? `ambiguous-${cairoDayKey()}` : "vendors"}:${ids}`);
  }

  return {
    ambiguousPairs: after.ambiguousPairs,
    counts,
    detail: salesCodeSyncDetail(counts, after.ambiguousPairs),
    dryRun,
    newHiddenVendors,
    wouldRetire: before.wouldRetire,
  };
}
