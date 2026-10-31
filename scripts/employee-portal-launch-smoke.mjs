import { chromium } from "playwright";

const baseUrl = process.env.PHOENIX_EMPLOYEE_PORTAL_BASE_URL ?? "http://localhost:3006";
const hardErrorPattern = /application error|portal error|employee portal unavailable|internal server error|runtime error|failed to compile|typeerror|referenceerror/i;
const mojibakePattern = /[\u00C3\u00C2\u00E2\uFFFD]/;

const employeePortalStaticRoutes = [
  "/employee-portals",
  "/employee-portals/coaching",
  "/employee-portals/contact-hr-support",
  "/employee-portals/dsms-performance",
  "/employee-portals/excuses",
  "/employee-portals/expense-dashboard",
  "/employee-portals/expenses",
  "/employee-portals/incentive",
  "/employee-portals/marketing-requests",
  "/employee-portals/marketing-requests/control",
  "/employee-portals/marketing-requests/customer-database",
  "/employee-portals/marketing-requests/validation",
  "/employee-portals/med-reps-performance",
  "/employee-portals/organogram",
  "/employee-portals/payroll",
  "/employee-portals/payslips",
  "/employee-portals/probation",
  "/employee-portals/profile",
  "/employee-portals/sales",
  "/employee-portals/submit-expense",
  "/employee-portals/team-expenses",
  "/employee-portals/team-performance",
  "/employee-portals/training-manager",
  "/employee-portals/coaching-skills-survey",
  "/employee-portals/training-manager/field-coaching",
  "/employee-portals/vacancies",
];

const employeePortalReachableRoutes = [
  ...employeePortalStaticRoutes,
  "/payslips",
  "/leave-management/vacation-request",
  "/leave-management/vacation-report",
];

