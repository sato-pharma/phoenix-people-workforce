import { getSupabaseAdmin } from "@/lib/supabase/server";

export type ResetScope = "sales" | "weekly" | "marketing" | "all";

export type ResetGroupMeta = {
  module: "sales" | "weekly" | "marketing";
  label: string;
  description: string;
  tables: string[];
};

// Describes what each scope wipes — used in the UI to show the user exactly
// what will be deleted before they confirm
export const RESET_GROUPS: ResetGroupMeta[] = [
  {
    module: "sales",
    label: "Source of Sales — Uploaded Data",
    description:
      "Deletes all import batches, uploaded rows, and import summaries. " +
      "Customer maps, distributor profiles, product aliases, and reference tables (regions, areas, blocks, bricks, products) are kept.",
    tables: [
      "source_of_sales_import_summaries",
      "source_of_sales_import_rows",
      "source_of_sales_import_batches",
    ],
  },
  {
    module: "weekly",
    label: "Weekly Sales — Uploaded Data",
    description:
      "Deletes all weekly upload batches and uploaded rows. " +
      "Distributor column profiles, branch-region maps, product scope, and aliases are kept.",
    tables: ["weekly_sales_rows", "weekly_sales_batches"],
  },
  {
    module: "marketing",
    label: "Marketing Requests — All Submissions",
    description:
      "Deletes all submitted marketing requests and their products, pharmacies, approval steps, finance requirements, and ROI analytics. " +
      "Customer/pharmacy master data, products, distributors, workflow steps, and ROI filter presets are kept.",
    tables: [
      "marketing_roi_customer_facts",
      "marketing_roi_distributor_facts",
      "marketing_roi_region_facts",
      "marketing_roi_line_facts",
      "marketing_roi_product_facts",
      "marketing_roi_trend_facts",
      "marketing_roi_request_facts",
      "marketing_roi_refresh_runs",
      "marketing_roi_export_audit",
      "marketing_request_finance_requirements",
      "marketing_request_approval_steps",
      "marketing_request_pharmacies",
      "marketing_request_products",
      "marketing_requests",
    ],
  },
];

export type ResetTableResult = { table: string; deleted: number };

export type ResetResult = {
  scope: ResetScope;
  executedAt: string;
  executedBy: string;
  tables: ResetTableResult[];
  totalDeleted: number;
};

export async function executeReset(scope: ResetScope, executedBy: string): Promise<ResetResult> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase.rpc("phx_admin_reset_module_data", {
    p_module: scope,
  });

  if (error) {
    throw new Error(`Reset failed: ${error.message}`);
  }

  const tables = (data as ResetTableResult[] | null) ?? [];
  const totalDeleted = tables.reduce((sum, t) => sum + (t.deleted ?? 0), 0);

  return {
    scope,
    executedAt: new Date().toISOString(),
    executedBy,
    tables,
    totalDeleted,
  };
}
