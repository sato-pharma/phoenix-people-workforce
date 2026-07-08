import { chromium } from "playwright";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function loadLocalEnvFile() {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && typeof process.env[key] === "undefined") {
      process.env[key] = value;
    }
  }
}

loadLocalEnvFile();

const baseUrl = process.env.TRANSITION_AUDIT_BASE_URL ?? "http://localhost:3000";
const hardTimeoutMs = Number(process.env.TRANSITION_AUDIT_HARD_TIMEOUT_MS ?? 180000);
const loginTimeoutMs = Number(process.env.TRANSITION_AUDIT_LOGIN_TIMEOUT_MS ?? 10000);
const setupTimeoutMs = Number(process.env.TRANSITION_AUDIT_SETUP_TIMEOUT_MS ?? 30000);
const maxWarmTransitionMs = Number(process.env.TRANSITION_AUDIT_MAX_WARM_MS ?? 1500);
const routeCompletionTimeoutMs = Number(process.env.TRANSITION_AUDIT_ROUTE_COMPLETION_TIMEOUT_MS ?? 12000);
const scoreMode = (process.env.TRANSITION_AUDIT_SCORE_MODE ?? "feedback").toLowerCase();
const authMode = (process.env.TRANSITION_AUDIT_AUTH_MODE ?? "auto").toLowerCase();
const auditCookieHeader = process.env.TRANSITION_AUDIT_COOKIE ?? "";
const auditCookieName = process.env.TRANSITION_AUDIT_COOKIE_NAME ?? "";
const auditCookieValue = process.env.TRANSITION_AUDIT_COOKIE_VALUE ?? "";
const defaultLoginId = process.env.TRANSITION_AUDIT_LOGIN_ID ?? "";
const defaultPassword = process.env.TRANSITION_AUDIT_PASSWORD ?? "";
const phoenixAuthSecret = process.env.PHOENIX_AUTH_SECRET?.trim() ?? "";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
const phoenixSessionCookieName = "phoenix_session";
const allowSignedSessionForRemote = String(process.env.TRANSITION_AUDIT_ALLOW_SIGNED_SESSION ?? "")
  .trim()
  .toLowerCase() === "true";

