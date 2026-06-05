// Recruitment / ATS — Phase 4c offer-letter generation + versioning.
//
// Generates a versioned snapshot of the offer terms and renders a print-ready
// HTML letter (the user saves it as PDF from the browser — no PDF dependency).
// Gated on the `offers` resource at the route layer (salary data).

import { systemIdentity } from "@/config/system-settings";
import type { AccessContext } from "@/lib/auth/permissions";
import { numberOrNull, recruitmentDb, textOrNull } from "@/lib/recruitment/db";

export type OfferLetterVersion = {
  id: string;
  offerId: string;
  applicationId: string | null;
  version: number;
  kind: string;
  snapshot: Record<string, unknown>;
  generatedBy: string | null;
  generatedAt: string;
};

function mapVersion(row: Record<string, unknown>): OfferLetterVersion {
  return {
    id: String(row.id),
    offerId: String(row.offer_id),
    applicationId: textOrNull(row.application_id),
    version: numberOrNull(row.version) ?? 0,
    kind: textOrNull(row.kind) ?? "offer_letter",
    snapshot: row.snapshot && typeof row.snapshot === "object" ? (row.snapshot as Record<string, unknown>) : {},
    generatedBy: textOrNull(row.generated_by),
    generatedAt: String(row.generated_at ?? ""),
  };
}

// Next shared version number for an offer (letter + salary summary share a version).
export async function nextOfferLetterVersion(offerId: string): Promise<number> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_offer_letters")
    .select("version")
    .eq("offer_id", offerId)
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (numberOrNull(data?.[0]?.version) ?? 0) + 1;
}

export async function generateOfferLetter(
  access: AccessContext,
  offerId: string,
  options: { kind?: string; version?: number } = {},
): Promise<OfferLetterVersion> {
  const supabase = recruitmentDb();
  const { data: offer, error } = await supabase
    .from("job_offers")
    .select(
      "id,offer_code,candidate_name,job_title,base_salary,basic_salary,net_salary,gross_salary,fuel_allowance,extra_cost_of_living,social_insurance,taxes,benefits,probation_period_months,area_scope,manager_hr_id,start_date,expires_at,application_id",
    )
    .eq("id", offerId)
    .maybeSingle();
  if (error) throw error;
  if (!offer) throw new Error("Offer not found.");

  const kind = textOrNull(options.kind) ?? "offer_letter";
  const version = options.version ?? (await nextOfferLetterVersion(offerId));

  const snapshot = {
    offerCode: textOrNull(offer.offer_code),
    candidateName: textOrNull(offer.candidate_name),
    jobTitle: textOrNull(offer.job_title),
    baseSalary: numberOrNull(offer.base_salary),
    basicSalary: numberOrNull(offer.basic_salary),
    netSalary: numberOrNull(offer.net_salary),
    grossSalary: numberOrNull(offer.gross_salary),
    fuelAllowance: numberOrNull(offer.fuel_allowance),
    extraCostOfLiving: numberOrNull(offer.extra_cost_of_living),
    socialInsurance: numberOrNull(offer.social_insurance),
    taxes: numberOrNull(offer.taxes),
    probationPeriodMonths: numberOrNull(offer.probation_period_months),
    areaScope: textOrNull(offer.area_scope),
    managerHrId: textOrNull(offer.manager_hr_id),
    benefits: Array.isArray(offer.benefits) ? offer.benefits : [],
    startDate: textOrNull(offer.start_date),
    expiresAt: textOrNull(offer.expires_at),
  };

  const { data, error: insertError } = await supabase
    .from("recruitment_offer_letters")
    .insert({
      offer_id: offerId,
      application_id: textOrNull(offer.application_id),
      version,
      kind,
      snapshot,
      generated_by: access.hrId ?? access.loginId ?? null,
    })
    .select("*")
    .single();
  if (insertError) throw insertError;
  return mapVersion(data as Record<string, unknown>);
}

// Salary summary — a separate generated document sharing the offer-letter version.
export async function generateSalarySummary(
  access: AccessContext,
  offerId: string,
  version: number,
): Promise<OfferLetterVersion> {
  return generateOfferLetter(access, offerId, { kind: "salary_summary", version });
}

export async function listOfferLetterVersions(offerId: string): Promise<OfferLetterVersion[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_offer_letters")
    .select("*")
    .eq("offer_id", offerId)
    .order("version", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(mapVersion);
}

export async function getOfferLetterVersion(versionId: string): Promise<OfferLetterVersion | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_offer_letters")
    .select("*")
    .eq("id", versionId)
    .maybeSingle();
  if (error) throw error;
  return data ? mapVersion(data as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Pure print-ready HTML rendering.
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `EGP ${n.toLocaleString("en-US")}` : "—";
}

function probationText(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return `${n} month${n === 1 ? "" : "s"}`;
}

function benefitsRows(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "<li>As per company policy</li>";
  const rows = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const label = String(record.label ?? "").trim();
    if (!label) return [];
    const detail = String(record.detail ?? "").trim();
    return [`<li>${escapeHtml(label)}${detail ? ` — ${escapeHtml(detail)}` : ""}</li>`];
  });
  return rows.length > 0 ? rows.join("") : "<li>As per company policy</li>";
}

