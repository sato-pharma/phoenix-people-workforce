import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// The Case File's "Go deeper" drill-downs open IN PLACE — they never leave the page.
//
// ── THE DEFECT THIS PINS ─────────────────────────────────────────────────────
// The four drill-downs (Customer sales history, How this ROI was calculated, Matched sales rows,
// Direct-sales tracking) were plain full-navigation links pointed straight at raw JSON API routes
// (/api/marketing-requests/<id>/sales-evidence and its three siblings, every one a
// NextResponse.json(...)). Pressing any of them navigated the browser OFF the Case File and dumped
// raw JSON into the window, or triggered a download. The panels that render each of these richly
// already exist and self-fetch by request id; the fix mounts them inline below a toggle button.
//
// This is a source-pinning test on purpose: `pnpm run test` runs under --experimental-strip-types,
// which strips types and does NOT compile JSX, so a component cannot be rendered here. The assertions
// read the two component sources and check the invariants the browser fix depends on. They are
// scoped to the two files' text and never to this file's own comments, so nothing below passes by
// matching its own prose.
// ─────────────────────────────────────────────────────────────────────────────

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const GO_DEEPER = "src/components/marketing-requests/marketing-case-file-go-deeper.tsx";
const CASE_FILE = "src/components/marketing-requests/marketing-request-case-file.tsx";

export async function runMarketingCaseFileGoDeeperTests() {
  const goDeeper = source(GO_DEEPER);
  const caseFile = source(CASE_FILE);

  /* ---------------------------------------------------------------------- */
  /* 1. The expander is a client component                                   */
  /* ---------------------------------------------------------------------- */

  // It owns open/closed state and mounts panels that hold state and fetch on mount — none of which
  // a server component can do.
  assert.match(
    goDeeper.slice(0, 40),
    /^"use client";/,
    "the Go deeper expander holds toggle state and mounts self-fetching panels, so it must be a client component",
  );

  /* ---------------------------------------------------------------------- */
  /* 2. Each of the four drill-downs is imported AND rendered inline          */
  /* ---------------------------------------------------------------------- */

  // Both are pinned: an import with no JSX usage mounts nothing, and a JSX tag with no import does
  // not compile — only the pair proves the panel actually renders in place.
  const panels = [
    "MarketingSalesEvidencePanel",
    "MarketingRoiExplainPanel",
    "MarketingRequestSalesView",
    "DirectTrackingToggle",
  ] as const;
  for (const panel of panels) {
    assert.match(
      goDeeper,
      new RegExp(`import \\{ ${panel} \\}`),
      `Go deeper must import ${panel} — one of the four self-fetching drill-downs it renders`,
    );
    assert.match(
      goDeeper,
      new RegExp(`<${panel}[\\s/>]`),
      `Go deeper must RENDER <${panel}> inline, not merely import it`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 3. THE HEADLINE: no drill-down is a full-navigation link at the JSON     */
  /* ---------------------------------------------------------------------- */

  // The bug was an anchor carrying the section's API href. That anchor is gone from the Case File,
  // and no code path in either file builds one off the href field any more.
  assert.doesNotMatch(
    caseFile,
    /href=\{section\.href\}/,
    "the Case File must not link a drill-down at its raw JSON API route — pressing it dumped JSON and left the page",
  );
  for (const [label, text] of [["case file", caseFile], ["go deeper", goDeeper]] as const) {
    assert.doesNotMatch(
      text,
      /<a\b[^>]*section\.href/,
      `${label}: a drill-down must never be a full-navigation anchor to the API route — the fix is to expand it in place`,
    );
  }
  // The expander toggles panels, so it has no reason to read the href field at all.
  assert.doesNotMatch(
    goDeeper,
    /section\.href/,
    "the expander opens panels in place — it must never touch the href field that pointed at the JSON route",
  );

  /* ---------------------------------------------------------------------- */
  /* 4. The Case File delegates to the inline expander, threading the base    */
  /* ---------------------------------------------------------------------- */

  assert.match(
    caseFile,
    /<MarketingCaseFileGoDeeper\b/,
    "the Case File must render the inline expander in place of the old link list",
  );
  // The matched-sales panel builds its own internal view-sales links off this base, so the viewer's
  // resolved shell base has to travel to it — a hardcoded root would send half the chain in-shell
  // links into the wrong shell.
  assert.match(
    caseFile,
    /viewSalesBasePath=\{viewer\.viewSalesBasePath\}/,
    "the Case File must thread the viewer's shell-correct sales base into the expander",
  );
}
