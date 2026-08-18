import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext } from "@/lib/auth/permissions";
import { canViewMarketingOversightQueue } from "@/lib/marketing-requests/service";

function source(relPath: string): string {
  return readFileSync(relPath, "utf8");
}

function access(role: AccessContext["role"], scope: AccessContext["scope"] = "self"): AccessContext {
  return { hrId: "B-10", loginId: "b-10", role, scope, source: "session" };
}

/**
 * The Super Admin oversight queue in the marketing approval inbox.
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────
 * Every section of that inbox is scoped to the ACTOR: the rungs assigned to them, the CC rungs they
 * may comment on, and the rungs heading toward them. The live chain runs manager → SFE → marketing
 * → CEO → finance, and a Super Admin holds none of those rungs — so on 2026-08-18 the owner opened
 * the Marketing Inbox as Super Admin (B-10) and it read "no marketing requests involve you right
 * now" while four requests sat in `pending_approval` with other approvers. True about him, useless
 * about the company. This suite pins the fix and, more importantly, its limits.
 *
 * ── THE LIMITS, WHICH MATTER MORE THAN THE FEATURE ───────────────────────────
 * Oversight is the right to SEE a queue, not to decide it. The rows must stay out of `rows` (the
 * actionable section), must never carry a decision permission, and must never reach the sidebar
 * badge — a badge counting other people's work would pump orange at someone with nothing to do.
 */
export async function runMarketingSuperAdminOversightTests() {
  // ── Who gets it: Super Admin and the system context, nobody else ─────────────
  assert.equal(canViewMarketingOversightQueue(access("Super Admin")), true);
  // The system administrator context is not carried on the role label — same reason every other
  // gate in this service checks scope separately.
  assert.equal(canViewMarketingOversightQueue(access("Employee", "system")), true);

  // Deliberately NARROWER than the company register (marketingRegisterRoles), which also admits
  // these two. The register is a report; this is an inbox, and other people's pending decisions in
  // a manager's inbox blur whose turn it is.
  assert.equal(canViewMarketingOversightQueue(access("Marketing Manager")), false);
  assert.equal(canViewMarketingOversightQueue(access("SFE Manager")), false);
  // The approvers who actually hold rungs must keep seeing only their own work.
  assert.equal(canViewMarketingOversightQueue(access("CEO")), false);
  assert.equal(canViewMarketingOversightQueue(access("Finance Manager")), false);
  assert.equal(canViewMarketingOversightQueue(access("Medical Rep")), false);
  assert.equal(canViewMarketingOversightQueue(access("District Manager")), false);

  const service = source("src/lib/marketing-requests/service.ts");

  // ── The query only runs for a viewer who passes that gate ────────────────────
  assert.match(
    service,
    /const includeOversight = canViewMarketingOversightQueue\(access\)/,
    "the oversight query must be gated by canViewMarketingOversightQueue, not by the caller",
  );
  assert.match(
    service,
    /includeOversight\s*\?\s*supabase/,
    "the company-wide step read must be skipped entirely for a role without oversight",
  );

  // ── A read failure must throw, never silently degrade to an empty watch list ──
  assert.match(
    service,
    /if \(oversightResult\.error\) throw oversightResult\.error;/,
    "a failed oversight read must throw — an empty queue and a failed queue are opposite answers",
  );

  // ── The rows can never be actionable ─────────────────────────────────────────
  // Forced false, not inherited: these flags come off somebody else's step, and a truthy one is all
  // a future edit would need to render an Approve button on a request that is not his to decide.
  assert.match(
    service,
    /\.\.\.buildRow\(step, request, null\),\s*(?:\/\/[^\n]*\n\s*)*allowReject: false,\s*allowReturn: false,/,
    "every oversight row must be built with no rung of its own and with both decision flags forced false",
  );

  // ── No request may appear in two sections at once ────────────────────────────
  assert.match(
    service,
    /const myRequestIds = new Set\(rows\.map\(\(row\) => row\.id\)\);/,
    "the oversight loop must know which requests are already awaiting the viewer's own decision",
  );
  assert.match(
    service,
    /if \(myRequestIds\.has\(request\.id\)\) continue;/,
    "a request already in the actionable section must not be repeated as an oversight row",
  );

  // ── The sidebar badge is untouched ───────────────────────────────────────────
  // getMarketingApproverBadge runs its own actor-scoped query and must stay that way. Pinning it by
  // behaviour rather than by absence: the badge reducer counts only the gating steps handed to it.
  const badgeFn = service.slice(service.indexOf("export async function getMarketingApproverBadge"));
  assert.doesNotMatch(
    badgeFn.slice(0, 2_000),
    /oversight/i,
    "the pending-count badge must never count requests the viewer is only watching",
  );

  // ── The UI renders it read-only ──────────────────────────────────────────────
  const inbox = source("src/components/employee-portal/marketing-request-inbox.tsx");
  const oversightBlock = inbox.slice(inbox.indexOf("Everything in approval"));
  assert.ok(oversightBlock.length > 0, "the oversight section must exist in the inbox component");
  // decisionHref is what builds an approve / return / reject link. It must not appear anywhere in
  // the oversight block — the only link there is the read-only record.
  assert.doesNotMatch(
    oversightBlock,
    /decisionHref/,
    "the oversight section must offer no approve / return / reject control",
  );
  assert.match(
    oversightBlock,
    /href=\{`\/marketing-requests\/\$\{row\.id\}`\}/,
    "each oversight row must link through to the full record",
  );
  // Whose decision it is has to be on the row, or the section is just a list of codes.
  assert.match(
    oversightBlock,
    /Now with \$\{row\.awaitingApproverName/,
    "each oversight row must name the approver actually holding the request",
  );

  // ── The empty state must not contradict a populated watch list ───────────────
  assert.match(
    inbox,
    /rows\.length === 0 &&\s*advisoryRows\.length === 0 &&\s*upcomingRows\.length === 0 &&\s*oversightRows\.length === 0/,
    '"no marketing requests involve you right now" must not render above a populated oversight list',
  );

  // ── A failed load clears every section, including this one ───────────────────
  const failureClears = inbox.match(/setOversightRows\(\[\]\)/g) ?? [];
  assert.equal(
    failureClears.length,
    2,
    "both the not-ok response and the thrown-error path must clear the oversight rows",
  );
}
