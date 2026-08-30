import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  buildPermissionLookup,
  permissionMatrix,
  resolveNavigationMode,
  scopeForRole,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import {
  activePersonalWorkspaceTab,
  personalWorkspaceEntryHref,
  personalWorkspaceTabs,
  resolvePersonalWorkspaceTabs,
} from "../src/lib/workspace/personal-workspace-nav.ts";

/**
 * The personal workspace — /workspace/* in the admin shell — and the one rule that keeps it honest.
 *
 * ## What this is protecting
 *
 * Admin-shell roles have no employee portal, so their own payslip, incentive, deductions, vacation
 * balance, expenses and calendar live under `/workspace/*`. On 2026-08-30 that was fifteen working
 * personal pages of which **thirteen had no door**: no sidebar row, no hub card, and nothing in the
 * app linking to them. The frame they render in had no navigation either, so a typed URL landed you
 * on an island with no route to a second page. Phase 4 gave them a tab strip and put the door in the
 * account menu.
 *
 * ## The rule
 *
 * A tab is a promise that the page will open. `requireAdminShellEmployeeWorkspaceAccess` refuses by
 * `redirect()`ing with no message, so a tab shown to someone the page bounces does not read as "not
 * for you" — it reads as the app throwing you out. That defect has shipped here before, on the
 * sidebar's own "Request Vacation" row (Finance Manager, fixed 2026-08-10).
 *
 * So `personalWorkspaceTabs` copies each page's guard, and the test below **reads the page source
 * and compares** rather than trusting the copy. The two files cannot drift.
 *
 * ## Why it parses source text
 *
 * `admin-shell-employee-pages.tsx` imports `next/navigation`, which the test runner cannot resolve,
 * so the guards cannot be observed by calling them. Same constraint, and the same answer, as
 * `admin-shell-employee-roles.ts` and `marketing-requests/admin-page-access.ts`: assert against the
 * source. The parse is anchored on the literal call, so a rename breaks the test loudly (zero pages
 * found) rather than quietly passing on nothing.
 */

const PAGES_FILE = path.join(process.cwd(), "src/components/workspace/admin-shell-employee-pages.tsx");
const ROUTES_DIR = path.join(process.cwd(), "app/(admin)/workspace");

type ParsedGuard = {
  action: string;
  allowedRoles: string | null;
  rendersStrip: boolean;
  resource: string | null;
};

/**
 * Every `Workspace*Page` in the page module, with the guard it actually calls and whether it passes
 * `access={access}` to the frame — which is the single switch that renders the tab strip.
 */
function parsePageGuards(): Map<string, ParsedGuard> {
  const source = readFileSync(PAGES_FILE, "utf8");
  const out = new Map<string, ParsedGuard>();
  const fnPattern = /export async function (Workspace\w+Page)\b/g;
  const starts: Array<{ index: number; name: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = fnPattern.exec(source)) !== null) {
    starts.push({ index: match.index, name: match[1]! });
  }
  assert.ok(starts.length > 0, "found no Workspace*Page functions — the parse anchor has drifted");

  for (const [i, start] of starts.entries()) {
    const body = source.slice(start.index, starts[i + 1]?.index ?? source.length);
    const guard = /requireAdminShellEmployeeWorkspaceAccess\(\s*(\{[\s\S]*?\})\s*\)/.exec(body);
    // Two marketing pages call it with no options at all; they are not tabs, and the assertions
    // below only ever consult the guard of a page that IS one.
    const args = guard?.[1] ?? "{}";
    out.set(start.name, {
      action: /\baction:\s*"([^"]+)"/.exec(args)?.[1] ?? "read",
      allowedRoles: /\ballowedRoles:\s*(\w+)/.exec(args)?.[1] ?? null,
      rendersStrip: /<WorkspaceFrame\s*\n\s*access=\{access\}/.test(body),
      resource: /\bresource:\s*"([^"]+)"/.exec(args)?.[1] ?? null,
    });
  }
  return out;
}

/** Every `/workspace/*` route on disk, mapped to the `Workspace*Page` component it renders. */
function parseRoutes(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, href: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(child, `${href}/${entry.name}`);
        continue;
      }
      if (entry.name !== "page.tsx") continue;
      const component = /<(Workspace\w+Page)\b/.exec(readFileSync(child, "utf8"))?.[1];
      if (component) out.set(href || "/workspace", component);
    }
  };
  walk(ROUTES_DIR, "/workspace");
  assert.ok(out.size > 0, "found no /workspace routes — the route walk has drifted");
  return out;
}

const adminShellRoles = (Object.keys(permissionMatrix) as PhoenixRole[])
  .filter(
    (role) =>
      resolveNavigationMode({ hrId: null, role, scope: scopeForRole(role), source: "session" }) === "admin",
  )
  .sort();

