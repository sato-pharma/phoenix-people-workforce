import { test, expect } from "@playwright/test";

import { runJourney } from "../helpers/run-journey";

test("Sales Normalizer loads", async ({ page }, testInfo) => {
  await runJourney(
    page,
    testInfo,
    { id: "sales-normalizer", name: "Sales Normalizer loads", route: "/sales/normalizer", role: "Super Admin" },
    async (page) => {
      await expect(page.getByRole("heading", { level: 1, name: "Source Normalizer" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Monthly Normalization" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Weekly Normalization" })).toBeVisible();
    },
  );
});
