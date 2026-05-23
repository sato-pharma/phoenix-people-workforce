import { expect, test } from "@playwright/test";

test.describe("Authentication", () => {
  test("login page renders and shows required fields", async ({ page }) => {
    await page.goto("/login");

    await expect(page).toHaveTitle(/phoenix/i);
    await expect(page.getByRole("textbox", { name: /login|username|email/i })).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in|log in/i })).toBeVisible();
  });

  test("unauthenticated request to protected route redirects to login", async ({ page }) => {
    await page.goto("/overview");

    await expect(page).toHaveURL(/\/login/);
  });

  test("unauthenticated request to admin route redirects to login", async ({ page }) => {
    await page.goto("/admin");

    await expect(page).toHaveURL(/\/login/);
  });

  test("login page shows error on invalid credentials", async ({ page }) => {
    await page.goto("/login");

    await page.getByRole("textbox", { name: /login|username|email/i }).fill("invalid-user");
    await page.getByLabel(/password/i).fill("wrong-password");
    await page.getByRole("button", { name: /sign in|log in/i }).click();

    await expect(
      page.getByRole("alert").or(page.getByText(/invalid|incorrect|wrong|failed/i)),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("login form has accessible labels", async ({ page }) => {
    await page.goto("/login");

    const loginInput = page.getByRole("textbox", { name: /login|username|email/i });
    const passwordInput = page.getByLabel(/password/i);
    const submitButton = page.getByRole("button", { name: /sign in|log in/i });

    await expect(loginInput).toBeVisible();
    await expect(passwordInput).toBeVisible();
    await expect(submitButton).toBeEnabled();
  });

  test("password setup page validates token format", async ({ page }) => {
    await page.goto("/password-setup/not-a-valid-token");

    await expect(
      page.getByText(/invalid|expired|not valid/i).or(page.getByRole("alert")),
    ).toBeVisible({ timeout: 10_000 });
  });
});
