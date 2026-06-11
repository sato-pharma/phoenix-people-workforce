"use client";

import { AlertTriangle, ShieldCheck, Table2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { SiAdvancedFilters } from "@/components/sales/intelligence/si-advanced-filters";
import { SiCommandHero } from "@/components/sales/intelligence/si-command-hero";
import { SiCustomerPareto } from "@/components/sales/intelligence/si-customer-pareto";
import { SiDailyRhythm } from "@/components/sales/intelligence/si-daily-rhythm";
import { SiDistributorDependency } from "@/components/sales/intelligence/si-distributor-dependency";
import { SiFilterBar } from "@/components/sales/intelligence/si-filter-bar";
import { SiGeoMatrix } from "@/components/sales/intelligence/si-geo-matrix";
import { SiInsightRail, SiRisksBand } from "@/components/sales/intelligence/si-insight-rail";
import { SiKpiBand } from "@/components/sales/intelligence/si-kpi-band";
import { SiLineMix } from "@/components/sales/intelligence/si-line-mix";
import { SiProductDrilldown } from "@/components/sales/intelligence/si-product-drilldown";
import { SiProductMovers } from "@/components/sales/intelligence/si-product-movers";
import { SiProductsTable } from "@/components/sales/intelligence/si-products-table";
import type {
  SiCustomerChurn,
  SiCustomerInsights,
  SiDashboardBundle,
  SiMovers,
  SiProductDrill,
} from "@/lib/sales/intelligence/types";

// Executive Navy categorical ramp: deep navy → steel → dusty blue → slate → muted clay (+ extras).
const LINE_COLORS = ["#1E3A5F", "#3B6B9A", "#6B8FB5", "#94A3B8", "#B08968", "#475569", "#5B7B8A", "#7C8DA6"];

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    const payload = (await response.json()) as { success?: boolean; data?: T };
    return payload?.success ? (payload.data as T) : null;
  } catch {
    return null;
  }
}

export function SalesIntelligenceDashboard({ bundle, error }: { bundle: SiDashboardBundle | null; error: string | null }) {
  if (error || !bundle) {
    return (
      <div className="min-h-[60vh] p-5">
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold">Sales Intelligence could not load.</p>
            <p className="mt-1 text-sm">{error ?? "No data available."}</p>
          </div>
        </AdminCallout>
      </div>
    );
  }
  return <DashboardInner bundle={bundle} />;
}

