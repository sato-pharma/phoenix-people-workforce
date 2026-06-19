import { test, expect, type Page } from "@playwright/test";

/**
 * Read-only route smoke for Weekly / Monthly Plans.
 *
 * Local/staging only:
 * - Uses /api/dev-auth, which is disabled in production.
 * - Performs navigation and GET requests only.
 * - Does not create, patch, decide, acknowledge, or cancel plans.
 */

const BASE = "http://localhost:3000";

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 180_000 });

type ActorRoute = {
  hrId: string;
  name: string;
  role: string;
  routes: string[];
};

const ACTOR_ROUTES: ActorRoute[] = [
  {
    hrId: "A-8",
    name: "submitter employee portal",
    role: "Group Product Manager",
    routes: ["/employee-portals/plans", "/employee-portals/plans/calendar"],
  },
  {
    hrId: "A-9",
    name: "Marketing Manager workspace reviewer",
    role: "Marketing Manager",
    routes: ["/workspace/plans", "/workspace/plans/calendar"],
  },
  {
    hrId: "AA",
    name: "CEO admin reviewer",
    role: "CEO",
    routes: ["/admin/weekly-plans", "/admin/weekly-plans/calendar"],
  },
  {
    hrId: "B-10",
    name: "Super Admin HR reviewer",
    role: "Super Admin",
    routes: ["/admin/weekly-plans", "/admin/weekly-plans/calendar"],
  },
];

async function devAuthAvailable(page: Page) {
  const res = await page.request.get(
    `${BASE}/api/dev-auth?role=Super+Admin&hrId=B-10&next=/`,
    { maxRedirects: 0 },
  );
  return res.status() !== 404;
}

async function devAuth(page: Page, role: string, hrId: string, next: string) {
  const qs = new URLSearchParams({ hrId, next, role });
  await page.goto(`${BASE}/api/dev-auth?${qs.toString()}`, {
    waitUntil: "domcontentloaded",
  });
}

test.describe("Weekly Plans - read-only route smoke", () => {
  for (const actor of ACTOR_ROUTES) {
    test(`${actor.name} can load assigned planning routes`, async ({ page }) => {
      const available = await devAuthAvailable(page);
      if (!available) {
        test.skip(true, "/api/dev-auth not available - read-only smoke requires local/staging dev-auth.");
        return;
      }

      page.setDefaultNavigationTimeout(60_000);
      await page.context().clearCookies();
      await devAuth(page, actor.role, actor.hrId, "/");

      for (const route of actor.routes) {
        const response = await page.goto(`${BASE}${route}`, { waitUntil: "commit" });
        expect(response?.status(), `${actor.name} ${route} should not return a server error`).toBeLessThan(500);
        await expect(page).toHaveURL(new RegExp(route.replaceAll("/", "\\/")), { timeout: 15_000 });
      }
    });
  }
});
