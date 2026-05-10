"use client";

import { AlertTriangle, BarChart3, MapPinned, Route, TrendingUp, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { BrickCoverageTable } from "@/components/geo/brick-coverage-table";
import { GeoFilters } from "@/components/geo/geo-filters";
import { GeoKpiCard } from "@/components/geo/geo-kpi-card";
import { TripAnomalyTable } from "@/components/geo/trip-anomaly-table";
import { TerritoryMap } from "@/components/geo/territory-map";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type { GeoDashboardData } from "@/lib/geo-intelligence/types";

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(value);
}

const panelClassName =
  "rounded-[28px] border border-[#D8E0EA] bg-white/94 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur";

function GeoAdminShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate min-h-[calc(100vh-8rem)] overflow-hidden rounded-[34px] border border-[#D8E0EA] bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_32%),linear-gradient(135deg,#FFF9F3_0%,#FFFFFF_44%,#F7FAFC_100%)] p-4 shadow-[0_24px_70px_rgba(15,23,42,0.1)] sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-[#F97316]/12 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-10 left-1/4 h-64 w-64 rounded-full bg-[#0F172A]/6 blur-3xl"
      />
      <div className="relative z-10 space-y-6">{children}</div>
    </div>
  );
}

export function GeoIntelligenceDashboard({ data }: { data: GeoDashboardData }) {
  const router = useRouter();
  const [brickFile, setBrickFile] = useState<File | null>(null);
  const [expenseFile, setExpenseFile] = useState<File | null>(null);
  const [brickLine, setBrickLine] = useState("Pedia");
  const [expenseMonth, setExpenseMonth] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isImportingBricks, setIsImportingBricks] = useState(false);
  const [isImportingExpenses, setIsImportingExpenses] = useState(false);

  async function importFile(endpoint: string, file: File, extra: Record<string, string>) {
    const formData = new FormData();
    formData.append("file", file);
    Object.entries(extra).forEach(([key, value]) => {
      if (value) {
        formData.append(key, value);
      }
    });

    const response = await fetch(endpoint, { body: formData, method: "POST" });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message ?? payload.error ?? "Import failed.");
    }

    return payload;
  }

  async function handleBrickImport() {
    if (!brickFile) return;
    setIsImportingBricks(true);
    setMessage(null);
    try {
      const payload = await importFile("/api/geo/import-bricks", brickFile, { line: brickLine });
      setMessage(`Brick import completed. ${payload.inserted} rows inserted.`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Brick import failed.");
    } finally {
      setIsImportingBricks(false);
    }
  }

  async function handleExpenseImport() {
    if (!expenseFile) return;
    setIsImportingExpenses(true);
    setMessage(null);
    try {
      const payload = await importFile("/api/geo/import-expenses", expenseFile, { sourceFileMonth: expenseMonth });
      setMessage(`Expense import completed. ${payload.inserted} routes inserted.`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Expense import failed.");
    } finally {
      setIsImportingExpenses(false);
    }
  }

  return (
    <GeoAdminShell>
    <div className="space-y-6">
      <AdminPageHero
        description="Upload bricks and expense workbooks, geocode locations, validate routes against Google Maps, and surface territory or expense anomalies for review."
        eyebrow="Geo Intelligence"
        icon={<MapPinned className="h-3.5 w-3.5" />}
        title="Territory, route, and expense verification"
        badges={(
          <div className="flex flex-wrap gap-2 text-xs">
            <AdminInsightChip>Area: {data.filterOptions.areas.length}</AdminInsightChip>
            <AdminInsightChip tone="orange">Lines: {data.filterOptions.lines.length}</AdminInsightChip>
            <AdminInsightChip tone="slate">Routes: {data.kpis.totalTrips}</AdminInsightChip>
          </div>
        )}
        actions={(
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/geo-intelligence/territory-map">
              <Button className="rounded-2xl bg-[#0F172A] px-4 py-2 text-white shadow-[0_14px_30px_rgba(15,23,42,0.18)] hover:bg-[#111827]">Territory Map</Button>
            </Link>
            <Link href="/admin/geo-intelligence/expense-routes">
              <Button className="rounded-2xl bg-[#F97316] px-4 py-2 text-white shadow-[0_14px_30px_rgba(249,115,22,0.22)] hover:bg-[#EA580C]">Expense Routes</Button>
            </Link>
            <Link href="/admin/geo-intelligence/anomalies">
              <Button className="rounded-2xl border border-[#FECACA] bg-white px-4 py-2 text-[#B91C1C] shadow-sm hover:bg-[#FEF2F2]">Anomalies</Button>
            </Link>
          </div>
        )}
      />

      <AdminTableShell description="Filter data by line, area, employee, month, and status before inspecting tables, analytics, or map layers." title="Filters">
        <GeoFilters current={data.filters} options={data.filterOptions} />
      </AdminTableShell>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <GeoKpiCard helper="Ready for map and coverage analysis" icon={MapPinned} label="Total mapped bricks" value={data.kpis.totalMappedBricks.toLocaleString()} />
        <GeoKpiCard helper="Assigned and covered territory points" icon={BarChart3} label="Covered bricks" tone="amber" value={data.kpis.coveredBricks.toLocaleString()} />
        <GeoKpiCard helper="Missing or vacant assignment points" icon={AlertTriangle} label="Vacant bricks" tone="slate" value={data.kpis.vacantBricks.toLocaleString()} />
        <GeoKpiCard helper="Trips imported and validated" icon={Route} label="Total trips" value={data.kpis.totalTrips.toLocaleString()} />
        <GeoKpiCard helper="Imported trip claims" icon={Wallet} label="Claimed expenses" value={egp(data.kpis.totalClaimedExpenses)} />
        <GeoKpiCard helper="Expected from Google route distance" icon={TrendingUp} label="Expected expenses" tone="amber" value={egp(data.kpis.totalExpectedExpenses)} />
        <GeoKpiCard helper="Claimed minus expected" icon={TrendingUp} label="Total variance" tone={data.kpis.totalVariance >= 0 ? "orange" : "slate"} value={egp(data.kpis.totalVariance)} />
        <GeoKpiCard helper="Trips above the high-risk threshold" icon={AlertTriangle} label="High-risk trips" tone="red" value={data.kpis.highRiskTrips.toLocaleString()} />
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <ImportCard
          actionLabel="Import bricks workbook"
          browserKeyConfigured={data.browserKeyConfigured}
          busy={isImportingBricks}
          description="Use the line brick reference workbook to populate geo_bricks and cached brick locations."
          extraField={
            <Input
                className="h-11 rounded-2xl border-[#DDE6F1] bg-white text-[#0F172A] shadow-sm focus:border-[#FDBA74] focus-visible:outline-none"
              onChange={(event) => setBrickLine(event.target.value)}
              value={brickLine}
            />
          }
          extraLabel="Line"
          file={brickFile}
          onAction={handleBrickImport}
          onFileChange={setBrickFile}
          serverKeyConfigured={data.serverKeyConfigured}
          title="Brick import"
        />
        <ImportCard
          actionLabel="Import expenses workbook"
          browserKeyConfigured={data.browserKeyConfigured}
          busy={isImportingExpenses}
          description="Use the expenses workbook to generate routes, Google distance validation, and anomaly scoring."
          extraField={
            <Input
                className="h-11 rounded-2xl border-[#DDE6F1] bg-white text-[#0F172A] shadow-sm focus:border-[#FDBA74] focus-visible:outline-none"
              onChange={(event) => setExpenseMonth(event.target.value)}
              placeholder="2026-04"
              value={expenseMonth}
            />
          }
          extraLabel="Source month"
          file={expenseFile}
          onAction={handleExpenseImport}
          onFileChange={setExpenseFile}
          serverKeyConfigured={data.serverKeyConfigured}
          title="Expenses import"
        />
      </section>

      {message ? (
        <AdminCallout tone={message.toLowerCase().includes("failed") ? "danger" : "neutral"}>
          <p className="font-semibold">{message}</p>
        </AdminCallout>
      ) : null}

      <section className="grid gap-6 xl:grid-cols-2">
        <ChartCard data={data.chartData.varianceByEmployee} title="Expense variance by employee" valuePrefix="EGP " />
        <ChartCard data={data.chartData.varianceByArea} title="Expense variance by area" valuePrefix="EGP " />
        <ChartCard data={data.chartData.tripsByDestinationCity} title="Trips by destination city" />
        <ChartCard data={data.chartData.highRiskTripsOverTime} title="High-risk trips over time" />
      </section>

      <TerritoryMap data={data} />
      <TripAnomalyTable routes={data.anomalies.slice(0, 15)} title="Top suspicious routes" />
      <BrickCoverageTable bricks={data.bricks.slice(0, 60)} />
    </div>
    </GeoAdminShell>
  );
}

function ImportCard({
  actionLabel,
  browserKeyConfigured,
  busy,
  description,
  extraField,
  extraLabel,
  file,
  onAction,
  onFileChange,
  serverKeyConfigured,
  title,
}: {
  actionLabel: string;
  browserKeyConfigured: boolean;
  busy: boolean;
  description: string;
  extraField: ReactNode;
  extraLabel: string;
  file: File | null;
  onAction: () => void;
  onFileChange: (file: File | null) => void;
  serverKeyConfigured: boolean;
  title: string;
}) {
  return (
    <Card className={`${panelClassName} overflow-hidden p-0`}>
      <div className="relative overflow-hidden border-b border-[#1F2937] bg-[radial-gradient(circle_at_top_right,rgba(249,115,22,0.22),transparent_34%),linear-gradient(135deg,#080B10_0%,#111827_58%,#24150D_100%)] px-5 py-5 text-white">
        <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-44 w-44 rounded-full bg-[#F97316]/20 blur-3xl" />
        <div className="relative z-10">
          <p className="inline-flex rounded-full border border-[#F97316]/35 bg-[#F97316]/12 px-3 py-1 text-xs font-black uppercase tracking-[0.16em] text-[#FDBA74]">{title}</p>
          <p className="mt-3 text-sm leading-7 text-[#CBD5E1]">{description}</p>
        </div>
      </div>
      <div className="p-5">
      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_220px_auto]">
        <Input
          accept=".xlsx,.xls"
          className="h-11 rounded-2xl border-[#DDE6F1] bg-white text-[#0F172A] shadow-sm focus:border-[#FDBA74] focus-visible:outline-none"
          onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
          type="file"
        />
        <label className="block">
          <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">
            {extraLabel}
          </span>
          {extraField}
        </label>
        <div className="flex items-end">
          <Button
            className="h-10 rounded-[10px] bg-[#F97316] px-4 text-white hover:bg-[#EA580C]"
            disabled={!file || busy}
            onClick={onAction}
            type="button"
          >
            {busy ? <LoadingSpinner className="text-white" /> : null}
            {busy ? "Processing..." : actionLabel}
          </Button>
        </div>
      </div>
      {!serverKeyConfigured ? (
        <p className="mt-3 text-xs text-[#B45309]">
          `GOOGLE_MAPS_SERVER_KEY` is missing. Maps can still render with the browser key, but server geocoding and distance validation will not run until the server key is configured.
        </p>
      ) : !browserKeyConfigured ? (
        <p className="mt-3 text-xs text-[#B45309]">
          `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` is missing. Backend geo validation is available, but map rendering in the browser will stay disabled until the browser key is configured.
        </p>
      ) : (
        <p className="mt-3 text-xs text-[#166534]">
          Google Maps browser and server keys are configured.
        </p>
      )}
      </div>
    </Card>
  );
}

function ChartCard({
  data,
  title,
  valuePrefix = "",
}: {
  data: Array<{ label: string; value: number }>;
  title: string;
  valuePrefix?: string;
}) {
  return (
    <Card className={`${panelClassName} p-5`}>
      <p className="text-xs font-black uppercase tracking-[0.16em] text-[#64748B]">Analytics</p>
      <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-[#0F172A]">{title}</h2>
      <div className="mt-4 h-72 rounded-[24px] border border-[#E2E8F0] bg-[#F8FAFC]/70 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]">
        <ResponsiveContainer height="100%" width="100%">
          <BarChart data={data}>
            <CartesianGrid stroke="#E2E8F0" strokeDasharray="4 4" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(value) => `${valuePrefix}${Number(value).toLocaleString()}`} />
            <Bar dataKey="value" fill="#F97316" radius={[8, 8, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
