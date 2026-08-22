export type HiringPackDocument = "contract" | "form1";

/**
 * The fields HR fills in, which are the ones Phoenix cannot already answer from `employees`.
 * Every one of them is optional: a half-filled pack still prints, because an HR user who is
 * missing a graduation certificate on Tuesday still needs the contract on Tuesday. What a missing
 * value must never do is print a guess — see `HiringPackGap`.
 */
export type HiringPackProfileInput = {
  nationality?: string | null;
  qualification?: string | null;
  birthPlace?: string | null;
  jobTitleAr?: string | null;
  occupationCode?: string | null;
  insuranceOffice?: string | null;
  addressBuilding?: string | null;
  addressDistrict?: string | null;
  addressStreet?: string | null;
  addressMarkaz?: string | null;
  addressGovernorate?: string | null;
  contractDurationMonths?: number | null;
  contractStartDate?: string | null;
  contractEndDate?: string | null;
  underperformanceThresholdPct?: number | null;
  underperformanceMonths?: number | null;
  trainingBondMonths?: number | null;
  notes?: string | null;
};

export type HiringPackProfile = Required<{
  [K in keyof HiringPackProfileInput]: HiringPackProfileInput[K] extends infer V
    ? Exclude<V, undefined>
    : never;
}> & {
  hrId: string;
  contractSignedDate: string | null;
  form1SignedDate: string | null;
  contractPrintedAt: string | null;
  form1PrintedAt: string | null;
  updatedAt: string | null;
};

/**
 * What Phoenix already knows about the person, resolved once so the two templates never reach into
 * the database themselves.
 */
export type HiringPackEmployeeFacts = {
  hrId: string;
  fullName: string;
  nameAr: string | null;
  nationalId: string | null;
  socialInsuranceNumber: string | null;
  socialInsuranceWage: number | null;
  grossSalary: number | null;
  birthDate: string | null;
  hireDate: string | null;
  jobTitle: string | null;
  departmentAr: string | null;
  residenceAddress: string | null;
  residenceCity: string | null;
  mobileNumber: string | null;
  workEmail: string | null;
  employmentStatus: string | null;
};

/**
 * One value the document asks for and nobody has supplied.
 *
 * This exists because the alternative — printing a blank line and hoping somebody notices — is
 * precisely the hand-filled-form failure this feature was built to end. A gap is surfaced in the UI
 * BEFORE printing, and its `blocking` flag separates "the document is legally incomplete without
 * this" from "the office will accept it and you can fill it later".
 */
export type HiringPackGap = {
  field: string;
  labelEn: string;
  labelAr: string;
  document: HiringPackDocument | "both";
  blocking: boolean;
  /** Where the value has to come from, so the reader knows who to chase. */
  source: "employee-record" | "hiring-profile" | "company-settings";
};

/** One row in the employee picker on the fill screen. Deliberately thin — it is a chooser, not a record. */
export type HiringPackCandidate = {
  hrId: string;
  fullName: string;
  nameAr: string | null;
  jobTitle: string | null;
  hireDate: string | null;
};

export type HiringPackData = {
  employee: HiringPackEmployeeFacts;
  profile: HiringPackProfile;
  gaps: HiringPackGap[];
  /** Resolved terms — the profile override where present, the company default otherwise. */
  terms: {
    durationMonths: number;
    probationMonths: number;
    underperformanceThresholdPct: number;
    underperformanceMonths: number;
    trainingBondMonths: number;
    contractStartDate: string | null;
    contractEndDate: string | null;
  };
};

export type MarkHiringPackSignedInput = {
  hrId: string;
  document: HiringPackDocument;
  /** The date written on the paper. Not the moment the button was pressed. */
  signedDate: string;
  actorHrId?: string | null;
};
