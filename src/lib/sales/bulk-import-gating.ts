// Gating rule for /sales/upload's Bulk Import mode (src/components/sales/bulk-import-workspace.tsx):
// which touched (opened) distributor cards must be resolved or explicitly removed before
// "Confirm & Import All" is enabled. Pulled out of the component so the rule is unit-testable
// directly (that file also renders JSX, which the plain-Node test loader can't parse).

export type BulkSlotStage = "idle" | "working" | "rejected" | "ready" | "committed" | "commit_failed";

// A touched card only blocks when it has real in-flight state: a file picked that's still
// validating ("working") or that failed validation ("rejected"). A card that's merely been
// opened/peeked at and never had a file picked ("idle", or no status reported yet) has nothing to
// lose — it's silently skipped on confirm, exactly as if it had never been touched, so opening
// several distributors to check them never forces uploading (or explicitly removing) every single
// one. See PR #1427, which added the manual "Remove from this import" escape hatch but left a
// never-touched card permanently blocking until someone clicked it.
export function isBulkSlotBlocking(stage: BulkSlotStage | undefined): boolean {
  return stage === "working" || stage === "rejected";
}
