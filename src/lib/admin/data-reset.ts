import { bumpWeeklyRowsGeneration } from "@/lib/sales/weekly/row-cache";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type ResetScope = "sales" | "weekly" | "marketing" | "all";

export type ResetGroupMeta = {
  module: "sales" | "weekly" | "marketing";
  label: string;
  description: string;
  tables: string[];
  /** What this reset deliberately leaves behind, and why — shown before the owner confirms. */
  kept: string[];
};

/**
 * What each scope wipes. The UI reads this to tell the owner what he is about to destroy, so a
 * table missing from it is not a cosmetic gap: it is a row count he was never shown.
 *
 * 🔴 **Every table the function deletes from is listed here.** Until 2026-10-23 it named 19 of the
 * 27. The six Source of Sales rollups cascade off `source_of_sales_import_batches` —
 * `source_of_sales_fact_rollup` alone held 295,418 rows on production — and `marketing_roi_
 * request_geo_facts` and the one `direct_order_marketing_offsets` row went the same way: deleted
 * by the database, counted nowhere, named nowhere. The card said "3 tables will be wiped" over a
 * reset that emptied nine. They are deleted explicitly by the function now, which is what lets
 * `get diagnostics` count them, and they are named here, which is what lets the card be honest.
 */
export const RESET_GROUPS: ResetGroupMeta[] = [
  {
    module: "sales",
    label: "Source of Sales — Uploaded Data",
    description:
      "Deletes import batches, uploaded rows, import summaries, and the six rollups built from them " +
      "(brick moves, channel-customer, customer directory, customer presence, distributor-product, and the fact rollup). " +
      "Customer maps, distributor profiles, product aliases, and reference tables (regions, areas, blocks, bricks, products) are kept.",
    tables: [
      "source_of_sales_import_summaries",
      "source_of_sales_brick_move_files",
      "source_of_sales_channel_customer_rollup",
      "source_of_sales_customer_directory_rollup",
      "source_of_sales_customer_presence_rollup",
      "source_of_sales_distributor_product_rollup",
      "source_of_sales_fact_rollup",
      "source_of_sales_import_rows",
      "source_of_sales_import_batches",
    ],
    kept: [
      "A batch holding any row of a monthly closing that is still LOCKED is kept whole — rows, summaries and rollups together. " +
        "Unlock the closing first if you mean to delete it.",
    ],
  },
  {
    module: "weekly",
    label: "Weekly Sales — Uploaded Data",
    description:
      "Deletes all weekly upload batches and uploaded rows. " +
      "Distributor column profiles, branch-region maps, product scope, and aliases are kept.",
    tables: ["weekly_sales_rows", "weekly_sales_batches"],
    kept: [],
  },
  {
    module: "marketing",
    label: "Marketing Requests — All Submissions",
    description:
      "Deletes all submitted marketing requests and their products, pharmacies, approval steps, finance requirements, " +
      "direct-order offsets, and ROI analytics. " +
      "Customer/pharmacy master data, products, distributors, workflow steps, and ROI filter presets are kept.",
    tables: [
      "direct_order_marketing_offsets",
      "marketing_roi_customer_facts",
      "marketing_roi_distributor_facts",
      "marketing_roi_region_facts",
      "marketing_roi_line_facts",
      "marketing_roi_product_facts",
      "marketing_roi_trend_facts",
      "marketing_roi_request_geo_facts",
      "marketing_roi_request_facts",
      "marketing_roi_refresh_runs",
      "marketing_roi_export_audit",
      "marketing_request_finance_requirements",
      "marketing_request_approval_steps",
      "marketing_request_pharmacies",
      "marketing_request_products",
      "marketing_requests",
    ],
    kept: [
      "The request audit trail (marketing_request_events) is append-only by design and is kept. " +
        "Deleting the requests adds one request_deleted event to it for each one.",
    ],
  },
];

export type ResetTableResult = { table: string; deleted: number };

/** A table the reset deliberately did not empty, with the reason the database gave. */
export type ResetKeptNote = { table: string; batches?: number; rows?: number; reason: string };

