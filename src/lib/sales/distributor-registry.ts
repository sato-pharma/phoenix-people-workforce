import {
  codedSystemChannelSummary,
  isCodedSystemChannel,
  loadSalesReferenceData,
} from "@/lib/sales/monthly-distributor-import";
import { OFFICE_DISTRIBUTOR_CODE } from "@/lib/sales/office-allocation";
import { listMergedDistributorProfiles, resolveDistributorProfile } from "@/lib/sales/normalizer/distributor-profile-store";
import { rawProfileForDistributor } from "@/lib/sales/normalizer/profiles";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import type { DistributorProfile } from "@/lib/sales/normalizer/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  WEEKLY_DISTRIBUTORS,
  isWeeklyDistributorCode,
  weeklyDistributorByCode,
  type WeeklyCadence,
} from "@/lib/sales/weekly/distributors";

// ── Unified Sales Intelligence Registry ───────────────────────────────────────────────────────
// THE single authoritative source every sales workflow consumes for "what distributors exist and
// what they support". No page/route/service should keep its own distributor config. It unifies:
//   • distributor identities    → source_of_sales_distributors (master)
//   • monthly recognition       → RAW_DISTRIBUTOR_PROFILES + DB profile overrides
//   • weekly support + cadence  → WEEKLY_DISTRIBUTORS registry
//   • profile column mapping     → resolveDistributorProfile (for the profile viewer)
// (Health, readiness and certification are layered on in workstream C; their types live there.)

export type SalesDistributorEntry = {
  code: string;
  name: string;
  monthlySupported: boolean; // has a raw normalizer profile (recognizable monthly sheet)
  weeklySupported: boolean; // present in the weekly registry
  weeklyCadence: WeeklyCadence | null;
  separateSalesStockFiles: boolean; // PS ships separate sales + stock files
  hasProfile: boolean; // a raw distributor profile exists
};

export type DistributorProfileSummary = {
  distributorCode: string;
  distributorName: string;
  productColumns: string[];
  customerCodeColumns: string[];
  customerNameColumns: string[];
  quantityColumns: string[];
  dateColumns: string[];
  territoryColumns: string[];
  discountColumns: string[];
  bonusColumns: string[];
  valueSource: "recompute" | "sheet";
  hasDateColumn: boolean; // false → the sheet carries no date, so a period must be picked (e.g. CP)
  regionOnly: boolean;
};

export type SalesDistributorMasterRow = { code: string; name: string };

