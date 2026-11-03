// The nightly Sales -> Marketing pharmacy-code sync (owner, 2026-11-03). It calls the same function a
// person used to run by hand (scripts/sync-sales-pharmacy-codes-into-marketing.ts), which is additive,
// idempotent and keeps a merged vendor's codes. Each run's inserts carry their own batch id.
//
// WHAT CHANGES WITH NOBODY AT THE KEYBOARD.
//   * A vendor the Sales map names for the first time starts hidden until he allows it (the function,
//     20261103*_marketing_pharmacy_sync_hides_new_vendors.sql). He is told, by name, once per vendor. That
//     is read from the vendor's own age rather than a before-and-after, so a run that timed out but
//     committed, or a notice that failed to send, is told by the next night's run.
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
/**
 * How long a new hidden vendor stays eligible for its one notice. The vendors hidden before this job
 * existed are all older (the newest was made on 2026-08-19), so they are never announced as new.
 */
export const NEW_VENDOR_NOTICE_DAYS = 14;
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

/** Pure: the one notice a new hidden vendor gets. */
export function hiddenVendorNotice(name: string): { title: string; message: string } {
  return {
    message: [
      `New vendor from the Sales map, hidden until allowed: ${name}.`,
      "Its pharmacy codes stay out of the Vendor picker and wait. To allow it: Marketing Control, Vendors.",
    ].join("\n"),
    title: `New hidden vendor: ${name}`,
  };
}

/** Pure: the ambiguous-pairs notice, which repeats daily until they are cleared. Null at zero. */
export function ambiguousPairsNotice(ambiguousPairs: number): { title: string; message: string } | null {
  if (ambiguousPairs <= 0) return null;
  return {
    message: `${ambiguousPairs} pharmacy code(s) now sit on more than one reference row under one vendor. Customer Validation reads those as ambiguous rather than matched, so they need clearing.`,
    title: `Pharmacy codes turned ambiguous: ${ambiguousPairs}`,
  };
}

/** Pure: the oldest a hidden vendor's created_at can be and still get its notice. */
export function newVendorCutoffIso(now: number = Date.now()): string {
  return new Date(now - NEW_VENDOR_NOTICE_DAYS * 24 * 60 * 60 * 1000).toISOString();
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

async function readNewHiddenVendors(): Promise<Array<{ id: string; name: string }>> {
  const { data, error } = await getSupabaseAdmin()
    .from("marketing_distributors")
    .select("id,display_name")
    .eq("active", false)
    .gte("created_at", newVendorCutoffIso())
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Could not read the hidden vendors: ${error.message}`);
  return ((data ?? []) as Array<{ id: unknown; display_name: unknown }>).map((row) => ({
    id: String(row.id),
    name: String(row.display_name ?? ""),
  }));
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
async function tell(notice: { title: string; message: string }, keyPart: string, actionUrl = "/admin/marketing-requests/validation"): Promise<void> {
  try {
    const { recipients } = await resolveNotificationPersonRecipients(AUDIENCE_KEY, "Pharmacy-code sync recipients");
    await Promise.all(
      recipients.map((recipient) =>
        createSystemNotification({
          actionUrl,
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

  const counts = await callSync();
  const after = await readPreflight();
  const newHidden = await readNewHiddenVendors();
  const newHiddenVendors = newHidden.map((vendor) => vendor.name);

  // The key is the vendor's id, so it is told once however many nights it stays hidden inside the window.
  for (const vendor of newHidden) await tell(hiddenVendorNotice(vendor.name), `vendors:${vendor.id}`, "/admin/marketing-requests/control");
  // Ambiguous pairs repeat each night until they are cleared.
  const ambiguous = ambiguousPairsNotice(after.ambiguousPairs);
  if (ambiguous) await tell(ambiguous, `ambiguous:${cairoDayKey()}`);

  return {
    ambiguousPairs: after.ambiguousPairs,
    counts,
    detail: salesCodeSyncDetail(counts, after.ambiguousPairs),
    dryRun,
    newHiddenVendors,
    wouldRetire: before.wouldRetire,
  };
}
