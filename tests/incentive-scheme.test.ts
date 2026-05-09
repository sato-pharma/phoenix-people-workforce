import assert from "node:assert/strict";

import { calculateIncentive2026 } from "../src/lib/incentives/scheme-2026.ts";

export function runIncentiveSchemeTests() {
  const result = calculateIncentive2026({
    achievementPercent: 150,
    netSalary: 90000,
  });

  assert.equal(result.basicSalary, 63000);
  assert.equal(result.semesterTargetIncentive, 126000);
  assert.equal(result.payoutPercentage, 220);
  assert.equal(result.payoutAmount, 277200);

  const hundredPercent = calculateIncentive2026({
    achievementPercent: 100,
    netSalary: 90000,
  });

  assert.equal(hundredPercent.payoutPercentage, 100);
  assert.equal(hundredPercent.payoutAmount, 126000);
}
