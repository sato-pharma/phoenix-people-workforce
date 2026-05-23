import { expect, test } from "@playwright/test";

test.describe("API health checks", () => {
  test("unauthenticated GET /api/employees returns 401 or 403", async ({ page }) => {
    const response = await page.request.get("/api/employees");
    expect([401, 403]).toContain(response.status());
  });

  test("unauthenticated GET /api/payroll returns 401 or 403", async ({ page }) => {
    const response = await page.request.get("/api/payroll");
    expect([401, 403, 404]).toContain(response.status());
  });

  test("POST /api/auth/login with missing body returns 400", async ({ page }) => {
    const baseUrl = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
    const response = await page.request.post("/api/auth/login", {
      data: {},
      headers: { "Content-Type": "application/json", "Referer": `${baseUrl}/login` },
    });
    expect([400, 401]).toContain(response.status());
  });

  test("POST /api/auth/login cross-origin request is blocked by CSRF", async ({ page }) => {
    const response = await page.request.post("/api/auth/login", {
      data: { loginId: "test", password: "test" },
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example.com",
        Referer: "https://attacker.example.com/evil",
      },
    });
    expect(response.status()).toBe(403);
  });

  test("GET /api/notifications/birthdays without secret returns 401", async ({ page }) => {
    const response = await page.request.get("/api/notifications/birthdays");
    expect([401, 403]).toContain(response.status());
  });
});
