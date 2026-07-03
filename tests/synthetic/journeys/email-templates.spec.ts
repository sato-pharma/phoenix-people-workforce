import { test, expect } from "@playwright/test";

import { runJourney } from "../helpers/run-journey";

test("Email Templates loads", async ({ page }, testInfo) => {
  await runJourney(
    page,
    testInfo,
    { id: "email-templates", name: "Email Templates loads", route: "/admin/email-templates", role: "Super Admin" },
    async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Email Templates" })).toBeVisible();
    },
  );
});
