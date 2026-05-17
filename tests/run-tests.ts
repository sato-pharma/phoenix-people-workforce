import { runI18nConfigTests } from "./i18n-config.test.ts";
import { runIncentiveSchemeTests } from "./incentive-scheme.test.ts";
import { runEmailNotificationTests } from "./email-notifications.test.ts";
import { runPayrollEngineHardeningTests } from "./payroll-engine-hardening.test.ts";
import { runPayrollSheetMappingTests } from "./payroll-sheet-mapping.test.ts";
import { runPayrollWorkflowTests } from "./payroll-workflow.test.ts";
import { runPhoenixHrReplyTemplateTests } from "./phoenix-hr-reply-template.test.ts";
import { runCoachingScoringTests } from "./coaching-scoring.test.ts";
import { runCoachingAnalyticsTests } from "./coaching-analytics.test.ts";
import { runCoachingExcelExportTests } from "./coaching-excel-export.test.ts";
import { runCoachingAccessScopeTests } from "./coaching-access-scope.test.ts";
import { runSalesOthersBucketTests } from "./sales-others-bucket.test.ts";
import { runSalesRoleMappingTests } from "./sales-role-mapping.test.ts";
import { runSalesPeriodTests } from "./sales-period.test.ts";
import { runSalaryAllowancePolicyTests } from "./salary-allowance-policy.test.ts";
import { runWorkforceClassificationTests } from "./workforce-classification.test.ts";
import { runEmployeePortalSalesScopeTests } from "./employee-portal-sales-scope.test.ts";
import { runCoachingPermissionTests } from "./coaching-permissions.test.ts";
import { runCoachingInAppNotificationTests } from "./coaching-in-app-notifications.test.ts";
import { runRlsGapClosureTests } from "./rls-gap-closure.test.ts";
import { runAuthSessionTests } from "./auth-session.test.ts";
import { runEmployeeDisplayNameTests } from "./employee-display-name.test.ts";
import { runEmployeePortalNavigationTests } from "./employee-portal-navigation.test.ts";
import { runEmployeePortalPayslipSalaryTests } from "./employee-portal-payslip-salary.test.ts";
import { runOrganogramHardeningTests } from "./organogram-hardening.test.ts";
import { runProbationStabilizationTests } from "./probation-stabilization.test.ts";
import { runGoogleRoutesShortestTests } from "./google-routes-shortest.test.ts";
import { runAccessGovernanceHardeningTests } from "./access-governance-hardening.test.ts";
import { runVacationCalculationTests } from "./vacation-calculations.test.ts";
import { runVacationModuleTests } from "./vacation-module.test.ts";
import { runContractRenewalHardeningTests } from "./contract-renewal-hardening.test.ts";

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
await runTest("payroll workflow", runPayrollWorkflowTests);
await runTest("payroll engine hardening", runPayrollEngineHardeningTests);
await runTest("phoenix hr reply template", runPhoenixHrReplyTemplateTests);
await runTest("coaching scoring", runCoachingScoringTests);
await runTest("coaching analytics", runCoachingAnalyticsTests);
await runTest("coaching excel export", runCoachingExcelExportTests);
await runTest("coaching access scope", runCoachingAccessScopeTests);
await runTest("coaching permissions", runCoachingPermissionTests);
await runTest("coaching in-app notifications", runCoachingInAppNotificationTests);
await runTest("rls gap closure", runRlsGapClosureTests);
await runTest("sales others bucket", runSalesOthersBucketTests);
await runTest("sales role mapping", runSalesRoleMappingTests);
await runTest("sales period", runSalesPeriodTests);
await runTest("salary allowance policy", runSalaryAllowancePolicyTests);
await runTest("workforce classification", runWorkforceClassificationTests);
await runTest("employee portal sales scope", runEmployeePortalSalesScopeTests);
await runTest("employee portal navigation", runEmployeePortalNavigationTests);
await runTest("employee portal payslip salary", runEmployeePortalPayslipSalaryTests);
await runTest("organogram hardening", runOrganogramHardeningTests);
await runTest("probation stabilization", runProbationStabilizationTests);
  await runTest("google routes fastest", runGoogleRoutesShortestTests);
await runTest("auth session", runAuthSessionTests);
await runTest("employee display name", runEmployeeDisplayNameTests);
await runTest("access governance hardening", runAccessGovernanceHardeningTests);
await runTest("vacation calculations", runVacationCalculationTests);
await runTest("vacation module", runVacationModuleTests);
await runTest("contract renewal hardening", runContractRenewalHardeningTests);
