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
};

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
