"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Ban, Gauge, Store, TrendingDown, UserPlus } from "lucide-react";

import type { MonthPaceResult, MonthPaceRow } from "@/lib/sales/sos-month-pace";
import type { PortalPharmacyActionsPayload } from "@/lib/sales/sos-pharmacy-actions-loader";
import type { BrickUniverseEntry, CrossSellItem, PharmacyActionItem } from "@/lib/sales/sos-pharmacy-actions";

// "Where my sales come from" — the pharmacy action lists and the weekly month pace, above the
// distributor dashboard. Every rule is computed server-side (sos-pharmacy-actions.ts); this file
// only renders. Names only, never codes; value only, never units; square edges; no horizontal scroll
// (fixed tables with a colgroup on desktop, cards on mobile).

type ApiResponse = {
  success: boolean;
  data?: PortalPharmacyActionsPayload;
  pace?: MonthPaceResult | null;
  error?: string;
};

type TabKey = "stopped" | "dropping" | "newPharmacies" | "top" | "crossSell" | "untappedBricks";

/** "the 3 closings before the latest" / "the closing before the latest" — the window really compared. */
function earlierClosings(count: number): string {
  return count === 1 ? "the closing before the latest" : `the ${count} closings before the latest`;
}

const TABS: { key: TabKey; label: string; hint: (earlier: number) => string }[] = [
  {
    key: "stopped",
    label: "Stopped buying",
    hint: (earlier) =>
      `Bought in ${earlier === 1 ? "" : "at least one of "}${earlierClosings(earlier)}, and nothing in the latest. Biggest monthly average first.`,
  },
  {
    key: "dropping",
    label: "Dropping",
    hint: (earlier) => `The latest closing is 30% or more below its average over ${earlierClosings(earlier)}. Biggest gap first.`,
  },
  { key: "newPharmacies", label: "New", hint: (earlier) => `Bought in the latest closing and in none of ${earlierClosings(earlier)}.` },
  { key: "top", label: "Top pharmacies", hint: () => "Your biggest pharmacies in the latest closing and their share of your pharmacy sales." },
  {
    key: "crossSell",
    label: "Cross-sell gaps",
    hint: () => "Buys some of the products most of your pharmacies buy, but not these — across every closing shown.",
  },
  {
    key: "untappedBricks",
    label: "Untapped bricks",
    hint: () => "Bricks in your areas where no pharmacy bought anything across every closing shown.",
  },
];

const PAGE_SIZE = 10;

