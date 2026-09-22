import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// The portal home snapshot used to fetch a number nobody rendered.
//
// Its District Manager, National Sales Manager and Regional Manager branches each awaited
// `getAwaitingMyActionItems(access, "portal")`, took `.length`, and published it as
// `pendingApprovals` on `dsmTeam`, `nsmNational` and `rmRegional`. No component read it: all three
// command-center dashboards destructure the neighbouring fields and skip that one, and the field
// appears nowhere under `app/` or `src/components/`.
//
// It was not a free dead field. ONE "portal" call fans out to six data sources — vacation, excuse,
// resignations, contract renewals, plans awaiting action, and the whole employee directory — so
// every DM, NSM and RM paid for all six on every landing-page load, to compute a number that was
// then dropped on the floor.
//
// NOTHING IS LOST. The same count already reaches these users through the sidebar's
// `approvals-hub-pending` NavBadge, which reads `/api/approvals-hub/pending-count` — the very same
// `getAwaitingMyActionItems(access, "portal")` behind one shared endpoint. Removing the landing-page
// copy removes a duplicate fetch, not a capability, and the function keeps four other live callers.
//
// What this test pins is the pair of facts that made the removal safe, because either one drifting
// back is how the waste returns:
//   * the snapshot does not call getAwaitingMyActionItems at all, and
//   * the badge that actually shows the count is still wired to its endpoint.
// ─────────────────────────────────────────────────────────────────────────────

const SNAPSHOT_URL = new URL("../src/lib/employee-portal/home-snapshot.ts", import.meta.url);
const LAYOUT_URL = new URL("../src/components/employee-portal/employee-portal-layout.tsx", import.meta.url);
const DASHBOARDS = [
  "../src/components/employee-portal/dashboards/dsm-command-center.tsx",
  "../src/components/employee-portal/dashboards/nsm-command-center.tsx",
  "../src/components/employee-portal/dashboards/rm-command-center.tsx",
];

/** Drop comment lines: the prose in the module names both removed symbols on purpose. */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
    })
    .join("\n");
}

export async function runPortalHomeNoDeadApprovalsFetchTests() {
  const snapshot = stripComments(readFileSync(SNAPSHOT_URL, "utf8"));

  // ── The landing page must not fetch the approvals feed at all ─────────────
  assert.doesNotMatch(
    snapshot,
    /getAwaitingMyActionItems/,
    "RED the portal home snapshot must not call getAwaitingMyActionItems — one portal call fans out to six data sources, and the DM/NSM/RM landing pages rendered none of it",
  );
  assert.doesNotMatch(
    snapshot,
    /pendingApprovals/,
    "RED `pendingApprovals` is the dead field that fetch existed for — reintroducing it brings back six reads per landing-page load",
  );

  // ── The three dashboards must still not want it ───────────────────────────
  // If a dashboard ever starts rendering a pending count, this assertion fires and whoever is
  // adding it has to decide deliberately where the number comes from — rather than silently
  // resurrecting a second fetch of what the sidebar badge already has.
  for (const path of DASHBOARDS) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /pendingApprovals/,
      `RED ${path.split("/").pop()} reads pendingApprovals, which the snapshot no longer provides — wire it to the shared endpoint, do not re-add the fetch`,
    );
  }

  // ── The badge that DOES show this count is still wired ────────────────────
  // This is the half that makes the removal safe. If the badge goes, the count stops reaching these
  // users entirely, and that must not happen quietly as a side effect of some other change.
  const layout = readFileSync(LAYOUT_URL, "utf8");
  assert.match(
    layout,
    /approvals-hub-pending/,
    "RED the portal sidebar's approvals-hub-pending badge is what actually shows this count — without it the removal above would hide it",
  );
  assert.match(
    layout,
    /src="\/api\/approvals-hub\/pending-count"/,
    "RED the badge must still read /api/approvals-hub/pending-count — the shared endpoint over the same getAwaitingMyActionItems call",
  );
}
