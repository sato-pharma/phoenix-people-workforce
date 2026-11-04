// What the page receives, and the words it shows. No Supabase here, so a client component imports it.
//
// 🔴 TWO SHAPES, ON PURPOSE. `MedicalInsuranceView` carries no amount of any kind and is what the HR seats
// get; the HR Operations Specialist seat is salary-blind (`isSalaryBlindRole`). `MedicalInsuranceMoneyView`
// is built only after medical_insurance_invoices:read has passed, so an amount that never leaves the
// server cannot be read out of the page's data.

import type { MedicalInsuranceCategory, MedicalInsuranceMemberType, MedicalInsurancePeriod, PeriodStatement } from "./cost";
import type { InvoiceComparison } from "./compare";
import type { KeptException, MedicalInsuranceAction, MedicalInsuranceMovement, PlannedPerson } from "./eligibility";

export type MedicalInsurancePolicyView = {
  id: string;
  insurer: string;
  policyNumber: string;
  groupCode: string | null;
  subOffice: string | null;
  startsOn: string;
  endsOn: string;
};

export type MedicalInsuranceMemberRow = {
  id: string;
  hrId: string | null;
  memberType: MedicalInsuranceMemberType;
  principalMemberId: string | null;
  principalName: string | null;
  certificateNumber: string | null;
  name: string;
  jobTitle: string | null;
  category: MedicalInsuranceCategory;
  coverageStart: string;
  coverageEnd: string | null;
  endReason: string | null;
  notes: string | null;
  open: boolean;
};

export type MedicalInsuranceEmployeeOption = { hrId: string; name: string; jobTitle: string | null };

export type MedicalInsuranceDocumentKind = "communication_tool" | "form" | "policy" | "email";

export type MedicalInsuranceDocumentRow = {
  id: string;
  kind: MedicalInsuranceDocumentKind;
  title: string;
  fileName: string | null;
  sizeBytes: number | null;
  emailFrom: string | null;
  emailTo: string | null;
  emailSentOn: string | null;
  body: string | null;
  note: string | null;
  uploadedAt: string;
  uploadedByName: string | null;
};

export type MedicalInsuranceCounts = {
  covered: number;
  coveredEmployees: number;
  coveredFamily: number;
  addNow: number;
  addSoon: number;
  removeNow: number;
  removeSoon: number;
  review: number;
  exceptions: number;
};

export type MedicalInsuranceView = {
  asOf: string;
  policy: MedicalInsurancePolicyView;
  counts: MedicalInsuranceCounts;
  actions: MedicalInsuranceAction[];
  exceptions: KeptException[];
  members: MedicalInsuranceMemberRow[];
  movements: MedicalInsuranceMovement[];
  documents: MedicalInsuranceDocumentRow[];
  employees: MedicalInsuranceEmployeeOption[];
};

export type MedicalInsuranceInvoiceRow = {
  id: string;
  billNumber: string;
  issuedOn: string | null;
  periodStart: string;
  periodEnd: string;
  premiumTotal: number;
  feesTotal: number;
  totalDue: number;
  fileName: string;
  uploadedAt: string;
  comparedAt: string;
  comparison: InvoiceComparison;
};

export type MedicalInsuranceMoneyView = {
  period: MedicalInsurancePeriod;
  plan: {
    statement: PeriodStatement;
    people: PlannedPerson[];
    unpriced: number;
    prorated: number;
  };
  yearEstimate: number;
  invoices: MedicalInsuranceInvoiceRow[];
  documents: MedicalInsuranceDocumentRow[];
};

export const MEDICAL_INSURANCE_DOCUMENT_WORDS: Record<MedicalInsuranceDocumentKind, string> = {
  communication_tool: "Communication tool",
  email: "Email",
  form: "Form",
  policy: "Policy",
};

export const MEMBER_TYPE_WORDS: Record<MedicalInsuranceMemberType, string> = {
  child: "Child",
  employee: "Employee",
  spouse: "Spouse",
};

/**
 * What the policy leaves open and the insurer has not yet answered. Shown beside the cost, because the
 * first of these is what the plan has to assume, and the rest are what a claim or a bill may turn on.
 */
export const MEDICAL_INSURANCE_OPEN_POINTS: readonly string[] = [
  "No clause sets a refund for someone who leaves, or a charge for someone who joins, part-way through a billing period. This plan charges both by the day until the insurer confirms.",
  "The clauses on maternity contradict each other.",
  "Incubator cover for categories B and C is unclear.",
  "The natural-disaster exclusion needs the insurer's reading.",
  "The physiotherapy referral condition needs the insurer's reading.",
  "The policy gives both 60 and 65 as an age limit.",
  "Article 10 allows amounts to be billed back with no cap.",
  "The policy ends on 3 November 2027, and the medical cards say 31 October 2027.",
  "An EGP 350 charge on the first invoice does not appear in the policy's fee table.",
];

export function coveragePeriodWords(start: string, end: string | null, formatDay: (day: string) => string): string {
  return end ? `${formatDay(start)} to ${formatDay(end)}` : `From ${formatDay(start)}`;
}

export function monthWords(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return month;
  return new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC", year: "numeric" }).format(date);
}

export function egpWords(value: number): string {
  return `EGP ${value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}