// Pure merge of the three sources into one entry list, keyed by canonical (uppercased) code.
// Union of master distributors + profiled distributors so neither side can hide a distributor; the
// display name prefers the master, then the profile/weekly fallback.
export function buildSalesDistributorEntries(
  masterDistributors: SalesDistributorMasterRow[],
  profiledCodes: Set<string>,
): SalesDistributorEntry[] {
  const byCode = new Map<string, SalesDistributorEntry>();

  const upsert = (rawCode: string, name: string) => {
    const code = normalizeCodeKey(rawCode);
    if (!code) return;
    const weekly = weeklyDistributorByCode(code);
    const existing = byCode.get(code);
    const resolvedName = name || existing?.name || weekly?.name || code;
    byCode.set(code, {
      code,
      name: resolvedName,
      monthlySupported: profiledCodes.has(code),
      weeklySupported: Boolean(weekly),
      weeklyCadence: weekly?.cadence ?? null,
      separateSalesStockFiles: Boolean(weekly?.separateSalesStockFiles),
      hasProfile: profiledCodes.has(code),
    });
  };

  for (const row of masterDistributors) upsert(row.code, row.name);
  for (const code of profiledCodes) {
    if (!byCode.has(code)) upsert(code, rawProfileForDistributor(code)?.distributorName ?? "");
  }
  // Weekly-only distributors must still appear even if absent from the master/profiles.
  for (const weekly of WEEKLY_DISTRIBUTORS) {
    const code = normalizeCodeKey(weekly.code);
    if (!byCode.has(code)) upsert(weekly.code, weekly.name);
  }

  return [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
}

// Pure projection of a normalizer profile into the read-only "what Phoenix reads in this file" view.
export function summarizeProfile(profile: DistributorProfile): DistributorProfileSummary {
  const dateColumns = profile.dateColumns ?? [];
  return {
    distributorCode: profile.distributorCode,
    distributorName: profile.distributorName,
    productColumns: profile.productColumns ?? [],
    customerCodeColumns: profile.customerCodeColumns ?? [],
    customerNameColumns: profile.customerNameColumns ?? [],
    quantityColumns: profile.qtyColumns ?? [],
    dateColumns,
    territoryColumns: profile.territoryColumns ?? [],
    discountColumns: profile.discountColumns ?? [],
    bonusColumns: profile.bonusColumns ?? [],
    valueSource: profile.valueSource,
    hasDateColumn: dateColumns.length > 0,
    regionOnly: Boolean(profile.regionOnly),
  };
}

// Every distributor the Sales module knows, with monthly/weekly support flags. Reads the master
// distributor list (DB) and unions it with the MERGED profiles (code ∪ DB overrides) + weekly registry,
// so an in-app edited/onboarded distributor shows up in every dropdown with its saved name.
export async function listSalesDistributors(): Promise<SalesDistributorEntry[]> {
  const [refs, mergedProfiles] = await Promise.all([
    loadSalesReferenceData({ includeCustomerBricks: false }),
    listMergedDistributorProfiles(),
  ]);
  const master: SalesDistributorMasterRow[] = [
    ...(refs.distributors ?? []).map((d) => ({ code: d.code, name: d.name })),
    ...mergedProfiles.map((p) => ({ code: p.distributorCode, name: p.distributorName })),
  ];
  const profiledCodes = new Set(mergedProfiles.map((p) => normalizeCodeKey(p.distributorCode)));
  // Coded system channels (Direct) and the Office allocation channel have no raw normalizer profile,
  // but ARE monthly-uploadable — mark them supported so the upload hub enables file pick + validate.
  for (const row of master) {
    if (isCodedSystemChannel(row.code)) profiledCodes.add(normalizeCodeKey(row.code));
    if (normalizeCodeKey(row.code) === normalizeCodeKey(OFFICE_DISTRIBUTOR_CODE)) profiledCodes.add(normalizeCodeKey(row.code));
  }
  return buildSalesDistributorEntries(master, profiledCodes);
}

export async function getDistributor(code: string): Promise<SalesDistributorEntry | null> {
  const key = normalizeCodeKey(code);
  if (!key) return null;
  const all = await listSalesDistributors();
  return all.find((d) => d.code === key) ?? null;
}

// Re-exported from the weekly registry so callers have ONE place to ask "is this weekly-applicable?".
export const isWeeklyDistributor = isWeeklyDistributorCode;

// DB-first profile summary for the distributor profile viewer (honors saved overrides). For a coded
// system channel (Direct) there is no raw profile — synthesize the "what the system reads" view from
// the coded template so the upload hub enables and the viewer shows the real columns.
export async function getDistributorProfileSummary(code: string): Promise<DistributorProfileSummary | null> {
  const profile = await resolveDistributorProfile(code);
  if (profile) return summarizeProfile(profile);
  const coded = codedSystemChannelSummary(code);
  if (coded) {
    return {
      distributorCode: normalizeCodeKey(code),
      distributorName: normalizeCodeKey(code),
      productColumns: coded.productColumns,
      customerCodeColumns: [],
      customerNameColumns: coded.customerNameColumns,
      quantityColumns: coded.quantityColumns,
      dateColumns: coded.dateColumns,
      territoryColumns: coded.territoryColumns,
      discountColumns: [],
      bonusColumns: [],
      valueSource: coded.valueSource,
      hasDateColumn: coded.hasDateColumn,
      regionOnly: coded.regionOnly,
    };
  }
  // Office pivot: product name + total units, no geography, no date column — period is always required.
  if (normalizeCodeKey(code) === normalizeCodeKey(OFFICE_DISTRIBUTOR_CODE)) {
    return {
      distributorCode: normalizeCodeKey(code),
      distributorName: "Marcyrl",
      productColumns: ["Row Labels"],
      customerCodeColumns: [],
      customerNameColumns: [],
      quantityColumns: ["Sum of المبيعات"],
      dateColumns: [],
      territoryColumns: [],
      discountColumns: [],
      bonusColumns: [],
      valueSource: "recompute",
      hasDateColumn: false,
      regionOnly: false,
    };
  }
  return null;
}

// ── C6: distributor health + readiness (computed from existing tables; no new schema) ──
export type DistributorHealth = {
  distributorCode: string;
  hasProfile: boolean;
  customerMappings: number;
  productAliases: number;
  lastMonthlyPeriod: string | null;
  lastMonthlyRows: number | null;
  lastWeeklyWeek: string | null;
};

export type ReadinessBand = "Healthy" | "Attention" | "High-Risk";
export type DistributorReadiness = { score: number; band: ReadinessBand };

// Active-row count for one distributor; tolerant of a missing table (returns 0).
async function activeCount(table: string, dist: string): Promise<number> {
  try {
    const supabase = getSupabaseAdmin();
    const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true }).eq("distributor_code", dist).eq("active", true);
    return error ? 0 : (count ?? 0);
  } catch { return 0; }
}

