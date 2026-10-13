import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";
import type { AccessScope, PhoenixRole } from "../src/lib/auth/permissions.ts";
import {
  CLOSING_MATRIX_EMAIL_ROLES,
  resolveClosingPublishDestination,
} from "../src/lib/sales/closing-publish-destination.ts";
import { PORTAL_CLOSING_ROLES } from "../src/lib/sales/monthly-closing-portal.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE PUBLISHED-CLOSING EMAIL'S ONE LINK MUST REACH EVERY RECIPIENT'S OWN CLOSING PAGE.
//
// The email carries a single CTA URL for everybody it goes to, and
// app/api/sales/monthly-closing/go/route.ts resolves each clicker's destination server-side. The
// CEO is Cc'd on EVERY line's publish (FIXED_CC_ROLES in closing-publish-recipients.ts), and his
// link sent him to his Command Center — because the route still encoded the access rule as it stood
// when the email was built: Super Admin, system scope and the SFE Manager only.
//
// That rule changed on 2026-09-07. The CEO reported that Monthly Closing did not appear for him and
// that he could not reach it; he was offered the read-only analytics mount instead and refused it —
// he wants THAT page — and the owner's answer was to change the PAGE: its role guard now admits the
// CEO read-only (canPublish false, publish/unpublish/lock still Super-Admin-only in their own
// routes). Nothing tied the email's link to that guard, so for five weeks the one link in every
// publish notification could not open the page he had asked for by name.
//
// So this suite asserts the two against each other — the page's own guard source and the role set
// the link resolver uses — and not merely that today's answer is today's answer.
// ─────────────────────────────────────────────────────────────────────────────

const MATRIX_PAGE_SOURCE = "app/(admin)/sales/monthly-closing/page.tsx";
const GO_ROUTE_SOURCE = "app/api/sales/monthly-closing/go/route.ts";
const RECIPIENTS_SOURCE = "src/lib/sales/closing-publish-recipients.ts";

const LINE = "Pedia";
const PERIOD = "2026-08";

/** Every role's own scope, as scopeForRole resolves it — only `system` ever changes the answer. */
const SCOPE_BY_ROLE: Partial<Record<PhoenixRole, AccessScope>> = {
  "Super Admin": "company",
  CEO: "company",
  "SFE Manager": "company",
  "Marketing Manager": "company",
  "National Sales Manager": "line",
  "Regional Manager": "hierarchy",
  "District Manager": "team",
  "Medical Rep": "self",
};

function viewer(role: PhoenixRole): { role: PhoenixRole; scope: AccessScope } {
  return { role, scope: SCOPE_BY_ROLE[role] ?? "line" };
}

function destinationFor(role: PhoenixRole, options?: { canReadSales?: boolean }): string {
  return resolveClosingPublishDestination({
    viewer: viewer(role),
    canReadSales: options?.canReadSales ?? true,
    line: LINE,
    period: PERIOD,
  });
}

/** The live Cc list, read from the recipients module rather than copied, so adding a role here fails loudly. */
function fixedCcRoles(): PhoenixRole[] {
  const source = stripComments(readFileSync(RECIPIENTS_SOURCE, "utf8"));
  const declaration = /FIXED_CC_ROLES[^=]*=\s*\[([^\]]*)\]/.exec(source);
  assert.ok(
    declaration,
    `${RECIPIENTS_SOURCE} no longer declares FIXED_CC_ROLES — this suite reads the publish email's Cc list from it, so point it at the new name.`,
  );
  const roles = [...declaration[1].matchAll(/"([^"]+)"/g)].map(([, role]) => role as PhoenixRole);
  assert.ok(roles.length > 0, `${RECIPIENTS_SOURCE} declares FIXED_CC_ROLES with no roles in it.`);
  return roles;
}

/** The roles the Closing Matrix page's own guard names, which is the security boundary this link must respect. */
function matrixPageAdmittedRoles(): Set<PhoenixRole> {
  const source = stripComments(readFileSync(MATRIX_PAGE_SOURCE, "utf8"));
  const guard = /if \(!isSystemAdministratorViewer([^)]*)\)/.exec(source);
  assert.ok(
    guard,
    `${MATRIX_PAGE_SOURCE} no longer guards on isSystemAdministratorViewer — read its new guard here, because this link's role set is only correct while it matches that page.`,
  );
  // `access.role !== "SFE Manager" && access.role !== "CEO"` — every role the redirect excepts is
  // a role the page admits.
  return new Set([...guard[1].matchAll(/access\.role !== "([^"]+)"/g)].map(([, role]) => role as PhoenixRole));
}

