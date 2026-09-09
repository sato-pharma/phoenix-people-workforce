import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { canAccess, phoenixRoles, resolveNavigationMode } from "../src/lib/auth/permissions.ts";
import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";

const ROOT = process.cwd();

function ctx(role: PhoenixRole): AccessContext {
  const scope =
    role === "Super Admin"
      ? "system"
      : role === "HR Advisory" || role === "HR Operations" || role === "Training Manager"
        ? "company"
        : "self";
  return { role, scope, source: "session", hrId: "X-1", loginId: "x1" } as AccessContext;
}

/** Every file under app/ that renders the employee master screen — FOUND, never listed by hand. */
function pagesRenderingEmployeeManagement(): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry) && readFileSync(full, "utf8").includes("<EmployeeManagement")) {
        hits.push(relative(ROOT, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(join(ROOT, "app"));
  return hits.sort();
}

/**
 * The employee master screen is rendered by more than one page, and only one of them was telling
 * it whether the viewer may edit.
 *
 * WHAT WENT WRONG. `app/(admin)/employees/page.tsx` computes `canEdit` from
 * canAccess(employees, update) and passes it — its own comment says the prop exists so that
 * offering the page to a READER does not also offer her Save buttons the API refuses. The portal
 * mirror rendered the same component and passed nothing, and the component defaulted `canEdit` to
 * TRUE. So anyone reaching the portal copy was handed edit controls regardless of grant.
 *
 * NOBODY WAS AFFECTED, which is why it survived: no role holds `employees:read` and also resolves
 * to the portal shell, so the page's own gate redirected everyone before they got there (measured
 * 2026-09-09). It was a hole waiting for the first portal seat to be given the employee master.
 *
 * The fix has two halves and both matter. Passing the prop fixes the page that exists; defaulting
 * to FALSE fixes the next page somebody writes, because a mirror that forgets now renders
 * read-only instead of buttons that 403.
 */
export function runEmployeeManagementCanEditTests() {
  // ── 1. the default fails CLOSED ───────────────────────────────────────────────────────────
  const component = readFileSync(join(ROOT, "src/components/employees/employee-management.tsx"), "utf8");
  assert.match(
    component,
    /export function EmployeeManagement\(\{[\s\S]{0,900}?canEdit = false,/,
    "canEdit must default to FALSE — a page that forgets the prop must render read-only, never editable",
  );
  assert.ok(
    !/canEdit = true/.test(component),
    "a `canEdit = true` default must never come back; that is the exact shape of the original defect",
  );

  // ── 2. EVERY page rendering the screen passes it, and derives it from the right grant ─────
  // The list is SCANNED, not written down. A hardcoded list is how the portal mirror escaped
  // notice in the first place: it simply was not on anybody's list.
  const pages = pagesRenderingEmployeeManagement();
  assert.ok(pages.length >= 2, `expected to find the admin and portal pages, found: ${pages.join(", ")}`);

  for (const page of pages) {
    const source = readFileSync(join(ROOT, page), "utf8");
    assert.match(
      source,
      /<EmployeeManagement[\s\S]{0,300}?canEdit=\{canEdit\}/,
      `${page} renders the employee master and must pass canEdit — one mirror silently not passing it is the whole bug`,
    );
    assert.match(
      source,
      /const canEdit = await canAccess\(access, "employees", "update"\)/,
      `${page} must derive canEdit from employees:update, not from a narrower or wider grant`,
    );
  }
}

/**
 * Who can actually OPEN the portal copy — the blast radius, measured rather than assumed.
 *
 * Separate from the rules above because canAccess is async. It asserts the PROPERTY that matters
 * (a reacher's controls follow that reacher's grant) rather than pinning a count, so granting a
 * portal seat the employee master does not fail this test — it just changes what it reports.
 */
export async function runEmployeeManagementCanEditReachTests() {
  const reachers: Array<{ canUpdate: boolean; role: PhoenixRole }> = [];
  for (const role of phoenixRoles) {
    const access = ctx(role);
    if (resolveNavigationMode(access) !== "employee-portal") continue;
    if (!(await canAccess(access, "employees", "read"))) continue;
    reachers.push({ canUpdate: await canAccess(access, "employees", "update"), role });
  }

  // The guarantee: nobody who can open that page may hold edit controls without employees:update.
  // Before the fix every one of them did, unconditionally. The set is empty today, so this is the
  // rule that starts doing work the day it is not.
  for (const reacher of reachers) {
    assert.equal(
      reacher.canUpdate,
      await canAccess(ctx(reacher.role), "employees", "update"),
      `${reacher.role} reaches the portal employee master, so its edit controls must follow its own grant`,
    );
  }

  // A portal-shell role must still exist, or the sweep above is vacuous and would pass on a
  // codebase where the whole portal shell had been deleted.
  const portalRoles = phoenixRoles.filter((role) => resolveNavigationMode(ctx(role)) === "employee-portal");
  assert.ok(portalRoles.length > 0, "the portal shell must still route some role, or this sweep proves nothing");
}
