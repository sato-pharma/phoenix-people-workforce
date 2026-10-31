// The public careers-site applicant COUNTS endpoint — read-only and aggregate.
//
// The Sato Pharma careers register lives in the website's own panel, but every application syncs
// here into the ATS (see app/api/public/apply/route.ts). So the panel has no count of its own to
// show: the truth is in `ats_candidates`. This endpoint returns, per public role, how many people
// have applied for it — and for the field-force roles (Medical Rep, District Manager) it also
// breaks that down by the region and area the applicant chose, exactly the way Phoenix segments
// them (`preferred_region_code` / `preferred_area_name`). The Sato backend reads this server-side
// and fills each panel job's badge.
//
// A candidate counts for a role by the SAME rule the recruitment SQL uses: their stated
// `applied_for_job_title` matches the role, OR they are linked (via an application) to a
// requisition whose title matches. Nothing here returns a name, an email or any per-person field —
// only counts leave this route — which is why it needs neither reCAPTCHA nor the apply rate limit.

import { NextResponse } from "next/server";

import { logError } from "@/lib/observability/log";
import {
  candidateRegionLabels,
  type CandidateRegionCode,
} from "@/lib/recruitment/candidate-region";
import { recruitmentDb } from "@/lib/recruitment/db";
import {
  websiteApplyRoleKeys,
  type WebsiteApplyRoleKey,
} from "@/lib/recruitment/inbound/website-apply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// How a role is recognised in a free-text job title — the regex form of the recruitment SQL's ILIKE
// patterns ('%medical%rep%' → /medical.*rep/i), so this endpoint and a hand-run count agree.
const ROLE_MATCHERS: Record<WebsiteApplyRoleKey, RegExp> = {
  district_manager: /district.*manager/i,
  hr_section_head: /(\bhr\b|human\s*resources?).*section\s*(head|manager|lead|chief)/i,
  medical_representative: /medical.*rep/i,
  national_sales_manager: /national.*sales.*manager/i,
  office_coordinator: /office.*coordinator/i,
  personnel: /personnel/i,
  product_manager: /product.*manager/i,
  quality_control_analyst: /quality.*control/i,
  regulatory_affairs_specialist: /regulatory.*affairs/i,
  talent_acquisition_specialist: /talent.*acquisition/i,
};

// The roles the applicant chooses a working region/area for, so their count carries a breakdown.
const FIELD_FORCE_ROLES: ReadonlySet<WebsiteApplyRoleKey> = new Set([
  "medical_representative",
  "district_manager",
]);

const NONE_REGION = "none";

type CandidateRow = {
  id: string;
  applied_for_job_title: string | null;
  preferred_region_code: string | null;
  preferred_area_name: string | null;
};

type RegionCount = { code: string; label: string; count: number };
type AreaCount = { code: string; region: string; area: string; count: number };
type RoleCount = { total: number; byRegion?: RegionCount[]; byArea?: AreaCount[] };

const DEFAULT_ALLOWED_ORIGINS = ["https://www.satopharma.com", "https://satopharma.com"];

function allowedOrigins(): string[] {
  const configured = process.env.RECRUITMENT_APPLY_ALLOWED_ORIGINS?.trim();
  if (!configured) return DEFAULT_ALLOWED_ORIGINS;
  return configured.split(",").map((origin) => origin.trim()).filter(Boolean);
}

/** CORS echoing the request Origin only when allowlisted. Aggregate-only, but never a blanket "*".
 *  The Sato backend calls this server-side (no Origin), which these headers do not affect. */
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    Vary: "Origin",
  };
  if (origin && allowedOrigins().includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

function json(request: Request, body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { headers: corsHeaders(request), status });
}

export function OPTIONS(request: Request): NextResponse {
  return new NextResponse(null, { headers: corsHeaders(request), status: 204 });
}

