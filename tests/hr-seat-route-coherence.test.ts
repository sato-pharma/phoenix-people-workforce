import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { getNavigationSections } from "../src/config/system-navigation.ts";
import { hrBundleGrants, HR_ROLE_BUNDLES, type HrBundleName } from "../src/lib/auth/hr-functions.ts";
import {
  permissionActions,
  permissionMatrix,
  permissionResources,
  resolveNavigationMode,
  scopeForRole,
  type AccessContext,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { getSections, type PermissionLookup } from "../src/lib/navigation/active-path.ts";

/**
 * HR SEAT ROUTE COHERENCE — "nothing they are offered will bounce them".
 *
 * A permission matrix is checked one resource:action pair at a time, but a route handler is not
 * gated one pair at a time: POST /api/employees/[hrId]/resign asserts employees:update AND
 * resignations:create AND vacancies:create, all three, before it does anything. A seat holding two
 * of the three does not get two thirds of a resignation — it gets a 403, from a page its own
 * sidebar offered it.
 *
 * That is exactly what shipped. HR Operations owns offboarding (ops 6) and held
 * employees:update + resignations:create; HR Advisory held vacancies:create through recruiting.
 * NEITHER seat could record a single resignation, and no per-pair test could see it, because every
 * individual grant was correct on its own. The defect lived in the gap between them.
 *
 * So this test reads the ROUTES rather than the matrix: for every HTTP handler in app/api, if a
 * seat holds SOME of the permissions that handler asserts, it must hold ALL of them. Holding NONE
 * is fine and is the normal case — that is a boundary doing its job. Holding SOME is the bug shape.
 *
 * The second half makes the same claim one layer up, about PAGES. A page decides on arrival whether
 * to render or redirect, and it does not have to decide with a permission: /hr/admin/deductions
 * admitted {Super Admin, CEO} by name, so the HR sidebar offered HR Operations a Deductions link on
 * `deductions:read` — a grant she really holds — and the page sent her to /employee-portals. No
 * permission test could see that either, because the gate was never a permission. This half reads
 * each offered row's page, resolves whichever gate shape it uses, and requires the seat to pass it;
 * the shapes it cannot parse are listed by name rather than skipped, so "unchecked" can never be
 * mistaken for "fine".
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Comments and string CONTENTS replaced by spaces, LENGTH PRESERVED, so offsets computed on the
 * blanked text still index the original. Without this a brace inside a string or a comment ends a
 * handler body early and its assertions land under the wrong HTTP method.
 */
function blankOut(source: string): string {
  const chars = source.split("");
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") {
        chars[i] = " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] !== "\n") chars[i] = " ";
        i += 1;
      }
      if (i < n) {
        chars[i] = " ";
        chars[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      chars[i] = " ";
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          chars[i] = " ";
          if (i + 1 < n && source[i + 1] !== "\n") chars[i + 1] = " ";
          i += 2;
          continue;
        }
        if (source[i] === c) {
          chars[i] = " ";
          i += 1;
          break;
        }
        if (source[i] !== "\n") chars[i] = " ";
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return chars.join("");
}

type Handler = { method: string; body: string };

function handlers(source: string): Handler[] {
  const blank = blankOut(source);
  const found: Handler[] = [];
  const re = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(blank))) {
    let i = match.index + match[0].length - 1;
    let parens = 0;
    for (; i < blank.length; i += 1) {
      if (blank[i] === "(") parens += 1;
      else if (blank[i] === ")") {
        parens -= 1;
        if (parens === 0) {
          i += 1;
          break;
        }
      }
    }
    while (i < blank.length && blank[i] !== "{") i += 1;
    const start = i;
    let braces = 0;
    for (; i < blank.length; i += 1) {
      if (blank[i] === "{") braces += 1;
      else if (blank[i] === "}") {
        braces -= 1;
        if (braces === 0) {
          i += 1;
          break;
        }
      }
    }
    found.push({ method: match[1], body: source.slice(start, i) });
  }
  return found;
}

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

/**
 * Handlers whose assertions are NOT one hard gate, so "some but not all" is correct there. Each
 * entry names a specific file and its reason — never a pattern, so a new offender cannot hide
 * behind an existing exemption.
 */
const NOT_A_HARD_GATE: Record<string, string> = {
  "app/api/approvals/badge-counts/route.ts":
    "every domain runs inside Promise.allSettled and a rejected assertion falls back to {count: 0}, " +
    "so a seat missing one of the three reads gets an unbadged row, never a 403",
};