const SHEET_STYLE = `
  :root { color-scheme: light; }
  body { font-family: Arial, Helvetica, sans-serif; color: #0f172a; margin: 0; background: #f1f5f9; }
  .sheet { max-width: 720px; margin: 24px auto; background: #fff; padding: 48px; box-shadow: 0 2px 12px rgba(15,23,42,.12); }
  .brand { font-size: 22px; font-weight: 800; color: #ea580c; }
  .muted { color: #64748b; font-size: 12px; }
  h1 { font-size: 18px; margin: 24px 0 8px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { border: 1px solid #e2e8f0; padding: 8px 10px; text-align: left; font-size: 14px; }
  th { background: #f8fafc; width: 45%; }
  ul { font-size: 14px; padding-left: 20px; }
  .toolbar { max-width: 720px; margin: 16px auto 0; text-align: right; }
  button { background: #ea580c; color: #fff; border: 0; padding: 10px 16px; font-size: 14px; cursor: pointer; }
  @media print { body { background: #fff; } .sheet { box-shadow: none; margin: 0; max-width: none; } .toolbar { display: none; } }`;

function text(value: unknown, fallback = "—"): string {
  const trimmed = String(value ?? "").trim();
  return trimmed ? escapeHtml(trimmed) : fallback;
}

export function renderOfferLetterHtml(version: OfferLetterVersion): string {
  const s = version.snapshot;
  const brand = escapeHtml(systemIdentity.appName);
  const candidate = text(s.candidateName, "Candidate");
  const jobTitle = text(s.jobTitle, "the role");
  const offerCode = text(s.offerCode, "");
  const startDate = text(s.startDate, "to be confirmed");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Offer Letter ${offerCode} — v${version.version}</title>
<style>${SHEET_STYLE}</style>
</head>
<body>
  <div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div>
  <div class="sheet">
    <div class="brand">${brand}</div>
    <div class="muted">Offer reference ${offerCode} &middot; Version ${version.version} &middot; Generated ${text(version.generatedAt)}</div>
    <h1>Employment Offer</h1>
    <p>Dear ${candidate},</p>
    <p>We are pleased to offer you the position of <strong>${jobTitle}</strong> at ${brand}. The proposed terms of your employment are summarised below.</p>
    <table>
      <tr><th>Position</th><td>${jobTitle}</td></tr>
      <tr><th>Area / territory</th><td>${text(s.areaScope)}</td></tr>
      <tr><th>Reporting manager</th><td>${text(s.managerHrId)}</td></tr>
      <tr><th>Start date</th><td>${startDate}</td></tr>
      <tr><th>Probation period</th><td>${probationText(s.probationPeriodMonths)}</td></tr>
      <tr><th>Base salary</th><td>${money(s.baseSalary)}</td></tr>
      <tr><th>Basic salary</th><td>${money(s.basicSalary)}</td></tr>
      <tr><th>Net salary</th><td>${money(s.netSalary)}</td></tr>
      <tr><th>Gross salary</th><td>${money(s.grossSalary)}</td></tr>
      <tr><th>Fuel allowance</th><td>${money(s.fuelAllowance)}</td></tr>
      <tr><th>Cost of living</th><td>${money(s.extraCostOfLiving)}</td></tr>
    </table>
    <h1>Benefits</h1>
    <ul>${benefitsRows(s.benefits)}</ul>
    <p>This offer is subject to the completion of pre-boarding documentation and verification. We look forward to welcoming you to the team.</p>
    <p style="margin-top:32px">Sincerely,<br/>${brand} — People &amp; Talent</p>
  </div>
</body>
</html>`;
}

export function renderSalarySummaryHtml(version: OfferLetterVersion): string {
  const s = version.snapshot;
  const brand = escapeHtml(systemIdentity.appName);
  const candidate = text(s.candidateName, "Candidate");
  const jobTitle = text(s.jobTitle, "the role");
  const offerCode = text(s.offerCode, "");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Salary Summary ${offerCode} — v${version.version}</title>
<style>${SHEET_STYLE}</style>
</head>
<body>
  <div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div>
  <div class="sheet">
    <div class="brand">${brand}</div>
    <div class="muted">Salary summary ${offerCode} &middot; Version ${version.version} &middot; Generated ${text(version.generatedAt)}</div>
    <h1>Salary Summary — ${candidate}</h1>
    <p>Proposed compensation for the position of <strong>${jobTitle}</strong>.</p>
    <table>
      <tr><th>Base salary</th><td>${money(s.baseSalary)}</td></tr>
      <tr><th>Basic salary (70%)</th><td>${money(s.basicSalary)}</td></tr>
      <tr><th>Fuel allowance</th><td>${money(s.fuelAllowance)}</td></tr>
      <tr><th>Cost of living</th><td>${money(s.extraCostOfLiving)}</td></tr>
      <tr><th>Social insurance</th><td>${money(s.socialInsurance)}</td></tr>
      <tr><th>Taxes</th><td>${money(s.taxes)}</td></tr>
      <tr><th>Gross salary</th><td>${money(s.grossSalary)}</td></tr>
      <tr><th>Net salary</th><td>${money(s.netSalary)}</td></tr>
    </table>
    <h1>Benefits</h1>
    <ul>${benefitsRows(s.benefits)}</ul>
    <p class="muted">This salary summary accompanies the formal offer letter (reference ${offerCode}).</p>
  </div>
</body>
</html>`;
}
