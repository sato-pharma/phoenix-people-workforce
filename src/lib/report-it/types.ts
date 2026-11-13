// ─── Reaction block ────────────────────────────────────────────────────────

export type SeriousnessReason =
  | "Life threatening"
  | "Death"
  | "Caused/prolonged hospitalisation"
  | "Disabling/incapacitating"
  | "Congenital anomaly/birth defect"
  | "Other medically important condition";

export type ReactionOutcome =
  | "Recovered/Resolved"
  | "Recovering/Resolving"
  | "Not Recovered/Not Resolved"
  | "Recovered with some lasting effects"
  | "Fatal"
  | "Unknown";

export type AgeUnit = "Year" | "Month" | "Week" | "Day" | "Hour";
export type DurationUnit = "Year" | "Month" | "Week" | "Day" | "Hour" | "Minute" | "Second";

export type ReactionBlock = {
  id: string;
  symptom: string;
  startDate: { day: string; month: string; year: string };
  endDate: { day: string; month: string; year: string };
  duration: string;
  durationUnit: DurationUnit | "";
  outcome: ReactionOutcome | "";
  isSerious: "Yes" | "No" | "";
  seriousnessReasons: SeriousnessReason[];
};

// ─── Medicine block ─────────────────────────────────────────────────────────

export type AdminRoute =
  | "Oral"
  | "Injection into vein (Intravenous)"
  | "Injection into muscle (Intramuscular)"
  | "Injection under skin (Subcutaneous)"
  | "Inhalation (Respiratory)"
  | "Into eye (Ophthalmic)"
  | "Nasal"
  | "Rectal"
  | "Topical"
  | "Vaginal"
  | "Other"
  | "Unknown";

export type MedicineActionTaken =
  | "Stopped taking the medicine"
  | "Dose reduced"
  | "Dose increased"
  | "Dose not changed"
  | "Unknown"
  | "Not applicable";

export type MedicineBlock = {
  id: string;
  name: string;
  probablyCausingReaction: boolean;
  producer: string;
  batchNumber: string;
  dosage: string;
  adminRoute: AdminRoute | "";
  startDate: { day: string; month: string; year: string };
  endDate: { day: string; month: string; year: string };
  duration: string;
  durationUnit: DurationUnit | "";
  reasonForTaking: string;
  actionTaken: MedicineActionTaken | "";
};

// ─── Full form payload ──────────────────────────────────────────────────────

export type ReportItPayload = {
  patientInitials: string;
  patientSex: "Male" | "Female" | "Unknown" | "";
  isPregnant: boolean;
  isLactating: boolean;
  weight: string;
  dateOfBirth: { day: string; month: string; year: string };
  ageAtReaction: string;
  ageUnit: AgeUnit | "";
  country: string;
  reactions: ReactionBlock[];
  medicines: MedicineBlock[];
  currentIllnesses: string;
  additionalComments: string;
};

// ─── DB row shape (snake_case) ──────────────────────────────────────────────

export type ReportItReportRow = {
  id: string;
  report_number: string;
  submitted_by_hr_id: string | null;
  submitted_by_name: string | null;
  submitted_by_role: string | null;
  department: string | null;
  line: string | null;
  area: string | null;
  patient_initials: string | null;
  patient_sex: string | null;
  patient_country: string;
  is_serious: boolean;
  outcome_summary: string | null;
  suspected_medicines: string[];
  reactions_summary: string[];
  report_payload: ReportItPayload;
  status: string;
  created_at: string;
  updated_at: string;
  // The lifecycle (REC-033, 13 Nov 2026) — optional because a row read before the migration lacks them.
  assessment_started_at?: string | null;
  assessed_by_hr_id?: string | null;
  closed_at?: string | null;
  closed_by_hr_id?: string | null;
  due_at?: string | null;
};

// ─── The lifecycle ──────────────────────────────────────────────────────────

/**
 * A report is received, then under assessment, then closed (owner, 13 Nov 2026). The database
 * allows exactly these three (`report_it_reports_status_check`); the old `submitted` became
 * `received` in the migration that added them.
 */
export const REPORT_IT_STATUSES = ["received", "under_assessment", "closed"] as const;
export type ReportItStatus = (typeof REPORT_IT_STATUSES)[number];

export const REPORT_IT_STATUS_LABELS: Record<ReportItStatus, string> = {
  received: "Received",
  under_assessment: "Under assessment",
  closed: "Closed",
};

/** The words for any stored status, including one written before the lifecycle existed. */
export function reportItStatusLabel(status: string | null | undefined): string {
  const key = String(status ?? "").trim().toLowerCase();
  if (key === "submitted") return REPORT_IT_STATUS_LABELS.received;
  return (REPORT_IT_STATUS_LABELS as Record<string, string>)[key] ?? (key ? key.replace(/_/g, " ") : "—");
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export const REACTION_OUTCOMES: ReactionOutcome[] = [
  "Recovered/Resolved",
  "Recovering/Resolving",
  "Not Recovered/Not Resolved",
  "Recovered with some lasting effects",
  "Fatal",
  "Unknown",
];

export const SERIOUSNESS_REASONS: SeriousnessReason[] = [
  "Life threatening",
  "Death",
  "Caused/prolonged hospitalisation",
  "Disabling/incapacitating",
  "Congenital anomaly/birth defect",
  "Other medically important condition",
];

export const ADMIN_ROUTES: AdminRoute[] = [
  "Oral",
  "Injection into vein (Intravenous)",
  "Injection into muscle (Intramuscular)",
  "Injection under skin (Subcutaneous)",
  "Inhalation (Respiratory)",
  "Into eye (Ophthalmic)",
  "Nasal",
  "Rectal",
  "Topical",
  "Vaginal",
  "Other",
  "Unknown",
];

export const MEDICINE_ACTIONS: MedicineActionTaken[] = [
  "Stopped taking the medicine",
  "Dose reduced",
  "Dose increased",
  "Dose not changed",
  "Unknown",
  "Not applicable",
];

export const AGE_UNITS: AgeUnit[] = ["Year", "Month", "Week", "Day", "Hour"];
export const DURATION_UNITS: DurationUnit[] = ["Year", "Month", "Week", "Day", "Hour", "Minute", "Second"];
