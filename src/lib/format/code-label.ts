// A stored code, written as words a person reads.
//
// The owner's rule is names, never codes or ids, on every screen. Before this, 71 places in 53
// files showed a stored value as `String(status).replace(/_/g, " ")`, which prints
// "pending manager", "ceo approved" and "kpi review" — lower case, acronyms lost, and still
// visibly a database value. A domain that already owns a label function keeps using it
// (`employmentStatusLabel`, `describeDirectOrderStatus`, `vacationTypeLabel`,
// `validationStatusLabel`, the plan and marketing labels); everything else comes here.
//
// Sentence case, not Title Case: "Pending manager" reads as a phrase, "Pending Manager" reads as a
// value someone ran a regular expression over. A known acronym keeps its own spelling wherever it
// sits. Pure and import-free, so a client component and a server builder share it.

const ACRONYMS: Readonly<Record<string, string>> = {
  ai: "AI",
  am: "AM",
  ats: "ATS",
  ceo: "CEO",
  cfo: "CFO",
  crm: "CRM",
  cv: "CV",
  dm: "DM",
  gps: "GPS",
  gpm: "GPM",
  hr: "HR",
  hq: "HQ",
  id: "ID",
  kpi: "KPI",
  kpis: "KPIs",
  nsm: "NSM",
  ok: "OK",
  otp: "OTP",
  pdf: "PDF",
  pm: "PM",
  rm: "RM",
  roi: "ROI",
  sfe: "SFE",
  sms: "SMS",
  url: "URL",
  vat: "VAT",
};

/**
 * `pending_manager` → "Pending manager", `ceo_approved` → "CEO approved", `kpi-review` →
 * "KPI review". Empty, null and whitespace give "" so a caller can fall back with `||`.
 */
export function humanizeCode(value: string | null | undefined): string {
  const words = String(value ?? "")
    .trim()
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ACRONYMS[word.toLowerCase()] ?? word.toLowerCase());
  if (words.length === 0) return "";
  const [first, ...rest] = words;
  const lead = ACRONYMS[first.toLowerCase()] ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return [lead, ...rest].join(" ");
}

/**
 * A value that may be a stored code or may already be words for people ("Late", "Short day").
 * Words are kept exactly as written; only something that looks like a code — an underscore, or a
 * lower-case first letter — is turned into words.
 */
export function codeOrWords(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (!raw.includes("_") && !/^[a-z]/.test(raw)) return raw;
  return humanizeCode(raw);
}
