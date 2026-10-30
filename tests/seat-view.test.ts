import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { stripComments } from "./support/comment-strip.ts";

import { assignablePhoenixRoles, createAccessContext, normalizeHrId, type AccessContext } from "../src/lib/auth/permissions.ts";
import { isPortalShellRole } from "../src/lib/auth/portal-shell-roles.ts";
import { assertRealSessionForDecision, isPreviewSession } from "../src/lib/auth/preview-session-guard.ts";
import {
  applySeatView,
  assertNotSeatView,
  assertSeatViewMayRun,
  isReadOnlyViewer,
  isSeatViewableRole,
  SEAT_VIEW_REFUSED_READS,
  seatViewableRoles,
  seatViewMayRun,
  seatViewOfficeRoles,
  seatViewPersonRule,
  seatViewPortalRoles,
} from "../src/lib/auth/seat-view.ts";
import {
  SEAT_VIEW_EXIT_PATH,
  SEAT_VIEW_LOGIN_ID,
  SEAT_VIEW_REFUSAL,
  SEAT_VIEW_START_PATH,
  SEAT_VIEW_TTL_SECONDS,
} from "../src/lib/auth/seat-view-constants.ts";
import { createSeatViewToken, verifySeatViewToken } from "../src/lib/auth/seat-view-token.ts";
import { createSessionToken, verifySessionToken } from "../src/lib/auth/session-token.ts";
import { ApiError } from "../src/lib/http/api-errors.ts";

/**
 * VIEW AS SEAT — the Super Admin sees the live site as another seat sees it, READ ONLY.
 *
 * Owner, 2026-10-20: "View as seat … finish it and merge for me to use", with "Office seats + a person
 * picker". What this file pins, in the order a failure would cost most:
 *
 *   1. NOTHING A VIEW SENDS IS SAVED — every write on disk is refused except leaving the view, and every
 *      GET that writes a row as it reads is refused or named here with the reason it is harmless.
 *   2. THE VIEW NEVER STANDS ALONE — it is honoured only on top of the owner's own live Super Admin
 *      session, the exact session and login it was signed for, and never on a test account or a preview.
 *   3. THE TOKEN IS ITS OWN KIND — it never passes as a session token, a session token never passes as
 *      it, and it dies within the hour.
 *   4. IT IS A PREVIEW TO THE DECISION GUARDS — payroll and outstation decisions refuse it a second time.
 *   5. THE WIRING — both resolvers, both shells, sign-out, the proxy shortcut, the routes and the registry.
 */

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

function refusedWith(run: () => unknown, pattern: RegExp, message: string): void {
  assert.throws(run, (error: unknown) => error instanceof ApiError && error.status === 403 && pattern.test(error.message), message);
}

function source(path: string): string {
  return stripComments(readFileSync(join(REPO_ROOT, path), "utf8"));
}

function routeFiles(): string[] {
  const files: string[] = [];
  (function walk(directory: string) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === "route.ts") files.push(path);
    }
  })(join(REPO_ROOT, "app", "api"));
  return files;
}

/** The URL a route file answers, with every dynamic segment filled. */
function routePathOf(file: string): string {
  const segments = relative(join(REPO_ROOT, "app"), file).split(sep).slice(0, -1);
  return `/${segments
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .map((segment) => (/^\[.*\]$/.test(segment) ? "x" : segment))
    .join("/")}`;
}

