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
    snapshot: row.snapshot && typeof row.snapshot === "object" ? (row.snapshot as Record<string, unknown>) : {},
    generatedBy: textOrNull(row.generated_by),
    generatedAt: String(row.generated_at ?? ""),
  };
}

export async function generateOfferLetter(access: AccessContext, offerId: string): Promise<OfferLetterVersion> {
  const supabase = recruitmentDb();
  const { data: offer, error } = await supabase
    .from("job_offers")
    .select(
      "id,offer_code,candidate_name,job_title,base_salary,net_salary,gross_salary,fuel_allowance,start_date,expires_at,application_id",
    )
    .eq("id", offerId)
    .maybeSingle();
  if (error) throw error;
  if (!offer) throw new Error("Offer not found.");

  const { data: latest, error: versionError } = await supabase
    .from("recruitment_offer_letters")
    .select("version")
    .eq("offer_id", offerId)
    .order("version", { ascending: false })
    .limit(1);
  if (versionError) throw versionError;
  const nextVersion = (numberOrNull(latest?.[0]?.version) ?? 0) + 1;

  const snapshot = {
    offerCode: textOrNull(offer.offer_code),
    candidateName: textOrNull(offer.candidate_name),
    jobTitle: textOrNull(offer.job_title),
    baseSalary: numberOrNull(offer.base_salary),
    netSalary: numberOrNull(offer.net_salary),
    grossSalary: numberOrNull(offer.gross_salary),
    fuelAllowance: numberOrNull(offer.fuel_allowance),
    startDate: textOrNull(offer.start_date),
    expiresAt: textOrNull(offer.expires_at),
  };

  const { data, error: insertError } = await supabase
    .from("recruitment_offer_letters")
    .insert({
      offer_id: offerId,
      application_id: textOrNull(offer.application_id),
      version: nextVersion,
      snapshot,
      generated_by: access.hrId ?? access.loginId ?? null,
    })
    .select("*")
    .single();
  if (insertError) throw insertError;
  return mapVersion(data as Record<string, unknown>);
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
<style>
  :root { color-scheme: light; }
  body { font-family: Arial, Helvetica, sans-serif; color: #0f172a; margin: 0; background: #f1f5f9; }
  .sheet { max-width: 720px; margin: 24px auto; background: #fff; padding: 48px; box-shadow: 0 2px 12px rgba(15,23,42,.12); }
  .brand { font-size: 22px; font-weight: 800; color: #ea580c; }
  .muted { color: #64748b; font-size: 12px; }
  h1 { font-size: 18px; margin: 24px 0 8px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { border: 1px solid #e2e8f0; padding: 8px 10px; text-align: left; font-size: 14px; }
  th { background: #f8fafc; width: 45%; }
  .toolbar { max-width: 720px; margin: 16px auto 0; text-align: right; }
  button { background: #ea580c; color: #fff; border: 0; padding: 10px 16px; font-size: 14px; cursor: pointer; }
  @media print { body { background: #fff; } .sheet { box-shadow: none; margin: 0; max-width: none; } .toolbar { display: none; } }
</style>
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
      <tr><th>Start date</th><td>${startDate}</td></tr>
      <tr><th>Base salary</th><td>${money(s.baseSalary)}</td></tr>
      <tr><th>Net salary</th><td>${money(s.netSalary)}</td></tr>
      <tr><th>Gross salary</th><td>${money(s.grossSalary)}</td></tr>
      <tr><th>Fuel allowance</th><td>${money(s.fuelAllowance)}</td></tr>
    </table>
    <p>This offer is subject to the completion of pre-boarding documentation and verification. We look forward to welcoming you to the team.</p>
    <p style="margin-top:32px">Sincerely,<br/>${brand} — People &amp; Talent</p>
  </div>
</body>
</html>`;
}
