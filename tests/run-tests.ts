import { runI18nConfigTests } from "./i18n-config.test.ts";
import { runIncentiveSchemeTests } from "./incentive-scheme.test.ts";
import { runEmailNotificationTests } from "./email-notifications.test.ts";
import { runPayrollSheetMappingTests } from "./payroll-sheet-mapping.test.ts";
import { runPhoenixHrReplyTemplateTests } from "./phoenix-hr-reply-template.test.ts";

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
