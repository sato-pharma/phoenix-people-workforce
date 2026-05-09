/**
 * 2026 Incentive Scheme Logic
 *
 * 1) Incentive Frequency: Per semester (2 payouts per year).
 * 2) Incentive Value per Semester: 2 months of Basic Salary.
 *    Net Salary   = Gross - Social Insurance - Taxes
 *    Basic Salary = Net Salary × 70%
 *
 *    NOTE: gross_salary in salary_records is the BASE salary BEFORE additions
 *    (fuel allowance, extra cost of living, etc. are stored separately in
 *    total_additions). Therefore net = gross - SI - taxes already excludes
 *    those allowances — do NOT subtract them again.
 *
 * 3) Achievement-to-Payout Logic (Performance Curve):
 *    - < 90% achievement: 0% payout
 *    - 90% achievement: 50% payout
 *    - 91% to 100%: +5% payout for each 1% achievement
 *    - 101% to 120%: +1.5% payout for each 1% achievement
 *    - Above 120%: +3% payout for each 1% achievement
 *    - Achievement ceiling capped at 150%
 */

export type IncentiveCalculation = {
  netSalary: number;
  basicSalary: number;
  semesterTargetIncentive: number;
  payoutPercentage: number;
  payoutAmount: number;
  achievement: number; // 0 to 150 (capped)
};

export function calculateIncentive2026(params: {
  netSalary?: number;
  grossSalary?: number;
  socialInsurance?: number;
  taxes?: number;
  achievementPercent: number;
}): IncentiveCalculation {
  // gross_salary in salary_records is the BASE salary (before additions).
  // Compute net = gross - SI - taxes; this already excludes allowances.
  const hasGrossBasis =
    params.grossSalary !== undefined && (params.grossSalary ?? 0) > 0;
  const grossSalary = params.grossSalary ?? 0;
  const socialInsurance = params.socialInsurance ?? 0;
  const taxes = params.taxes ?? 0;
  const netSalary = Math.max(
    0,
    hasGrossBasis ? grossSalary - socialInsurance - taxes : params.netSalary ?? 0,
  );
  const basicSalary = netSalary * 0.7;
  const semesterTargetIncentive = basicSalary * 2;
  
  // Cap achievement at 150%
  const achievement = Math.min(150, Math.max(0, params.achievementPercent));
  
  let payoutPercentage = 0;
  
  if (achievement < 90) {
    payoutPercentage = 0;
  } else if (achievement === 90) {
    payoutPercentage = 50;
  } else if (achievement <= 100) {
    // 91% -> 55%, 92% -> 60%, ..., 100% -> 100%
    payoutPercentage = 50 + (achievement - 90) * 5;
  } else if (achievement <= 120) {
    // 101% -> 101.5%, ..., 120% -> 130%
    payoutPercentage = 100 + (achievement - 100) * 1.5;
  } else {
    // Above 120%
    // 121% -> 133%, ..., 150% -> capped at 150%
    payoutPercentage = 130 + (achievement - 120) * 3;
  }

  // Enforce final payout cap at 150%.
  payoutPercentage = Math.min(150, payoutPercentage);
  
  const payoutAmount = (semesterTargetIncentive * payoutPercentage) / 100;
  
  return {
    netSalary,
    basicSalary,
    semesterTargetIncentive,
    payoutPercentage,
    payoutAmount,
    achievement,
  };
}
