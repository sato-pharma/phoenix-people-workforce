import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE MARKETING REQUESTS LIVE-SHEET LINKS PANEL (13 Oct 2026).
//
// Until now Marketing's links were API-only, and `SHARE_LINK_FEEDS` recorded `screen: null`. A second
// live feed link could therefore be minted by hand and the Friday token rotation would refuse for as
// long as it stood, with no screen able to say so (the CV-lifecycle sheet sat unrotated 3 d 22 h on
// exactly that). The panel mounts the shared rotation banner and gives the owner the mint and revoke
// controls that make it actionable. Each assertion below pins a rule that regresses silently and
// invisibly: a gate drifting from its API, a surface nothing serves, a horizontal scroll, a corner.
// ─────────────────────────────────────────────────────────────────────────────

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

export function runMarketingShareLinksPanelTests() {
  const panel = stripComments(read("../src/components/marketing-requests/report-share-links-panel.tsx"));
  const service = stripComments(read("../src/lib/marketing-requests/report-share-links.ts"));
  const adminPage = stripComments(read("../app/(admin)/admin/marketing-requests/all/page.tsx"));
  const portalPage = stripComments(read("../app/employee-portals/marketing-requests/all/page.tsx"));
  const registry = read("../src/lib/security/access-registry.ts");

  // ── 1. The page gate IS the API gate ────────────────────────────────────────
  // The service asserts expenses:export on list, create and revoke. A page narrower than that strands
  // a holder who can still call the API; a page wider offers a button that bounces on arrival.
  const serviceGates = [...service.matchAll(/assertPermission\(access, "(\w+)", "(\w+)"\)/g)].map(
    (match) => `${match[1]}:${match[2]}`,
  );
  assert.deepEqual([...new Set(serviceGates)], ["expenses:export"], "every service entry point asserts expenses:export");
  for (const [name, page] of [["admin", adminPage], ["portal", portalPage]] as const) {
    assert.ok(
      page.includes('canAccess(access, "expenses", "export")'),
      `the ${name} register must gate the panel on expenses:export, exactly as the service does`,
    );
    assert.ok(
      /\{canShare \? <MarketingReportShareLinksPanel \/> : null\}/.test(page),
      `the ${name} register must mount the panel only for a holder of that gate`,
    );
  }
  assert.ok(
    registry.includes('pattern: "/api/marketing-requests/report/share-links"'),
    "the management route must still be declared in the access registry",
  );

  // ── 2. Feed only: no route serves a Marketing 'live' link ──────────────────
  assert.ok(panel.includes('surface: "feed"'), "the panel mints Sheets feed links");
  assert.ok(!/surface:\s*"live"|setSurface|passcode/i.test(panel), "no live surface and no passcode: nothing serves a human Marketing link");

  // ── 3. The sheet takes the bare token (FEED_TOKEN), shown once, never listed ─
  assert.ok(panel.includes("FEED_TOKEN"), "the mint result must name the script property the sheet reads");
  assert.ok(panel.includes("refreshMarketingRequests"), "…and the function that proves the sheet took it");
  assert.ok(panel.includes("shown once and cannot be retrieved"), "the mint result must say this is the only sighting");
  assert.ok(panel.includes("allowFiles"), "the file grant is a separate, explicit choice on the form");

  // ── 4. The rotation banner is on the panel, and loads without a click ──────
  assert.ok(!panel.includes("if (!open) return;"), "the list read must not wait for the open click");
  assert.ok(panel.includes("useEffect"), "the list is read on mount");

  // ── 5. The owner's golden rules, in the markup ──────────────────────────────
  assert.ok(panel.includes("table-fixed") && panel.includes("<colgroup>"), "desktop is table-fixed with a colgroup");
  assert.ok(panel.includes("md:hidden"), "mobile gets cards");
  assert.ok(!panel.includes("overflow-x-auto") && !panel.includes("overflow-x-scroll"), "never a horizontal scroll");
  assert.ok(!panel.includes("min-w-["), "no min-width floor to scroll over");
  assert.ok(!/\brounded(-|\b)/.test(panel), "the square-edge golden rule: no rounded corners");
  assert.ok(!/\btruncate\b/.test(panel) && !/text-ellipsis/.test(panel), "never truncate with an ellipsis — wrap");
  assert.ok(panel.includes("break-all") && panel.includes("break-words"), "fitting is done by wrapping");
  assert.ok(panel.includes('timeZone: "Africa/Cairo"'), "every time is Cairo local");
  assert.ok(
    panel.includes("phxFieldClassName") && panel.includes("CheckTile"),
    "controls come from the one form design: form-tokens and form-kit, never hand-written boxes",
  );
}
