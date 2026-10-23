import assert from "node:assert/strict";

import { getNavigationSections, type NavigationSectionItem } from "../src/config/system-navigation.ts";
import { phoenixRoles, type NavigationMode, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { EMPLOYEE_PORTAL_SIDEBAR_ROWS } from "../src/lib/employee-portal/sidebar-rows.ts";
import { getSections } from "../src/lib/navigation/active-path.ts";
import { humaniseAddress, resolveSidebarLabel, shellForRole } from "../src/lib/system-audit/sidebar-label.ts";
import { NOT_IN_SIDEBAR_PREFIX } from "../src/lib/system-audit/types.ts";

/**
 * Column 3 — the module the person was in, in the words THEIR sidebar used. The sweep below asks
 * the rail itself (`getSections`, the function that draws it) what every role sees, and requires the
 * audit to give back the same words for the same address, for every role, every row.
 */

const UUID = "3f2b8c1a-1111-4222-8333-444455556666";

function basePath(href: string): string {
  return href.split("#")[0].split("?")[0];
}

/** Rows whose address is shared with another row (`?tab=` pairs) are told apart by the query alone. */
function sharedBases(mode: NavigationMode): Set<string> {
  const counts = new Map<string, Set<string>>();
  for (const section of getNavigationSections(mode)) {
    for (const item of section.items) {
      const base = basePath(item.href);
      const hrefs = counts.get(base) ?? new Set<string>();
      hrefs.add(item.href);
      counts.set(base, hrefs);
    }
  }
  return new Set([...counts].filter(([, hrefs]) => hrefs.size > 1).map(([base]) => base));
}

function inShell(href: string, mode: NavigationMode): boolean {
  if (!href.startsWith("/") || href.includes("?") || href.includes("#")) return false;
  if (mode === "hr") return href === "/hr" || href.startsWith("/hr/");
  return !href.startsWith("/hr/") && href !== "/hr" && !href.startsWith("/employee-portals") && !href.startsWith("/api/");
}

export function runSystemAuditSidebarLabelTests() {
  // ── Which rail a role lives in ─────────────────────────────────────────────────────────────────
  assert.equal(shellForRole("Super Admin"), "admin");
  assert.equal(shellForRole("CEO"), "admin");
  assert.equal(shellForRole("HR Operations"), "hr");
  assert.equal(shellForRole("Medical Rep"), "portal");
  assert.equal(shellForRole("Not A Role"), null);

  // ── The sweep: every role's own rail, every row, the same words back ───────────────────────────
  let checked = 0;
  for (const role of phoenixRoles as readonly PhoenixRole[]) {
    const shell = shellForRole(role);
    if (shell !== "admin" && shell !== "hr") continue;
    const mode: NavigationMode = shell;
    const shared = sharedBases(mode);
    for (const section of getSections(getNavigationSections(mode), mode, {}, role)) {
      for (const item of section.items as readonly NavigationSectionItem[]) {
        if (!inShell(item.href, mode) || shared.has(basePath(item.href))) continue;
        const label = resolveSidebarLabel({ route: item.href, role });
        assert.equal(
          label.label,
          item.label,
          `${role} on ${item.href}: the audit must name the row "${item.label}" exactly as the ${mode} rail draws it, got "${label.label}"`,
        );
        assert.equal(label.source, "nav_exact", `${role} on ${item.href} is the row's own address`);
        assert.equal(label.shell, shell);
        checked += 1;

        // A detail page under a row that lights its children reads as that row.
        if (!item.exact && !item.activeTab) {
          const child = resolveSidebarLabel({ route: `${item.href}/${UUID}?tab=x`, role });
          assert.equal(child.label, item.label, `${role} on a detail page under ${item.href} must read "${item.label}"`);
          assert.equal(child.source, "nav_parent");
        }
      }
    }
  }
  assert.ok(checked > 200, `the sweep must actually cover the rails (checked ${checked} rows)`);

  // ── The HR seats: a bare address the proxy rewrote reads as their /hr row ──────────────────────
  const hrRows = getSections(getNavigationSections("hr"), "hr", {}, "HR Operations")
    .flatMap((section) => section.items)
    .filter((item) => item.href.startsWith("/hr/") && inShell(item.href, "hr") && !sharedBases("hr").has(basePath(item.href)));
  assert.ok(hrRows.length > 0, "the HR Operations rail must have rows to test");
  const hrRow = hrRows[0];
  const bare = resolveSidebarLabel({ route: hrRow.href.slice("/hr".length), role: "HR Operations" });
  assert.equal(bare.label, hrRow.label, `an HR seat on ${hrRow.href.slice(3)} was on ${hrRow.href} — its rail's words`);
  assert.equal(bare.shell, "hr");

  // ── The portal rail ────────────────────────────────────────────────────────────────────────────
  const seen = new Set<string>();
  for (const row of EMPLOYEE_PORTAL_SIDEBAR_ROWS) {
    if (seen.has(row.href) || row.href.includes("?") || row.href.includes("#")) continue;
    seen.add(row.href);
    const label = resolveSidebarLabel({ route: row.href, role: "Medical Rep" });
    assert.equal(label.label, row.label, `the portal row ${row.href} must read "${row.label}"`);
    assert.equal(label.source, "nav_exact");
    assert.equal(label.shell, "portal");
  }
  const detail = resolveSidebarLabel({ route: "/employee-portals/employee-360/a-12", role: "Medical Rep" });
  assert.equal(detail.label, "Employee 360");
  assert.equal(detail.source, "nav_parent");
  // The portal root lights only on itself; a page with no row of its own is NOT "Command Center".
  const profile = resolveSidebarLabel({ route: "/employee-portals/profile", role: "Medical Rep" });
  assert.equal(profile.label.startsWith(NOT_IN_SIDEBAR_PREFIX), true, `a portal page with no row must say so, got "${profile.label}"`);
  assert.equal(profile.source, "none");
  assert.equal(profile.shell, "portal");

  // ── API requests: the page trail, then the map, then honestly nothing ──────────────────────────
  const trail = resolveSidebarLabel({
    route: "/api/approvals/vacation/123",
    role: "Medical Rep",
    recentPageRoute: "/employee-portals/approvals/vacation?status=pending",
  });
  assert.equal(trail.label, "Leave Approvals");
  assert.equal(trail.source, "page_trail");

  const mapped = resolveSidebarLabel({ route: "/api/approvals/vacation/123", role: "Medical Rep" });
  assert.equal(mapped.label, "Leave Approvals", "a portal seat's API error is named by the PORTAL page that calls it");
  assert.equal(mapped.source, "api_map");

  const adminMapped = resolveSidebarLabel({ route: "/api/approvals/vacation", role: "Super Admin" });
  assert.equal(adminMapped.source, "api_map");
  assert.equal(adminMapped.shell, "admin");
  assert.equal(adminMapped.label.startsWith(NOT_IN_SIDEBAR_PREFIX), false);

  const apiTrailIgnored = resolveSidebarLabel({ route: "/api/approvals/vacation", role: "Medical Rep", recentPageRoute: "/api/other" });
  assert.equal(apiTrailIgnored.source, "api_map", "a page trail that is itself an API names nothing");

  const cron = resolveSidebarLabel({ route: "/api/cron/notify-daily", role: null });
  assert.equal(cron.label.startsWith(`${NOT_IN_SIDEBAR_PREFIX}Scheduled job`), true, cron.label);
  assert.equal(cron.source, "none");

  const unknownApi = resolveSidebarLabel({ route: "/api/zzz-never-mapped", role: "Super Admin" });
  assert.equal(unknownApi.label.startsWith(`${NOT_IN_SIDEBAR_PREFIX}API`), true, unknownApi.label);
  assert.equal(unknownApi.source, "none");

  // ── Not an address at all ──────────────────────────────────────────────────────────────────────
  assert.deepEqual(resolveSidebarLabel({ route: "cron.notify-daily", routeType: "structured-log" }), {
    label: "Background job — cron.notify-daily",
    source: "none",
    shell: null,
    href: null,
  });
  assert.equal(resolveSidebarLabel({ route: null, routeType: "structured-log" }).label, "Background job — no name recorded");
  assert.equal(resolveSidebarLabel({ route: "", role: "Super Admin" }).label, `${NOT_IN_SIDEBAR_PREFIX}no address recorded`);

  // ── The address in words ───────────────────────────────────────────────────────────────────────
  assert.equal(humaniseAddress("/employee-portals/employee-360/a-12").includes("[id]"), false);
  assert.equal(humaniseAddress("/"), "Home");
}