function roleEnvKey(role) {
  return String(role ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function smokeCredentialsForRole(role) {
  const usersJson = process.env.PHOENIX_EMPLOYEE_PORTAL_SMOKE_USERS_JSON;
  if (usersJson) {
    const users = JSON.parse(usersJson);
    const user = users?.[role] ?? users?.[roleEnvKey(role)];
    if (user?.loginId && user?.password) return user;
  }

  const roleKey = roleEnvKey(role);
  const roleLoginId = process.env[`PHOENIX_EMPLOYEE_PORTAL_${roleKey}_LOGIN_ID`];
  const rolePassword = process.env[`PHOENIX_EMPLOYEE_PORTAL_${roleKey}_PASSWORD`];
  if (roleLoginId && rolePassword) {
    return {
      hrId: process.env[`PHOENIX_EMPLOYEE_PORTAL_${roleKey}_HR_ID`],
      loginId: roleLoginId,
      password: rolePassword,
    };
  }

  if (process.env.PHOENIX_EMPLOYEE_PORTAL_SMOKE_LOGIN_ID && process.env.PHOENIX_EMPLOYEE_PORTAL_SMOKE_PASSWORD) {
    return {
      hrId: process.env.PHOENIX_EMPLOYEE_PORTAL_SMOKE_HR_ID,
      loginId: process.env.PHOENIX_EMPLOYEE_PORTAL_SMOKE_LOGIN_ID,
      password: process.env.PHOENIX_EMPLOYEE_PORTAL_SMOKE_PASSWORD,
    };
  }

  return null;
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function bodyText(page) {
  return page.locator("body").innerText({ timeout: 7000 });
}

async function authenticate(context, role, hrId, next = "/employee-portals") {
  const realUser = smokeCredentialsForRole(role);
  if (realUser) {
    const response = await context.request.post(`${baseUrl}/api/auth/login`, {
      data: {
        loginId: realUser.loginId,
        password: realUser.password,
        remember: false,
      },
      timeout: 30000,
    });

    if (!response.ok()) {
      throw new Error(`Real auth failed for ${role}; status ${response.status()}`);
    }

    return;
  }

  const url = new URL("/api/dev-auth", baseUrl);
  url.searchParams.set("role", role);
  url.searchParams.set("loginId", `portal-smoke.${role.toLowerCase().replace(/[^a-z0-9]+/g, ".")}`);
  url.searchParams.set("next", next);
  if (hrId) url.searchParams.set("hrId", hrId);

  const response = await context.request.get(url.toString(), { maxRedirects: 0, timeout: 30000 });
  const setCookie = response.headers()["set-cookie"] ?? "";
  const match = setCookie.match(/phoenix_dev_preview=([^;]+)/);
  if (!match) {
    throw new Error(
      `Dev auth did not set a session cookie for ${role}; status ${response.status()}. ` +
        "For public preview smoke, set PHOENIX_EMPLOYEE_PORTAL_SMOKE_USERS_JSON or role-specific login/password env vars.",
    );
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
}

async function visit(page, label, path, expectedText = [], forbiddenText = []) {
  console.error(`[portal-smoke] ${label} -> ${path}`);
  const response = await page.goto(`${baseUrl}${path}`, { timeout: 45000, waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => null);

  const text = await bodyText(page);
  const lowerText = text.toLowerCase();
  const missing = expectedText.filter((item) => !lowerText.includes(String(item).toLowerCase()));
  const forbidden = forbiddenText.filter((item) => lowerText.includes(String(item).toLowerCase()));
  const hasHardError = hardErrorPattern.test(text);
  const hasMojibake = mojibakePattern.test(text);

  return {
    finalUrl: page.url(),
    forbidden,
    hasHardError,
    hasMojibake,
    label,
    missing,
    ok: response?.ok() && missing.length === 0 && forbidden.length === 0 && !hasHardError && !hasMojibake,
    path,
    snippet: normalizeWhitespace(text).slice(0, 360),
    status: response?.status() ?? 0,
  };
}

async function runForRole(browser, role, hrId, checks) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await authenticate(context, role, hrId);
  const page = await context.newPage();
  const results = [];

  for (const check of checks) {
    results.push(await visit(page, `${role}: ${check.label}`, check.path, check.expectedText, check.forbiddenText));
  }

  await context.close();
  return results;
}

async function runDirectRouteSweep(browser, role, hrId) {
  const checks = employeePortalReachableRoutes.map((path) => ({
    forbiddenText: ["Application error", "Internal Server Error", "Runtime Error", "Forbidden:"],
    label: `direct-entry ${path}`,
    path,
  }));
  return runForRole(browser, role, hrId, checks);
}

async function runSearchCheck(browser) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await authenticate(context, "National Sales Manager", "PHASE23-NSM");
  const page = await context.newPage();
  console.error("[portal-smoke] National Sales Manager: top navigation search -> /employee-portals");
  await page.goto(`${baseUrl}/employee-portals`, { timeout: 45000, waitUntil: "domcontentloaded" });
  await page.getByLabel("Search").fill("Expense");
  await page.waitForTimeout(300);
  const suggestions = await bodyText(page);
  await page.getByLabel("Search").press("Enter");
  await page.waitForURL(/employee-portals\/expense|employee-portals\/team-expenses|employee-portals\/submit-expense/, {
    timeout: 7000,
  });
  const text = await bodyText(page);
  const finalUrl = page.url();
  await context.close();

  return {
    finalUrl,
    hasHardError: hardErrorPattern.test(text),
    hasMojibake: mojibakePattern.test(text),
    label: "National Sales Manager: top navigation search",
    ok: /Expense/i.test(suggestions) && /employee-portals\/(expense|team-expenses|submit-expense)/.test(finalUrl) && !hardErrorPattern.test(text) && !mojibakePattern.test(text),
    path: "/employee-portals",
    snippet: normalizeWhitespace(text).slice(0, 360),
    status: 200,
  };
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  try {
    const unauthContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const unauthPage = await unauthContext.newPage();
    const results = [
      await visit(unauthPage, "Login page helper text removed", "/login", ["Phoenix"], ["Need a password link", "Users & Access"]),
    ];
    await unauthContext.close();

    results.push(...await runForRole(browser, "Employee", "PHASE23-EMP", [
      {
        expectedText: ["Expense"],
        forbiddenText: ["linked to your profile"],
        label: "expense dashboard empty state",
        path: "/employee-portals/expense-dashboard",
      },
      {
        expectedText: ["Probation"],
        label: "probation self-service",
        path: "/employee-portals/probation",
      },
      {
        expectedText: ["Vacancies Unavailable"],
        forbiddenText: ["Application error", "Forbidden"],
        label: "vacancies direct-entry guard",
        path: "/employee-portals/vacancies",
      },
    ]));

    results.push(...await runForRole(browser, "Medical Rep", "PHASE23-MR", [
      {
        expectedText: ["2026 Incentive Policy", "Basic Salary x 2 months"],
        label: "incentive policy text",
        path: "/employee-portals/incentive",
      },
      {
        expectedText: ["HR", "Support"],
        label: "contact HR support",
        path: "/employee-portals/contact-hr-support",
      },
    ]));

    results.push(...await runForRole(browser, "District Manager", "PHASE23-DM", [
      {
        expectedText: ["Team Performance"],
        label: "team performance",
        path: "/employee-portals/team-performance",
      },
      {
        expectedText: ["Submit Expense"],
        label: "submit expense",
        path: "/employee-portals/submit-expense",
      },
    ]));

    results.push(...await runForRole(browser, "Training Manager", "PHASE23-TM", [
      {
        expectedText: ["Training"],
        label: "training manager dashboard",
        path: "/employee-portals/training-manager",
      },
    ]));

    // The retired Talent Acquisition seat (A-16, resigned) was checked here as a PORTAL role that
    // must be refused the admin shell. Its two successors are admin-shell roles, so the check is
    // kept but its meaning has changed: admin-shell does not mean Super Admin. /admin is the Super
    // Admin home and gates on `admin:read`, which neither bundle holds, so both are still refused
    // there — while /workspace, where resolveLoginLandingPath sends them, must render.
    // Rerunning this against A-16 would have proved nothing: with the retired role now failing
    // closed to Employee, that hr_id no longer exercises an HR seat at all.
    for (const [role, hrId] of [["HR Advisory", "PHASE23-HRA"], ["HR Operations", "PHASE23-HROPS"]]) {
      results.push(...await runForRole(browser, role, hrId, [
        {
          expectedText: ["Access unavailable"],
          forbiddenText: ["Application error", "Employee portal unavailable"],
          label: `${role}: /admin stays Super Admin only`,
          path: "/admin",
        },
        {
          forbiddenText: ["Access unavailable", "Application error"],
          label: `${role}: lands on the admin-shell workspace`,
          path: "/workspace",
        },
      ]));
    }

    results.push(...await runDirectRouteSweep(browser, "Employee", "PHASE23-EMP"));
    results.push(...await runDirectRouteSweep(browser, "National Sales Manager", "PHASE23-NSM"));
    results.push(...await runDirectRouteSweep(browser, "Training Manager", "PHASE23-TM"));

    results.push(await runSearchCheck(browser));

    const failed = results.filter((result) => !result.ok);
    console.log(JSON.stringify({ failed, passed: results.length - failed.length, results }, null, 2));
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await run().catch((error) => {
  console.error("[portal-smoke] fatal", error);
  process.exit(1);
});
