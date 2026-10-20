import { closingFileName, coversOneRegion, regionScopeLabel } from "@/lib/sales/closing-export-filename";
import { loadRegionManagerNames } from "@/lib/sales/closing-organogram-regions";

/**
 * The download name of a Monthly Closing workbook, with the region's manager looked up when the
 * workbook covers exactly one region (owner, 2026-10-20 — see closing-export-filename.ts).
 *
 * Callers hand over the region labels their own rows carry, exactly as they handed them to
 * `regionScopeLabel`; this resolves the scope, then asks the organogram who runs that region on the
 * line. A workbook that spans several regions asks nobody. The lookup never throws — a name it
 * cannot find leaves the file named for the region alone.
 */
export async function resolveClosingFileName(
  parts: Omit<Parameters<typeof closingFileName>[0], "manager" | "region"> & {
    regionNames: Iterable<string | null | undefined>;
  },
): Promise<string> {
  const { regionNames, ...rest } = parts;
  const region = regionScopeLabel(regionNames);
  let manager: string | null = null;
  if (coversOneRegion(region)) {
    const managers = await loadRegionManagerNames(rest.line);
    manager = managers.get(region.trim().toLowerCase()) ?? null;
  }
  return closingFileName({ ...rest, manager, region });
}
