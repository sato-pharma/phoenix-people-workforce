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
  adminPanelClassName,
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
              <Button className="rounded-[10px] bg-[#0F172A] px-4 py-2 text-white hover:bg-[#111827]">Territory Map</Button>
            </Link>
            <Link href="/admin/geo-intelligence/expense-routes">
              <Button className="rounded-[10px] bg-[#F97316] px-4 py-2 text-white hover:bg-[#EA580C]">Expense Routes</Button>
            </Link>
            <Link href="/admin/geo-intelligence/anomalies">
              <Button className="rounded-[10px] border border-[#FECACA] bg-white px-4 py-2 text-[#B91C1C] hover:bg-[#FEF2F2]">Anomalies</Button>
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
              className="rounded-[12px] border-[#DDE6F1] bg-white text-[#0F172A] focus:border-[#FDBA74] focus-visible:outline-none"
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
              className="rounded-[12px] border-[#DDE6F1] bg-white text-[#0F172A] focus:border-[#FDBA74] focus-visible:outline-none"
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
    <Card className={`${adminPanelClassName} p-5`}>
      <p className="text-xs font-black uppercase tracking-[0.16em] text-[#EA580C]">{title}</p>
      <p className="mt-2 text-sm leading-7 text-[#64748B]">{description}</p>
      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_220px_auto]">
        <Input
          accept=".xlsx,.xls"
          className="h-10 rounded-[12px] border-[#DDE6F1] bg-white text-[#0F172A] focus:border-[#FDBA74] focus-visible:outline-none"
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
    <Card className={`${adminPanelClassName} p-5`}>
      <p className="text-xs font-black uppercase tracking-[0.16em] text-[#64748B]">Analytics</p>
      <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-[#0F172A]">{title}</h2>
      <div className="mt-4 h-72">
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