/** The dense resource:action lookup the shells build, so an absent grant reads false, never undefined. */
function lookupForSeat(seat: HrBundleName): PermissionLookup {
  const rolePermissions = permissionMatrix[seat as unknown as PhoenixRole];
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = rolePermissions?.[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

/**
 * The minimum AccessContext resolveNavigationMode reads: it branches on `source`, `scope` and
 * `role`, nothing else. Built from the real scopeForRole rather than a literal, so a scope change
 * for either seat shows up here instead of being papered over by a hard-coded "self".
 */
function accessFor(seat: HrBundleName): AccessContext {
  const role = seat as unknown as PhoenixRole;
  return { role, scope: scopeForRole(role), hrId: "HR-SEAT-TEST", source: "session" } as AccessContext;
}

function heldKeys(seat: HrBundleName): Set<string> {
  const keys = new Set<string>();
  for (const [resource, actions] of Object.entries(hrBundleGrants(seat))) {
    for (const action of actions ?? []) keys.add(`${resource}:${action}`);
  }
  return keys;
}

function pageFileFor(href: string): string | null {
  const rest = href.startsWith("/hr/") ? href.slice(3) : href === "/hr" ? "/" : href;
  const rel = rest.replace(/^\//, "");
  for (const candidate of [
    path.join(REPO_ROOT, "app", "(admin)", rel, "page.tsx"),
    path.join(REPO_ROOT, "app", rel, "page.tsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Indent for a multi-line assertion message, built from a char code rather than an escape. This
 * repository is edited through shells that halve backslashes in a heredoc (AGENTS.md 2.1), and a
 * swallowed escape here turns the separator into a real line break mid-template-literal — which is
 * a syntax error that takes the whole suite down before one test runs. It already did, once, while
 * this section was being written. tests/hr-function-governance.test.ts carries the same constant
 * for the same reason.
 */
const NAV_SEP = String.fromCharCode(10) + "  ";

/**
 * An ENTRY gate, not a capability flag. `if (!(await canAccess(...))) redirect(...)` decides whether
 * the page opens at all; `const canDelete = await canAccess(...)` is a prop passed to a component
 * and must NOT be counted — treating one as the other reports a page as closed when it merely hides
 * a button. The optional `(` matters: the real shape in this codebase is `!(await canAccess(…))`,
 * and a pattern that only allowed `!await` read 8 gated pages where there are 12.
 */
const PAGE_ENTRY_GATE = /!\(?\s*await\s+canAccess\(\s*access\s*,\s*"([a-z_]+)"\s*,\s*"([a-z_]+)"\s*\)/g;
const PAGE_ENTRY_ASSERT = /await\s+assertPermission\(\s*access\s*,\s*"([a-z_]+)"\s*,\s*"([a-z_]+)"\s*\)/g;

/**
 * A hard-coded ROLE SET gate — `VIEW_ROLES.has(access.role)`, `ALLOWED.includes(access.role)`. This
 * is the shape a permission cannot express and therefore the shape the sidebar cannot reason about,
 * which is exactly why it is worth reading: /hr/admin/deductions admits {Super Admin, CEO} by name
 * and redirects everyone else, so offering that row on `deductions:read` handed HR Operations a link
 * that bounced her on arrival. Nothing in the permission matrix could have shown that.
 */
const PAGE_ROLE_SET_MEMBER = /"([^"]+)"/g;
/** `const VIEW_ROLES = new Set([...])` / `const ALLOWED = [...]` — the set is almost never inline. */
const PAGE_ROLE_SET_BINDING = /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:new Set\(\s*)?\[([^\]]*)\]/g;
/** `!VIEW_ROLES.has(access.role)` — negated only: an un-negated test is a deny list or a flag. */
const PAGE_ROLE_SET_USE = /!\s*([A-Za-z_$][\w$]*)\s*\.\s*(?:has|includes)\(\s*access\.role\s*\)/g;
/** The same thing written inline, `!new Set([...]).has(access.role)`. Rare, but free to cover. */
const PAGE_ROLE_SET_INLINE =
  /!\s*(?:new Set\(\s*)?\[([^\]]*)\]\)?\s*\.\s*(?:has|includes)\(\s*access\.role\s*\)/g;

function literalStrings(body: string): string[] {
  const names: string[] = [];
  PAGE_ROLE_SET_MEMBER.lastIndex = 0;
  let member: RegExpExecArray | null;
  while ((member = PAGE_ROLE_SET_MEMBER.exec(body))) names.push(member[1]!);
  return names;
}

/** Every hard-coded admit-list the page's entry gate tests `access.role` against. */
function roleSetGates(source: string): string[][] {
  const bindings = new Map<string, string[]>();
  PAGE_ROLE_SET_BINDING.lastIndex = 0;
  let binding: RegExpExecArray | null;
  while ((binding = PAGE_ROLE_SET_BINDING.exec(source))) {
    const names = literalStrings(binding[2]!);
    if (names.length) bindings.set(binding[1]!, names);
  }

  const gates: string[][] = [];
  PAGE_ROLE_SET_USE.lastIndex = 0;
  let use: RegExpExecArray | null;
  while ((use = PAGE_ROLE_SET_USE.exec(source))) {
    const names = bindings.get(use[1]!);
    if (names) gates.push(names);
  }
  PAGE_ROLE_SET_INLINE.lastIndex = 0;
  let inline: RegExpExecArray | null;
  while ((inline = PAGE_ROLE_SET_INLINE.exec(source))) {
    const names = literalStrings(inline[1]!);
    if (names.length) gates.push(names);
  }
  return gates;
}

/**
 * Pages an HR seat is offered whose entry gate this file cannot read, each hand-verified on
 * 2026-08-28 against both seats by calling the gate's own predicate. They are listed rather than
 * skipped: an unreadable gate that nobody has written down is an unchecked page, and the assertion
 * below requires this list to match the unreadable set EXACTLY — so a new unreadable page fails
 * loudly, and one that becomes readable has to be removed from here.
 */
const GATE_SHAPE_NOT_MACHINE_READABLE: Record<string, string> = {
  "/hr/admin/hr-command-center":
    "hrBundleForRole(access.role) — the same lookup that decides the seat's grants, so it admits " +
    "exactly the two seats by construction rather than by a second list agreeing with the first",
  "/hr/probation": "canReadAllProbation(access) — true for both seats",
  "/hr/recruitment/contact-review": "canReviewCandidateContacts(access) — true for Advisory, the only seat offered it",
  "/hr/recruitment/intake-health": "canViewInboundIntakeHealth(access) — true for Advisory, the only seat offered it",
  "/hr/attendance/device-user-mapping": 'canAccessAttendanceSetup(access, "read") — true for Operations, the only seat offered it',
  "/hr/attendance/policies": 'canAccessAttendanceSetup(access, "read") — true for Operations, the only seat offered it',
  "/hr/admin/support-requests": "hoisted const canRead = await canAccess(access, support_requests, read) — true for both",
  "/hr/offers": "destructured Promise.all, gate is !canRead = offers:read — true for Advisory, the only seat offered it",
  "/hr/hiring-documents": "destructured Promise.all, gate is isHrAuthorityRole && employee_documents:read — true for both",
  "/hr/hiring-pack": "destructured Promise.all, gate is isHrAuthorityRole && employee_documents:read — true for both",
  "/hr/admin/payroll-management": "any-of payroll:read || payslips:read || deductions:read — both hold deductions:read",
  "/hr/attendance": "shell gate only — no permission gate underneath it",
  "/hr/leave-management": "shell gate only — no permission gate underneath it",
  "/hr/admin/approvals-hub": "shell gate, plus a deep-link redirect that is routing rather than access",
};

/**
 * The SHELL gate: `if (resolveNavigationMode(access) === "employee-portal") redirect(...)`. It asks
 * which shell the viewer belongs in, not what they may do, so it is satisfied or not by the seat's
 * role alone — and this file settles it by CALLING resolveNavigationMode rather than assuming both
 * seats are admin-shell roles. If either ever stopped being one, every page carrying this line would
 * close at once and the sidebar would go on offering all of them.
 */
const PAGE_SHELL_GATE = /resolveNavigationMode\(\s*access\s*\)\s*===\s*"employee-portal"/;

/**
 * Pages offered to an HR seat that carry NO entry gate at all — no redirect, no notFound. Not a
 * defect and not an omission to chase: the admin shell itself is the gate for these, and the row
 * only renders for a seat the navigation already admitted.
 */
const PAGE_ENTRY_EXIT = /\b(?:redirect|notFound)\(/;

export async function runHrSeatRouteCoherenceTests() {
  const apiRoot = path.join(REPO_ROOT, "app", "api");
  const files = routeFiles(apiRoot);
  assert.ok(files.length > 300, `expected the whole api tree, found ${files.length} route files`);

  const seats = Object.keys(HR_ROLE_BUNDLES) as HrBundleName[];
  const held = new Map<HrBundleName, Set<string>>();
  for (const seat of seats) {
    const grants = hrBundleGrants(seat);
    const keys = new Set<string>();
    for (const [resource, actions] of Object.entries(grants)) {
      for (const action of actions ?? []) keys.add(`${resource as PermissionResource}:${action as PermissionAction}`);
    }
    held.set(seat, keys);
  }

  let handlersScanned = 0;
  let gatedHandlers = 0;
  let multiGrantHandlers = 0;
  const failures: string[] = [];

  for (const file of files) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    const source = readFileSync(file, "utf8");
    for (const handler of handlers(source)) {
      handlersScanned += 1;
      const required = new Set<string>();
      const re = /assertPermission\(\s*[A-Za-z_$][\w$]*\s*,\s*"([a-z_]+)"\s*,\s*"([a-z_]+)"\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(handler.body))) {
        required.add(`${match[1]}:${match[2]}`);
      }
      if (required.size === 0) continue;
      gatedHandlers += 1;
      if (required.size < 2) continue;
      multiGrantHandlers += 1;
      if (NOT_A_HARD_GATE[relative]) continue;

      for (const seat of seats) {
        const seatKeys = held.get(seat)!;
        const has = [...required].filter((key) => seatKeys.has(key));
        if (has.length === 0 || has.length === required.size) continue;
        const missing = [...required].filter((key) => !seatKeys.has(key));
        failures.push(
          `${relative} ${handler.method} requires ${[...required].sort().join(" + ")} — ` +
            `"${seat}" holds ${has.sort().join(", ")} but NOT ${missing.sort().join(", ")}, ` +
            "so a page offered to that seat 403s halfway",
        );
      }
    }
  }

  // Floors, so a walk that silently stopped finding routes cannot pass by scanning nothing.
  assert.ok(handlersScanned > 400, `expected the api handlers, found ${handlersScanned}`);
  assert.ok(gatedHandlers > 200, `expected assertPermission-gated handlers, found ${gatedHandlers}`);
  assert.ok(
    multiGrantHandlers >= 2,
    `expected handlers asserting more than one permission, found ${multiGrantHandlers}`,
  );

  assert.deepEqual(
    failures,
    [],
    `HR seat(s) hold PART of a route's permission set:\n  ${failures.join("\n  ")}`,
  );

  // The resignation route is why this test exists. Pin it by name so a refactor that moves the
  // third grant elsewhere cannot quietly take this test's only real subject away.
  const resign = readFileSync(path.join(apiRoot, "employees", "[hrId]", "resign", "route.ts"), "utf8");
  for (const resource of ["employees", "resignations", "vacancies"]) {
    assert.ok(
      resign.includes(`assertPermission(access, "${resource}"`),
      `the resignation route no longer asserts ${resource} — re-check which seat can record a departure`,
    );
  }
  const opsKeys = held.get("HR Operations" as HrBundleName)!;
  for (const key of ["employees:update", "resignations:create", "vacancies:create"]) {
    assert.ok(opsKeys.has(key), `HR Operations owns offboarding but lacks ${key}`);
  }

  // The role-set extractor has nothing to match on today — no page an HR seat is offered gates by
  // role name any more, which is the point of the fix below. That makes it a tripwire with no live
  // subject, so pin it to the page that taught it: if this stops reading {Super Admin, CEO} out of
  // the Deductions page, the pattern has rotted and the tripwire is disarmed without saying so.
  const deductionsPage = readFileSync(
    path.join(REPO_ROOT, "app", "(admin)", "admin", "deductions", "page.tsx"),
    "utf8",
  );
  assert.deepEqual(
    roleSetGates(deductionsPage),
    [["Super Admin", "CEO"]],
    "the role-set gate extractor no longer reads app/(admin)/admin/deductions/page.tsx — either the " +
      "page changed shape, or the pattern broke and every role-name gate is now invisible to this test",
  );

  // ── The same claim one layer up: the PAGE a rendered sidebar row points at ────────────────────
  // The API half above cannot see this. A page carries its own entry gate and redirects before it
  // renders, so a nav row can pass every permission clause in the navigation config and still bounce
  // the seat on arrival — the offered-but-closed shape, with no 403 anywhere to find it by.
  const catalog = getNavigationSections("hr");
  const navFailures: string[] = [];
  const unreadable = new Set<string>();
  let rowsOffered = 0;
  let gatedPages = 0;

  for (const seat of seats) {
    const keys = held.get(seat)!;
    const rows = getSections(catalog, "hr", lookupForSeat(seat), seat as unknown as PhoenixRole)
      .flatMap((section) => section.items);
    assert.ok(rows.length >= 10, `"${seat}" is offered only ${rows.length} HR nav rows — the shell did not build`);
    for (const row of rows) {
      rowsOffered += 1;
      const file = pageFileFor(row.href);
      if (!file) {
        navFailures.push(`${seat}: "${row.label}" -> ${row.href} has no page file`);
        continue;
      }
      const source = readFileSync(file, "utf8");

      const needs = new Set<string>();
      for (const re of [PAGE_ENTRY_GATE, PAGE_ENTRY_ASSERT]) {
        re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(source))) needs.add(`${match[1]}:${match[2]}`);
      }

      // A role-set gate admits by NAME, so the seat is either in the literal or it is redirected.
      const roleSets = roleSetGates(source);

      const shellGated = PAGE_SHELL_GATE.test(source);
      if (shellGated && resolveNavigationMode(accessFor(seat)) === "employee-portal") {
        navFailures.push(
          `${seat}: "${row.label}" (${row.href}) is in the sidebar, but the page sends anyone whose ` +
            "navigation mode is employee-portal away, and that is now this seat",
        );
      }

      // The shell gate deliberately does NOT count as reading the page. A page can carry it AND a
      // predicate gate underneath (probation does), so letting it satisfy the classification would
      // quietly drop that page out of the hand-verified list while its real gate stayed unread.
      if (needs.size || roleSets.length) gatedPages += 1;
      else if (PAGE_ENTRY_EXIT.test(source)) unreadable.add(row.href);

      const missing = [...needs].filter((key) => !keys.has(key));
      if (missing.length) {
        navFailures.push(
          `${seat}: "${row.label}" (${row.href}) is in the sidebar, but the page gates on ` +
            `${[...needs].sort().join(" + ")} and the seat lacks ${missing.sort().join(", ")}`,
        );
      }
      for (const names of roleSets) {
        if (!names.includes(seat)) {
          navFailures.push(
            `${seat}: "${row.label}" (${row.href}) is in the sidebar, but the page admits only ` +
              `${names.join(", ")} by name and redirects everyone else — put the same list in the ` +
              "nav entry's `roles`, or ask the owner to widen the page's set",
          );
        }
      }
    }
  }

  // Floor on the EXTRACTOR, not just the result. If the gate patterns ever stop matching — a page
  // style changes, a helper is renamed — `needs` is empty everywhere and this whole section passes
  // by checking nothing. That silent pass is the failure mode worth guarding, and it is not
  // hypothetical: the first version of this check read 8 gated pages where there are 12, because
  // its pattern missed `!(await canAccess(…))`.
  assert.ok(rowsOffered >= 30, `expected both seats' HR sidebars, got ${rowsOffered} rows`);
  assert.ok(
    gatedPages >= 12,
    `only ${gatedPages} of ${rowsOffered} offered rows matched an entry-gate pattern — the ` +
      "extractor has probably stopped seeing gates, which would make this check pass by doing nothing",
  );

  // The unreadable set has to match the hand-verified list EXACTLY. A page whose gate shape this
  // file cannot parse is an unchecked page; listing it is what keeps "unchecked" from meaning
  // "silently assumed fine".
  assert.deepEqual(
    [...unreadable].sort(),
    Object.keys(GATE_SHAPE_NOT_MACHINE_READABLE).sort(),
    "the set of HR pages whose entry gate cannot be read from source has changed — verify each new " +
      "one by calling its gate's own predicate for both seats, then record the verdict in " +
      `GATE_SHAPE_NOT_MACHINE_READABLE (or drop the entry if the gate is now readable)`,
  );

  assert.deepEqual(
    navFailures,
    [],
    `HR sidebar rows that bounce on arrival:${NAV_SEP}${navFailures.join(NAV_SEP)}`,
  );
}
