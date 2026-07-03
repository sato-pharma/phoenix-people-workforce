import { test, expect } from "@playwright/test";

import { runJourney } from "../helpers/run-journey";

test("Admin shell loads", async ({ page }, testInfo) => {
  await runJourney(
    page,
    testInfo,
    { id: "admin-shell", name: "Admin shell loads", route: "/admin", role: "Super Admin" },
    async (page) => {
      await expect(page.locator(".admin-shell")).toBeVisible();
      await expect(page.locator("nav").first()).toBeVisible();
    },
  );
});
