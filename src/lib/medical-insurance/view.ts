// What the page receives, and the words it shows. No Supabase here, so a client component imports it.
//
// 🔴 TWO SHAPES, ON PURPOSE. `MedicalInsuranceView` carries no amount of any kind and is what the HR seats
// get; the HR Operations Specialist seat is salary-blind (`isSalaryBlindRole`). `MedicalInsuranceMoneyView`
// is built only after medical_insurance_invoices:read has passed, so an amount that never leaves the
// server cannot be read out of the page's data.

import type { InvoiceComparison, MedicalInsuranceInvoiceKind } from "./compare";
import type { MedicalInsuranceCategory, MedicalInsuranceMemberType, MedicalInsuranceRateCard } from "./cost";
import type { KeptException, MedicalInsuranceAction, MedicalInsuranceMovement, PolicyYearCost } from "./eligibility";

export type MedicalInsurancePolicyView = {
  id: string;
  insurer: string;
  /** Issued by the insurer with the policy; null until then. */
  policyNumber: string | null;
  proposalCode: string | null;
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
  staffNumber: string | null;
  name: string;
  jobTitle: string | null;
  category: MedicalInsuranceCategory;
  /** The member's own, else their employee record's. */
  birthDate: string | null;
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
  invoiceNumber: string;
  kind: MedicalInsuranceInvoiceKind;
  issuedOn: string | null;
  coversFrom: string | null;
  coversTo: string | null;
  totalDue: number;
  fileName: string | null;
  note: string | null;
  recordedAt: string;
  comparedAt: string;
  comparison: InvoiceComparison;
};

export type MedicalInsuranceMoneyView = {
  rateCard: MedicalInsuranceRateCard;
  year: PolicyYearCost;
  invoices: MedicalInsuranceInvoiceRow[];
  documents: MedicalInsuranceDocumentRow[];
};

export const MEDICAL_INSURANCE_DOCUMENT_WORDS: Record<MedicalInsuranceDocumentKind, string> = {
  communication_tool: "Communication tool",
  email: "Email",
  form: "Form",
  policy: "Policy",
};

/** The reason an exclusion is saved with unless another is typed: medical insurance is optional (owner, 2026-11-17). */
export const DECLINED_REASON = "Does not want medical insurance";

export const MEMBER_TYPE_WORDS: Record<MedicalInsuranceMemberType, string> = {
  child: "Child",
  employee: "Employee",
  spouse: "Spouse",
};

export function policyNumberWords(policy: Pick<MedicalInsurancePolicyView, "policyNumber" | "proposalCode">): string {
  if (policy.policyNumber) return `policy ${policy.policyNumber}`;
  return policy.proposalCode ? `proposal ${policy.proposalCode}, policy number not issued yet` : "policy number not issued yet";
}

/**
 * What the contract leaves open, and so what the cost has to assume until Libano-Suisse answers. Shown
 * beside the cost, because every figure on the tab rests on these.
 */
export const MEDICAL_INSURANCE_OPEN_POINTS: readonly string[] = [
  "The age that picks a person's band is taken on the day their cover starts. The offer does not say which day it means.",
  "A joiner is charged the 1.55% tax and the EGP 30 card on top of the premium, and a leaver's refund gives back the tax but not the card. The offer states the fees only for the opening bill.",
  "A leaver is refunded by the day from the day after their last covered day, whether or not the card was used, as the offer says. A person removed because they were never an employee on the policy dates is refunded from the first day.",
  "Bands the offer did not quote (for example Plan A under 25, or anyone 65 and over) have no rate. Anyone in one is counted but not priced until Libano-Suisse quotes it.",
  "An employee or spouse over 64 needs a health statement, and conditions from before the policy are not covered. A child is covered up to 18.",
  "The policy number is issued with the policy. Until then the proposal, Rev 1.3, stands in for it.",
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
