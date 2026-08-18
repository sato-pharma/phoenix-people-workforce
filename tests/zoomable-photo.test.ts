import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Tap a photo → it opens full screen and zooms.
//
// This is a source-shape test on purpose. The behaviour being protected is a browser gesture
// (pinch, wheel, drag) that no assertion in this hand-rolled Node suite can actually perform —
// there is no DOM here. What CAN be pinned, and what actually regresses, is the wiring: a photo
// surface quietly going back to a bare <img>, or one of the four non-obvious lines in the overlay
// being "tidied away" by someone who cannot see what it does.
// ─────────────────────────────────────────────────────────────────────────────

const source = (path: string) => readFileSync(path, "utf8");

/**
 * Source with its comments stripped.
 *
 * Needed because several of these files DISCUSS `<img>` in prose — cv-preview-modal.tsx explains at
 * length why a photographed CV is rendered as one — and a "no bare <img> left" check that reads a
 * comment as code fails on a file that is already correct.
 */
function code(path: string): string {
  // Line-wise, NOT a `/* … */` regex: one unbalanced comment opener anywhere in a 2,000-line file
  // makes a block-matching strip swallow real JSX hundreds of lines further down, and the failure
  // reads as "this surface was never wired" on a surface that plainly was.
  return source(path)
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !(
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("{/*")
      );
    })
    .join("\n");
}

/**
 * Every photo a person needs to actually LOOK at.
 *
 * Deliberately NOT in this list: the SATO/Phoenix logos in the command centres and the hero
 * portrait on the CEO identity banner. Those are branding — nobody needs to inspect them, and
 * making a logo open full screen on tap would be a bug, not a feature.
 */
const PHOTO_SURFACES = [
  // Marketing evidence — the storefront captures an approver decides money against.
  "src/components/marketing-requests/marketing-request-case-file.tsx",
  "src/components/marketing-requests/marketing-request-approver-detail.tsx",
  "src/components/employee-portal/marketing-request-decision-confirmation.tsx",
  "src/components/employee-portal/marketing-validation-workspace.tsx",
  // Outstation — receipts and car evidence, previously cropped to a strip.
  "src/components/outstation/trip-attachments.tsx",
  "src/components/outstation/my-expense-submissions.tsx",
  "src/components/outstation/outstation-requests-admin.tsx",
  "src/components/outstation/mobile-outstation-wizard.tsx",
  // Direct orders — the pharmacy storefront behind a validation decision.
  "src/components/direct-orders/validation-desk.tsx",
  "src/components/direct-orders/pharmacy-validation-capture.tsx",
  "src/components/approvals-hub/direct-order-request-detail.tsx",
  // People — avatars are square-cropped small enough to cut off the face.
  "src/components/people/person-photo.tsx",
  "src/components/employees/employee-management.tsx",
  "src/components/employees/employee-photo-manager.tsx",
  "src/components/employee-portal/employee-photo-editor.tsx",
  // Recruitment — CVs photographed on a phone and sent over WhatsApp.
  "src/components/recruitment/cv-preview-modal.tsx",
];

export function runZoomablePhotoTests() {
  const viewer = source("src/components/ui/zoomable-photo.tsx");

  // ── 1. Every photo surface goes through the shared viewer ──────────────────
  // The point of one component is that all sixteen surfaces behave identically. A surface that
  // renders its own <img> is the exact regression this list exists to catch.
  for (const path of PHOTO_SURFACES) {
    const file = code(path);
    assert.match(file, /<ZoomablePhoto\b/, `${path} must render its photo through the shared viewer`);
    assert.doesNotMatch(
      file,
      /<img\b/,
      `${path} still renders a bare <img> — that photo cannot be opened or zoomed`,
    );
  }

  // ── 2. The four lines that make the gestures work ──────────────────────────

  // React attaches its onWheel listener PASSIVELY, so preventDefault() inside it is ignored and the
  // page scrolls behind the overlay while the photo zooms. A hand-attached non-passive listener is
  // the only way to stop that — losing `{ passive: false }` breaks desktop zoom in a way that looks
  // like the component "sort of works".
  assert.match(
    viewer,
    /addEventListener\("wheel",\s*handleWheel,\s*\{\s*passive:\s*false\s*\}\)/,
    "the wheel listener must be non-passive, or the page scrolls behind a zooming photo",
  );

  // Without touch-action:none the browser claims the pinch for its own page zoom and the two-finger
  // drag for scrolling, and NEITHER gesture ever reaches this component. On a phone that is the
  // whole feature.
  assert.match(viewer, /touch-none/, "the stage must set touch-action:none or no pinch ever reaches it");

  // Rendered into document.body, so the overlay escapes every `overflow-hidden` card and stacking
  // context it would otherwise be clipped inside — several of these photos sit in exactly that.
  assert.match(viewer, /createPortal\(/, "the overlay must portal out of its card, not render in place");

  // Esc, focus trap, return-focus and the body scroll lock all come from the repo's own hook rather
  // than a second implementation that would drift from every other modal.
  assert.match(viewer, /useDialogA11y/, "the overlay must reuse the shared dialog a11y hook");

  // ── 3. Opening a photo must not fire the row underneath it ─────────────────
  // Several of these photos sit inside a link or a clickable row — the outstation trip attachment
  // is literally wrapped in an <a target="_blank">. Without both calls, tapping the photo opens the
  // viewer AND navigates away from it.
  assert.match(viewer, /event\.preventDefault\(\);/, "opening the viewer must not follow the anchor around it");
  assert.match(viewer, /event\.stopPropagation\(\);/, "opening the viewer must not fire the row's own click");

  // ── 4. Zoom cannot go below the fitted size ────────────────────────────────
  // Scaling under 1 would shrink the photo inside its own overlay, which is never what anyone
  // wants, and the reset path depends on 1 meaning "fitted".
  assert.match(viewer, /const MIN_SCALE = 1;/, "1 is fitted-to-window — zooming below it is never useful");
}
