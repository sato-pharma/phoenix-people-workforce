/** A single marginal income-tax bracket. `upTo` is the annual EGP ceiling of the
 *  band (null = the top, open-ended band). `rate` is a fraction (0.10 = 10%). */
export type TaxBracket = {
  upTo: number | null;
  rate: number;
};

/** Effective-dated Egyptian statutory parameters (see payroll_statutory_config). */
export type StatutoryConfig = {
  effectiveFrom: string;
  personalExemptionAnnual: number;
  disabledExemptionAnnual: number;
  taxBrackets: TaxBracket[];
  taxableRoundingStep: number;
  siEmployeeRate: number;
  siEmployerRate: number;
  siMinMonthlyWage: number;
  siMaxMonthlyWage: number;
};

export type SocialInsuranceResult = {
  /** Insurance/subject wage after clamping to the statutory min/max. */
  subjectWage: number;
  /** Employee monthly contribution (the payroll deduction). */
  employee: number;
  /** Employer monthly contribution (for statutory reporting, not net pay). */
  employer: number;
};

export type StatutoryResult = {
  socialInsurance: number;
  employerSocialInsurance: number;
  incomeTax: number;
  subjectWage: number;
};