function formatEgp(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `EGP ${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `EGP ${(value / 1_000).toFixed(1)}K`;
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}
function formatPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
function formatPeriod(period: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period ?? "").trim());
  if (!match) return "—";
  return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-hidden border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-3.5 w-[3px] bg-orange-500" />
          <h2 className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-200">{title}</h2>
        </div>
        {action ?? <span className="h-1.5 w-10 bg-orange-500/80" />}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Tile({
  accent,
  icon: Icon,
  label,
  value,
  sub,
  active,
  onClick,
}: {
  accent: string;
  icon: typeof Ban;
  label: string;
  value: string;
  sub: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`group relative overflow-hidden border bg-white text-left shadow-[0_8px_22px_rgba(15,23,42,0.04)] ring-1 transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_34px_rgba(15,23,42,0.08)] ${
        active ? "border-orange-300 ring-orange-200" : "border-slate-200 ring-slate-200/60"
      }`}
      onClick={onClick}
      type="button"
    >
      <span className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: accent }} />
      <div className="p-3.5 sm:p-4">
        <span className="flex h-7 w-7 items-center justify-center" style={{ backgroundColor: `${accent}1A`, color: accent }}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <p className="mt-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">{label}</p>
        <p className="mt-0.5 text-lg font-black tabular-nums tracking-tight text-slate-900 sm:text-xl">{value}</p>
        <p className="mt-0.5 text-phx-2xs font-semibold text-slate-500">{sub}</p>
      </div>
    </button>
  );
}

function PharmacyName({ item }: { item: PharmacyActionItem }) {
  const place = [item.brickName, item.areaName].filter(Boolean).join(" · ");
  return (
    <div className="min-w-0">
      <p className="break-words text-sm font-bold text-slate-900">
        {item.name}
        {item.isDirect ? (
          <span className="ml-2 inline-block border border-orange-200 px-1.5 align-middle text-phx-2xs font-black uppercase tracking-[0.1em] text-orange-600">
            Direct order
          </span>
        ) : null}
      </p>
      {place ? <p className="break-words text-phx-2xs font-semibold text-slate-500">{place}</p> : null}
      {item.address ? <p className="break-words text-phx-2xs text-slate-400">{item.address}</p> : null}
    </div>
  );
}

function ChangePill({ change }: { change: number | null }) {
  if (change == null) return <span className="text-slate-400">—</span>;
  const down = change < 0;
  return (
    <span
      className={`inline-flex px-1.5 py-0.5 text-phx-2xs font-black tabular-nums ${
        down ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"
      }`}
    >
      {`${down ? "" : "+"}${formatPct(change)}`}
    </span>
  );
}

type Column<T> = { label: string; width: string; align?: "right"; render: (item: T) => ReactNode };

function ResponsiveTable<T extends { key: string }>({
  items,
  columns,
  lead,
  emptyText,
}: {
  items: T[];
  columns: Column<T>[];
  /** The first column, also the card heading on mobile. */
  lead: Column<T>;
  emptyText: string;
}) {
  if (items.length === 0) {
    return <p className="border border-dashed border-slate-200 p-6 text-center text-sm font-semibold text-slate-500">{emptyText}</p>;
  }
  return (
    <>
      <table className="hidden w-full table-fixed text-sm md:table">
        <colgroup>
          <col style={{ width: lead.width }} />
          {columns.map((column) => (
            <col key={column.label} style={{ width: column.width }} />
          ))}
        </colgroup>
        <thead>
          <tr className="border-b border-slate-200 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">
            <th className="px-2 py-2 text-left">{lead.label}</th>
            {columns.map((column) => (
              <th key={column.label} className={`px-2 py-2 ${column.align === "right" ? "text-right" : "text-left"}`}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.key} className="border-b border-slate-100 align-top last:border-0">
              <td className="px-2 py-2.5">{lead.render(item)}</td>
              {columns.map((column) => (
                <td
                  key={column.label}
                  className={`px-2 py-2.5 tabular-nums text-slate-700 ${column.align === "right" ? "text-right" : "text-left"}`}
                >
                  {column.render(item)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="space-y-2 md:hidden">
        {items.map((item) => (
          <div key={item.key} className="border border-slate-200 bg-white p-3">
            {lead.render(item)}
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
              {columns.map((column) => (
                <div key={column.label} className="min-w-0">
                  <dt className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-400">{column.label}</dt>
                  <dd className="break-words text-sm font-semibold tabular-nums text-slate-800">{column.render(item)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </>
  );
}

function ShowMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <p className="text-phx-2xs font-semibold text-slate-500">{`Showing ${shown} of ${total}`}</p>
      <button
        className="border border-slate-300 bg-white px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-700 hover:border-orange-400 hover:text-orange-600"
        onClick={onMore}
        type="button"
      >
        Show more
      </button>
    </div>
  );
}

const pharmacyLead: Column<PharmacyActionItem> = { label: "Pharmacy", width: "46%", render: (item) => <PharmacyName item={item} /> };

function PaceBar({ row }: { row: MonthPaceRow }) {
  if (row.progress == null) return <span className="text-phx-2xs font-semibold text-slate-400">No target</span>;
  const width = Math.min(100, Math.max(0, row.progress * 100));
  const expected = row.targetValue ? Math.min(100, ((row.expectedByToday ?? 0) / row.targetValue) * 100) : 0;
  return (
    <div className="min-w-0">
      <div className="relative h-2 w-full bg-slate-100">
        <span className={`absolute inset-y-0 left-0 ${row.onPace ? "bg-emerald-500" : "bg-orange-500"}`} style={{ width: `${width}%` }} />
        <span className="absolute inset-y-[-3px] w-[2px] bg-slate-700" style={{ left: `${expected}%` }} title="Expected by today" />
      </div>
      <p className="mt-1 text-phx-2xs font-bold tabular-nums text-slate-600">{`${formatPct(row.progress)} of target`}</p>
    </div>
  );
}

function MonthPace({ pace, area }: { pace: MonthPaceResult; area: string }) {
  const rows = area ? pace.rows.filter((row) => row.areaCode === area) : pace.rows;
  const month = formatPeriod(pace.period);
  const showDirect = pace.hasDirectOrders;
  const leadColumn: Column<MonthPaceRow & { key: string }> = {
    label: "Area",
    width: showDirect ? "20%" : "24%",
    render: (row) => <span className="break-words text-sm font-bold text-slate-900">{row.areaName}</span>,
  };
  const columns: Column<MonthPaceRow & { key: string }>[] = [
    { label: "Month target", width: showDirect ? "14%" : "16%", align: "right", render: (row) => (row.targetValue == null ? "—" : formatEgp(row.targetValue)) },
    { label: "Weekly so far", width: showDirect ? "14%" : "16%", align: "right", render: (row) => formatEgp(row.weeklyValue) },
    ...(showDirect
      ? [{ label: "Direct orders", width: "14%", align: "right" as const, render: (row: MonthPaceRow) => formatEgp(row.directValue) }]
      : []),
    { label: "Progress", width: showDirect ? "24%" : "28%", render: (row) => <PaceBar row={row} /> },
    {
      label: "Pace",
      width: showDirect ? "14%" : "16%",
      render: (row) =>
        row.onPace == null ? (
          <span className="text-slate-400">—</span>
        ) : (
          <span className={`text-phx-2xs font-black uppercase tracking-[0.1em] ${row.onPace ? "text-emerald-700" : "text-orange-600"}`}>
            {row.onPace ? "On pace" : "Behind"}
          </span>
        ),
    },
  ];
  return (
    <Section title={`Month pace · ${month} · weekly, approximate`}>
      <p className="mb-3 text-sm text-slate-600">
        {`Weekly depot uploads so far in ${month}, plus the direct orders booked into ${month}, against the month's target, with the line marking where you should be by day ${pace.dayOfMonth} of ${pace.daysInMonth}. This is not the closing — the ${month} closing is the official number once it is published.`}
        {pace.allocatedShare != null && pace.allocatedShare > 0
          ? ` ${formatPct(pace.allocatedShare)} of the weekly value was placed in areas by branch name, so treat it as a guide.`
          : ""}
        {pace.directInWeekly ? ` The ${month} weekly upload already carries direct orders, so they are not added a second time.` : ""}
      </p>
      {!pace.hasWeeklyData && !pace.hasDirectOrders ? (
        <p className="mb-3 border border-dashed border-slate-200 p-3 text-sm font-semibold text-slate-500">{`No weekly upload for ${month} has reached your areas yet.`}</p>
      ) : null}
      {!pace.hasTargets ? (
        <p className="mb-3 border border-dashed border-slate-200 p-3 text-sm font-semibold text-slate-500">{`No target is loaded for ${month} yet.`}</p>
      ) : null}
      {rows.length > 0 ? (
        <ResponsiveTable
          columns={columns}
          emptyText="Nothing to show for this area."
          items={rows.map((row) => ({ ...row, key: row.areaCode }))}
          lead={leadColumn}
        />
      ) : null}
      {!area && pace.rows.length > 1 && pace.hasTargets ? (
        <p className="mt-3 text-sm font-bold text-slate-700">
          {`All your areas: ${formatEgp(pace.totals.soFarValue)} of ${formatEgp(pace.totals.targetValue)}`}
          {pace.hasDirectOrders ? ` (weekly ${formatEgp(pace.totals.weeklyValue)} + direct orders ${formatEgp(pace.totals.directValue)})` : ""}
          {pace.totals.progress != null ? ` (${formatPct(pace.totals.progress)})` : ""}
          {` · expected by today ${formatEgp(pace.totals.expectedByToday)}`}
        </p>
      ) : null}
    </Section>
  );
}

