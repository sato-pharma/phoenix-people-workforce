import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_DISPLAY_SCALE,
  DISPLAY_SCALE_CSS_VAR,
  DISPLAY_SCALE_OPTIONS,
  DISPLAY_SCALE_STORAGE_KEY,
  formatDisplayScale,
  isDisplayScale,
  parseDisplayScale,
  scaledWidthCapCss,
} from "../src/lib/ui/display-scale.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Display scale — the app's own zoom-out, on the dashboard content only.
//
// The owner asked for the system to OPEN scaled down (~80%) instead of at the browser's 100%,
// where a table shows six rows where it should show fifteen, plus a zoom control on the nav bar
// of every account type. His correction, twice: the sidebar, the upper bar and any bottom bar do
// NOT shrink — "it is the part of the dashboard itself", the identity banner and everything below
// it. So the zoom lives on <main> and nowhere above it.
//
// Most of the checks below exist because the failure they catch is SILENT. A zoom that stops
// applying, a shell whose <main> never got the class, a cap that turns the zoom into a narrower
// page, a statutory form printed at 80% — none of these throw, none go red on their own, and every
// one of them looks like "it just didn't do anything" from the outside.
// ─────────────────────────────────────────────────────────────────────────────

const GLOBALS_CSS = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const ROOT_LAYOUT = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
const APP_SHELL = readFileSync(new URL("../src/components/layout/app-shell.tsx", import.meta.url), "utf8");
const APP_SHELL_LOADING = readFileSync(
  new URL("../src/components/layout/app-shell-loading.tsx", import.meta.url),
  "utf8",
);
const PORTAL_LAYOUT = readFileSync(
  new URL("../src/components/employee-portal/employee-portal-layout.tsx", import.meta.url),
  "utf8",
);
const TOPBAR = readFileSync(new URL("../src/components/layout/topbar.tsx", import.meta.url), "utf8");
const SCREENING_PAGE_CLIENT = readFileSync(
  new URL("../src/components/recruitment/workstation/workstation-page-client.tsx", import.meta.url),
  "utf8",
);

const DESKTOP_GATE = "@media screen and (min-width: 1024px)";

/**
 * The stylesheet block that actually applies the zoom.
 *
 * Located by SEARCHING for the gate rather than by slicing a fixed byte window: a pinning test that
 * slices a window false-fails the moment anything above it in the file shifts, and globals.css is
 * edited constantly.
 */
function desktopZoomBlock(): string {
  const start = GLOBALS_CSS.indexOf(DESKTOP_GATE);
  assert.notEqual(
    start,
    -1,
    "app/globals.css no longer contains the desktop-gated display-scale block. If the gate was " +
      "widened or reworded, the zoom now also runs on phones — where it collides with the 16px " +
      "form-control floor that exists to stop iOS Safari zooming in and staying zoomed.",
  );
  return GLOBALS_CSS.slice(start, start + 2000);
}

function runScaleVocabularyTests() {
  // The default MUST be one of the offered steps. If it is not, the control computes an index of
  // -1, both buttons disable, and the reader is stuck at a scale they cannot change — the exact
  // shape of "the zoom buttons don't work".
  assert.ok(
    isDisplayScale(DEFAULT_DISPLAY_SCALE),
    `DEFAULT_DISPLAY_SCALE (${DEFAULT_DISPLAY_SCALE}) is not one of DISPLAY_SCALE_OPTIONS, so the ` +
      "nav-bar control would render with both buttons disabled and no way back.",
  );

  // Largest first: the control walks this array, and zooming IN means walking toward index 0.
  // Reversing it silently swaps the two buttons.
  const descending = [...DISPLAY_SCALE_OPTIONS].sort((a, b) => b - a);
  assert.deepEqual(
    [...DISPLAY_SCALE_OPTIONS],
    descending,
    "DISPLAY_SCALE_OPTIONS must stay ordered largest-to-smallest — the control derives which " +
      "button to disable from the index, so reordering inverts zoom in and zoom out.",
  );

  assert.ok(
    Math.min(...DISPLAY_SCALE_OPTIONS) >= 0.75,
    "No step below 75%: measured against this app's type scale, body text lands near 9px optical " +
      "and the field force on older laptops cannot read it.",
  );
  assert.equal(
    Math.max(...DISPLAY_SCALE_OPTIONS),
    1,
    "100% must remain offered — it is the way back for anyone who finds the default too small.",
  );

  assert.equal(formatDisplayScale(0.8), "80%");
  assert.equal(formatDisplayScale(1), "100%");
}

