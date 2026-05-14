import { expect, test, type Page } from "@playwright/test";

const appBaseUrl = process.env.E2E_LEAVE_BASE_URL;
const employeeLogin = process.env.E2E_LEAVE_EMPLOYEE_LOGIN;
const employeePassword = process.env.E2E_LEAVE_EMPLOYEE_PASSWORD;
const managerLogin = process.env.E2E_LEAVE_MANAGER_LOGIN;
const managerPassword = process.env.E2E_LEAVE_MANAGER_PASSWORD;
const hrLogin = process.env.E2E_LEAVE_HR_LOGIN;
const hrPassword = process.env.E2E_LEAVE_HR_PASSWORD;

function requiredCredential(name: string, value: string | undefined) {
  if (!value) throw new Error(`${name} is required for leave E2E tests.`);
  return value;
}

function appUrl(path: string) {
  return new URL(path, requiredCredential("E2E_LEAVE_BASE_URL", appBaseUrl)).toString();
}

async function login(page: Page, loginId: string, password: string) {
  await page.goto(appUrl("/login"));
  await page.getByLabel(/login|email|user/i).fill(loginId);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in|login/i }).click();
  await page.waitForLoadState("networkidle");
}

async function acceptNextDialog(page: Page, text?: string) {
  const dialogPromise = page.waitForEvent("dialog");
  const dialog = await dialogPromise;
  await dialog.accept(text);
}

test.describe("Leave Management staging E2E", () => {
  test.skip(
    !appBaseUrl || !employeeLogin || !employeePassword || !managerLogin || !managerPassword || !hrLogin || !hrPassword,
    "Leave E2E staging base URL and credentials are required.",
  );

  test("employee submit flow and attachment upload flow", async ({ page }) => {
    await login(page, requiredCredential("E2E_LEAVE_EMPLOYEE_LOGIN", employeeLogin), requiredCredential("E2E_LEAVE_EMPLOYEE_PASSWORD", employeePassword));
    await page.goto(appUrl("/employee-portals/leave"));
    await expect(page.getByTestId("employee-leave-workspace")).toBeVisible();
    await expect(page.getByTestId("leave-submit-form")).toBeVisible();
    await page.getByTestId("leave-start-date-input").fill(process.env.E2E_LEAVE_START_DATE ?? "2026-12-13");
    await page.getByTestId("leave-end-date-input").fill(process.env.E2E_LEAVE_END_DATE ?? "2026-12-14");
    if (process.env.E2E_LEAVE_DURATION_UNIT) {
      await page.getByTestId("leave-duration-unit-select").selectOption(process.env.E2E_LEAVE_DURATION_UNIT);
    }
    await page.getByTestId("leave-reason-input").fill("Playwright employee submit flow");
    await page.getByTestId("leave-attachment-input").setInputFiles({
      buffer: Buffer.from("Phoenix Leave E2E attachment"),
      mimeType: "application/pdf",
      name: "leave-e2e.pdf",
    });
    await page.getByTestId("leave-request-submit-button").click();
    await expect(page.getByText(/submitted|pending/i)).toBeVisible();
  });

  test("conflict warning flow", async ({ page }) => {
    await login(page, requiredCredential("E2E_LEAVE_EMPLOYEE_LOGIN", employeeLogin), requiredCredential("E2E_LEAVE_EMPLOYEE_PASSWORD", employeePassword));
    await page.goto(appUrl("/employee-portals/leave"));
    await expect(page.getByTestId("employee-leave-workspace")).toBeVisible();
    await expect(page.getByTestId("leave-submit-form")).toBeVisible();
    await page.getByTestId("leave-start-date-input").fill(process.env.E2E_LEAVE_CONFLICT_START_DATE ?? "2026-12-13");
    await page.getByTestId("leave-end-date-input").fill(process.env.E2E_LEAVE_CONFLICT_END_DATE ?? "2026-12-14");
    await expect(page.getByTestId("leave-conflict-warning")).toBeVisible();
  });

  test("manager approve and reject flows", async ({ page }) => {
    await login(page, requiredCredential("E2E_LEAVE_MANAGER_LOGIN", managerLogin), requiredCredential("E2E_LEAVE_MANAGER_PASSWORD", managerPassword));
    await page.goto(appUrl("/employee-portals/leave-approvals"));
    await expect(page.getByTestId("manager-leave-workspace")).toBeVisible();
    const approveButton = page.getByTestId("manager-leave-approve-button").first();
    await expect(approveButton).toBeVisible();
    const approveDialog = acceptNextDialog(page, "Playwright manager approval");
    await approveButton.click();
    await approveDialog;
    await expect(page.getByText(/decision recorded|pending hr/i)).toBeVisible();
    await page.reload();
    await page.waitForLoadState("networkidle");
    const rejectButton = page.getByTestId("manager-leave-reject-button").first();
    await expect(rejectButton).toBeVisible();
    const rejectDialog = acceptNextDialog(page, "Playwright manager rejection");
    await rejectButton.click();
    await rejectDialog;
    await expect(page.getByText(/decision recorded|rejected/i)).toBeVisible();
  });

  test("HR approve and reject flows, accrual dry-run, accrual execution, and analytics rendering", async ({ page }) => {
    await login(page, requiredCredential("E2E_LEAVE_HR_LOGIN", hrLogin), requiredCredential("E2E_LEAVE_HR_PASSWORD", hrPassword));
    await page.goto(appUrl("/admin/leave"));
    await expect(page.getByTestId("admin-leave-workspace")).toBeVisible();
    await expect(page.getByTestId("leave-admin-analytics")).toBeVisible();
    await page.getByTestId("leave-accrual-dry-run-button").click();
    await expect(page.getByText(/Dry run ready|Would Accrue/i)).toBeVisible();
    const safeRunDialog = acceptNextDialog(page);
    await page.getByTestId("leave-accrual-safe-run-button").click();
    await safeRunDialog;
    await expect(page.getByText(/Accrual processed/i)).toBeVisible();
    const hrApproveButton = page.getByTestId("hr-leave-approve-button").first();
    await expect(hrApproveButton).toBeVisible();
    const hrApproveDialog = acceptNextDialog(page, "Playwright HR approval");
    await hrApproveButton.click();
    await hrApproveDialog;
    await expect(page.getByText(/HR decision recorded|approved/i)).toBeVisible();
    await page.reload();
    await page.waitForLoadState("networkidle");
    const hrRejectButton = page.getByTestId("hr-leave-reject-button").first();
    await expect(hrRejectButton).toBeVisible();
    const hrRejectDialog = acceptNextDialog(page, "Playwright HR rejection");
    await hrRejectButton.click();
    await hrRejectDialog;
    await expect(page.getByText(/HR decision recorded|rejected/i)).toBeVisible();
  });
});