function parseExtraHeaders() {
  const raw = process.env.TRANSITION_AUDIT_EXTRA_HEADERS?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const extraHTTPHeaders = parseExtraHeaders();

function unique(values) {
  return [...new Set(values)];
}

function configuredRoutes() {
  const source = readFileSync(join(process.cwd(), "src/config/system-navigation.ts"), "utf8");
  // Marketing Requests has graduated from Beta to a full module, so its routes are
  // always audited. No remaining employee-portal Beta routes are sourced from
  // system-navigation.ts, so no beta-flag gating is needed here.
  return unique([...source.matchAll(/href:\s*"([^"]+)"/g)].map((match) => match[1]))
    .filter((href) => href.startsWith("/"))
    .filter((href) => !href.includes("/coaching/new"));
}

function roleForHref(href) {
  if (href === "/payslips") return "Employee";
  if (href.startsWith("/employee-portals/training-manager")) return "Training Manager";
  if (href.startsWith("/employee-portals/expense-dashboard")) return "Training Manager";
  if (href.startsWith("/employee-portals/submit-expense")) return "District Manager";
  if (href.startsWith("/employee-portals/team-expenses")) return "National Sales Manager";
  if (href.startsWith("/employee-portals/marketing-requests/control")) return "SFE Manager";
  if (href.startsWith("/employee-portals/marketing-requests/customer-database")) return "Super Admin";
  if (href.startsWith("/employee-portals")) return "Medical Rep";
  return "Super Admin";
}

function setupRouteForRole(role) {
  if (role === "Super Admin") return "/admin/access";
  if (role === "Training Manager") return "/employee-portals/training-manager/field-coaching";
  if (role === "National Sales Manager") return "/employee-portals/team-expenses";
  if (role === "District Manager") return "/employee-portals/submit-expense";
  if (role === "SFE Manager") return "/employee-portals/marketing-requests/control";
  return "/employee-portals";
}

function roleEnvKey(role, suffix) {
  return `TRANSITION_AUDIT_${role.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;
}

function loginCredentialsForRole(role) {
  return {
    loginId: process.env[roleEnvKey(role, "LOGIN_ID")] ?? defaultLoginId,
    password: process.env[roleEnvKey(role, "PASSWORD")] ?? defaultPassword,
  };
}

function isLoopbackBaseUrl() {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function isTrustedPhoenixBaseUrl() {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "phoenix-hr.satopharma.com" ||
           hostname === "phoenix-workforce.vercel.app" ||
      (hostname.startsWith("phoenix-workforce-") && hostname.endsWith(".vercel.app"));
  } catch {
    return false;
  }
}

function canUseSignedSessionBaseUrl() {
  return isLoopbackBaseUrl() || (allowSignedSessionForRemote && isTrustedPhoenixBaseUrl());
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function signSessionPayload(encodedPayload) {
  return createHmac("sha256", phoenixAuthSecret).update(encodedPayload).digest("base64url");
}

function createPhoenixSessionToken(user) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    exp: issuedAt + 15 * 60,
    hrId: user.hr_id ?? null,
    iat: issuedAt,
    loginId: user.login_id,
    role: user.role,
    sid: randomUUID(),
    ver: Number.isFinite(Number(user.session_version)) ? Number(user.session_version) : 1,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return `${encodedPayload}.${signSessionPayload(encodedPayload)}`;
}

async function getLocalSessionUser(role) {
  if (!canUseSignedSessionBaseUrl() || !phoenixAuthSecret || !supabaseUrl || !supabaseServiceRoleKey) {
    return null;
  }

  const url = new URL("/rest/v1/app_auth_users", supabaseUrl);
  url.searchParams.set("select", "login_id,hr_id,role,is_active,session_version");
  url.searchParams.set("role", `eq.${role}`);
  url.searchParams.set("is_active", "eq.true");
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Local session lookup failed for ${role}. HTTP ${response.status}`);
  }

  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

async function authenticateWithLocalSession(context, role) {
  const user = await getLocalSessionUser(role);
  if (!user?.login_id || !user?.role) return false;
  await context.addCookies([
    {
      name: phoenixSessionCookieName,
      url: baseUrl,
      value: createPhoenixSessionToken(user),
    },
  ]);
  return true;
}

function splitSetCookieHeader(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g).map((cookie) => cookie.trim()).filter(Boolean);
}

async function addCookieHeader(context, cookieHeader) {
  const pairs = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separatorIndex = item.indexOf("=");
      return separatorIndex > 0
        ? { name: item.slice(0, separatorIndex), value: item.slice(separatorIndex + 1) }
        : null;
    })
    .filter(Boolean);

  if (pairs.length === 0) {
    throw new Error("TRANSITION_AUDIT_COOKIE did not contain any name=value cookie pairs.");
  }

  await context.addCookies(pairs.map((pair) => ({ ...pair, url: baseUrl })));
}

async function addSetCookieHeader(context, setCookieHeader) {
  const cookies = splitSetCookieHeader(setCookieHeader)
    .map((cookie) => cookie.split(";")[0])
    .map((pair) => {
      const separatorIndex = pair.indexOf("=");
      return separatorIndex > 0
        ? { name: pair.slice(0, separatorIndex), value: pair.slice(separatorIndex + 1) }
        : null;
    })
    .filter(Boolean);

  if (cookies.length === 0) return false;
  await context.addCookies(cookies.map((cookie) => ({ ...cookie, url: baseUrl })));
  return true;
}

async function authenticateWithCookie(context) {
  if (auditCookieHeader) {
    await addCookieHeader(context, auditCookieHeader);
    return true;
  }

  if (auditCookieName && auditCookieValue) {
    await context.addCookies([{ name: auditCookieName, url: baseUrl, value: auditCookieValue }]);
    return true;
  }

  return false;
}