function runParseTotalityTests() {
  // parseDisplayScale reads a value from localStorage, which anyone can hand-edit and which an
  // older release may have written in a since-retired step. It runs inside the inline boot script,
  // ABOVE every React error boundary, so a throw here is a blank page rather than a wrong zoom.
  const rubbish = [null, undefined, "", "   ", "abc", "NaN", "0.83", "2", "-1", "0", "Infinity"];
  for (const bad of rubbish) {
    assert.equal(
      parseDisplayScale(bad as string | null | undefined),
      DEFAULT_DISPLAY_SCALE,
      `parseDisplayScale(${JSON.stringify(bad)}) must fall back to the default rather than let a ` +
        "value the stylesheet cannot use reach the page.",
    );
  }
  for (const good of DISPLAY_SCALE_OPTIONS) {
    assert.equal(parseDisplayScale(String(good)), good);
  }
}

function runStylesheetContractTests() {
  const block = desktopZoomBlock();

  // 1. The zoom is on the content surface, NOT on :root. The owner's correction, in his own words:
  //    the sidebar, the upper bar and any bottom bar do not shrink.
  assert.ok(
    block.includes(".phx-zoom-surface"),
    "The desktop block no longer targets .phx-zoom-surface. If the zoom moved up to :root, the " +
      "sidebar, the top bar and the zoom control itself shrink with it — which the owner " +
      "explicitly refused.",
  );
  assert.ok(
    !/:root\s*\{[^}]*\bzoom\s*:/.test(GLOBALS_CSS),
    "zoom must never be applied to :root — that scales the sidebar and the whole chrome with it, " +
      "which is the thing the owner asked twice to have left alone.",
  );

  // 2. PRINT IS EXCLUDED. A4 landscape is 1123px at 96dpi, so a bare `min-width: 1024px` fires
  //    while printing. Social-insurance Form 1 prints exactly as the Authority issues it, and the
  //    hiring-pack papers are pinned to real paper geometry — both would have gone out at 80%.
  assert.ok(
    block.startsWith("@media screen and"),
    "The display-scale media query must keep its `screen` keyword. Dropping it prints every " +
      "statutory form and hiring-pack paper at the display scale.",
  );

  // 3. One variable, one source: the stylesheet and the boot script must name the same custom
  //    property, or the zoom silently never applies.
  assert.ok(
    GLOBALS_CSS.includes(DISPLAY_SCALE_CSS_VAR),
    `app/globals.css must read ${DISPLAY_SCALE_CSS_VAR}, the property the boot script writes.`,
  );

  // 4. The width cap divides by the scale. Without this the zoom makes the page NARROWER, not
  //    denser: measured on the live portal at 1440x900, a raw cap took the content column from
  //    1,425 device px down to 1,264 with 81px of dead margin, for only 15% more content.
  assert.ok(
    GLOBALS_CSS.includes(scaledWidthCapCss(1760)),
    `The admin cap must be ${scaledWidthCapCss(1760)} — a raw 1760px cap inside the zoomed ` +
      "coordinate space paints at 1,408 device px and undoes the whole change.",
  );
}