export type ResetResult = {
  scope: ResetScope;
  executedAt: string;
  executedBy: string;
  tables: ResetTableResult[];
  totalDeleted: number;
  kept: ResetKeptNote[];
  /** Deletable batches still waiting when the run stopped. 0 on a complete reset. */
  remaining: number;
  /** False only when the pass cap was reached first — the counts are still real, just partial. */
  completed: boolean;
  passes: number;
};

type ResetRpcResult = {
  tables?: ResetTableResult[] | null;
  kept?: ResetKeptNote[] | null;
  remaining?: number | null;
  done?: boolean | null;
};

/**
 * One call of `phx_admin_reset_module_data`. Taking it as an argument is what lets
 * `tests/admin-reset-module-data.test.ts` prove the loop merges counts across passes and stops —
 * both on `done` and on the cap — without a database.
 */
export type ResetRpcCall = (args: {
  p_module: ResetScope;
  p_max_batches: number;
}) => Promise<{ data: unknown; error: { message: string } | null }>;

/**
 * Batches cleared per RPC call. The function deletes a whole batch at a time across nine tables;
 * 25 batches is ~65,000 rows here, comfortably inside the Data API's patience and nowhere near
 * `service_role`'s 300 s statement timeout.
 */
const BATCHES_PER_PASS = 25;

/**
 * Hard stop on the loop. Production holds 156 Source of Sales batches and 87 weekly ones, so a
 * full reset is about ten passes; 60 leaves room for growth and still refuses to spin for ever if
 * the function ever reported `done: false` without making progress.
 */
const MAX_PASSES = 60;

export async function executeReset(scope: ResetScope, executedBy: string): Promise<ResetResult> {
  const supabase = getSupabaseAdmin();
  // `rpc()` hands back a PostgrestFilterBuilder, which is a thenable and not a Promise — awaiting
  // it here is what turns it into one. Typing ResetRpcCall as the Promise is deliberate: the stub
  // the test passes in is an ordinary async function, and widening the type to PromiseLike to fit
  // the builder would let a builder be returned unawaited from somewhere that never resolves it.
  return executeResetWith(
    async (args) => await supabase.rpc("phx_admin_reset_module_data", args),
    scope,
    executedBy,
  );
}

export async function executeResetWith(
  rpc: ResetRpcCall,
  scope: ResetScope,
  executedBy: string,
): Promise<ResetResult> {
  const totals = new Map<string, number>();
  const order: string[] = [];
  const kept = new Map<string, ResetKeptNote>();
  let remaining = 0;
  let completed = false;
  let passes = 0;

  while (passes < MAX_PASSES) {
    const { data, error } = await rpc({ p_module: scope, p_max_batches: BATCHES_PER_PASS });

    if (error) {
      throw new Error(`Reset failed: ${error.message}`);
    }

    passes += 1;
    const result = (data as ResetRpcResult | null) ?? {};

    for (const row of result.tables ?? []) {
      if (!totals.has(row.table)) order.push(row.table);
      totals.set(row.table, (totals.get(row.table) ?? 0) + (row.deleted ?? 0));
    }
    // The last pass's reading wins: a lock that was lifted mid-run should not be reported as held.
    kept.clear();
    for (const note of result.kept ?? []) kept.set(note.table, note);

    remaining = result.remaining ?? 0;

    if (result.done) {
      completed = true;
      break;
    }
  }

  const tables = order.map((table) => ({ table, deleted: totals.get(table) ?? 0 }));
  const totalDeleted = tables.reduce((sum, t) => sum + t.deleted, 0);

  // The Source of Sales tables bump their own geography version from a trigger; weekly has nothing
  // of the kind, and `loadWeeklyDashboard` would keep serving the deleted rows from its in-process
  // cache for up to 60 s. Every other weekly write path calls this, and so must the reset.
  if (scope === "weekly" || scope === "all") {
    bumpWeeklyRowsGeneration("admin module reset");
  }

  return {
    scope,
    executedAt: new Date().toISOString(),
    executedBy,
    tables,
    totalDeleted,
    kept: [...kept.values()],
    remaining,
    completed,
    passes,
  };
}