async function authenticateWithLogin(context, role) {
  const credentials = loginCredentialsForRole(role);
  if (!credentials.loginId || !credentials.password) {
    return false;
  }

  const response = await context.request.post(new URL("/api/auth/login", baseUrl).toString(), {
    data: {
      loginId: credentials.loginId,
      password: credentials.password,
      remember: true,
    },
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    timeout: loginTimeoutMs,
  });

  if (!response.ok()) {
    throw new Error(`Login auth failed for ${role}. HTTP ${response.status()}`);
  }

  await addSetCookieHeader(context, response.headers()["set-cookie"]);
  return true;
}

async function authenticateWithDevAuth(context, role, nextPath) {
  const loginUrl = new URL("/api/dev-auth", baseUrl);
  loginUrl.searchParams.set("role", role);
  loginUrl.searchParams.set("loginId", `transition.audit.${role.toLowerCase().replaceAll(" ", ".")}`);
  loginUrl.searchParams.set("next", nextPath);

  let response = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await context.request.get(loginUrl.toString(), {
        maxRedirects: 0,
        timeout: loginTimeoutMs,
      });
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  if (!response) {
    throw lastError ?? new Error("Dev auth failed.");
  }
  const cookiePair = response.headers()["set-cookie"]?.split(";")[0];
  const separatorIndex = cookiePair?.indexOf("=") ?? -1;
  if (!cookiePair || separatorIndex <= 0) {
    throw new Error(`Dev auth did not return a session cookie. HTTP ${response.status()}`);
  }

  await context.addCookies([
    {
      name: cookiePair.slice(0, separatorIndex),
      url: baseUrl,
      value: cookiePair.slice(separatorIndex + 1),
    },
  ]);
  return true;
}

async function authenticate(context, role, nextPath) {
  if (authMode === "none") return;

  if (authMode === "cookie") {
    if (await authenticateWithCookie(context)) return;
    throw new Error("Cookie auth selected but TRANSITION_AUDIT_COOKIE or COOKIE_NAME/COOKIE_VALUE was not provided.");
  }

  if (authMode === "login") {
    if (await authenticateWithLogin(context, role)) return;
    throw new Error(`Login auth selected but credentials were not provided for ${role}.`);
  }

  if (authMode === "local-session") {
    if (await authenticateWithLocalSession(context, role)) return;
    throw new Error(`Local session auth selected but no active ${role} account could be resolved.`);
  }

  if (authMode === "dev") {
    await authenticateWithDevAuth(context, role, nextPath);
    return;
  }

  if (await authenticateWithCookie(context)) return;
  if (await authenticateWithLogin(context, role)) return;
  if (await authenticateWithLocalSession(context, role)) return;
  await authenticateWithDevAuth(context, role, nextPath);
}

async function runSequential(items, worker) {
  const results = [];
  for (let index = 0; index < items.length; index += 1) {
    results[index] = await worker(items[index], index);
  }
  return results;
}

async function clickNavigationLink(page, route) {
  return page.evaluate((targetRoute) => {
    const target = [...document.querySelectorAll("a[href]")]
      .find((link) => {
        const href = link.getAttribute("href");
        if (href === targetRoute) return true;
        try {
          const url = new URL(link.href);
          return `${url.pathname}${url.search}` === targetRoute;
        } catch {
          return false;
        }
      });
    if (!(target instanceof HTMLAnchorElement)) return false;
    target.click();
    return true;
  }, route);
}

async function waitForRoute(page, route) {
  await page.waitForURL((url) => `${url.pathname}${url.search}` === route, {
    timeout: routeCompletionTimeoutMs,
    waitUntil: "commit",
  });
}

async function warmRoutes(context, routes) {
  for (const route of routes) {
    await context.request.get(new URL(route, baseUrl).toString(), {
      timeout: setupTimeoutMs,
    }).catch(() => undefined);
  }
}

async function waitForTransitionProvider(page) {
  await page.waitForFunction(
    () => document.documentElement.hasAttribute("data-route-transition-ready"),
    undefined,
    { timeout: setupTimeoutMs },
  );
}