function runBootScriptContractTests() {
  // The scale must be applied BEFORE first paint. A React effect would paint the shell at 100%
  // and then snap it — a visible lurch on every load and every navigation.
  assert.ok(
    ROOT_LAYOUT.includes("DISPLAY_SCALE_BOOT_SCRIPT"),
    "app/layout.tsx no longer carries the pre-paint boot script; the content will flash at 100% " +
      "before correcting, on every page load.",
  );
  assert.ok(
    ROOT_LAYOUT.indexOf("DISPLAY_SCALE_BOOT_SCRIPT") < ROOT_LAYOUT.indexOf("<GlobalErrorReporter"),
    "The boot script must render before the shell, or it stops preventing the flash it exists for.",
  );

  // Interpolated from the module rather than hand-typed, so the allowed steps cannot drift between
  // the control, the stylesheet and the boot script.
  for (const token of ["DISPLAY_SCALE_OPTIONS", "DISPLAY_SCALE_STORAGE_KEY", "DISPLAY_SCALE_CSS_VAR"]) {
    assert.ok(
      ROOT_LAYOUT.includes(token),
      `The boot script must interpolate ${token} from src/lib/ui/display-scale.ts rather than ` +
        "repeat its value, or the two copies drift and a stored scale stops being recognised.",
    );
  }

  assert.ok(
    ROOT_LAYOUT.includes("catch(e)"),
    "The boot script must stay wrapped in try/catch — localStorage throws outright in some privacy " +
      "modes, and this runs above every React error boundary, so an uncaught throw is a blank page.",
  );

  assert.equal(
    DISPLAY_SCALE_STORAGE_KEY,
    "phoenix-display-scale",
    "Renaming the storage key silently resets every reader's saved zoom back to the default.",
  );
}

function runWiringTests() {
  // THE CHECK THAT MATTERS MOST. A feature can ship green, deploy cleanly and be reachable by
  // nobody — and a shell whose <main> never got the class simply does not zoom, with no error.
  const surfaces: ReadonlyArray<readonly [string, string]> = [
    ["src/components/layout/app-shell.tsx", APP_SHELL],
    ["src/components/layout/app-shell-loading.tsx", APP_SHELL_LOADING],
    ["src/components/employee-portal/employee-portal-layout.tsx", PORTAL_LAYOUT],
  ];
  for (const [name, source] of surfaces) {
    assert.ok(
      source.includes("phx-zoom-surface"),
      `${name} has a <main> with no phx-zoom-surface class, so that shell renders at 100% while ` +
        "the others scale. The loading skeleton counts too: if it disagrees with the loaded page, " +
        "the content visibly jumps size as the page settles.",
    );
  }

  // The control on the nav bar of every account type — the owner asked for it there by name, after
  // a first version put it in the account menu and he could not see any difference at all.
  assert.ok(
    TOPBAR.includes("<DisplayScaleControl"),
    "The admin topbar no longer renders the zoom control.",
  );
  assert.ok(
    PORTAL_LAYOUT.includes("<DisplayScaleControl"),
    "The employee-portal nav bar no longer renders the zoom control.",
  );
}

function runViewportFrameTests() {
  // `zoom` does not compensate viewport units — 100vh resolves against the real window and is THEN
  // scaled — so a frame sized in vh inside <main> paints at 80% of the height it asked for. The
  // stylesheet divides `.h-screen` / `.min-h-screen` and deliberately leaves arbitrary values alone,
  // which means each full-height frame has to divide itself. The screening frame is the one the
  // owner saw: a CV pane 20% short, with a band of empty page under it.
  assert.ok(
    SCREENING_PAGE_CLIENT.includes("h-[calc((100vh_-_4rem)_/_var(--phx-scale-applied,1))]"),
    "The screening frame's height no longer divides 100vh by --phx-scale-applied, so inside the " +
      "0.8 zoom it paints at 80% of the window and leaves the CV pane short.",
  );
  assert.ok(
    SCREENING_PAGE_CLIENT.includes("min-h-[calc(32rem_/_var(--phx-scale-applied,1))]"),
    "The screening frame's floor no longer divides by --phx-scale-applied, so on a short window " +
      "it paints at 410px instead of the 512px it was written to hold.",
  );
}

export async function runDisplayScaleTests() {
  runScaleVocabularyTests();
  runParseTotalityTests();
  runStylesheetContractTests();
  runBootScriptContractTests();
  runWiringTests();
  runViewportFrameTests();
}
