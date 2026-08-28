import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase23BrowserRoleWalkthroughTests() {
  const smoke = readFileSync("scripts/phase23-browser-role-walkthrough.mjs", "utf8");
  const devAuthRoute = readFileSync("app/api/dev-auth/route.ts", "utf8");
  const devPreviewLib = readFileSync("src/lib/auth/dev-preview.ts", "utf8");
  const employeesPage = readFileSync("app/(admin)/employees/page.tsx", "utf8");
  const permissionsSource = readFileSync("src/lib/auth/permissions.ts", "utf8");

  assert.match(smoke, /import \{ chromium \} from "playwright"/);
  assert.match(smoke, /\/api\/dev-auth/);
  assert.match(smoke, /context\.request\.get/);
  assert.match(smoke, /context\.addCookies/);
  assert.match(smoke, /Super Admin/);
  assert.match(smoke, /HR Advisory/);
  assert.match(smoke, /HR Operations/);
  assert.match(smoke, /Finance Manager/);
  assert.match(smoke, /CEO/);
  assert.match(smoke, /District Manager/);
  assert.match(smoke, /Medical Rep/);
  assert.match(smoke, /Employee/);

  assert.match(smoke, /admin command center access/);
  assert.match(smoke, /users access admin access/);
  assert.match(smoke, /payroll admin visibility/);
  assert.match(smoke, /employee directory denied by permission/);
  assert.match(smoke, /team performance scoped portal/);
  assert.match(smoke, /team performance does not expose team data/);
  assert.match(smoke, /portal payroll self visibility/);
  assert.match(smoke, /portal sales self visibility/);
  assert.match(smoke, /portal expenses self visibility/);
  assert.match(smoke, /portal probation self visibility/);
  assert.match(smoke, /admin dashboard denied/);

  assert.match(smoke, /payroll upload mutation denied/);
  assert.match(smoke, /sales import mutation denied/);
  assert.match(smoke, /payroll workflow mutation denied/);
  assert.match(smoke, /user bulk mutation denied/);
  assert.match(smoke, /expectedStatus: 403/);
  assert.doesNotMatch(smoke, /\.insert\(/);
  assert.doesNotMatch(smoke, /\.update\(/);
  assert.doesNotMatch(smoke, /\.delete\(/);

  // The local-dev+loopback gate lives in src/lib/auth/dev-preview.ts (isLocalDevelopmentRequest)
  // so /api/dev-auth and the Super Admin-gated /api/dev-auth/preview both enforce the same rule.
  assert.match(devPreviewLib, /process\.env\.NODE_ENV !== "development"/);
  assert.match(devPreviewLib, /function isLoopbackHostname/);
  assert.match(devPreviewLib, /normalized === "localhost"/);
  assert.match(devPreviewLib, /normalized === "127\.0\.0\.1"/);
  assert.match(devAuthRoute, /isLocalDevelopmentRequest/);
  assert.match(devAuthRoute, /phoenixDevPreviewCookieName/);
  assert.match(devAuthRoute, /createDevPreviewSessionToken/);

  assert.match(employeesPage, /canAccess\(access, "employees", "read"\)/);
  assert.match(employeesPage, /redirect\("\/employee-portals"\)/);

  assert.match(permissionsSource, /"Finance Manager": \{/);
  assert.doesNotMatch(
    permissionsSource.match(/"Finance Manager": \{[\s\S]*?\n  \}/)?.[0] ?? "",
    /employees:\s*\[/,
  );
  assert.match(permissionsSource, /function canSeeDirectReportsByRole/);
  assert.match(permissionsSource, /return canSeeDirectReportsByRole\(context\.role\) && isDirectReport/);
}