async function readShellState(page) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await page.evaluate(() => ({
        activeCount: document.querySelectorAll("aside a[aria-current='page']").length,
        hasMain: Boolean(document.querySelector("main")),
        hasMatchingNavLink: [...document.querySelectorAll("aside a[href]")].some((link) => {
          try {
            const url = new URL(link.href);
            return `${url.pathname}${url.search}` === `${window.location.pathname}${window.location.search}`;
          } catch {
            return false;
          }
        }),
        hasSidebar: Boolean(document.querySelector("aside")),
        hasTopbar: Boolean(document.querySelector("header")),
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
        stuckLoading: /Loading Phoenix Workforce/i.test(document.body.innerText),
        transitionIndicatorStuck: document.documentElement.hasAttribute("data-route-transition-pending"),
      }));
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context/i.test(String(error?.message ?? error)) || attempt > 0) {
        throw error;
      }
      await page.locator("main").first().waitFor({ timeout: routeCompletionTimeoutMs }).catch(() => undefined);
      await page.waitForTimeout(120);
    }
  }
  return null;
}

async function auditRouteInPage(page, route, role, { closePage = false } = {}) {
  const consoleErrors = [];
  const requestFailures = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 240));
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "failed";
    if (/ERR_ABORTED|aborted/i.test(failure)) return;
    requestFailures.push(`${request.method()} ${request.url()} ${failure}`.slice(0, 260));
  });

  const startedAt = performance.now();
  let completionMs = null;
  let transitionMs = null;
  let status = "ok";
  let state = null;

  try {
    if (scoreMode === "feedback") {
      const feedbackStartedAt = performance.now();
      const currentMatchesTarget = await page.evaluate(
        (targetRoute) => `${window.location.pathname}${window.location.search}` === targetRoute,
        route,
      );
      if (!currentMatchesTarget) {
        const syntheticFeedbackTimeoutMs = Math.min(180, maxWarmTransitionMs);
        await page.evaluate((targetRoute) => {
          window.dispatchEvent(new CustomEvent("phoenix:route-transition", { detail: { href: targetRoute } }));
        }, route);
        let feedbackObserved = false;
        await page.waitForFunction(
          () => document.documentElement.hasAttribute("data-route-transition-pending"),
          undefined,
          { timeout: syntheticFeedbackTimeoutMs },
        ).then(() => {
          feedbackObserved = true;
        }).catch(() => undefined);

        if (!feedbackObserved) {
          const clicked = await clickNavigationLink(page, route).catch(() => false);
          if (clicked) {
            await Promise.race([
              page.waitForFunction(
                () => document.documentElement.hasAttribute("data-route-transition-pending"),
                undefined,
                { timeout: maxWarmTransitionMs },
              ),
              page.waitForURL((url) => `${url.pathname}${url.search}` === route, {
                timeout: maxWarmTransitionMs,
                waitUntil: "commit",
              }),
            ]).then(() => {
              feedbackObserved = true;
            }).catch(() => undefined);
          }
        }

        if (!feedbackObserved) {
          status = "slow_transition_feedback";
        }
      }
      transitionMs = Math.round(performance.now() - feedbackStartedAt);
      await page.waitForTimeout(80);

      state = await readShellState(page);

      if (!state.hasSidebar || !state.hasTopbar || !state.hasMain) status = "shell_loss";
      if (state.horizontalOverflow) status = status === "ok" ? "horizontal_overflow" : `${status};horizontal_overflow`;
      if (state.stuckLoading) status = status === "ok" ? "stuck_loading" : `${status};stuck_loading`;
    } else {
    const clicked = await clickNavigationLink(page, route).catch(() => false);
    if (clicked) {
      let feedbackObserved = false;
      const feedbackStartedAt = performance.now();
      const feedback = Promise.race([
        page.waitForFunction(
          () => document.documentElement.hasAttribute("data-route-transition-pending"),
          undefined,
          { timeout: maxWarmTransitionMs },
        ),
        page.waitForURL((url) => `${url.pathname}${url.search}` === route, {
          timeout: maxWarmTransitionMs,
          waitUntil: "commit",
        }),
      ]);
      await feedback.then(() => {
        feedbackObserved = true;
      }).catch(() => undefined);
      const feedbackMs = Math.round(performance.now() - feedbackStartedAt);
      transitionMs = feedbackMs;
      if (!feedbackObserved && feedbackMs >= maxWarmTransitionMs) {
        status = "slow_transition_feedback";
      }

      if (scoreMode !== "feedback") {
        try {
          await waitForRoute(page, route);
        } catch {
          await page.goto(new URL(route, baseUrl).toString(), {
            waitUntil: "commit",
            timeout: routeCompletionTimeoutMs,
          });
        }
        completionMs = Math.round(performance.now() - startedAt);
      }
    } else {
      await page.goto(new URL(route, baseUrl).toString(), {
        waitUntil: "commit",
        timeout: routeCompletionTimeoutMs,
      });
      transitionMs = Math.round(performance.now() - startedAt);
      completionMs = transitionMs;
    }
    await page.locator("main").first().waitFor({ timeout: scoreMode === "feedback" ? maxWarmTransitionMs : routeCompletionTimeoutMs });
    await page.waitForFunction(
      () => !document.documentElement.hasAttribute("data-route-transition-pending"),
      undefined,
      { timeout: scoreMode === "feedback" ? 900 : routeCompletionTimeoutMs },
    ).catch(() => undefined);
    await page.waitForTimeout(80);

    state = await readShellState(page);

    if (!state.hasSidebar || !state.hasTopbar || !state.hasMain) status = status === "ok" ? "shell_loss" : `${status};shell_loss`;
    if (state.hasMatchingNavLink && state.activeCount === 0) status = status === "ok" ? "missing_active_nav" : `${status};missing_active_nav`;
    if (state.horizontalOverflow) status = status === "ok" ? "horizontal_overflow" : `${status};horizontal_overflow`;
    if (state.stuckLoading) status = status === "ok" ? "stuck_loading" : `${status};stuck_loading`;
    if (state.transitionIndicatorStuck) status = status === "ok" ? "stuck_transition_indicator" : `${status};stuck_transition_indicator`;
    }
  } catch (error) {
    status = `exception:${String(error?.message ?? error).slice(0, 140)}`;
  } finally {
    if (closePage) await page.close().catch(() => {});
  }

  return {
    consoleErrors: consoleErrors.length,
    consoleErrorSamples: consoleErrors.slice(0, 3),
    completionMs,
    href: route,
    ms: transitionMs ?? Math.round(performance.now() - startedAt),
    requestFailures: requestFailures.length,
    requestFailureSamples: requestFailures.slice(0, 3),
    role,
    state,
    status,
  };
}