function DashboardInner({ bundle }: { bundle: SiDashboardBundle }) {
  const { kpis, products, geography, distributors, access, compare } = bundle;
  const bundleKey = `${bundle.period ?? ""}|${access.restrictedIncluded ? "1" : "0"}`;

  // ── Progressive lazy chain (strictly sequential: movers → customers → churn) ──────────
  const [lazy, setLazy] = useState<{
    key: string;
    movers: SiMovers | null;
    customers: SiCustomerInsights | null;
    churn: SiCustomerChurn | null;
    moversDone: boolean;
    customersDone: boolean;
  }>({ key: "", movers: null, customers: null, churn: null, moversDone: false, customersDone: false });
  const fresh = lazy.key === bundleKey;
  const moversPending = !fresh || !lazy.moversDone;
  const customersPending = !fresh || !lazy.customersDone;
  const movers = fresh ? lazy.movers : null;
  const customers = fresh ? lazy.customers : null;
  const churn = fresh ? lazy.churn : null;

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (bundle.period) params.set("period", bundle.period);
    if (access.restrictedIncluded) params.set("includeRestricted", "1");
    const query = params.toString();

    (async () => {
      const moversData = await fetchJson<SiMovers>(`/api/sales/intelligence/movers?${query}`);
      if (cancelled) return;
      setLazy({ key: bundleKey, movers: moversData, customers: null, churn: null, moversDone: true, customersDone: false });

      const customerData = await fetchJson<SiCustomerInsights>(`/api/sales/intelligence/customers?${query}`);
      if (cancelled) return;
      setLazy((current) => ({ ...current, key: bundleKey, customers: customerData, customersDone: true }));

      const churnData = await fetchJson<SiCustomerChurn>(`/api/sales/intelligence/churn?${query}`);
      if (cancelled) return;
      setLazy((current) => ({ ...current, key: bundleKey, churn: churnData }));
    })();

    return () => {
      cancelled = true;
    };
  }, [bundleKey, bundle.period, access.restrictedIncluded]);

  // ── Product drill-down (URL-driven: ?product=CODE) ────────────────────────────────────
  const [drillState, setDrillState] = useState<{
    open: boolean;
    code: string | null;
    name: string | null;
    data: SiProductDrill | null;
    loading: boolean;
    error: string | null;
  }>({ open: false, code: null, name: null, data: null, loading: false, error: null });

  const openProduct = (code: string, name?: string) => {
    setDrillState({ open: true, code, name: name ?? null, data: null, loading: true, error: null });
    const url = new URL(window.location.href);
    url.searchParams.set("product", code);
    window.history.replaceState(null, "", url.toString());
  };
  const closeProduct = () => {
    setDrillState((current) => ({ ...current, open: false }));
    const url = new URL(window.location.href);
    url.searchParams.delete("product");
    window.history.replaceState(null, "", url.toString());
  };

  // Deep link: open the drill if ?product= is present on first mount (scheduled async so the
  // effect never sets state synchronously).
  useEffect(() => {
    const id = window.setTimeout(() => {
      const fromUrl = new URL(window.location.href).searchParams.get("product");
      if (fromUrl) {
        setDrillState({ open: true, code: fromUrl, name: null, data: null, loading: true, error: null });
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!drillState.open || !drillState.code || !bundle.period) return;
    let cancelled = false;
    const params = new URLSearchParams({ period: bundle.period, product: drillState.code });
    if (access.restrictedIncluded) params.set("includeRestricted", "1");
    fetch(`/api/sales/intelligence/product-drill?${params.toString()}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        if (payload?.success) {
          setDrillState((current) => ({ ...current, data: payload.data as SiProductDrill, loading: false }));
        } else {
          setDrillState((current) => ({ ...current, loading: false, error: String(payload?.error ?? "Drill-down unavailable.") }));
        }
      })
      .catch(() => {
        if (!cancelled) setDrillState((current) => ({ ...current, loading: false, error: "Drill-down unavailable." }));
      });
    return () => {
      cancelled = true;
    };
  }, [drillState.open, drillState.code, bundle.period, access.restrictedIncluded]);

  const lineMixData = useMemo(
    () => products.lineMix.slice(0, 8).map((line, index) => ({
      name: line.name,
      value: line.value,
      color: LINE_COLORS[index % LINE_COLORS.length],
      share: line.share,
    })),
    [products.lineMix],
  );

  const topDistributor = distributors.distributors[0]
    ? { name: distributors.distributors[0].name, share: distributors.distributors[0].share, value: distributors.distributors[0].value }
    : null;

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 sm:p-5 xl:p-6">
      <SiCommandHero
        access={access}
        compare={compare}
        customerCount={customers?.customerCount ?? null}
        customerPending={customersPending}
        insights={bundle.insights}
        kpis={kpis}
        period={bundle.period}
      />

      {/* Sticky control bar — pinned BELOW the app topbar (sticky top-0 z-20) and at a lower
          z-index so it can never slide over the global navigation header on scroll. */}
      <div className="sticky top-[5rem] z-10 -mx-1 flex flex-wrap items-start gap-2 bg-[#F3F6FA]/95 px-1 py-1 backdrop-blur sm:top-[5.5rem]">
        <div className="min-w-0 flex-1">
          <SiFilterBar access={access} availablePeriods={bundle.availablePeriods} period={bundle.period} />
        </div>
        <SiAdvancedFilters facets={bundle.facets} filters={bundle.filters} period={bundle.period} />
      </div>

      <SiKpiBand
        compare={compare}
        concentration={bundle.concentration}
        coverage={bundle.coverage}
        customerPending={customersPending}
        customerTop10Share={customers?.top10Share ?? null}
        kpis={kpis}
        sparks={bundle.kpiSparks}
      />

      {/* Act II — time */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12" id="rhythm">
        <div className="lg:col-span-8">
          <SiDailyRhythm curve={bundle.daily} prior={bundle.dailyPrior} runRate={bundle.runRate} />
        </div>
        <div className="lg:col-span-4">
          <SiInsightRail insights={bundle.insights} />
        </div>
      </div>

      {/* Act III — product */}
      <SiLineMix lines={lineMixData} totalValue={kpis.totals.value} />

      <SiProductMovers
        movers={movers}
        onOpenProduct={(code) => openProduct(code)}
        pending={moversPending}
        topProducts={products.products}
      />

      <SiProductsTable
        movers={movers}
        moversPending={moversPending}
        onOpenProduct={(code, name) => openProduct(code, name)}
        products={products.products}
      />

      {/* Act IV — geography + network */}
      <div id="geography">
        <SiGeoMatrix areas={geography.areas} regions={geography.regions} zeroSalesAreasCount={bundle.zeroSalesAreas.length} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-5" id="distributors">
          <SiDistributorDependency distributors={distributors.distributors} />
        </div>
        <div className="lg:col-span-7">
          <SiCustomerPareto churn={churn} customers={customers} loading={customersPending} />
        </div>
      </div>

      <SiRisksBand
        concentration={bundle.concentration}
        customerTop10Share={customers?.top10Share ?? null}
        kpis={kpis}
        period={bundle.period}
        topDistributor={topDistributor}
        zeroSalesAreas={bundle.zeroSalesAreas}
      />

      {/* Footer nav to the sibling pages */}
      <div className="flex flex-wrap gap-2 pb-2">
        <Link href="/sales-intelligence/details">
          <span className="inline-flex h-10 items-center gap-2 border border-[#D8E0EA] bg-white px-3 text-xs font-black text-[#0F172A] transition hover:border-[#6B8FB5] hover:text-[#1E3A5F]">
            <Table2 className="h-4 w-4" /> Sales Details
          </span>
        </Link>
        <Link href="/sales-intelligence/data-quality">
          <span className="inline-flex h-10 items-center gap-2 border border-[#D8E0EA] bg-white px-3 text-xs font-black text-[#0F172A] transition hover:border-[#6B8FB5] hover:text-[#1E3A5F]">
            <ShieldCheck className="h-4 w-4" /> Data Quality Center
          </span>
        </Link>
      </div>

      <SiProductDrilldown
        drill={drillState.data}
        error={drillState.error}
        loading={drillState.loading}
        onClose={closeProduct}
        open={drillState.open}
        productName={drillState.name}
      />
    </div>
  );
}
