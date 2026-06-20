// Sales Upload — pure decision for the Step-1 "AI verification" panel (PURE, no I/O, unit-tested).
//
// Auto-detection (src/lib/sales/distributor-detection.ts) is ADVISORY ONLY. It returns best=null
// whenever it cannot confidently identify the distributor — either no profile matched the file's
// headers, or two+ profiles tie ("ambiguous"). The real safety gate is the strict validation in
// Step 2 plus the server re-validation at commit, NOT this step.
//
// REGRESSION GUARD (this is why the helper exists): the wizard originally drew the "Confirm" button
// ONLY when detection succeeded, so a file detection couldn't recognize (or an ambiguous tie) left the
// operator silently stuck on Step 1 — no message, no button, Validate locked forever. The invariant
// below makes that impossible: once a detection attempt has FINISHED (`ran`), there is ALWAYS a way to
// confirm and unlock Step 2 (canConfirm === true for every finished state). tests/sales-upload-
// verification.test.ts asserts this, so the dead-end can never be reintroduced unnoticed.

export type VerificationStepInput = {
  /** True once a detection attempt has completed — even when it found nothing. */
  ran: boolean;
  /** The auto-detected distributor code, or null when detection was ambiguous / matched no profile. */
  detectedCode: string | null;
  /** The distributor the operator already picked on the page. */
  selectedCode: string;
};

// idle        → verification hasn't run yet (nothing to show)
// match       → detected the SAME distributor the operator picked
// mismatch    → detected a DIFFERENT distributor (warn, but allow override)
// unrecognized→ detection finished but couldn't identify one distributor (none / ambiguous tie)
export type VerificationPanel = "idle" | "match" | "mismatch" | "unrecognized";

export type VerificationStepView = {
  panel: VerificationPanel;
  /** Whether a Confirm control must be shown so the operator can unlock Step 2. */
  canConfirm: boolean;
};

// Distributor codes are short stable identifiers; compare case/space-insensitively so a trivial casing
// difference between the detected code and the picked code can never be misread as a mismatch.
function sameDistributor(a: string | null, b: string): boolean {
  if (!a) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function resolveVerificationStep(input: VerificationStepInput): VerificationStepView {
  const { ran, detectedCode, selectedCode } = input;
  if (sameDistributor(detectedCode, selectedCode)) return { panel: "match", canConfirm: true };
  if (detectedCode) return { panel: "mismatch", canConfirm: true };
  if (ran) return { panel: "unrecognized", canConfirm: true };
  return { panel: "idle", canConfirm: false };
}
