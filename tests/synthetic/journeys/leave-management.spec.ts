import { test, expect } from "@playwright/test";

import { runJourney } from "../helpers/run-journey";

test("Leave Management (Vacation Control) loads", async ({ page }, testInfo) => {
  await runJourney(
    page,
    testInfo,
    {
      id: "leave-management",
      name: "Leave Management (Vacation Control) loads",
      route: "/leave-management/vacation-control",
      role: "Super Admin",
    },
    async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Vacation Control" })).toBeVisible();
    },
  );
});