/**
 * A viewer's access as a signed-in session really resolves it: `scopeForRole` is the same function
 * `resolveAccessContext` calls, so no scope here is invented.
 *
 * Worth knowing before reading assertion 5b: **`scopeForRole` never returns `"system"`.** A
 * signed-in Super Admin is `"company"`-scoped like the CEO, the Finance Manager and HR Operations.
 * `"system"` belongs to `systemAccessContext` — the server-side identity crons and imports run as —
 * which never renders a topbar. So every assertion built on `accessFor` measures the LOOKUP path,
 * which is the path a real person takes.
 */
function accessFor(role: PhoenixRole) {
  return { role, scope: scopeForRole(role) };
}

export async function runPersonalWorkspaceNavTests() {
  const guards = parsePageGuards();
  const routes = parseRoutes();

  // ── 1. every tab is a real route ────────────────────────────────────────────────
  for (const tab of personalWorkspaceTabs) {
    assert.ok(
      routes.has(tab.href),
      `personalWorkspaceTabs lists ${tab.href}, which is not a route under app/(admin)/workspace — a tab that 404s`,
    );
  }

  // ── 2. the tab set and the strip-rendering page set are the SAME set ─────────────
  // This is the assertion that keeps the two files honest in both directions. Passing
  // `access={access}` is what renders the strip, so a page that renders it but is not a tab shows
  // a strip that does not contain the page you are on, and a tab whose page does not render it
  // drops you out of the navigation the moment you use it.
  const tabHrefs = new Set(personalWorkspaceTabs.map((tab) => tab.href));
  const tabComponents = new Set([...tabHrefs].map((href) => routes.get(href)!));
  const stripComponents = new Set(
    [...guards.entries()].filter(([, guard]) => guard.rendersStrip).map(([name]) => name),
  );
  assert.deepEqual(
    [...stripComponents].sort(),
    [...tabComponents].sort(),
    "the pages that render the tab strip must be exactly the pages that ARE tabs — add the page to "
      + "personalWorkspaceTabs, or stop passing access={access} to its WorkspaceFrame",
  );

  // ── 3. every tab's gate is the page's OWN gate, verbatim ────────────────────────
  for (const tab of personalWorkspaceTabs) {
    const guard = guards.get(routes.get(tab.href)!);
    assert.ok(guard, `${tab.href} maps to a component with no parsed guard`);
    assert.equal(
      tab.resource ?? null,
      guard.resource,
      `${tab.href}: the tab declares resource ${JSON.stringify(tab.resource ?? null)} but the page `
        + `guards on ${JSON.stringify(guard.resource)} — the tab would be offered to people the page bounces`,
    );
    assert.equal(
      tab.action ?? "read",
      guard.action,
      `${tab.href}: the tab declares action "${tab.action ?? "read"}" but the page guards on "${guard.action}"`,
    );
    // The page names its allowedRoles by identifier; the tab must carry a list, not the default.
    assert.equal(
      Boolean(tab.allowedRoles),
      Boolean(guard.allowedRoles),
      `${tab.href}: the page ${guard.allowedRoles ? `passes allowedRoles: ${guard.allowedRoles}` : "passes no allowedRoles"}`
        + `, and the tab ${tab.allowedRoles ? "carries a list" : "carries none"} — they must agree`,
    );
  }

  // ── 4. no tab is dead ───────────────────────────────────────────────────────────
  // A tab nobody can open is the sidebar defect this repo has already shipped twice: an entry that
  // reads exactly like a working grant and renders for zero people.
  for (const tab of personalWorkspaceTabs) {
    const seen = adminShellRoles.filter((role) =>
      resolvePersonalWorkspaceTabs(accessFor(role), buildPermissionLookup(permissionMatrix, role)).some(
        (visible) => visible.href === tab.href,
      ),
    );
    assert.ok(seen.length > 0, `${tab.href} is a tab no admin-shell role can open — it renders for nobody`);
  }

  // ── 5. the CEO has no personal workspace, and is not offered a door to one ──────
  // He is not in adminShellEmployeeRoles and never has been, so every one of these pages would
  // redirect him. The account menu must not show him the entry.
  assert.equal(
    resolvePersonalWorkspaceTabs(accessFor("CEO"), buildPermissionLookup(permissionMatrix, "CEO")).length,
    0,
    "the CEO resolves personal workspace tabs, but every one of those pages will redirect him",
  );
  assert.equal(
    personalWorkspaceEntryHref(accessFor("CEO"), buildPermissionLookup(permissionMatrix, "CEO")),
    null,
    "the CEO must not be offered a My Workspace entry — every page behind it would redirect him",
  );

  // ── 5b. what a real Super Admin session actually takes, and the system bypass beside it ────────
  // Read these two in order, because the obvious assumption about them is wrong.
  //
  // FIRST, the path a person takes. A signed-in Super Admin is "company"-scoped, not "system"
  // (scopeForRole returns "system" for nobody), so he reaches all fifteen tabs through his LOOKUP
  // like everyone else. That is the assertion that protects the product.
  assert.equal(
    resolvePersonalWorkspaceTabs(accessFor("Super Admin"), buildPermissionLookup(permissionMatrix, "Super Admin"))
      .length,
    personalWorkspaceTabs.length,
    "a signed-in Super Admin must reach every personal tab through the permission matrix — he is "
      + "company-scoped, not system-scoped, so nothing waives the resource check for him",
  );
  //
  // SECOND, the bypass itself. `canAccess` returns true unconditionally on scope "system", so a
  // resolver that mirrors it must too, or the same context gets two different answers from two
  // functions that claim to describe one gate. Only `systemAccessContext` holds that scope — crons
  // and imports, never a browser — so nothing measured against the live matrix can see this line at
  // all: the matrix grants the Super Admin everything, and deleting the bypass changes no real
  // number. An EMPTY lookup is the only probe that can. With the bypass, fifteen; without it, one.
  assert.equal(
    resolvePersonalWorkspaceTabs({ role: "Super Admin", scope: "system" }, {}).length,
    personalWorkspaceTabs.length,
    "scope \"system\" must waive the resource check exactly as canAccess does — a resolver that "
      + "disagrees with the gate it mirrors is a second, quieter gate",
  );
  // And the same probe proves the bypass is his alone: any other viewer on an empty lookup keeps
  // only the tabs that ask for no resource at all.
  assert.equal(
    resolvePersonalWorkspaceTabs(accessFor("SFE Manager"), {}).length,
    personalWorkspaceTabs.filter((tab) => !tab.resource).length,
    "a viewer with no permissions must resolve only the tabs that guard on no resource",
  );

  // ── 6. every OTHER admin-shell role gets a door, and it opens ──────────────────
  for (const role of adminShellRoles.filter((candidate) => candidate !== "CEO")) {
    const lookup = buildPermissionLookup(permissionMatrix, role);
    const href = personalWorkspaceEntryHref(accessFor(role), lookup);
    assert.ok(href, `${role} has no personal workspace door, but has personal pages`);
    const visible = resolvePersonalWorkspaceTabs(accessFor(role), lookup);
    assert.ok(
      visible.some((tab) => tab.href === href),
      `${role}'s account-menu entry points at ${href}, which is not a tab that role can open`,
    );
  }

  // ── 7. the active-tab matcher ──────────────────────────────────────────────────
  // The root is a prefix of every other entry, so it must match EXACTLY or it claims every page in
  // the frame — including the marketing request pages, which share the frame and are not tabs.
  assert.equal(activePersonalWorkspaceTab("/workspace")?.href, "/workspace");
  assert.equal(activePersonalWorkspaceTab("/workspace/marketing-requests"), null);
  assert.equal(activePersonalWorkspaceTab("/workspace/marketing-requests/inbox"), null);
  assert.equal(activePersonalWorkspaceTab("/workspace/organogram"), null);
  // Longest match wins, so a nested route resolves to itself and not to its parent.
  assert.equal(activePersonalWorkspaceTab("/workspace/plans")?.href, "/workspace/plans");
  assert.equal(activePersonalWorkspaceTab("/workspace/plans/calendar")?.href, "/workspace/plans/calendar");
  // A deeper path under a tab still belongs to that tab.
  assert.equal(activePersonalWorkspaceTab("/workspace/payslips/2026-08")?.href, "/workspace/payslips");
  assert.equal(activePersonalWorkspaceTab("/admin/profile"), null);

  // ── 8. labels fit the strip ────────────────────────────────────────────────────
  // Owner rule: text is never truncated and never wraps. The strip is one scrolling line, so a
  // label long enough to wrap breaks that rule on a phone before it breaks it anywhere else.
  for (const tab of personalWorkspaceTabs) {
    assert.ok(
      tab.label.length <= 18,
      `"${tab.label}" is too long for a one-line tab (${tab.label.length} chars) — labels never wrap or ellipsise`,
    );
  }

  // ── 9. groups stay contiguous ──────────────────────────────────────────────────
  // The strip draws its hairline wherever the group changes between adjacent tabs, so a group split
  // across the array would silently draw two hairlines and read as two groups.
  const groupFirstSeen = new Map<string, number>();
  for (const [index, tab] of personalWorkspaceTabs.entries()) {
    if (!groupFirstSeen.has(tab.group)) groupFirstSeen.set(tab.group, index);
    const previous = personalWorkspaceTabs[index - 1];
    if (previous && previous.group !== tab.group) {
      assert.equal(
        groupFirstSeen.get(tab.group),
        index,
        `group "${tab.group}" is split across personalWorkspaceTabs — each group must be one contiguous run`,
      );
    }
  }
}
