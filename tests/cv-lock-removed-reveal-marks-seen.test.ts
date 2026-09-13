import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

function read(relativePath: string): string {
  return readFileSync(relativePath, "utf8");
}

/**
 * The owner, 2026-09-13: *"remove the lock feature ... when the manager request to view the number,
 * then the number appear, and the CV is marked as seen ... he can normally move between any CVs."*
 *
 * Two halves. The CV feedback lock (2026-09-09 → 2026-09-13) must stay gone from every place it
 * lived, and pressing "I will call" — the one action that reveals the phone number — must also
 * record the CV as seen, best-effort.
 */
export function runCvLockRemovedRevealMarksSeenTests() {
  // ── 1 · The lock is gone ─────────────────────────────────────────────────────────────────────
  for (const removed of [
    "src/lib/recruitment/cv-feedback-lock.ts",
    "src/lib/recruitment/cv-feedback-lock-db.ts",
    "src/components/employee-portal/owed-feedback-box.tsx",
  ]) {
    assert.equal(existsSync(removed), false, `${removed} belonged to the removed CV feedback lock`);
  }

  const download = read("src/lib/recruitment/hiring-manager-view.ts");
  assert.doesNotMatch(
    download,
    /loadOutstandingFeedback|cvOpenRefusal|CvFeedbackRequiredError/,
    "opening a CV must not be refused for feedback owed on another CV",
  );
  // The open signal itself stays — only the refusal went.
  assert.match(download, /recordManagerCvOpen\(\{\s*candidateId,\s*viewerHrId:\s*access\.hrId\s*\}\)/);

  const fileRoute = read("app/api/recruitment/hiring-manager/candidates/[candidateId]/files/[fileId]/route.ts");
  assert.doesNotMatch(fileRoute, /423|feedback_required/, "the CV file route must not answer 423 for owed feedback");

  const preview = read("src/components/recruitment/cv-preview-modal.tsx");
  assert.doesNotMatch(preview, /status === 423|OwedFeedbackBox/, "the preview must not render a feedback lock");

  for (const page of [
    "app/employee-portals/recruitment-candidates/page.tsx",
    "app/(admin)/recruitment/candidates/page.tsx",
    "src/components/employee-portal/recruitment-candidates-portal.tsx",
    "src/components/employee-portal/candidate-cv-actions.tsx",
  ]) {
    assert.doesNotMatch(read(page), /outstandingFeedback|OutstandingFeedback/i, `${page} still carries the feedback lock`);
  }

  // ── 2 · Revealing the number marks the CV seen ───────────────────────────────────────────────
  const callRoute = read("app/api/recruitment/hiring-manager/candidates/[candidateId]/call/route.ts");
  assert.match(
    callRoute,
    /const revealed = action === "will_call" && Boolean\(outcome\.claim\);/,
    "the reveal is a successful will_call — the same moment the phone number is returned",
  );
  assert.match(
    callRoute,
    /const contact = revealed \? await loadCandidateContact\(candidateId\) : null;/,
    "the number and the seen mark must hang off the one condition",
  );
  assert.match(
    callRoute,
    /if \(revealed\) \{\s*try \{\s*await recordManagerCvOpen\(\{\s*candidateId,\s*viewerHrId:\s*access\.hrId\s*\}\);\s*\} catch \{/,
    "revealing the number must mark the CV seen under the manager's own HR_ID, wrapped so it never blocks the reveal",
  );
}
