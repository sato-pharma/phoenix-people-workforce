/**
 * Phoenix CRM — the read a module page starts for its screen (the rule: src/lib/phoenix-crm/first-read.ts).
 *
 * 🔴 EVERY LOAD BELOW IS THE ROUTE'S OWN CALL, WORD FOR WORD, reading the same address the screen would have
 * sent. Nothing about a module's data is decided here; tests/phoenix-crm-first-read.test.ts compares each one
 * with its route and each address with its tab. What it saves is signing in again and finding the seats again.
 *
 * Each loader is imported when its module opens, so the page does not carry all of them.
 */

import { randomUUID } from "node:crypto";

import { headers } from "next/headers";

import { assertPermission, type AccessContext, type PermissionAction } from "@/lib/auth/permissions";
import { assertSeatViewMayRun } from "@/lib/auth/seat-view";
import { assertTestAccountMayRun } from "@/lib/auth/test-persona";
import { crmUrl } from "@/lib/phoenix-crm/crm-url";
import { isForecastLine } from "@/lib/phoenix-crm/daily-forecast";
import type { CrmFirstRead } from "@/lib/phoenix-crm/first-read";
import { allowedTabs, openingTab, seatOf, type PhoenixCrmSurface } from "@/lib/phoenix-crm/opening-tab";
import { resolvePhoenixCrmViewer, testModeFor, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import type { PhoenixCrmOverview } from "@/lib/phoenix-crm/view-types";

type FirstReadTarget = {
  key: string;
  load: (viewer: PhoenixCrmViewer, search: URLSearchParams) => unknown;
  permission?: PermissionAction;
  url: string;
};

const managerToday = (test: boolean): FirstReadTarget => ({
  key: "today",
  load: async (viewer, search) => {
    const { loadManagerToday } = await import("@/lib/phoenix-crm/server/manager-visits");
    return loadManagerToday(viewer, { test: search.get("test") });
  },
  url: crmUrl("/api/phoenix-crm/manager-plans/visits", { test }),
});

/**
 * What the opening tab asks for first, or null when it asks for nothing. This reads the overview the way
 * `tabContent` (phoenix-crm-app.tsx) does on its first render, when no other territory has been chosen yet.
 */
export function phoenixCrmFirstReadTarget(overview: PhoenixCrmOverview, requested: string | null, surface: PhoenixCrmSurface): FirstReadTarget | null {
  if (overview.closedMessage !== null || allowedTabs(overview.tabs).length === 0) return null;
  const who = overview.viewer;
  const test = who.isTestPersona;
  const managerPlanner = overview.managerPlans?.planner === true;

  switch (openingTab(overview, requested, surface)) {
    case "visits": {
      const seatId = seatOf(overview, "visits", null);
      if (seatId === null) return managerPlanner ? managerToday(test) : null;
      return {
        key: "day",
        load: async (viewer, search) => {
          const { loadVisitDay } = await import("@/lib/phoenix-crm/server/visits");
          return loadVisitDay(viewer, { seatId: search.get("seatId"), test: search.get("test"), date: search.get("date") });
        },
        url: crmUrl("/api/phoenix-crm/visits", { seatId, test }),
      };
    }
    case "list": {
      const seatId = seatOf(overview, "list", null);
      if (seatId === null) return null;
      return {
        key: "list",
        load: async (viewer, search) => {
          const { loadTerritoryList } = await import("@/lib/phoenix-crm/server/list");
          return loadTerritoryList(viewer, search.get("seatId"), search.get("test"));
        },
        url: crmUrl("/api/phoenix-crm/list", { seatId, test }),
      };
    }
    case "plan": {
      if (managerPlanner && !who.isRep) {
        return {
          key: "board",
          load: async (viewer, search) => {
            const { loadManagerPlanBoard } = await import("@/lib/phoenix-crm/server/manager-plans");
            return loadManagerPlanBoard(viewer, {
              week: search.get("week"),
              manager: search.get("manager"),
              test: search.get("test"),
              scope: search.get("scope"),
            });
          },
          url: crmUrl("/api/phoenix-crm/manager-plans", { test }),
        };
      }
      const seatId = seatOf(overview, "plan", null);
      if (seatId === null) return null;
      return {
        key: "planner",
        load: async (viewer, search) => {
          const { loadMonthlyPlanner } = await import("@/lib/phoenix-crm/server/monthly-plans");
          return loadMonthlyPlanner(viewer, { seatId: search.get("seatId"), test: search.get("test"), month: search.get("month") });
        },
        url: crmUrl("/api/phoenix-crm/monthly-plans", { seatId, test }),
      };
    }
    case "forecast": {
      const own = who.isSuperAdmin
        ? []
        : overview.territories.filter((territory) => isForecastLine(territory.lineCode) && overview.ownSeatIds.includes(territory.seatId));
      if (own.length > 0) {
        return {
          key: "form",
          load: async (viewer, search) => {
            const { loadForecastForm } = await import("@/lib/phoenix-crm/server/daily-forecast");
            return loadForecastForm(viewer, { seatId: search.get("seatId"), test: search.get("test") });
          },
          url: crmUrl("/api/phoenix-crm/forecast", { seatId: own[0].seatId, test }),
        };
      }
      if (!overview.tabs.team) return null;
      return {
        key: "board",
        load: async (viewer, search) => {
          const { loadForecastBoard } = await import("@/lib/phoenix-crm/server/daily-forecast");
          const day = await loadForecastBoard(viewer, { day: search.get("day"), test: search.get("test") });
          return { kind: "day", day };
        },
        url: crmUrl("/api/phoenix-crm/forecast/board", { test, view: "day" }),
      };
    }
    case "team":
      return {
        key: "team",
        load: async (viewer, search) => {
          const { loadTeamView } = await import("@/lib/phoenix-crm/server/team");
          return loadTeamView(viewer, { test: search.get("test") });
        },
        url: crmUrl("/api/phoenix-crm/team", { test }),
      };
    case "calendar":
      return {
        key: "report",
        load: async (viewer, search) => {
          const { loadTeamCalendar } = await import("@/lib/phoenix-crm/server/team-calendar");
          return loadTeamCalendar(viewer, { month: search.get("month"), test: search.get("includeTest") });
        },
        url: crmUrl("/api/phoenix-crm/reports", { includeTest: test, section: "calendar" }),
      };
    case "doctors":
      return {
        key: "directory",
        load: async (viewer, search) => {
          const { loadDoctorDirectory } = await import("@/lib/phoenix-crm/server/doctors");
          const isTest = testModeFor(viewer, search.get("test"));
          return loadDoctorDirectory(viewer, isTest);
        },
        url: crmUrl("/api/phoenix-crm/doctors", { test }),
      };
    case "reports":
      return {
        key: "report",
        load: async (viewer) => {
          const { loadReportScope } = await import("@/lib/phoenix-crm/server/reports");
          return loadReportScope(viewer);
        },
        url: crmUrl("/api/phoenix-crm/reports", { section: "scope" }),
      };
    case "settings":
      return {
        key: "settings",
        load: async (viewer) => {
          const { loadSettingsView } = await import("@/lib/phoenix-crm/server/admin-settings");
          return loadSettingsView(viewer);
        },
        permission: "update",
        url: "/api/phoenix-crm/settings",
      };
    case "testAccounts":
      return {
        key: "testApprovals",
        load: async (viewer) => {
          const { loadTestApprovals } = await import("@/lib/phoenix-crm/server/test-approvals");
          return loadTestApprovals(viewer);
        },
        url: "/api/phoenix-crm/test-approvals",
      };
  }
}

/**
 * Is anybody going to use it? 🔴 NOT ON A REFRESH: a saved visit calls `router.refresh()` to empty the
 * browser's copy of the page, the screen is already on its data and reads its own day again, so starting the
 * read here would be one more for every visit logged. Next asks for a refresh by marking the top of the tree it
 * sends ("refetch"; a move between pages marks only the segment that changed). Should a later Next stop doing
 * that, this answers true and the cost is that spare read, never a wrong screen.
 */
export function pageRequestWantsFirstRead(headerStore: Pick<Headers, "get">): boolean {
  if (headerStore.get("next-router-prefetch")) return false;
  const tree = headerStore.get("next-router-state-tree");
  if (!tree) return true;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(tree));
    return !(Array.isArray(parsed) && parsed[3] === "refetch");
  } catch {
    return true;
  }
}

/** Never rejects: a failure of any kind is null, and the screen's own read then says what went wrong. */
async function runFirstRead(access: AccessContext, target: FirstReadTarget): Promise<string | null> {
  try {
    const request = { method: "GET", url: target.url };
    // The guards `resolveAccessContext` runs on the route, then the route's own two gates.
    assertTestAccountMayRun(access, request);
    assertSeatViewMayRun(access, request);
    await assertPermission(access, "phoenix_crm", target.permission ?? "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = new URL(target.url, "http://phoenix.local").searchParams;
    return JSON.stringify(await target.load(viewer, search));
  } catch {
    return null;
  }
}

/** Starts the read and hands it back still running: the page never waits for it, and neither does its first paint. */
export async function startPhoenixCrmFirstRead(
  access: AccessContext,
  overview: PhoenixCrmOverview,
  requested: string | null,
  surface: PhoenixCrmSurface,
): Promise<CrmFirstRead | null> {
  if (!pageRequestWantsFirstRead(await headers())) return null;
  const target = phoenixCrmFirstReadTarget(overview, requested, surface);
  if (target === null) return null;
  return { body: runFirstRead(access, target), id: randomUUID(), key: target.key, url: target.url };
}