/** The body of one exported handler, up to the next export — enough to see what that handler itself calls. */
function handlerBody(text: string, method: string): string | null {
  const match = text.match(new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\s*\\(|export\\s+const\\s+${method}\\s*=`));
  if (!match || match.index === undefined) return null;
  const rest = text.slice(match.index + match[0].length);
  const next = rest.search(/\nexport\s/);
  return next === -1 ? rest : rest.slice(0, next);
}

const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
const WRITE_MARKER = /\.(insert|upsert|update|delete)\(|writeAuditLog|writeRequiredAuditLog/;

/**
 * GET handlers that write as they read and are NOT refused during a view, each with the reason a view
 * reaching it records nothing as the viewed seat. A new GET that writes fails this file until it is
 * either refused in SEAT_VIEW_REFUSED_READS or named here.
 */
const HARMLESS_WRITING_READS: Record<string, string> = {
  "/api/cron/crm-contact-lists": "a cron job: it answers only the scheduler's secret, never a browser session",
  "/api/cron/job-heartbeat-sweep": "a cron job: it answers only the scheduler's secret, never a browser session",
  "/api/share/direct-orders/x/file": "a public share link opened by its own token, the same for every visitor; it records no viewer",
  "/api/share/marketing-requests/x/file": "a public share link opened by its own token, the same for every visitor; it records no viewer",
};

export function runSeatViewTests(): void {
  process.env.PHOENIX_AUTH_SECRET = process.env.PHOENIX_AUTH_SECRET || "test-seat-view-secret";
  const now = Math.floor(Date.now() / 1000);

  const owner = createAccessContext({ hrId: "B-10", loginId: "B-10", role: "Super Admin", source: "session" });
  const sessionToken = createSessionToken({
    hrId: "B-10",
    loginId: "B-10",
    maxAgeSeconds: 3600,
    role: "Super Admin",
    sessionId: "SID-OWNER",
    sessionVersion: 1,
  });
  const officeToken = createSeatViewToken({
    role: "HR Operations",
    hrId: null,
    personName: null,
    ownerLoginId: "B-10",
    ownerSid: "SID-OWNER",
  }).token;
  const portalToken = createSeatViewToken({
    role: "Medical Rep",
    hrId: "B-7",
    personName: "Aya Ibrahim",
    ownerLoginId: "B-10",
    ownerSid: "SID-OWNER",
  }).token;

  // ── 1. The token is its own kind, and it dies within the hour ─────────────────────────────────────
  {
    const view = verifySeatViewToken(officeToken);
    assert.ok(view, "a freshly signed seat token verifies");
    assert.equal(view.role, "HR Operations");
    assert.equal(view.hrId, null);
    assert.equal(view.exp - view.iat, SEAT_VIEW_TTL_SECONDS, "the view lives exactly one hour");
    assert.equal(SEAT_VIEW_TTL_SECONDS, 3600);

    const [prefix, payload, signature] = officeToken.split(".");
    assert.equal(prefix, "sv1", "its own prefix");
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    assert.equal(verifySeatViewToken(`${prefix}.${payload}.${flipped}`), null, "a tampered signature is refused");
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), role: "CEO" }),
    ).toString("base64url");
    assert.equal(verifySeatViewToken(`${prefix}.${forgedPayload}.${signature}`), null, "a rewritten seat is refused");

    const expired = createSeatViewToken({
      role: "HR Operations",
      hrId: null,
      personName: null,
      ownerLoginId: "B-10",
      ownerSid: "SID-OWNER",
      nowSeconds: now - SEAT_VIEW_TTL_SECONDS - 5,
    }).token;
    assert.equal(verifySeatViewToken(expired), null, "an hour-old view is dead");

    // A token CORRECTLY signed with the same key but a longer life is still refused — the cap is read,
    // not merely the clock.
    const key = createHmac("sha256", process.env.PHOENIX_AUTH_SECRET as string).update("phoenix-seat-view-v1").digest();
    const longBody = `sv1.${Buffer.from(
      JSON.stringify({ role: "HR Operations", hrId: null, personName: null, ownerLoginId: "B-10", ownerSid: "SID-OWNER", iat: now, exp: now + SEAT_VIEW_TTL_SECONDS * 8 }),
    ).toString("base64url")}`;
    const longToken = `${longBody}.${createHmac("sha256", key).update(longBody).digest("base64url")}`;
    assert.equal(verifySeatViewToken(longToken), null, "a view signed for longer than the hour is refused");

    assert.equal(verifySessionToken(officeToken), null, "a seat token never passes as a session");
    assert.equal(verifySeatViewToken(sessionToken), null, "a session token never passes as a seat token");
    assert.equal(verifySeatViewToken(""), null);
    assert.equal(verifySeatViewToken(null), null);
  }

  // ── 2. The view is honoured only on top of the owner's own live session ───────────────────────────
  {
    const office = applySeatView(owner, sessionToken, officeToken);
    assert.ok(office, "an office seat opens on the owner's own session");
    assert.equal(office.role, "HR Operations");
    assert.equal(office.hrId, null, "an office seat is viewed by role alone");
    assert.equal(office.loginId, SEAT_VIEW_LOGIN_ID, "the view carries SEAT-VIEW, never the owner's or the person's login");
    assert.equal(office.source, "session");
    assert.equal(office.seatView?.ownerLoginId, "B-10");
    assert.equal(office.testPersona, undefined, "a view is not a test account");

    const portal = applySeatView(owner, sessionToken, portalToken);
    assert.ok(portal, "a portal seat opens as the person");
    assert.equal(portal.role, "Medical Rep");
    assert.equal(portal.hrId, normalizeHrId("B-7"), "the person's HR id, in the same form every session carries");
    assert.equal(portal.seatView?.personName, "Aya Ibrahim");

    assert.equal(applySeatView(owner, sessionToken, null), null, "no cookie, no view");
    assert.equal(applySeatView(owner, sessionToken, "sv1.garbage.sig"), null, "a broken cookie is ignored");

    const otherSession = createSessionToken({
      hrId: "B-10",
      loginId: "B-10",
      maxAgeSeconds: 3600,
      role: "Super Admin",
      sessionId: "SID-ELSEWHERE",
      sessionVersion: 1,
    });
    assert.equal(applySeatView(owner, otherSession, officeToken), null, "a view signed for another session id is dead");
    assert.equal(applySeatView(owner, null, officeToken), null, "no session token, no view");

    const otherOwner = createAccessContext({ hrId: "B-11", loginId: "B-11", role: "Super Admin", source: "session" });
    assert.equal(applySeatView(otherOwner, sessionToken, officeToken), null, "a view signed for another login is dead");

    for (const [label, notOwner] of [
      ["an HR seat", createAccessContext({ hrId: "B-10", loginId: "B-10", role: "HR Operations", source: "session" })],
      ["a CEO", createAccessContext({ hrId: "B-10", loginId: "B-10", role: "CEO", source: "session" })],
      ["a dev-header sweep", createAccessContext({ hrId: "B-10", loginId: "B-10", role: "Super Admin", source: "dev-header" })],
      [
        "a test account",
        createAccessContext({
          hrId: "B-10",
          loginId: "B-10",
          role: "Super Admin",
          source: "session",
          testPersona: { loginId: "TEST-X", mirrorsHrId: "B-10" },
        }),
      ],
    ] as Array<[string, AccessContext]>) {
      assert.equal(applySeatView(notOwner, sessionToken, officeToken), null, `${label} cannot hold a view`);
    }
    assert.equal(applySeatView(office, sessionToken, officeToken), null, "a view never stacks on a view");

    const sign = (role: string, hrId: string | null) =>
      createSeatViewToken({ role, hrId, personName: hrId ? "Somebody" : null, ownerLoginId: "B-10", ownerSid: "SID-OWNER" }).token;
    assert.equal(applySeatView(owner, sessionToken, sign("Medical Rep", null)), null, "a portal seat without a person shows nothing, so it is refused");
    assert.equal(applySeatView(owner, sessionToken, sign("HR Operations", "B-9")), null, "an office seat is never viewed as a named person");
    assert.equal(applySeatView(owner, sessionToken, sign("Super Admin", null)), null, "his own seat is not a view");
    assert.equal(applySeatView(owner, sessionToken, sign("Not A Role", null)), null, "an unknown seat is refused");
  }

  // ── 3. Which seats can be viewed ──────────────────────────────────────────────────────────────────
  {
    assert.deepEqual(
      [...seatViewableRoles()].sort(),
      assignablePhoenixRoles.filter((role) => role !== "Super Admin").sort(),
      "every assignable seat but his own — a new seat appears by itself",
    );
    const office = seatViewOfficeRoles();
    const portal = seatViewPortalRoles();
    assert.deepEqual([...office, ...portal].sort(), [...seatViewableRoles()].sort(), "office and portal cover every viewable seat");
    assert.equal(office.filter((role) => portal.includes(role)).length, 0, "no seat is both");
    for (const role of portal) {
      assert.ok(isPortalShellRole(role), `${role} is a portal seat`);
      assert.equal(seatViewPersonRule(role), "required", `${role} is viewed as a person`);
    }
    for (const role of office) assert.equal(seatViewPersonRule(role), "forbidden", `${role} is viewed by role alone`);
    assert.ok(office.includes("HR Operations") && office.includes("CEO"), "the HR seats and the CEO are office seats");
    assert.ok(portal.includes("Medical Rep") && portal.includes("District Manager"), "reps and managers are portal seats");
    assert.equal(isSeatViewableRole("Super Admin"), false);
  }

  // ── 4. Nothing a view sends is saved ──────────────────────────────────────────────────────────────
  {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      assert.equal(seatViewMayRun(method, "/api/leave-requests"), true, `a view reads (${method})`);
    }
    for (const method of WRITE_METHODS) {
      assert.equal(seatViewMayRun(method, "/api/leave-requests"), false, `${method} is refused`);
    }
    assert.equal(seatViewMayRun("POST", SEAT_VIEW_EXIT_PATH), true, "leaving the view is the one write");
    assert.equal(seatViewMayRun("POST", SEAT_VIEW_START_PATH), false, "a view never opens another view");
    assert.equal(seatViewMayRun("POST", "/api/auth/logout"), false, "signing out would sign the OWNER out — he exits the view first");
    assert.equal(seatViewMayRun("POST", "/api/phoenix-crm/visits"), false, "Phoenix CRM has no seat-view world: refused like the rest");
    assert.equal(seatViewMayRun("GET", "/api/employees/export"), false, "an export is refused");
    assert.equal(seatViewMayRun("GET", "/api/phoenix-crm/list/template"), false, "a template download is refused");
    assert.equal(seatViewMayRun("GET", "/api/reports/organogram/contact-numbers"), false, "a logged contact list is refused");
    assert.equal(seatViewMayRun("GET", "/api/recruitment/cv-lookup/x/application"), false, "a logged CV search is refused");

    const viewer = applySeatView(owner, sessionToken, officeToken) as AccessContext;
    refusedWith(
      () => assertSeatViewMayRun(viewer, { method: "POST", url: "https://phoenix-hr.satopharma.com/api/leave-requests" }),
      /viewing another seat, read only/,
      "the guard throws a 403 carrying the sentence the screen shows",
    );
    assert.doesNotThrow(() => assertSeatViewMayRun(viewer, { method: "POST", url: `https://phoenix-hr.satopharma.com${SEAT_VIEW_EXIT_PATH}` }));
    assert.doesNotThrow(() => assertSeatViewMayRun(viewer, { method: "GET", url: "https://phoenix-hr.satopharma.com/api/leave-requests" }));
    assert.doesNotThrow(
      () => assertSeatViewMayRun(owner, { method: "POST", url: "https://phoenix-hr.satopharma.com/api/leave-requests" }),
      "his own session is never touched by the guard",
    );
    refusedWith(() => assertNotSeatView(viewer), /viewing another seat/, "a server action is refused to a view");
    assert.doesNotThrow(() => assertNotSeatView(owner));
    assert.ok(SEAT_VIEW_REFUSAL.includes("Nothing here is saved"), "the refusal says nothing was saved");

    // Every mutating handler on disk, by the URL it answers.
    let writeHandlers = 0;
    for (const file of routeFiles()) {
      const text = stripComments(readFileSync(file, "utf8"));
      const path = routePathOf(file);
      for (const method of WRITE_METHODS) {
        if (!handlerBody(text, method)) continue;
        writeHandlers += 1;
        const allowed = method === "POST" && path === SEAT_VIEW_EXIT_PATH;
        assert.equal(seatViewMayRun(method, path), allowed, `${method} ${path} during a seat view`);
      }
    }
    assert.ok(writeHandlers > 500, `the sweep must see the real route tree (saw ${writeHandlers} write handlers)`);

    // Every GET handler that writes as it reads: refused, or named above with its reason.
    const writingReads: string[] = [];
    for (const file of routeFiles()) {
      const body = handlerBody(stripComments(readFileSync(file, "utf8")), "GET");
      if (!body || !WRITE_MARKER.test(body)) continue;
      const path = routePathOf(file);
      writingReads.push(path);
      if (!seatViewMayRun("GET", path)) continue;
      assert.ok(
        HARMLESS_WRITING_READS[path],
        `GET ${path} writes as it reads and a seat view may open it — refuse it in SEAT_VIEW_REFUSED_READS (src/lib/auth/seat-view.ts) or name it in HARMLESS_WRITING_READS with the reason it records nothing as the seat`,
      );
    }
    assert.ok(writingReads.length >= 25, `the GET sweep must see the writing reads (saw ${writingReads.length})`);
    for (const path of Object.keys(HARMLESS_WRITING_READS)) {
      assert.ok(writingReads.includes(path), `${path} is named harmless but no longer writes — drop it from the list`);
    }
    for (const path of [
      "/api/admin/activity/timeline",
      "/api/admin/field-workforce-compliance/live-snapshots/x",
      "/api/business-review/pack",
      "/api/recruitment/interview-calendar/my-calendar-feed",
      "/api/hiring-pack/x/print",
      "/api/recruitment/hiring-manager/candidates/x/files/y",
      "/api/phoenix-crm/day-interviews/cv",
    ]) {
      assert.equal(seatViewMayRun("GET", path), false, `GET ${path} is refused during a view`);
    }
    assert.ok(SEAT_VIEW_REFUSED_READS.length >= 8);
  }

  // ── 5. A view is a preview to the decision guards, and leaves no trace while reading ─────────────
  {
    const viewer = applySeatView(owner, sessionToken, portalToken) as AccessContext;
    assert.equal(isPreviewSession(viewer), true, "payroll and outstation decision guards treat a view as a preview");
    assert.equal(isPreviewSession(owner), false);
    refusedWith(
      () => assertRealSessionForDecision(viewer, "approve this expense"),
      /viewing another seat, read only, so you cannot approve this expense/,
      "a decision is refused with the seat-view sentence",
    );
    assert.equal(isReadOnlyViewer(viewer), true);
    assert.equal(isReadOnlyViewer(owner), false);
    assert.equal(
      isReadOnlyViewer(createAccessContext({ hrId: "B-7", loginId: "TEST-AYA", role: "Medical Rep", source: "session", testPersona: { loginId: "TEST-AYA", mirrorsHrId: "B-7" } })),
      true,
      "a test account is a read-only viewer too",
    );
    assert.equal("seatView" in owner, false, "an ordinary session carries no seatView key at all");
  }

  // ── 6. The wiring ─────────────────────────────────────────────────────────────────────────────────
  {
    const server = source("src/lib/auth/server.ts");
    assert.equal(
      (server.match(/applySeatView\(sessionContext, /g) ?? []).length,
      2,
      "both resolvers — API and page — layer the view, on the cookie path only",
    );
    assert.ok(
      /assertTestAccountMayRun\(access, request\);\s*assertSeatViewMayRun\(access, request\);\s*return access;/.test(server),
      "the write guard runs at the one choke point every API route passes",
    );
    assert.ok(
      /if \(access\.seatView && !pageRequestMayUseRecentCopy\(await headers\(\)\)\) assertNotSeatView\(access\);/.test(server),
      "a server action or a form post is refused on the page side",
    );
    assert.ok(/if \(access\.seatView\) \{[\s\S]{0,400}roleLabel: personName \? seatTitle : "Read-only seat view"/.test(server), "the topbar names the seat, never the owner");

    assert.ok(/access\.seatView \? \(\s*<SeatViewBanner/.test(source("src/components/layout/app-shell.tsx")), "the admin shell says it on every page");
    const portalShell = source("src/components/employee-portal/employee-portal-server-shell.tsx");
    assert.ok(/const seatViewBanner = access\.seatView \?/.test(portalShell), "the portal shell builds the banner");
    assert.equal((portalShell.match(/\{seatViewBanner\}/g) ?? []).length, 2, "the portal says it on every page, the empty state included");

    // The MCP server bundles the notifications module and must hold no administrative IO: the
    // read-only check those writers ask stays in its dependency-free file, never seat-view.ts.
    for (const path of ["src/lib/notifications/in-app.ts", "src/lib/outstation/service.ts", "app/api/notifications/push/context/route.ts"]) {
      const text = source(path);
      assert.ok(text.includes('from "@/lib/auth/read-only-viewer"'), `${path} asks the dependency-free read-only check`);
      assert.ok(!text.includes('from "@/lib/auth/seat-view"'), `${path} must not pull the seat-view signer into its bundle`);
    }
    assert.ok(!/^import (?!type)/m.test(source("src/lib/auth/read-only-viewer.ts")), "read-only-viewer.ts imports nothing at runtime");

    const banner = source("src/components/layout/seat-view-banner.tsx");
    assert.ok(banner.startsWith('"use client"'), "the banner is a client component");
    assert.ok(!/seat-view-token|seat-view-service|from "@\/lib\/auth\/seat-view"/.test(banner), "nothing server-side reaches the browser through the banner");
    assert.ok(banner.includes("SEAT_VIEW_EXIT_PATH"), "Exit posts to the exit route");

    assert.ok(/cookieStore\.delete\(phoenixSeatViewCookieName\);/.test(source("app/api/auth/logout/route.ts")), "sign-out ends the view too");
    assert.ok(/request\.cookies\.get\(phoenixSeatViewCookieName\)\?\.value\) return null;/.test(source("proxy.ts")), "the candidates shortcut never reroutes a view by the owner's role");

    const start = source("app/api/admin/seat-view/start/route.ts");
    assert.ok(/assertSameOriginMutation\(request\)/.test(start), "the start refuses a cross-site post");
    assert.ok(/httpOnly: true/.test(start) && /sameSite: "strict"/.test(start) && /secure: process\.env\.NODE_ENV === "production"/.test(start), "the cookie is httpOnly, strict and secure");
    assert.ok(/maxAge,/.test(start), "the cookie lives exactly as long as the token");
    const exit = source("app/api/admin/seat-view/exit/route.ts");
    assert.ok(/assertSameOriginMutation\(request\)/.test(exit));
    assert.ok(/maxAge: 0/.test(exit), "the exit always clears the cookie");

    const service = source("src/lib/auth/seat-view-service.ts");
    assert.ok(/assertSeatViewOwner\(input\.access\);/.test(service), "only the owner opens a view");
    assert.ok(/findDevPreviewCandidateByHrId\(role, wanted\)/.test(service), "the person is checked again on the server");
    assert.ok(service.indexOf("await writeRequiredAuditLog(") < service.indexOf("return { token, landingPath"), "no audit row, no view");

    const registry = source("src/lib/security/access-registry.ts");
    for (const path of [SEAT_VIEW_START_PATH, SEAT_VIEW_EXIT_PATH]) {
      assert.ok(registry.includes(`pattern: "${path}"`), `${path} is in the access registry`);
    }

    const navigation = source("src/config/system-navigation.ts");
    assert.ok(/href: "\/admin\/view-as-seat",[\s\S]{0,600}roles: \["Super Admin"\]/.test(navigation), "the menu offers it to the Super Admin only");
    assert.ok(/redirect\("\/admin\/admin-tools"\)/.test(source("app/(admin)/admin/view-as-seat/page.tsx")), "the page sends anyone else away");
  }
}
