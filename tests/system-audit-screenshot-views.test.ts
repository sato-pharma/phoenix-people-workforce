import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./system-audit-routes-access.test.ts";

import type { AuditLogInput } from "../src/lib/admin/audit.ts";
import { AUDIT_ENTITY_TYPES } from "../src/lib/admin/audit-entity-types.ts";
import { cairoDateTime } from "../src/lib/format/cairo-datetime.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import {
  recordScreenshotView,
  screenshotViewAuditRow,
  screenshotViewSummary,
  type ViewedScreenshot,
} from "../src/lib/system-audit/screenshot-views.ts";

/**
 * Every screenshot opened on the System Audit page leaves an audit row (owner, 23 Oct 2026: "log every
 * screenshot view on the System Audit page").
 *
 * Both pictures are unmasked by his choice, and the access registry already declared the picture
 * route an audited read while neither route wrote anything. What is pinned, each by the failure it
 * prevents:
 *   1. The row says who looked, at whose screen (by name), which picture, the page and when it was
 *      taken — under its own entity type, so /admin/logs can pick it out.
 *   2. A name that cannot be read still writes the row, with the HR ID in its place.
 *   3. Both routes write it AFTER the Super Admin guard and after the picture is found (a 404 writes
 *      nothing), BEFORE the picture or its URL leaves, and awaited — never deferred past the response.
 *   4. Both routes are declared audited reads in the access registry.
 */

const SCREENS_ROUTE = "app/api/admin/system-audit/screens/[id]/route.ts";
const SIGNED_URL_ROUTE = "app/api/admin/system-audit/screenshot/[eventId]/route.ts";

const TAKEN_AT = "2026-10-23T16:05:00.000Z";
const VIEWER = { hrId: "B-10", loginId: "owner-login" };

const refused: ViewedScreenshot = {
  source: "screen",
  id: "5d2f7a52-8a0e-4b8e-9d39-6a1f1c1c2a11",
  screenKind: "refused_request",
  hrId: "M-204",
  loginId: "m204",
  page: "/employee-portals/payslips",
  takenAt: TAKEN_AT,
  isTest: false,
};

const crash: ViewedScreenshot = {
  source: "crash",
  id: "8f6a3c1e-1b2d-4c5e-8f70-9a1b2c3d4e5f",
  hrId: "M-204",
  loginId: "m204",
  page: "/employee-portals/payslips",
  takenAt: TAKEN_AT,
};

type Lookup = { data: unknown; error: { message: string } | null };

/** The one read recordScreenshotView makes: employees.hr_id, full_name `in` the HR ID's keys. */
function fakeClient(answer: Lookup | (() => never)) {
  const reads: string[] = [];
  const client = {
    from(table: string) {
      reads.push(table);
      return {
        select() {
          return {
            in() {
              if (typeof answer === "function") return answer();
              return Promise.resolve(answer);
            },
          };
        },
      };
    },
  };
  return { client: client as never, reads };
}

function source(relative: string): string {
  return stripComments(readFileSync(relative, "utf8"));
}

// ── 1. What the row says ─────────────────────────────────────────────────────────────────────────

function rowTests() {
  assert.equal(
    screenshotViewSummary(refused, "Mona Adel"),
    `Viewed the screenshot of what Mona Adel saw — Request refused on /employee-portals/payslips, taken ${cairoDateTime(TAKEN_AT)} Cairo.`,
    "a block screen names the person, the drawer's own words for the kind, the page and the Cairo time",
  );
  assert.equal(
    screenshotViewSummary(crash, "Mona Adel"),
    `Viewed the screenshot of what Mona Adel saw — Crash on /employee-portals/payslips, taken ${cairoDateTime(TAKEN_AT)} Cairo.`,
  );
  assert.equal(screenshotViewSummary({ ...refused, screenKind: "error_screen" }, "Mona Adel").includes("— Error screen shown on"), true);
  assert.equal(screenshotViewSummary({ ...refused, screenKind: "failed_request" }, "Mona Adel").includes("— Request failed on"), true);

  assert.ok(screenshotViewSummary(refused, null).includes("what M-204 saw"), "no name read: the HR ID stands in");
  assert.ok(
    screenshotViewSummary({ ...refused, hrId: null }, null).includes("what login m204 saw"),
    "no HR ID: the login stands in",
  );
  assert.ok(
    screenshotViewSummary({ ...refused, hrId: null, loginId: null }, null).includes("what an unknown person saw"),
  );
  assert.ok(
    screenshotViewSummary({ ...refused, isTest: true }, "Mona Adel").includes("what Mona Adel (test account) saw"),
    "a test account's picture says so",
  );
  assert.equal(
    screenshotViewSummary({ ...refused, page: null, takenAt: null }, "Mona Adel"),
    "Viewed the screenshot of what Mona Adel saw — Request refused.",
    "an absent page or time is left out, never printed as a dash",
  );

  const row = screenshotViewAuditRow(VIEWER, refused, "Mona Adel");
  assert.equal(row.entityType, "system_audit_screenshot_view", "its own entity type");
  assert.equal(row.entityId, refused.id, "the picture's id");
  assert.equal(row.actorLoginId, VIEWER.loginId, "the viewer is the actor");
  assert.deepEqual(row.newValues, {
    viewerHrId: "B-10",
    picture: "screen",
    kind: "Request refused",
    personHrId: "M-204",
    personLoginId: "m204",
    page: "/employee-portals/payslips",
    takenAt: TAKEN_AT,
    isTest: false,
  });
  assert.ok(AUDIT_ENTITY_TYPES.includes("system_audit_screenshot_view"), "/admin/logs can pick the trail out");
}

