import { runI18nConfigTests } from "./i18n-config.test.ts";
import { runIncentiveSchemeTests } from "./incentive-scheme.test.ts";
import { runEmailNotificationTests } from "./email-notifications.test.ts";
import { runPayrollSheetMappingTests } from "./payroll-sheet-mapping.test.ts";
import { runPhoenixHrReplyTemplateTests } from "./phoenix-hr-reply-template.test.ts";
import { runCoachingScoringTests } from "./coaching-scoring.test.ts";
import { runCoachingAnalyticsTests } from "./coaching-analytics.test.ts";
import { runCoachingExcelExportTests } from "./coaching-excel-export.test.ts";
import { runSalesOthersBucketTests } from "./sales-others-bucket.test.ts";
import { runSalesRoleMappingTests } from "./sales-role-mapping.test.ts";
import { runSalesPeriodTests } from "./sales-period.test.ts";
import { runEmployeePortalSalesScopeTests } from "./employee-portal-sales-scope.test.ts";
import { runCoachingPermissionTests } from "./coaching-permissions.test.ts";
import { runCoachingInAppNotificationTests } from "./coaching-in-app-notifications.test.ts";
import { runRlsGapClosureTests } from "./rls-gap-closure.test.ts";
import { runAuthSessionTests } from "./auth-session.test.ts";
import { runEmployeeDisplayNameTests } from "./employee-display-name.test.ts";
import { runEmployeePortalNavigationTests } from "./employee-portal-navigation.test.ts";
import { runLeaveCalculationTests } from "./leave-calculations.test.ts";
import { runLeaveMigrationTests } from "./leave-migration.test.ts";

async function runTest(name: string, execute: () => void | Promise<void>) {
  try {
    await execute();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await runTest("i18n config", runI18nConfigTests);
await runTest("incentive scheme", runIncentiveSchemeTests);
await runTest("email notifications", runEmailNotificationTests);
await runTest("payroll sheet mapping", runPayrollSheetMappingTests);
await runTest("phoenix hr reply template", runPhoenixHrReplyTemplateTests);
await runTest("coaching scoring", runCoachingScoringTests);
await runTest("coaching analytics", runCoachingAnalyticsTests);
await runTest("coaching excel export", runCoachingExcelExportTests);
await runTest("coaching permissions", runCoachingPermissionTests);
await runTest("coaching in-app notifications", runCoachingInAppNotificationTests);
await runTest("rls gap closure", runRlsGapClosureTests);
await runTest("sales others bucket", runSalesOthersBucketTests);
await runTest("sales role mapping", runSalesRoleMappingTests);
await runTest("sales period", runSalesPeriodTests);
await runTest("employee portal sales scope", runEmployeePortalSalesScopeTests);
await runTest("employee portal navigation", runEmployeePortalNavigationTests);
await runTest("leave calculations", runLeaveCalculationTests);
await runTest("leave migration", runLeaveMigrationTests);
await runTest("auth session", runAuthSessionTests);
await runTest("employee display name", runEmployeeDisplayNameTests);
