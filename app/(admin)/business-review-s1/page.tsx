// S1 Business Review — READ-ONLY analytical page inside the Phoenix admin shell
// (sidebar/topbar provided by app/(admin)/layout.tsx). Visible only to CEO,
// SFE Manager, and Super Admin. Reads the bundled, pre-verified S1 dataset (one
// line at a time, chosen via ?line=) — it does not touch any other Phoenix
// domain, service, or table. Line switch is a URL search param so every switch
// re-runs the role gate server-side, same as any other navigation.
import { redirect } from "next/navigation";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  bandFor,
  DEFAULT_S1_VIEW,
  getS1Company,
  getS1CompanyAreas,
  getS1CompanyDms,
  getS1CompanyProductTables,
  getS1CompanyThresholds,
  getS1Dataset,
  isS1View,
  payoutPercentageFor,
  type S1View,
} from "@/lib/business-review-s1/service";
import { S1ReviewDashboard } from "@/components/business-review-s1/dashboard.client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["CEO", "SFE Manager", "Super Admin"]);

function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

type PageProps = { searchParams?: Promise<{ line?: string | string[] }> };

export default async function BusinessReviewS1Page({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!ALLOWED_ROLES.has(access.role)) redirect("/admin/access");

  const params = await searchParams;
  const requested = firstSearchParam(params?.line);
  const view: S1View = isS1View(requested) ? requested : DEFAULT_S1_VIEW;
  const company = getS1Company();

  // The company rollup is cross-line: it consolidates every line's bricks and DM seats
  // instead of loading a single per-line dataset.
  if (view === "company") {
    return (
      <S1ReviewDashboard
        view="company"
        company={company}
        viewerRole={access.role}
        companyDms={getS1CompanyDms().map((d) => ({
          ...d,
          payoutPct: payoutPercentageFor(d.allProducts.ach),
          band: bandFor(d.allProducts.ach),
          activePayoutPct: payoutPercentageFor(d.activeIncludeOnly.ach),
          activeBand: bandFor(d.activeIncludeOnly.ach),
        }))}
        companyAreas={getS1CompanyAreas().map((a) => ({
          ...a,
          payoutPct: payoutPercentageFor(a.allProducts.ach),
          band: bandFor(a.allProducts.ach),
        }))}
        companyProductTables={getS1CompanyProductTables()}
        companyThresholds={getS1CompanyThresholds()}
      />
    );
  }

  const ds = getS1Dataset(view);
  const dms = ds.dms.map((d) => ({
    ...d,
    payoutPct: payoutPercentageFor(d.allProducts.ach),
    band: bandFor(d.allProducts.ach),
    activePayoutPct: payoutPercentageFor(d.activeIncludeOnly.ach),
    activeBand: bandFor(d.activeIncludeOnly.ach),
  }));
  const areas = ds.areas.map((a) => ({
    ...a,
    payoutPct: payoutPercentageFor(a.allProducts.ach),
    band: bandFor(a.allProducts.ach),
  }));

  return (
    <S1ReviewDashboard
      view={view}
      ds={ds}
      dms={dms}
      areas={areas}
      viewerRole={access.role}
      company={company}
    />
  );
}
