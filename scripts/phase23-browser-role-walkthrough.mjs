import { chromium } from "playwright";

const baseUrl = process.env.PHOENIX_PHASE23_BASE_URL ?? "http://localhost:3000";
const fakeId = "00000000-0000-0000-0000-000000000000";

function expectStatus(actual, expected) {
  return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function settledBodyText(page) {
  return page.locator("body").innerText({ timeout: 5000 }).catch((error) => `BODY_ERROR: ${error.message}`);
}

async function authenticate(context, role, hrId, next = "/") {
  const loginId = `phase23.${role.toLowerCase().replace(/[^a-z0-9]+/g, ".")}`;
  const url = new URL("/api/dev-auth", baseUrl);
  url.searchParams.set("role", role);
  url.searchParams.set("loginId", loginId);
  if (hrId) url.searchParams.set("hrId", hrId);
  url.searchParams.set("next", next);

  const response = await context.request.get(url.toString(), { maxRedirects: 0, timeout: 30000 });
  const setCookie = response.headers()["set-cookie"] ?? "";
  const match = setCookie.match(/phoenix_dev_preview=([^;]+)/);
  if (!match) {
    throw new Error(`Dev preview auth did not set a session cookie for ${role}; status ${response.status()}`);
  }

  await context.addCookies([
    {
      domain: new URL(baseUrl).hostname,
      httpOnly: true,
      name: "phoenix_dev_preview",
      path: "/",
      sameSite: "Lax",
      secure: false,
      value: decodeURIComponent(match[1]),
    },
  ]);

  const page = await context.newPage();
  return page;
}

async function visitPage(page, label, path, options = {}) {
  const expectedUrlIncludes = options.expectedUrlIncludes ?? path;
  const expectedText = options.expectedText ?? [];
  const forbiddenText = options.forbiddenText ?? [];
  const response = await page.goto(`${baseUrl}${path}`, { timeout: 45000, waitUntil: "domcontentloaded" }).catch((error) => ({
    status: () => 0,
    error,
  }));
  const status = typeof response?.status === "function" ? response.status() : 0;
  let text = "";
  let finalUrl = page.url();
  let missing = expectedText;
  let forbidden = [];
  let hardError = false;
  let urlOk = false;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(750);
    text = await settledBodyText(page);
    finalUrl = page.url();
    const lowerText = text.toLowerCase();
    missing = expectedText.filter((item) => !lowerText.includes(String(item).toLowerCase()));
    forbidden = forbiddenText.filter((item) => lowerText.includes(String(item).toLowerCase()));
    hardError = /application error|internal server error|runtime error|body_error|typeerror|referenceerror|failed to compile/i.test(text);
    urlOk = Array.isArray(expectedUrlIncludes)
      ? expectedUrlIncludes.some((item) => finalUrl.includes(item))
      : finalUrl.includes(expectedUrlIncludes);
    if (hardError || (urlOk && missing.length === 0 && forbidden.length === 0)) {
      break;
    }
  }

  return {
    finalUrl,
    forbidden,
    label,
    missing,
    ok: !hardError && urlOk && missing.length === 0 && forbidden.length === 0,
    path,
    snippet: normalizeWhitespace(text).slice(0, 420),
    status,
  };
}

async function apiJson(page, label, path, init, expectedStatus) {
  const result = await page.evaluate(
    async ({ init, path }) => {
      const response = await fetch(path, init);
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text.slice(0, 300);
      }
      return { body, status: response.status };
    },
    { init, path },
  );

  return {
    body: result.body,
    expectedStatus,
    label,
    ok: expectStatus(result.status, expectedStatus),
    status: result.status,
  };
}

async function apiMultipart(page, label, path, fields, expectedStatus) {
  const result = await page.evaluate(
    async ({ fields, path }) => {
      const formData = new FormData();
      for (const [key, value] of Object.entries(fields)) {
        formData.append(key, String(value));
      }
      const response = await fetch(path, { body: formData, method: "POST" });
      const body = await response.json().catch(() => null);
      return { body, status: response.status };
    },
    { fields, path },
  );

  return {
    body: result.body,
    expectedStatus,
    label,
    ok: expectStatus(result.status, expectedStatus),
    status: result.status,
  };
}