// ── 2. One row per view, whatever the name lookup does ───────────────────────────────────────────

async function recordTests() {
  {
    const written: AuditLogInput[] = [];
    const { client, reads } = fakeClient({ data: [{ hr_id: "M-204", full_name: " Mona Adel " }], error: null });
    await recordScreenshotView(VIEWER, refused, { client, write: async (input) => void written.push(input) });
    assert.deepEqual(reads, ["employees"], "one read, for the person's name");
    assert.equal(written.length, 1, "exactly one row per picture viewed");
    assert.ok(written[0].summary.includes("what Mona Adel saw"), "the person by name");
  }
  {
    const written: AuditLogInput[] = [];
    const { client } = fakeClient({ data: null, error: { message: "statement timeout" } });
    await recordScreenshotView(VIEWER, crash, { client, write: async (input) => void written.push(input) });
    assert.equal(written.length, 1, "a failed name read still writes the row");
    assert.ok(written[0].summary.includes("what M-204 saw"), "with the HR ID in place of the name");
  }
  {
    const written: AuditLogInput[] = [];
    const { client } = fakeClient(() => {
      throw new Error("connection reset");
    });
    await recordScreenshotView(VIEWER, crash, { client, write: async (input) => void written.push(input) });
    assert.equal(written.length, 1, "a thrown name read still writes the row");
  }
  {
    const written: AuditLogInput[] = [];
    const { client, reads } = fakeClient({ data: [], error: null });
    await recordScreenshotView(VIEWER, { ...crash, hrId: null }, { client, write: async (input) => void written.push(input) });
    assert.deepEqual(reads, [], "no HR ID, no name read");
    assert.equal(written.length, 1);
  }

  const helper = stripComments(readFileSync("src/lib/system-audit/screenshot-views.ts", "utf8"));
  const body = helper.slice(helper.indexOf("export async function recordScreenshotView("));
  assert.match(
    body,
    /try \{\s*await \(deps\.write \?\? writeAuditLog\)\(row\);\s*\} catch \(error\) \{\s*logError\(/,
    "a failing trail is logged and never refuses the picture",
  );
}

// ── 3. Both routes write it in the right place ───────────────────────────────────────────────────

function routeTests() {
  for (const [file, found, served] of [
    [SCREENS_ROUTE, "loadUserScreenImage(", "new NextResponse(image.bytes"],
    [SIGNED_URL_ROUTE, "createSignedUrl(", "{ url: signed.data.signedUrl"],
  ] as const) {
    const code = source(file);
    const guard = code.indexOf("assertSystemAdministratorWorkspaceAccess(access");
    const read = code.indexOf(found);
    const missing = code.indexOf("status: 404");
    const record = code.indexOf("await recordScreenshotView(");
    const leaves = code.indexOf(served);
    assert.ok(record !== -1, `${file} writes a screenshot view audit row, awaited`);
    assert.equal(code.split("recordScreenshotView(").length - 1, 1, `${file} writes exactly one row per picture`);
    assert.ok(guard !== -1 && guard < record, `${file} writes the row only after the Super Admin guard`);
    assert.ok(read !== -1 && read < record, `${file} writes the row only once the picture is found`);
    assert.ok(missing !== -1 && missing < record, `${file} answers a missing picture with 404 before the row — nothing was seen`);
    assert.ok(leaves !== -1 && record < leaves, `${file} writes the row BEFORE the picture or its URL leaves`);
    assert.doesNotMatch(code, /\bafterResponse\(|\bafter\(/, `${file} never defers the row past the response — a crash there loses it`);
    assert.match(code, /source: "(screen|crash)"/, `${file} says which picture was opened`);
  }
}

// ── 4. Declared audited reads ────────────────────────────────────────────────────────────────────

function registryTests() {
  for (const route of ["/api/admin/system-audit/screens/:id", "/api/admin/system-audit/screenshot/:eventId"]) {
    const entry = findAccessRegistryEntry(route, "GET");
    assert.ok(entry, `${route} is in the access registry`);
    assert.equal(entry.audit.classification, "access-read", `${route} is declared an audited read`);
    assert.equal(entry.audit.required, true, `${route}'s audit row is required`);
  }
}

export async function runSystemAuditScreenshotViewsTests() {
  rowTests();
  await recordTests();
  routeTests();
  registryTests();
}
