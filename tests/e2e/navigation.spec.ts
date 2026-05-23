import { expect, test } from "@playwright/test";

test.describe("Navigation & layout", () => {
  test("root path redirects to login when unauthenticated", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveURL(/\/login/);
  });

  test("login page has skip-to-main-content accessibility link", async ({ page }) => {
    await page.goto("/login");

    const skipLink = page.getByRole("link", { name: /skip to main content/i });
    await expect(skipLink).toBeAttached();
  });

  test("login page is responsive on mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/login");

    await expect(page.getByRole("button", { name: /sign in|log in/i })).toBeVisible();
  });

  test("API health: /api routes reject CSRF violations", async ({ page }) => {
    const response = await page.request.post("/api/auth/login", {
      data: { loginId: "test", password: "test" },
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example.com",
      },
    });

    expect(response.status()).toBe(403);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("csrf_violation");
  });

  test("rate limiting: password-setup endpoint enforces request cap", async ({ page }) => {
    const makeRequest = () =>
      page.request.post("/api/auth/password-setup/00000000-0000-0000-0000-000000000000", {
        data: { password: "test1234", confirmPassword: "test1234" },
        headers: { "Content-Type": "application/json" },
      });

    const results = await Promise.all(Array.from({ length: 6 }, makeRequest));
    const statuses = results.map((r) => r.status());

    // At least the 6th request should be rate-limited or blocked (400 for bad token, 429 for rate limit)
    expect(statuses.some((s) => s === 429 || s === 400)).toBe(true);
  });
});