/** Every row of a table, in pages — the REST client caps a single select at 1000. */
async function fetchAll<T>(
  table: string,
  columns: string,
): Promise<T[]> {
  const supabase = recruitmentDb();
  const pageSize = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

/** A code's region label, or the shared "no region stated" bucket for a null / un-coded region. */
function regionLabelFor(code: string | null): { code: string; label: string } {
  if (code && code in candidateRegionLabels) {
    return { code, label: candidateRegionLabels[code as CandidateRegionCode] };
  }
  return { code: NONE_REGION, label: "No region stated" };
}

/** GET /api/public/apply/counts — applicant counts per public role, with a region/area breakdown
 *  for the field-force roles. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const [candidates, requisitions, applications] = await Promise.all([
      fetchAll<CandidateRow>(
        "ats_candidates",
        "id, applied_for_job_title, preferred_region_code, preferred_area_name",
      ),
      fetchAll<{ id: string; job_title: string | null }>("ats_requisitions", "id, job_title"),
      fetchAll<{ candidate_id: string; requisition_id: string }>(
        "ats_applications",
        "candidate_id, requisition_id",
      ),
    ]);

    const candidateById = new Map<string, CandidateRow>();
    for (const c of candidates) candidateById.set(c.id, c);

    const roleKeys = websiteApplyRoleKeys();
    const roleSets = {} as Record<WebsiteApplyRoleKey, Set<string>>;
    for (const key of roleKeys) roleSets[key] = new Set<string>();

    // Stated applied-for title.
    for (const c of candidates) {
      const title = c.applied_for_job_title ?? "";
      if (!title) continue;
      for (const key of roleKeys) {
        if (ROLE_MATCHERS[key].test(title)) roleSets[key].add(c.id);
      }
    }

    // Linked to a requisition whose title matches — the extra evidence the stated field misses.
    const requisitionTitleById = new Map<string, string>();
    for (const r of requisitions) requisitionTitleById.set(r.id, r.job_title ?? "");
    for (const a of applications) {
      const title = requisitionTitleById.get(a.requisition_id) ?? "";
      if (!title) continue;
      for (const key of roleKeys) {
        if (ROLE_MATCHERS[key].test(title)) roleSets[key].add(a.candidate_id);
      }
    }

    const roles: Record<string, RoleCount> = {};
    for (const key of roleKeys) {
      const ids = roleSets[key];
      const roleCount: RoleCount = { total: ids.size };

      if (FIELD_FORCE_ROLES.has(key)) {
        const regionTotals = new Map<string, number>();
        const areaTotals = new Map<string, AreaCount>();
        for (const id of ids) {
          const c = candidateById.get(id);
          const { code, label } = regionLabelFor(c?.preferred_region_code ?? null);
          regionTotals.set(code, (regionTotals.get(code) ?? 0) + 1);
          // Area detail only under a real coded region — the "no region" bucket holds free-text
          // area strings (typos, Arabic, stray marks) that are not canonical territories.
          const area = (c?.preferred_area_name ?? "").trim();
          if (area && code !== NONE_REGION) {
            const areaKey = `${code}||${area}`;
            const existing = areaTotals.get(areaKey);
            if (existing) existing.count += 1;
            else areaTotals.set(areaKey, { area, code, count: 1, region: label });
          }
        }
        roleCount.byRegion = [...regionTotals.entries()]
          .map(([code, count]) => {
            const resolved = regionLabelFor(code === NONE_REGION ? null : code);
            return { code: resolved.code, count, label: resolved.label };
          })
          .sort((a, b) => b.count - a.count);
        roleCount.byArea = [...areaTotals.values()].sort((a, b) => b.count - a.count);
      }

      roles[key] = roleCount;
    }

    return json(request, {
      generatedAt: new Date().toISOString(),
      regionLabels: candidateRegionLabels,
      roles,
    });
  } catch (error) {
    logError("Public apply counts failed to build", {
      error,
      labels: { event: "public_apply_counts_failed" },
    });
    return json(request, { error: "counts_unavailable" }, 500);
  }
}