function LoadingState() {
  return (
    <Section title="Where my sales come from">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-28 animate-pulse bg-slate-100" />
        ))}
      </div>
      <div className="mt-4 space-y-2">
        {[0, 1, 2, 3, 4].map((index) => (
          <div key={index} className="h-10 animate-pulse bg-slate-100" />
        ))}
      </div>
      <p className="mt-3 text-phx-2xs font-semibold text-slate-400">Reading your published closings…</p>
    </Section>
  );
}

export function PortalSosPharmacyActions() {
  const [line, setLine] = useState<string | null>(null);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [area, setArea] = useState("");
  const [tab, setTab] = useState<TabKey>("stopped");
  const [shown, setShown] = useState(PAGE_SIZE);

  useEffect(() => {
    const controller = new AbortController();
    const query = line ? `?line=${encodeURIComponent(line)}` : "";
    fetch(`/api/employee-portals/source-of-sales/actions${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (result) => (await result.json()) as ApiResponse)
      .then((next) => {
        setResponse(next);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if ((error as { name?: string } | null)?.name === "AbortError") return;
        setResponse({ success: false, error: "Could not load your pharmacy actions." });
        setLoading(false);
      });
    return () => controller.abort();
  }, [line]);

  const data = response?.data;
  const actions = data?.actions ?? null;
  const pace = response?.pace ?? null;

  const areaOptions = useMemo(() => {
    const merged = new Map<string, string>();
    for (const option of actions?.areas ?? []) merged.set(option.code, option.name);
    for (const row of pace?.rows ?? []) if (!merged.has(row.areaCode)) merged.set(row.areaCode, row.areaName);
    return [...merged].map(([code, name]) => ({ code, name })).sort((left, right) => left.name.localeCompare(right.name));
  }, [actions, pace]);

  const selectTab = (next: TabKey) => {
    setTab(next);
    setShown(PAGE_SIZE);
  };
  const selectArea = (next: string) => {
    setArea(next);
    setShown(PAGE_SIZE);
  };
  const selectLine = (next: string) => {
    setLoading(true);
    setArea("");
    setShown(PAGE_SIZE);
    setLine(next);
  };

  if (loading) return <LoadingState />;

  const selectClass = "h-8 max-w-full border border-slate-600 bg-slate-800 px-2 text-phx-2xs font-bold text-slate-100";
  const headerAction =
    (data?.availableLines.length ?? 0) > 1 || areaOptions.length > 1 ? (
      <div className="flex flex-wrap items-center gap-2">
        {data && data.availableLines.length > 1 ? (
          <select aria-label="Line" className={selectClass} onChange={(event) => selectLine(event.target.value)} value={data.line ?? ""}>
            {data.availableLines.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : null}
        {areaOptions.length > 1 ? (
          <select aria-label="Area" className={selectClass} onChange={(event) => selectArea(event.target.value)} value={area}>
            <option value="">All my areas</option>
            {areaOptions.map((option) => (
              <option key={option.code} value={option.code}>
                {option.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    ) : undefined;

  if (!response?.success || !data) {
    return (
      <Section title="Where my sales come from">
        <p className="text-sm font-semibold text-slate-600">{response?.error ?? "Could not load your pharmacy actions."}</p>
      </Section>
    );
  }

  const inArea = <T extends { areaCode: string }>(list: T[]): T[] => (area ? list.filter((item) => item.areaCode === area) : list);

  const renderList = (): ReactNode => {
    if (!actions) return null;
    const more = (total: number) => <ShowMore onMore={() => setShown((current) => current + PAGE_SIZE)} shown={Math.min(shown, total)} total={total} />;
    if (tab === "crossSell") {
      const list = inArea(actions.crossSell);
      const columns: Column<CrossSellItem>[] = [
        { label: "Latest closing", width: "18%", align: "right", render: (item) => formatEgp(item.latestValue) },
        {
          label: "Not buying",
          width: "36%",
          render: (item) => (
            <div className="flex flex-wrap gap-1">
              {item.missingProducts.map((product) => (
                <span key={product.code} className="bg-orange-50 px-1.5 py-0.5 text-phx-2xs font-bold text-orange-700 ring-1 ring-orange-100">
                  {product.name}
                </span>
              ))}
            </div>
          ),
        },
      ];
      return (
        <>
          <ResponsiveTable
            columns={columns}
            emptyText="No gaps: every active pharmacy that buys your core products buys all of them."
            items={list.slice(0, shown)}
            lead={pharmacyLead as Column<CrossSellItem>}
          />
          {more(list.length)}
        </>
      );
    }
    if (tab === "untappedBricks") {
      const list = inArea(actions.untappedBricks).map((brick: BrickUniverseEntry) => ({ ...brick, key: brick.brickId }));
      const lead: Column<(typeof list)[number]> = {
        label: "Brick",
        width: "60%",
        render: (brick) => <span className="break-words text-sm font-bold text-slate-900">{brick.brickName}</span>,
      };
      const columns: Column<(typeof list)[number]>[] = [{ label: "Area", width: "40%", render: (brick) => brick.areaName }];
      return (
        <>
          <ResponsiveTable columns={columns} emptyText="Every brick in your areas had a pharmacy buying." items={list.slice(0, shown)} lead={lead} />
          {more(list.length)}
        </>
      );
    }

    const list = inArea(actions[tab]);
    const latest: Column<PharmacyActionItem> = { label: "Latest closing", width: "18%", align: "right", render: (item) => formatEgp(item.latestValue) };
    const earlier = actions.priorPeriods.length;
    const average: Column<PharmacyActionItem> = {
      label: earlier === 1 ? "Month before" : `${earlier}-closing average`,
      width: "18%",
      align: "right",
      render: (item) => formatEgp(item.priorAverage),
    };
    const columnsByTab: Record<"stopped" | "dropping" | "newPharmacies" | "top", Column<PharmacyActionItem>[]> = {
      stopped: [average, { label: "Last bought", width: "18%", align: "right", render: (item) => formatPeriod(item.lastBoughtPeriod) }],
      dropping: [latest, average, { label: "Change", width: "18%", align: "right", render: (item) => <ChangePill change={item.change} /> }],
      newPharmacies: [latest],
      top: [latest, { label: "Share", width: "18%", align: "right", render: (item) => (item.share == null ? "—" : formatPct(item.share)) }],
    };
    const emptyByTab: Record<"stopped" | "dropping" | "newPharmacies" | "top", string> = {
      stopped: "No pharmacy stopped buying.",
      dropping: "No pharmacy dropped 30% or more.",
      newPharmacies: "No new pharmacy in the latest closing.",
      top: "No pharmacy sales in the latest closing.",
    };
    return (
      <>
        <ResponsiveTable columns={columnsByTab[tab]} emptyText={emptyByTab[tab]} items={list.slice(0, shown)} lead={pharmacyLead} />
        {more(list.length)}
      </>
    );
  };

  const activeTab = TABS.find((entry) => entry.key === tab) ?? TABS[0];
  const countOf = (key: TabKey): number => {
    if (!actions) return 0;
    return inArea(actions[key] as { areaCode: string }[]).length;
  };
  const totals = actions?.latestTotals;
  const tieBack = totals
    ? [
        `pharmacies ${formatEgp(totals.pharmacies)}`,
        totals.mainStores > 0 ? `Main Stores ${formatEgp(totals.mainStores)}` : null,
        totals.wholesalerShares > 0 ? `wholesaler shares ${formatEgp(totals.wholesalerShares)}` : null,
        totals.noCustomerCode > 0 ? `no customer code ${formatEgp(totals.noCustomerCode)}` : null,
      ].filter(Boolean)
    : [];

  return (
    <div className="space-y-6">
      <Section action={headerAction} title="Where my sales come from">
        {!actions ? (
          <p className="text-sm font-semibold text-slate-600">{data.message ?? "No published closing to read yet."}</p>
        ) : (
          <>
            <p className="mb-3 text-sm text-slate-600">
              {actions.priorPeriods.length > 0
                ? `${data.line ?? ""} closing for ${formatPeriod(actions.latestPeriod)}, compared with ${actions.priorPeriods
                    .slice()
                    .reverse()
                    .map(formatPeriod)
                    .join(", ")}. Published closings only.`
                : `${data.line ?? ""} closing for ${formatPeriod(actions.latestPeriod)} — the first published month, so nothing to compare with yet.`}
              {!actions.historyComplete && actions.priorPeriods.length > 0
                ? ` Only ${actions.priorPeriods.length} earlier closing${actions.priorPeriods.length === 1 ? " is" : "s are"} published, so "New" may include pharmacies that bought before them.`
                : ""}
            </p>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile
                accent="#EF4444"
                active={tab === "stopped"}
                icon={Ban}
                label="Stopped buying"
                onClick={() => selectTab("stopped")}
                sub={`${formatEgp(actions.valueAtStake.stopped)} a month before`}
                value={String(countOf("stopped"))}
              />
              <Tile
                accent="#F97316"
                active={tab === "dropping"}
                icon={TrendingDown}
                label="Dropping 30%+"
                onClick={() => selectTab("dropping")}
                sub={`${formatEgp(actions.valueAtStake.dropping)} below average`}
                value={String(countOf("dropping"))}
              />
              <Tile
                accent="#22C55E"
                active={tab === "newPharmacies"}
                icon={UserPlus}
                label="New this closing"
                onClick={() => selectTab("newPharmacies")}
                sub={`${formatEgp(actions.valueAtStake.newPharmacies)} in their first month`}
                value={String(countOf("newPharmacies"))}
              />
              <Tile
                accent="#0EA5E9"
                active={tab === "top"}
                icon={Store}
                label="Buying pharmacies"
                onClick={() => selectTab("top")}
                sub={`${formatEgp(totals?.pharmacies ?? 0)} in the latest closing`}
                value={String(actions.counts.activePharmacies)}
              />
            </div>

            {totals && totals.total > 0 ? (
              <p className="mt-3 text-phx-2xs font-semibold text-slate-500">
                {`Your ${formatPeriod(actions.latestPeriod)} closing: ${formatEgp(totals.total)} = ${tieBack.join(" + ")}. Only pharmacies are listed — Main Stores and wholesaler shares are split across areas and have no single pharmacy to visit.`}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2 border-b border-slate-200 pb-3">
              {TABS.map((entry) => (
                <button
                  key={entry.key}
                  className={`border px-2.5 py-1.5 text-phx-2xs font-black uppercase tracking-[0.1em] transition ${
                    entry.key === tab
                      ? "border-orange-500 bg-orange-500 text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:border-orange-300 hover:text-orange-600"
                  }`}
                  onClick={() => selectTab(entry.key)}
                  type="button"
                >
                  {entry.key === "top" ? entry.label : `${entry.label} · ${countOf(entry.key)}`}
                </button>
              ))}
            </div>
            <p className="mb-3 mt-3 text-phx-2xs font-semibold text-slate-500">{activeTab.hint(actions.priorPeriods.length)}</p>
            {renderList()}
          </>
        )}
      </Section>

      {pace ? <MonthPace area={area} pace={pace} /> : null}
      {!pace && data.line ? (
        <Section title="Month pace · weekly, approximate">
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-500">
            <Gauge className="h-4 w-4" />
            Weekly pace is not available for your scope right now.
          </p>
        </Section>
      ) : null}
    </div>
  );
}