export async function runClosingPublishEmailDestinationTests() {
  // ── 1. The regression: the CEO's link opens the Closing Matrix on the published month ──────────
  assert.equal(
    destinationFor("CEO"),
    `/sales/monthly-closing?line=${LINE}&period=${PERIOD}`,
    "the CEO is Cc'd on every publish and the page admits him read-only since 2026-09-07 — his link must open that matrix on the month that was just published, not his Command Center",
  );
  assert.notEqual(
    destinationFor("CEO"),
    resolveLandingPathForRole("CEO"),
    "the CEO's publish-email link must never degrade to his landing page while he can open the Closing Matrix itself",
  );

  // ── 2. Nobody Cc'd on every line's publish lands on a generic page ────────────────────────────
  const closingPaths = ["/sales/monthly-closing", "/employee-portals/monthly-closing"];
  for (const role of fixedCcRoles()) {
    const destination = destinationFor(role);
    assert.ok(
      closingPaths.some((path) => destination === path || destination.startsWith(`${path}?`)),
      `${role} is Cc'd on every closing publish, so the email's link must open a closing page for them — it resolved to ${destination}`,
    );
  }

  // ── 3. The link's role set and the page's own guard must agree ────────────────────────────────
  const admitted = matrixPageAdmittedRoles();
  for (const role of admitted) {
    assert.ok(
      CLOSING_MATRIX_EMAIL_ROLES.has(role),
      `${MATRIX_PAGE_SOURCE} admits ${role} but the publish email's link does not send them there — this is exactly the drift that stranded the CEO for five weeks`,
    );
  }
  for (const role of CLOSING_MATRIX_EMAIL_ROLES) {
    if (role === "Super Admin") continue; // covered by isSystemAdministratorViewer, not by name
    assert.ok(
      admitted.has(role),
      `the publish email's link sends ${role} to ${MATRIX_PAGE_SOURCE}, whose guard no longer admits them — the link would bounce straight back out`,
    );
  }

  // ── 4. A portal viewer gets the portal tab, with the period only ──────────────────────────────
  for (const role of PORTAL_CLOSING_ROLES) {
    if (CLOSING_MATRIX_EMAIL_ROLES.has(role)) continue; // a Matrix role never falls through to the portal
    const destination = destinationFor(role);
    assert.equal(
      destination,
      `/employee-portals/monthly-closing?period=${PERIOD}`,
      `${role} reads the closing in their portal tab, scoped from their HR_ID — the link must carry the period and nothing else`,
    );
    assert.ok(
      !destination.includes("line="),
      `${role} never picks a line — it is resolved from their own record — so the link must not forward one`,
    );
  }

  // ── 5. Super Admin and system scope, unchanged ────────────────────────────────────────────────
  assert.equal(destinationFor("Super Admin"), `/sales/monthly-closing?line=${LINE}&period=${PERIOD}`);
  assert.equal(
    resolveClosingPublishDestination({
      viewer: { role: "Employee", scope: "system" },
      canReadSales: true,
      line: LINE,
      period: PERIOD,
    }),
    `/sales/monthly-closing?line=${LINE}&period=${PERIOD}`,
    "system scope opens the matrix whatever the role reads, exactly as the page's own guard does",
  );

  // ── 6. sales:read is still the boundary, and the fall-through is a landing page ────────────────
  for (const role of ["CEO", "SFE Manager", "District Manager", "Marketing Manager"] as PhoenixRole[]) {
    assert.equal(
      destinationFor(role, { canReadSales: false }),
      resolveLandingPathForRole(role),
      `a ${role} who cannot read sales must degrade to their landing page — this route checks that boundary, it never widens it`,
    );
  }
  for (const role of ["Finance Manager", "Employee", "HR Operations"] as PhoenixRole[]) {
    assert.equal(
      destinationFor(role),
      resolveLandingPathForRole(role),
      `${role} has no closing surface this link can open, so it must stay their landing page — a redirect here is never a 403`,
    );
  }

  // ── 7. Missing line/period, and a scope that is not `system`, change nothing structurally ─────
  assert.equal(
    resolveClosingPublishDestination({ viewer: viewer("CEO"), canReadSales: true }),
    "/sales/monthly-closing",
    "a link with no line or period still opens the matrix, on its own default month",
  );
  assert.equal(
    resolveClosingPublishDestination({ viewer: viewer("CEO"), canReadSales: true, line: "  ", period: " " }),
    "/sales/monthly-closing",
    "blank query values must not become blank filters",
  );
  for (const scope of ["self", "team", "hierarchy", "line", "company"] as AccessScope[]) {
    assert.equal(
      resolveClosingPublishDestination({ viewer: { role: "CEO", scope }, canReadSales: true, period: PERIOD }),
      `/sales/monthly-closing?period=${PERIOD}`,
      `the CEO's destination comes from his ROLE — a ${scope} scope must not change it`,
    );
  }

  // ── 8. The route holds no second copy of the rule ─────────────────────────────────────────────
  const route = stripComments(readFileSync(GO_ROUTE_SOURCE, "utf8"));
  assert.ok(
    route.includes("resolveClosingPublishDestination"),
    `${GO_ROUTE_SOURCE} must resolve its destination through resolveClosingPublishDestination — a copy of the rule inside the handler is what drifted from the page guard`,
  );
  assert.ok(
    !route.includes("/employee-portals/monthly-closing"),
    `${GO_ROUTE_SOURCE} builds no closing path of its own any more`,
  );
  assert.ok(
    route.includes("isGuestFallbackAccess") && route.includes('"/login"'),
    `${GO_ROUTE_SOURCE} must still send an unauthenticated click to /login before anything else`,
  );
  assert.ok(
    !route.includes("NextResponse.json"),
    `${GO_ROUTE_SOURCE} stays redirect-only — it must never answer a click with an error body`,
  );
}
