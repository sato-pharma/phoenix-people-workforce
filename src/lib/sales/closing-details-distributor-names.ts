import { canRevealClosingSource, MASKED_SOURCE_DISTRIBUTORS, type SourceMaskViewer } from "@/lib/sales/closing-source-mask";
import type { ClosingDetailRow, ClosingDetailsResult } from "@/lib/sales/monthly-closing-details";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The Details panel's distributor NAMES.
//
// The panel showed `row.distributorCode` under every customer and as every Distributor filter
// option — `IS-S`, `EP-PHS`, `PS` — and the owner's rule is names, never codes, in the UI.
//
// 🔴 THIS RUNS ON THE LOADER'S OUTPUT, AFTER THE EL QEMA MASK, AND ONLY FOR THE SCREEN. By the time
// a result reaches here `loadMonthlyClosingDetails` has already REMOVED El Qema's rows for every
// viewer who may not reveal them (closing-source-mask.ts), so there is nothing of theirs left to
// name. The masked-code check below is a second lock, not the mechanism: a masked row that ever
// did arrive for such a viewer gets NO name, never El Qema's and never another distributor's.
//
// A BLANK code stays blank. A Main Stores row carries no distributor on purpose — it stands in for
// El Qema's money — and "Unnamed distributor" on it would announce a supplier that is being hidden.
// The fallback is for a real code the master has no name for, nothing else.
//
// The shared `ClosingDetailRow` type is deliberately left alone: the frozen monthly closing export
// and every computation read it, and none of them should start carrying a display label.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What a real distributor code with no name in the master is called on screen. Never the code. */
export const UNNAMED_DISTRIBUTOR_LABEL = "Unnamed distributor" as const;

export type NamedClosingDetailRow = ClosingDetailRow & {
  /** Display name for the row's distributor. Empty when the row has no distributor to name. */
  distributorName: string;
};

export type NamedClosingDetailsResult = Omit<ClosingDetailsResult, "rows" | "options"> & {
  rows: NamedClosingDetailRow[];
  options: Omit<ClosingDetailsResult["options"], "distributors"> & {
    /** The filter's choices: the CODE is the value sent back, the NAME is the label shown. */
    distributors: { code: string; name: string }[];
  };
};

function key(code: string | null | undefined): string {
  return String(code ?? "").trim().toUpperCase();
}

/** Code → name, keyed case-insensitively. Blank names are skipped so the fallback applies. */
export function buildDistributorNameIndex(
  entries: readonly { code: string; name: string }[],
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const entry of entries) {
    const code = key(entry.code);
    const name = String(entry.name ?? "").trim();
    if (code && name) index.set(code, name);
  }
  return index;
}

/**
 * The name a viewer sees for one distributor code.
 *
 * Blank code → blank (nothing to name). A masked distributor the viewer may not reveal → blank.
 * Otherwise the master's name, or `Unnamed distributor` — never the code itself.
 */
export function closingDetailDistributorName(
  code: string | null | undefined,
  names: ReadonlyMap<string, string>,
  viewer: SourceMaskViewer,
): string {
  const normalized = key(code);
  if (!normalized) return "";
  if (MASKED_SOURCE_DISTRIBUTORS.has(normalized) && !canRevealClosingSource(viewer)) return "";
  return names.get(normalized) ?? UNNAMED_DISTRIBUTOR_LABEL;
}

/** Put the display name on every row and label every Distributor filter option by name. */
export function nameClosingDetailDistributors(
  result: ClosingDetailsResult,
  names: ReadonlyMap<string, string>,
  viewer: SourceMaskViewer,
): NamedClosingDetailsResult {
  const distributors = result.options.distributors
    .map((code) => ({ code, name: closingDetailDistributorName(code, names, viewer) }))
    // An option with no name is one this viewer may not see: dropped, never offered blank.
    .filter((option) => option.name !== "")
    .sort((left, right) => left.name.localeCompare(right.name) || left.code.localeCompare(right.code));

  return {
    ...result,
    rows: result.rows.map((row) => ({
      ...row,
      distributorName: closingDetailDistributorName(row.distributorCode, names, viewer),
    })),
    options: { ...result.options, distributors },
  };
}

/**
 * Every distributor the master has ever named — INACTIVE ones included, because a closing month can
 * hold rows from a distributor retired since (chimipharm and Direct (Company) do). Fails soft to an
 * empty index: a missing label must never take the Details tab down.
 */
export async function loadDistributorNameIndex(): Promise<ReadonlyMap<string, string>> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("source_of_sales_distributors")
      .select("distributor_code,distributor_name");
    if (error) throw error;
    return buildDistributorNameIndex(
      (data ?? []).map((row) => ({
        code: String((row as Record<string, unknown>).distributor_code ?? ""),
        name: String((row as Record<string, unknown>).distributor_name ?? ""),
      })),
    );
  } catch {
    return new Map();
  }
}
