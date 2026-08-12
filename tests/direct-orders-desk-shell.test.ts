import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

/**
 * "ONE PLACE" HAS TO REACH THE DESKS, or it stops at the edge of one route.
 *
 * WHAT THIS PINS. The workspace's Pharmacy Control / Reports / Commercial Controls tabs render a
 * grid of links OUT to ten desk pages. Before this, following one replaced the whole page: the tab
 * strip vanished, the only way back was the browser's Back button, and a Super Admin moving between
 * the validation queue and the held lane — one job, done in two places — left and re-entered the
 * module each time.
 *
 * The desks now sit under a `(desks)` route group whose layout renders the strip above every one of
 * them. A route group does not appear in the URL, so every desk link, redirect and bookmark is
 * unchanged; what it buys is a frame around exactly the ten desks and nothing else.
 *
 * The checks below are about the two ways this quietly comes undone: a new desk added outside the
 * group (which would open bare, and nobody would notice because it still works), and the tab strip
 * being copied rather than shared (which is how this module ended up correcting the word "Approved"
 * in four files).
 */
export async function runDirectOrderDeskShellTests() {
  const groupDir = new URL("../app/(admin)/admin/direct-orders/(desks)/", import.meta.url);
  const parentDir = new URL("../app/(admin)/admin/direct-orders/", import.meta.url);

  assert.ok(existsSync(new URL("layout.tsx", groupDir)), "the (desks) group must have a layout — that is the shell");

  // ── Every desk is inside the group ────────────────────────────────────────
  const DESKS = [
    "validations",
    "held",
    "pharmacies",
    "pharmacy-variances",
    "cleanup",
    "report",
    "rep-counters",
    "reconciliation",
    "approval-exceptions",
    "caps",
  ];
  for (const desk of DESKS) {
    assert.ok(
      existsSync(new URL(`${desk}/page.tsx`, groupDir)),
      `${desk} must live under (desks)/ so the Direct Orders tab strip frames it`,
    );
    assert.ok(
      !existsSync(new URL(`${desk}/page.tsx`, parentDir)),
      `${desk} must not ALSO exist outside the group — two files claiming one route is a build error ` +
        "waiting for whichever Next resolves first",
    );
  }

  // ── And only the desks are ───────────────────────────────────────────────
  //
  // `/new` and `/[id]` are focused single-purpose screens. A tab strip above them would offer six
  // ways to abandon what you are doing, and `/[id]` already has a Back link that returns to the
  // exact list you came from.
  const outsideGroup = readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("("))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(
    outsideGroup,
    ["[id]", "new"],
    "only the order detail and the submit form belong outside the desk shell. A NEW DESK ADDED HERE " +
      "would render bare — it would still work, which is exactly why nobody would notice.",
  );

  // ── The strip has ONE definition ─────────────────────────────────────────
  const strip = readFileSync(new URL("../src/components/direct-orders/workspace/direct-orders-tab-strip.tsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../src/components/direct-orders/workspace/direct-orders-desk-shell.tsx", import.meta.url), "utf8");
  const workspace = readFileSync(new URL("../src/components/direct-orders/workspace/direct-orders-workspace.tsx", import.meta.url), "utf8");

  assert.match(strip, /export const TAB_LABEL/, "the labels must live with the strip that renders them");
  for (const [name, source] of [["the desk shell", shell], ["the workspace", workspace]] as const) {
    assert.match(
      source,
      /DirectOrdersTabStrip/,
      `${name} must render the shared strip rather than its own copy`,
    );
    assert.doesNotMatch(
      source,
      /const TAB_LABEL/,
      `${name} must not declare its own labels — two copies is how "Approved" ended up wrong in four files`,
    );
  }

  // Tabs are LINKS, not click handlers: that is what makes a tab a real URL, so right-click,
  // middle-click and "copy link address" behave, and what lets the server fetch only that view.
  assert.match(strip, /<Link/, "the strip must navigate by <Link>");
  assert.doesNotMatch(strip, /onClick=/, "a tab must be a URL, not a click handler");

  // ── The shell must not invent an authorization rule ──────────────────────
  //
  // Each desk asserts its own, and several are narrower than anything the layout could know: the
  // Held Desk and Approval Exceptions are Super-Admin-only while the report is not. A gate here
  // would either duplicate those rules or weaken them.
  // Comments stripped first. The layout's docblock NAMES both `loadDirectOrderWorkspaceView` and the
  // absent access gate, precisely so nobody adds them — and an assertion that cannot tell a comment
  // from a call site is one that gets "fixed" by deleting the explanation.
  const layoutSource = readFileSync(new URL("layout.tsx", groupDir), "utf8");
  const layout = layoutSource
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
    .join("\n");
  assert.doesNotMatch(
    layout,
    /redirect\(|assertPermission|Forbidden/,
    "the desk layout must not gate access — each desk owns its own rule, and a second copy would drift",
  );
  assert.match(
    layout,
    /resolveDirectOrderWorkspaceTabs\(access\)/,
    "the strip's tabs must come from the shared capability resolver, so a desk and the workspace " +
      "cannot disagree about which tabs a viewer has",
  );
  assert.doesNotMatch(
    layout,
    /loadDirectOrderWorkspaceView/,
    "the layout must NOT run the workspace loader — that would fire four counts and build the Needs " +
      "Action inbox on every desk page, to draw six buttons",
  );

  console.log(`  direct-orders desk shell: ${DESKS.length} desks framed, /new and /[id] deliberately outside`);
  console.log("  direct-orders desk shell: one tab-strip definition, links not handlers, no second access rule");
}
