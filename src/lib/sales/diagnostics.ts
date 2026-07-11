import { detectDistributorFromBuffer } from "@/lib/sales/distributor-detection";
import { getDistributorProfileSummary, type DistributorProfileSummary } from "@/lib/sales/distributor-registry";
import type { DetectionResult } from "@/lib/sales/normalizer/detect-distributor";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { analyzeMonthlyUpload, type AnalyzeResult } from "@/lib/sales/sales-upload";

// ── E5: Sales Diagnostics ──────────────────────────────────────────────────────────────────────
// Upload any file and see EXACTLY what the system would do — detected distributor + confidence,
// the profile it would use, recognition coverage, unknown items and the reconciliation receipt —
// WITHOUT importing. Reuses the same detection + analyze (recognizer) the real upload uses, so the
// diagnosis matches the real behavior.

export type DiagnosticsResult = {
  detection: DetectionResult;
  chosenDistributor: string | null;
  profileSummary: DistributorProfileSummary | null;
  analyze: AnalyzeResult | null;
};

export async function diagnoseWorkbook(
  file: File,
  distributorOverride?: string,
  // Confidential products (LA003/LA004/SS001) to strip from the analyze breakdown/preview — this
  // reuses the real analyze path, so it must apply the same viewer-based exclusion analyze does.
  excludeProductCodes: readonly string[] = [],
): Promise<DiagnosticsResult> {
  const buffer = await file.arrayBuffer();
  const detection = await detectDistributorFromBuffer(buffer);
  const chosen = normalizeCodeKey(distributorOverride || detection.best?.distributorCode || "");
  let profileSummary: DistributorProfileSummary | null = null;
  let analyze: AnalyzeResult | null = null;
  if (chosen) {
    profileSummary = await getDistributorProfileSummary(chosen);
    analyze = await analyzeMonthlyUpload(chosen, file, "", excludeProductCodes);
  }
  return { detection, chosenDistributor: chosen || null, profileSummary, analyze };
}
