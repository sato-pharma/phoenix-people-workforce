import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import {
  adminNavigationSections,
  type NavigationSection,
} from "../src/config/system-navigation.ts";
import {
  buildPermissionLookup,
  createAccessContext,
  permissionMatrix,
  resolveNavigationMode,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { needsYouDestinations } from "../src/lib/needs-you/types.ts";
import { getSections } from "../src/lib/navigation/active-path.ts";
import { portalTwinRules, resolvePortalTwin } from "../src/lib/navigation/portal-twins.ts";
import { canDecideStep } from "../src/lib/market-awareness/workflow.ts";
import { stripComments } from "./support/comment-strip.ts";

const ADMIN_INBOX = "/admin/market-awareness/inbox";
const PORTAL_INBOX = "/employee-portals/market-awareness/inbox";

function adminHrefsFor(role: PhoenixRole): string[] {
  // buildPermissionLookup, never a hand-rolled double loop: tests/permission-lookup-totality counts them.
  return getSections(
    adminNavigationSections as readonly NavigationSection[],
    "admin",
    buildPermissionLookup(permissionMatrix, role),
    role,
  )
    .flatMap((navSection) => navSection.items.map((navItem) => navItem.href));
}

function source(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

/**
 * The CEO must be able to DECIDE a Market Awareness activity, not merely be named as its last step.
 *
 * Found 2026-10-04: four activities were sitting at `pending_ceo`, the CEO was told so, and he had no
 * Approve, Reject or Return button anywhere. The data layer was right — `canDecideStep` clears the
 * CEO step on role, and the inbox card draws its buttons when the server says `canDecide` — but the
 * only screen that draws them was `/employee-portals/market-awareness/inbox`, and
 * `resolveNavigationMode` pins the CEO (and every Super Admin) to the ADMIN shell, so that page
 * answered him with a redirect to /overview. The admin Market Awareness page holds the workspace and
 * no decision control, and nothing in the admin sidebar or on his Needs You card led to an inbox.
 *
 * Every assertion pins one of the doors; any one closing again reproduces the outage.
 */
export function runCeoMarketAwarenessApprovalInboxTests() {
  const ceo = createAccessContext({ hrId: "AA", role: "CEO" });
  const superAdmin = createAccessContext({ hrId: "B-10", role: "Super Admin" });

  // ── The premise: the two people who answer the last step each have exactly ONE shell, the admin ─
  assert.equal(resolveNavigationMode(ceo), "admin", "the CEO is an admin-shell executive");
  assert.equal(resolveNavigationMode(superAdmin), "admin", "Super Admin is an admin-shell role");
  assert.equal(canDecideStep({ access: ceo, step: "ceo" }), true, "the CEO answers the CEO step");
  assert.equal(canDecideStep({ access: superAdmin, step: "ceo" }), true, "Super Admin may answer any step");
  assert.equal(
    canDecideStep({ access: createAccessContext({ hrId: "A-9", role: "Marketing Manager" }), step: "ceo" }),
    false,
    "the approval group never answers the CEO step",
  );

  // ── Door 1: the admin page exists, serves the SAME inbox, and gates inline ──────────────────────
  const adminPage = source("app/(admin)/admin/market-awareness/inbox/page.tsx");
  assert.match(
    adminPage,
    /<MarketAwarenessInbox isCeoStepHolder=\{isCeoStepHolder\} \/>/,
    "the admin page must render the one shared inbox component, or the two shells drift into two sets of buttons",
  );
  assert.match(
    adminPage,
    /isCeoStepHolder = access\.role === "CEO" \|\| access\.role === "Super Admin"/,
    "only the CEO step is offered the amended-amount field",
  );
  assert.match(
    adminPage,
    /canAccess\(access, "market_awareness", "read"\)/,
    "the gate must be inline so the nav entry's permission mirrors a check the page really makes",
  );
  assert.match(
    adminPage,
    /resolveNavigationMode\(access\) === "employee-portal"\)\s*\{\s*redirect\("\/employee-portals\/market-awareness\/inbox"\)/,
    "a portal-mode viewer who lands here goes to his own inbox, not to the portal home",
  );

  // ── Door 2: the sidebar link that leads there ──────────────────────────────────────────────────
  for (const [label, role] of [["CEO", "CEO"], ["Super Admin", "Super Admin"]] as const) {
    assert.equal(
      adminHrefsFor(role).includes(ADMIN_INBOX),
      true,
      `${label} must see Awareness Approvals in the admin sidebar — an unreachable page is the same as no page`,
    );
  }
  const navigation = readFileSync("src/config/system-navigation.ts", "utf8");
  const rowAt = navigation.indexOf(`href: "${ADMIN_INBOX}"`);
  assert.ok(rowAt > 0, "the admin sidebar seed must still carry the Awareness Approvals row");
  assert.match(
    navigation.slice(rowAt, rowAt + 400),
    /navBadge: "market-awareness-approvals-pending"/,
    "the row must carry the awareness badge, or a decision waits behind a silent link",
  );
  // It is the DECISION surface: roles holding no decision there never get it drawn.
  for (const role of ["Finance Manager", "SFE Manager", "Financial Advisor"] as const) {
    assert.equal(
      adminHrefsFor(role).includes(ADMIN_INBOX),
      false,
      `${role} holds no awareness decision and must not be offered the approvals row`,
    );
  }

  // ── Door 3: the portal pages no longer strand an admin-shell viewer on /overview ───────────────
  // Every decision notification, and the Needs You card before this change, names these addresses.
  const portalInbox = source("app/employee-portals/market-awareness/inbox/page.tsx");
  assert.match(
    portalInbox,
    /resolveNavigationMode\(access\) !== "employee-portal"\)\s*\{\s*redirect\("\/admin\/market-awareness\/inbox"\);/,
    "the portal inbox must forward an admin-shell viewer to the admin inbox",
  );
  assert.ok(
    !/redirect\("\/overview"\)/.test(portalInbox),
    "the portal inbox must never answer the CEO with /overview — that is the outage",
  );
  const portalWorkspace = source("app/employee-portals/market-awareness/page.tsx");
  assert.match(
    portalWorkspace,
    /resolveNavigationMode\(access\) !== "employee-portal"\)\s*\{\s*redirect\("\/admin\/market-awareness"\);/,
    "the portal workspace must forward an admin-shell viewer to the admin workspace",
  );
  assert.ok(
    !/redirect\("\/overview"\)/.test(portalWorkspace),
    "the portal workspace must not bounce the CEO to /overview either",
  );

  // ── Door 4: the Needs You card opens the screen that owns the decision ─────────────────────────
  assert.equal(
    needsYouDestinations["market-awareness-approvals"].href,
    ADMIN_INBOX,
    "the card says 'awaiting your decision' — it must open the inbox, not the workspace that has no buttons",
  );

  // ── The reverse hop: a portal-mode approver following that card lands on his own inbox ─────────
  assert.ok(
    portalTwinRules.some((rule) => rule.from === ADMIN_INBOX && rule.to === PORTAL_INBOX),
    "the twin table must carry the admin inbox, or a National Sales Manager is dropped on the portal home",
  );
  assert.equal(resolvePortalTwin(ADMIN_INBOX, "National Sales Manager"), PORTAL_INBOX);
  assert.equal(
    resolvePortalTwin("/admin/market-awareness", "National Sales Manager"),
    "/employee-portals/market-awareness",
    "the workspace twin is untouched by the new, longer rule",
  );
}