export async function getDistributorHealth(code: string): Promise<DistributorHealth> {
  const dist = normalizeCodeKey(code);
  const hasProfile = Boolean(rawProfileForDistributor(dist));
  const supabase = getSupabaseAdmin();

  const [customerMappings, productAliases] = await Promise.all([
    activeCount("source_of_sales_customer_map", dist),
    activeCount("source_of_sales_product_aliases", dist),
  ]);

  let lastMonthlyPeriod: string | null = null;
  let lastMonthlyRows: number | null = null;
  try {
    const { data } = await supabase
      .from("source_of_sales_import_batches")
      .select("period,total_rows,created_at")
      .eq("distributor_code", dist)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) { lastMonthlyPeriod = (data as { period: string | null }).period ?? null; lastMonthlyRows = Number((data as { total_rows: number | null }).total_rows ?? 0) || null; }
  } catch { /* tolerate */ }

  let lastWeeklyWeek: string | null = null;
  try {
    const { data } = await supabase
      .from("weekly_sales_batches")
      .select("week_start,created_at")
      .eq("distributor_code", dist)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) lastWeeklyWeek = (data as { week_start: string | null }).week_start ?? null;
  } catch { /* tolerate */ }

  return { distributorCode: dist, hasProfile, customerMappings, productAliases, lastMonthlyPeriod, lastMonthlyRows, lastWeeklyWeek };
}

export function readinessFromHealth(h: DistributorHealth): DistributorReadiness {
  let score = 0;
  if (h.hasProfile) score += 40;
  if (h.customerMappings > 0) score += 30;
  if (h.productAliases > 0) score += 15;
  if (h.lastMonthlyPeriod || h.lastWeeklyWeek) score += 15;
  const band: ReadinessBand = score >= 85 ? "Healthy" : score >= 55 ? "Attention" : "High-Risk";
  return { score, band };
}

export async function getDistributorReadiness(code: string): Promise<DistributorReadiness> {
  return readinessFromHealth(await getDistributorHealth(code));
}

// C4: certification status (display only — no import gate yet). Defaults to "Draft" when the table
// is absent or the distributor has no row, so it is safe to read everywhere.
export type CertificationStatus = "Draft" | "Testing" | "Certified" | "Production Ready";
export async function getCertificationStatus(code: string): Promise<CertificationStatus> {
  const dist = normalizeCodeKey(code);
  if (!dist) return "Draft";
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("source_of_sales_distributor_certification")
      .select("status")
      .eq("distributor_code", dist)
      .maybeSingle();
    if (error || !data) return "Draft";
    const status = String((data as { status: string }).status ?? "Draft");
    return (["Draft", "Testing", "Certified", "Production Ready"].includes(status) ? status : "Draft") as CertificationStatus;
  } catch { return "Draft"; }
}