async function runRole(browser, role, hrId, next, checks) {
  const context = await browser.newContext();
  const page = await authenticate(context, role, hrId, next);
  const results = [];
  for (const check of checks) {
    console.error(`[phase23] ${role}: ${check.label}`);
    if (check.type === "page") {
      results.push(await visitPage(page, `${role}: ${check.label}`, check.path, check));
    } else if (check.type === "json") {
      results.push(await apiJson(page, `${role}: ${check.label}`, check.path, check.init, check.expectedStatus));
    } else if (check.type === "multipart") {
      results.push(await apiMultipart(page, `${role}: ${check.label}`, check.path, check.fields ?? {}, check.expectedStatus));
    }
  }
  await context.close();
  return results;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  try {
    const roleChecks = [
      ["Super Admin", "PHASE23-SA", "/admin", [
        { type: "page", label: "admin command center access", path: "/admin", expectedText: ["Command Center"], expectedUrlIncludes: "/admin" },
        { type: "page", label: "users access admin access", path: "/admin/access", expectedText: ["Users", "Access"], expectedUrlIncludes: "/admin/access" },
      ]],
      ["HR Specialist", "PHASE23-HR", "/admin", [
        { type: "page", label: "admin command center access", path: "/admin", expectedText: ["Command Center"], expectedUrlIncludes: "/admin" },
        { type: "page", label: "probation admin access", path: "/probation", expectedText: ["Probation"], expectedUrlIncludes: "/probation" },
      ]],
      ["Finance Manager", "PHASE23-FIN", "/employee-portals", [
        { type: "page", label: "payroll admin visibility", path: "/payroll", expectedText: ["Payroll"], expectedUrlIncludes: "/payroll" },
        { type: "page", label: "employee portal expenses visibility", path: "/employee-portals/expense-dashboard", expectedText: ["Expense"], expectedUrlIncludes: "/employee-portals/expense-dashboard" },
        { type: "page", label: "employee directory denied by permission", path: "/employees", expectedText: ["EMPLOYEE PORTAL"], expectedUrlIncludes: "/employee-portals", forbiddenText: ["Add Employee"] },
      ]],
      ["CEO", "PHASE23-CEO", "/admin/sales-command", [
        { type: "page", label: "sales command landing", path: "/admin/sales-command", expectedText: ["Sales Command"], expectedUrlIncludes: "/admin/sales-command" },
        { type: "page", label: "command center read visibility", path: "/admin", expectedText: ["Command Center"], expectedUrlIncludes: "/admin" },
        { type: "page", label: "payroll read visibility", path: "/payroll", expectedText: ["Payroll"], expectedUrlIncludes: "/payroll" },
      ]],
      ["District Manager", "PHASE23-DM", "/employee-portals", [
        { type: "page", label: "admin dashboard denied", path: "/admin", expectedText: ["EMPLOYEE PORTAL"], expectedUrlIncludes: "/employee-portals", forbiddenText: ["COMMAND CENTER"] },
        { type: "page", label: "team performance scoped portal", path: "/employee-portals/team-performance", expectedText: ["Team Performance"], expectedUrlIncludes: "/employee-portals/team-performance" },
        { type: "page", label: "payroll admin redirected to payslips", path: "/payroll", expectedUrlIncludes: ["/payslips", "/employee-portals/payroll"], expectedText: ["Payroll"] },
      ]],
      ["Medical Rep", "PHASE23-MR", "/employee-portals", [
        { type: "page", label: "portal overview self visibility", path: "/employee-portals", expectedText: ["Overview"], expectedUrlIncludes: "/employee-portals" },
        { type: "page", label: "portal payroll self visibility", path: "/employee-portals/payroll", expectedText: ["Payroll"], expectedUrlIncludes: ["/employee-portals/payroll", "/payslips"] },
        { type: "page", label: "portal sales self visibility", path: "/employee-portals/sales", expectedText: ["Sales"], expectedUrlIncludes: "/employee-portals/sales" },
        { type: "page", label: "admin dashboard denied", path: "/admin", expectedText: ["EMPLOYEE PORTAL"], expectedUrlIncludes: "/employee-portals", forbiddenText: ["COMMAND CENTER"] },
        { type: "page", label: "team performance does not expose team data", path: "/employee-portals/team-performance", expectedText: ["Team Performance Unavailable"], forbiddenText: ["Full Rankings"] },
      ]],
      ["Employee", "PHASE23-EMP", "/employee-portals", [
        { type: "page", label: "portal overview self visibility", path: "/employee-portals", expectedText: ["Overview"], expectedUrlIncludes: "/employee-portals" },
        { type: "page", label: "portal expenses self visibility", path: "/employee-portals/expense-dashboard", expectedText: ["Expense"], expectedUrlIncludes: "/employee-portals/expense-dashboard" },
        { type: "page", label: "portal probation self visibility", path: "/employee-portals/probation", expectedText: ["Probation"], expectedUrlIncludes: "/employee-portals/probation" },
        { type: "page", label: "admin dashboard denied", path: "/admin", expectedText: ["EMPLOYEE PORTAL"], expectedUrlIncludes: "/employee-portals", forbiddenText: ["COMMAND CENTER"] },
        { type: "multipart", label: "payroll upload mutation denied", path: "/api/payroll/upload", fields: { month: 5, year: 2026 }, expectedStatus: 403 },
        { type: "multipart", label: "sales import mutation denied", path: "/api/sales/imports/upload", fields: { line: "Pedia" }, expectedStatus: 403 },
        { type: "json", label: "payroll workflow mutation denied", path: `/api/payroll/${fakeId}/workflow`, init: { body: JSON.stringify({ action: "approve" }), headers: { "Content-Type": "application/json" }, method: "POST" }, expectedStatus: 403 },
        { type: "json", label: "user bulk mutation denied", path: "/api/admin/users/bulk-action", init: { body: JSON.stringify({ action: "disable", loginIds: ["PHASE23-NOOP"] }), headers: { "Content-Type": "application/json" }, method: "POST" }, expectedStatus: 403 },
      ]],
    ];

    const results = [];
    for (const [role, hrId, next, checks] of roleChecks) {
      results.push(...(await runRole(browser, role, hrId, next, checks)));
    }
    const failed = results.filter((result) => !result.ok);
    console.log(JSON.stringify({ failed, passed: results.length - failed.length, results }, null, 2));
    if (failed.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

await run();