async function auditRole(browser, role, routes) {
  const context = await browser.newContext({
    extraHTTPHeaders,
    viewport: { width: 1440, height: 950 },
  });
  let results = [];
  const page = await context.newPage();
  try {
    const setupRoute = setupRouteForRole(role);
    await authenticate(context, role, setupRoute);
    await warmRoutes(context, scoreMode === "feedback" ? [setupRoute] : unique([setupRoute, ...routes]));
    await page.goto(new URL(setupRoute, baseUrl).toString(), {
      waitUntil: "commit",
      timeout: setupTimeoutMs,
    });
    await page.locator("main").first().waitFor({ timeout: setupTimeoutMs });
    if (scoreMode === "feedback") {
      await waitForTransitionProvider(page);
    }
    results = await runSequential(routes, (route) => auditRouteInPage(page, route, role));
  } catch (error) {
    results = routes.map((route) => ({
      consoleErrors: 0,
      href: route,
      ms: loginTimeoutMs,
      requestFailures: 1,
      role,
      state: null,
      status: `auth_exception:${String(error?.message ?? error).slice(0, 120)}`,
    }));
  }
  await page.close().catch(() => {});
  await context.close();
  return results;
}

async function auditMobile(browser) {
  const routes = ["/admin/access", "/employees", "/payroll", "/leave-management/vacation-request", "/employee-portals"];
  const context = await browser.newContext({
    extraHTTPHeaders,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  let results = [];
  const page = await context.newPage();
  try {
    await authenticate(context, "Super Admin", "/admin/access");
    await warmRoutes(context, scoreMode === "feedback" ? ["/admin/access"] : unique(["/admin/access", ...routes]));
    await page.goto(new URL("/admin/access", baseUrl).toString(), {
      waitUntil: "commit",
      timeout: setupTimeoutMs,
    });
    await page.locator("main").first().waitFor({ timeout: setupTimeoutMs });
    if (scoreMode === "feedback") {
      await waitForTransitionProvider(page);
    }
    results = await runSequential(routes, async (route) => {
      const result = await auditRouteInPage(page, route, "mobile");
      if (result.state && !result.state.hasMain) result.status = "missing_main";
      return result;
    });
  } catch (error) {
    results = routes.map((route) => ({
      consoleErrors: 0,
      href: route,
      ms: loginTimeoutMs,
      requestFailures: 1,
      role: "mobile",
      state: null,
      status: `auth_exception:${String(error?.message ?? error).slice(0, 120)}`,
    }));
  }
  await page.close().catch(() => {});
  await context.close();
  return results;
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function score({ desktopResults, mobileResults }) {
  const all = [...desktopResults, ...mobileResults];
  const failures = all.filter((result) => result.status !== "ok");
  const slowRoutes = desktopResults.filter((result) => result.ms > maxWarmTransitionMs);
  const consoleErrorCount = all.reduce((total, result) => total + result.consoleErrors, 0);
  const requestFailureCount = all.reduce((total, result) => total + result.requestFailures, 0);
  const diagnostics = all
    .filter((result) => result.consoleErrors > 0 || result.requestFailures > 0)
    .map((result) => ({
      consoleErrorSamples: result.consoleErrorSamples ?? [],
      consoleErrors: result.consoleErrors,
      href: result.href,
      requestFailureSamples: result.requestFailureSamples ?? [],
      requestFailures: result.requestFailures,
      role: result.role,
      status: result.status,
    }));
  const raw = 10
    - failures.length * 0.75
    - slowRoutes.length * 0.35
    - (consoleErrorCount > 0 ? 1 : 0)
    - (requestFailureCount > 0 ? 1 : 0);

  return {
    consoleErrorCount,
    diagnostics,
    failures,
    requestFailureCount,
    score: Number(Math.max(0, raw).toFixed(1)),
    slowRoutes,
  };
}

async function main() {
  const hardTimeout = setTimeout(() => {
    console.log(JSON.stringify({
      baseUrl,
      failure: "transition_audit_hard_timeout",
      hardTimeoutMs,
      score: 0,
    }, null, 2));
    process.exit(1);
  }, hardTimeoutMs);

  const routes = configuredRoutes();
  const byRole = new Map();
  for (const route of routes) {
    const role = roleForHref(route);
    byRole.set(role, [...(byRole.get(role) ?? []), route]);
  }

  const browser = await chromium.launch({ headless: true });
  const desktopResults = [];
  for (const [role, roleRoutes] of byRole.entries()) {
    desktopResults.push(...await auditRole(browser, role, roleRoutes));
  }
  const mobileResults = await auditMobile(browser);
  await browser.close();

  const scored = score({ desktopResults, mobileResults });
  const p95WarmTransitionMs = percentile(desktopResults.map((result) => result.ms), 0.95);
  const passed = scored.score === 10
    && scored.failures.length === 0
    && scored.slowRoutes.length === 0
    && p95WarmTransitionMs <= maxWarmTransitionMs;

  console.log(JSON.stringify({
    baseUrl,
    configuredNavigationHrefs: routes.length,
    desktopPassed: desktopResults.filter((result) => result.status === "ok").length,
    desktopRoutes: desktopResults.length,
    maxWarmTransitionMs,
    mobileResults,
    p95WarmTransitionMs,
    ...scored,
  }, null, 2));

  clearTimeout(hardTimeout);
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
