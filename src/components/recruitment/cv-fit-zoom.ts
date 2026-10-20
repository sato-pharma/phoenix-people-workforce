// The CV viewer's zoom arithmetic, kept apart from the viewer (`cv-preview-modal.tsx`) so it is
// plain TypeScript the test runner can load and pin without a browser
// (`tests/recruitment-workspace-table.test.ts`).

/** How far the reader may push the zoom by hand, and the step the buttons move in. */
export const MIN_ZOOM = 0.35;
export const MAX_ZOOM = 2;
export const ZOOM_STEP = 0.15;

export function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/**
 * The zoom that fits a page into a pane.
 *
 * `pageWidth`/`pageHeight` are the page as painted at zoom 1, padding included. "width" fits across;
 * "page" fits across AND down, whichever is tighter — the recruitment workspace's half-page CV, where
 * page 1 must show whole with no scrolling (owner, 2026-10-20). It only ever SHRINKS (capped at 1 —
 * enlarging pdf.js's raster blurs it; the + button is for wanting it larger) and never below the hand
 * zoom's floor. A dimension not measured yet leaves the page at its true size.
 */
export function cvFitZoom({
  mode,
  pageHeight,
  pageWidth,
  paneHeight,
  paneWidth,
}: {
  mode: "width" | "page";
  pageHeight: number | null;
  pageWidth: number | null;
  paneHeight: number | null;
  paneWidth: number | null;
}): number {
  if (!pageWidth || !paneWidth || pageWidth <= 0 || paneWidth <= 0) return 1;
  const across = paneWidth / pageWidth;
  const down =
    mode === "page" && pageHeight && paneHeight && pageHeight > 0 && paneHeight > 0 ? paneHeight / pageHeight : Number.POSITIVE_INFINITY;
  return clampZoom(Math.min(1, across, down));
}
