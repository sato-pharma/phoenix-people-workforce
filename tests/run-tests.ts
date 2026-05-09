import { runI18nConfigTests } from "./i18n-config.test.ts";
import { runIncentiveSchemeTests } from "./incentive-scheme.test.ts";

function runTest(name: string, execute: () => void) {
  try {
    execute();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest("i18n config", runI18nConfigTests);
runTest("incentive scheme", runIncentiveSchemeTests);
