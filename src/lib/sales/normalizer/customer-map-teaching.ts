import { autoAcceptMin } from "@/lib/sales/normalizer/auto-apply";

// Which live customer mappings the suggestion pipeline LEARNS from (customer-suggest.ts): the free
// steps' address and twin indexes, and the AI's reference list. Every active mapping still resolves
// sales exactly as before; this only decides which ones may teach the next suggestion.
//
// Until 2026-09-18 every active mapping taught, however weak. A normalizer Save writes every
// pre-filled dropdown, reviewed or not, with the suggestion's own confidence - so a 10% AI guess saved
// that way came straight back as a 90% "same address" or "known twin" answer for the next pharmacy,
// and a wrong guess copied itself. Measured that day: 477 live normalizer mappings sat at 50-79%,
// and 631 more at 80-94%.

export type TeachingCandidate = { confidence?: number | null; source?: string | null };

/**
 * A normalizer mapping that carries a confidence is a saved suggestion: it teaches only once it clears
 * the bar Auto-map applies on its own (autoAcceptMin, 95 by default). Everything else teaches - a
 * person's pick (saved with no confidence), a mapping from before confidences were recorded, the
 * owner's and the older bulk sources, and Auto-map's own saves, which passed its gate to be written.
 */
export function teachesFreeSteps(row: TeachingCandidate, min: number = autoAcceptMin()): boolean {
  if (String(row.source ?? "").trim() !== "normalizer") return true;
  if (row.confidence == null) return true;
  return Number(row.confidence) >= min;
}
