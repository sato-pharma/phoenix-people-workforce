"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChartColumnBig, ClipboardList, Plus, RefreshCcw, TriangleAlert } from "lucide-react";

/**
 * Market Awareness — one page, two tabs, exactly as the owner described it.
 *
 * GOLDEN RULES THIS FILE IS BOUND BY:
 *  - Never a horizontal scroll, at desktop OR 375px. The list is `w-full table-fixed` with a
 *    colgroup on desktop and CARDS on mobile — never `overflow-x-auto` over a min-width floor,
 *    which is the bug rather than the fix. Long values WRAP.
 *  - Square corners everywhere. No `rounded-*` class appears in this file at all, so it does not
 *    depend on the globals.css sweep — which cannot reach a hand-written border-radius or a
 *    scrollbar pseudo-element anyway.
 *  - No text is ever truncated with an ellipsis.
 *  - Human-readable names, never raw codes, and every date in Africa/Cairo.
 */

type Line = { id: number; lineCode: string; name: string };
type ActivityType = { id: number; code: string; name: string };
type ProductOption = { productCode: string; productName: string; lineName: string };
type AreaOption = {
  areaCode: string;
  areaName: string;
  selectable: boolean;
  unselectableReason: string | null;
  repName: string | null;
  repVacant: boolean;
  dmName: string | null;
};
type RegionOption = { regionCode: string; regionName: string; areas: AreaOption[] };
type BrickOption = { brickId: string; brickName: string };

type SeatHolder = {
  name: string | null;
  originalName: string | null;
  replacedOriginal: boolean;
  vacant: boolean;
};

type Activity = {
  id: string;
  activityCode: string;
  status: string;
  requesterName: string | null;
  managerName: string | null;
  activityType: { name: string };
  title: string | null;
  venue: string | null;
  city: string | null;
  startDate: string;
  endDate: string | null;
  primaryLine: Line;
  lines: Line[];
  regionName: string | null;
  areaName: string | null;
  areaCode: string;
  products: Array<{ productCode: string; productName: string | null }>;
  bricks: Array<{ brickId: string; isPrimary: boolean }>;
  currency: string;
  estimatedCost: number;
  approvedCost: number | null;
  actualCost: number | null;
  durationMonths: number;
  baselineMonths: number;
  financePaid: boolean;
  rep: SeatHolder;
  outcomeNote: string | null;
  decisions: Array<{
    id: number;
    stepCode: string;
    actorName: string | null;
    action: string;
    comment: string | null;
    createdAt: string;
  }>;
};

type TrackingPoint = { period: string; totalValue: number; units: number | null };
type Tracking = {
  baselinePeriods: string[];
  windowPeriods: string[];
  lastClosedPeriod: string | null;
  windowIncompleteReason: string | null;
  series: Array<{ line: Line; brick: TrackingPoint[]; area: TrackingPoint[] }>;
  reconciliation: Array<{ period: string; reconciled: boolean; difference: number }>;
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  pending_manager: "With the manager",
  pending_ceo: "With the CEO",
  returned: "Returned for changes",
  rejected: "Rejected",
  approved: "Approved",
  executed: "Held",
  closed: "Closed",
  withdrawn: "Withdrawn",
};

function money(amount: number | null, currency = "EGP"): string {
  if (amount === null || amount === undefined) return "Not set";
  return `${new Intl.NumberFormat("en-EG", { maximumFractionDigits: 0 }).format(amount)} ${currency}`;
}

function cairoDate(value: string | null): string {
  if (!value) return "Not set";
  const parsed = new Date(value.length <= 10 ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(parsed);
}

function monthLabel(period: string): string {
  const [year, month] = period.split("-");
  const parsed = new Date(Number(year), Number(month) - 1, 1);
  if (Number.isNaN(parsed.getTime())) return period;
  return new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit" }).format(parsed);
}

function Panel({ children, title, action }: { children: React.ReactNode; title: string; action?: React.ReactNode }) {
  return (
    <section className="border border-slate-200 bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
        <h2 className="text-phx-sm font-black uppercase tracking-[0.10em] text-slate-700">{title}</h2>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Field({ children, label, hint }: { children: React.ReactNode; label: string; hint?: string }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-phx-2xs font-medium text-slate-500">{hint}</span> : null}
    </label>
  );
}

const INPUT_CLASS =
  "h-10 w-full border border-slate-200 bg-white px-3 text-phx-md font-bold text-slate-800 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-50";

export function MarketAwarenessWorkspace({ canCreate }: { canCreate: boolean }) {
  const [tab, setTab] = useState<"request" | "tracking">("request");
  // `null` means "not loaded yet", so loading is DERIVED rather than set. An effect that calls a
  // loader which sets state before its first `await` is still a synchronous setState — the async
  // body runs synchronously up to that point — and that is a lint ERROR here, not a warning.
  const [activities, setActivities] = useState<Activity[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tracking, setTracking] = useState<Tracking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const loading = activities === null;

  const loadActivities = useCallback(async () => {
    try {
      const response = await fetch("/api/market-awareness", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || payload.success === false) {
        throw new Error(payload.message ?? "Could not load awareness activities.");
      }
      setActivities(payload.activities ?? []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load awareness activities.");
      setActivities([]);
    }
  }, []);

  useEffect(() => {
    void loadActivities();
  }, [loadActivities]);

  const selected = useMemo(
    () => (activities ?? []).find((activity) => activity.id === selectedId) ?? null,
    [activities, selectedId],
  );

  useEffect(() => {
    let cancelled = false;
    // Everything runs inside the async body: a setState called synchronously in an effect is a lint
    // ERROR in this repo, and it is the cascading-render shape the rule exists to stop.
    void (async () => {
      if (tab !== "tracking" || !selectedId) {
        if (!cancelled) setTracking(null);
        return;
      }
      try {
        const response = await fetch(`/api/market-awareness/${selectedId}/tracking`, { cache: "no-store" });
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok || payload.success === false) {
          throw new Error(payload.message ?? "Could not load the tracking.");
        }
        setTracking(payload.tracking);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Could not load the tracking.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, tab]);

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <nav className="flex w-full min-w-0 flex-wrap gap-1 border border-slate-200 bg-slate-50 p-1">
        {(
          [
            { icon: ClipboardList, key: "request" as const, label: "Request" },
            { icon: ChartColumnBig, key: "tracking" as const, label: "Tracking" },
          ]
        ).map((entry) => {
          const Icon = entry.icon;
          const active = tab === entry.key;
          return (
            <button
              className={
                active
                  ? "flex flex-1 items-center justify-center gap-2 border border-slate-900 bg-slate-900 px-4 py-2 text-phx-sm font-black uppercase tracking-[0.08em] text-white"
                  : "flex flex-1 items-center justify-center gap-2 border border-transparent px-4 py-2 text-phx-sm font-black uppercase tracking-[0.08em] text-slate-600 hover:bg-white"
              }
              key={entry.key}
              onClick={() => setTab(entry.key)}
              type="button"
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{entry.label}</span>
            </button>
          );
        })}
      </nav>

      {error ? (
        <div className="flex items-start gap-2 border border-amber-300 bg-amber-50 px-4 py-3">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-phx-sm font-bold text-amber-900">{error}</p>
        </div>
      ) : null}

      {tab === "request" ? (
        <RequestTab
          activities={activities ?? []}
          canCreate={canCreate}
          loading={loading}
          onCreated={() => {
            setShowForm(false);
            void loadActivities();
          }}
          onRefresh={() => void loadActivities()}
          onSelect={(id) => {
            setSelectedId(id);
            setTab("tracking");
          }}
          setShowForm={setShowForm}
          showForm={showForm}
        />
      ) : (
        <TrackingTab
          activities={activities ?? []}
          onSelect={setSelectedId}
          selected={selected}
          tracking={tracking}
        />
      )}
    </div>
  );
}

function RequestTab({
  activities,
  canCreate,
  loading,
  onCreated,
  onRefresh,
  onSelect,
  setShowForm,
  showForm,
}: {
  activities: Activity[];
  canCreate: boolean;
  loading: boolean;
  onCreated: () => void;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  setShowForm: (value: boolean) => void;
  showForm: boolean;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      {canCreate ? (
        showForm ? (
          <ActivityForm onCancel={() => setShowForm(false)} onCreated={onCreated} />
        ) : (
          <button
            className="flex items-center justify-center gap-2 border border-slate-900 bg-slate-900 px-4 py-3 text-phx-sm font-black uppercase tracking-[0.08em] text-white"
            onClick={() => setShowForm(true)}
            type="button"
          >
            <Plus className="h-4 w-4 shrink-0" />
            <span>Raise an awareness activity</span>
          </button>
        )
      ) : null}

      <Panel
        action={
          <button
            className="flex items-center gap-1.5 border border-slate-300 bg-white px-3 py-1.5 text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-600"
            onClick={onRefresh}
            type="button"
          >
            <RefreshCcw className="h-3 w-3 shrink-0" />
            <span>Refresh</span>
          </button>
        }
        title="Activities"
      >
        {loading ? (
          <p className="text-phx-sm font-bold text-slate-500">Loading activities.</p>
        ) : activities.length === 0 ? (
          <p className="text-phx-sm font-bold text-slate-500">
            No awareness activities yet. Raise one and it goes to your manager, then the CEO.
          </p>
        ) : (
          <>
            {/* Desktop: a fixed table with a colgroup. Never a min-width floor inside an
                overflow-x container — that is the horizontal scroll the golden rule forbids. */}
            <table className="hidden w-full table-fixed border-collapse md:table">
              <colgroup>
                <col style={{ width: "22%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "20%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "14%" }} />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  {["Activity", "Line", "Where", "Starts", "Value", "Status"].map((heading) => (
                    <th
                      className="px-2 py-2 text-left text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-500"
                      key={heading}
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activities.map((activity) => (
                  <tr
                    className="cursor-pointer border-b border-slate-100 align-top hover:bg-sky-50"
                    key={activity.id}
                    onClick={() => onSelect(activity.id)}
                  >
                    <td className="break-words px-2 py-3 text-phx-sm font-black text-slate-900">
                      {activity.title?.trim() || activity.activityType.name}
                      <span className="mt-0.5 block text-phx-2xs font-medium text-slate-500">
                        {activity.activityCode}
                      </span>
                    </td>
                    <td className="break-words px-2 py-3 text-phx-sm font-bold text-slate-700">
                      {activity.primaryLine.name}
                    </td>
                    <td className="break-words px-2 py-3 text-phx-sm font-bold text-slate-700">
                      {activity.areaName ?? activity.areaCode}
                      <span className="mt-0.5 block text-phx-2xs font-medium text-slate-500">
                        {activity.regionName ?? ""}
                      </span>
                    </td>
                    <td className="break-words px-2 py-3 text-phx-sm font-bold text-slate-700">
                      {cairoDate(activity.startDate)}
                    </td>
                    <td className="break-words px-2 py-3 text-phx-sm font-bold text-slate-700">
                      {money(activity.approvedCost ?? activity.estimatedCost, activity.currency)}
                    </td>
                    <td className="break-words px-2 py-3 text-phx-sm font-bold text-slate-700">
                      {STATUS_LABEL[activity.status] ?? activity.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Mobile: cards. The admin shell shows full tables on desktop and never on mobile. */}
            <ul className="flex flex-col gap-2 md:hidden">
              {activities.map((activity) => (
                <li key={activity.id}>
                  <button
                    className="flex w-full flex-col gap-1 border border-slate-200 bg-white p-3 text-left"
                    onClick={() => onSelect(activity.id)}
                    type="button"
                  >
                    <span className="break-words text-phx-sm font-black text-slate-900">
                      {activity.title?.trim() || activity.activityType.name}
                    </span>
                    <span className="break-words text-phx-2xs font-medium text-slate-500">
                      {activity.activityCode}
                    </span>
                    <span className="break-words text-phx-xs font-bold text-slate-700">
                      {activity.primaryLine.name} · {activity.areaName ?? activity.areaCode}
                    </span>
                    <span className="break-words text-phx-xs font-bold text-slate-700">
                      {cairoDate(activity.startDate)} ·{" "}
                      {money(activity.approvedCost ?? activity.estimatedCost, activity.currency)}
                    </span>
                    <span className="break-words text-phx-xs font-black uppercase tracking-[0.08em] text-slate-600">
                      {STATUS_LABEL[activity.status] ?? activity.status}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
    </div>
  );
}

function TrackingTab({
  activities,
  onSelect,
  selected,
  tracking,
}: {
  activities: Activity[];
  onSelect: (id: string) => void;
  selected: Activity | null;
  tracking: Tracking | null;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <Panel title="Which activity">
        <Field label="Activity">
          <select
            className={INPUT_CLASS}
            onChange={(event) => onSelect(event.target.value)}
            value={selected?.id ?? ""}
          >
            <option value="">Pick an activity</option>
            {activities.map((activity) => (
              <option key={activity.id} value={activity.id}>
                {(activity.title?.trim() || activity.activityType.name) +
                  " — " +
                  (activity.areaName ?? activity.areaCode)}
              </option>
            ))}
          </select>
        </Field>
      </Panel>

      {!selected ? null : (
        <Panel title="What was approved">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              ["Activity", selected.title?.trim() || selected.activityType.name],
              ["Type", selected.activityType.name],
              ["Primary line", selected.primaryLine.name],
              ["Where", `${selected.areaName ?? selected.areaCode} · ${selected.regionName ?? ""}`],
              ["Starts", cairoDate(selected.startDate)],
              ["Approved value", money(selected.approvedCost ?? selected.estimatedCost, selected.currency)],
              ["Window", `${selected.durationMonths} months, against ${selected.baselineMonths} before`],
              ["Products", selected.products.map((p) => p.productName ?? p.productCode).join(", ") || "None"],
              ["Finance", selected.financePaid ? "Marked paid" : "Not marked paid"],
            ].map(([label, value]) => (
              <div className="border border-slate-200 bg-slate-50 px-3 py-2" key={label}>
                <dt className="text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-500">{label}</dt>
                <dd className="mt-0.5 break-words text-phx-sm font-black text-slate-900">{value}</dd>
              </div>
            ))}
          </dl>

          {/* Owner answer 33: show today's holder, and say plainly when it is not who it was. */}
          {selected.rep.replacedOriginal ? (
            <p className="mt-3 border border-amber-300 bg-amber-50 px-3 py-2 text-phx-sm font-bold text-amber-900">
              The medical rep here is now {selected.rep.name ?? "vacant"}.{" "}
              {selected.rep.originalName ?? "The original rep"} held this area when the activity was
              approved and has since been replaced.
            </p>
          ) : selected.rep.vacant ? (
            <p className="mt-3 border border-slate-300 bg-slate-50 px-3 py-2 text-phx-sm font-bold text-slate-700">
              This area is vacant — will hire. The district manager still receives the activity.
            </p>
          ) : null}
        </Panel>
      )}

      {selected && !tracking ? (
        <Panel title="Sales">
          <p className="text-phx-sm font-bold text-slate-500">Loading the sales for this activity.</p>
        </Panel>
      ) : null}

      {tracking ? (
        <>
          {tracking.windowIncompleteReason ? (
            <div className="border border-sky-300 bg-sky-50 px-4 py-3">
              <p className="text-phx-sm font-bold text-sky-900">{tracking.windowIncompleteReason}</p>
            </div>
          ) : null}

          {tracking.series.map((series) => (
            <Panel key={series.line.id} title={`${series.line.name} — brick and area`}>
              <TrackingTable
                baselinePeriods={tracking.baselinePeriods}
                series={series}
                windowPeriods={tracking.windowPeriods}
              />
            </Panel>
          ))}

          {tracking.reconciliation.some((row) => !row.reconciled) ? (
            <div className="border border-amber-300 bg-amber-50 px-4 py-3">
              <p className="text-phx-sm font-bold text-amber-900">
                Some months do not reconcile against the published closing — the bricks of this area
                do not add up to the area total. The months affected are{" "}
                {tracking.reconciliation
                  .filter((row) => !row.reconciled)
                  .map((row) => monthLabel(row.period))
                  .join(", ")}
                . That gap is value the source data could not place in any brick; the area figure is
                still the published one.
              </p>
            </div>
          ) : (
            <p className="text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-500">
              Every month reconciles against the published Monthly Closing.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}

function TrackingTable({
  baselinePeriods,
  series,
  windowPeriods,
}: {
  baselinePeriods: string[];
  series: { brick: TrackingPoint[]; area: TrackingPoint[] };
  windowPeriods: string[];
}) {
  const allPeriods = [...baselinePeriods, ...windowPeriods];
  const baselineCount = baselinePeriods.length;

  const sum = (points: TrackingPoint[], from: number, to: number) =>
    points.slice(from, to).reduce((total, point) => total + point.totalValue, 0);

  const brickBefore = sum(series.brick, 0, baselineCount);
  const brickAfter = sum(series.brick, baselineCount, allPeriods.length);
  const areaBefore = sum(series.area, 0, baselineCount);
  const areaAfter = sum(series.area, baselineCount, allPeriods.length);

  const change = (before: number, after: number) => {
    if (before <= 0) return "No baseline";
    const pct = ((after - before) / before) * 100;
    return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
  };

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[
          ["Brick before", money(brickBefore)],
          ["Brick during the window", `${money(brickAfter)} (${change(brickBefore, brickAfter)})`],
          ["Area before", money(areaBefore)],
          ["Area during the window", `${money(areaAfter)} (${change(areaBefore, areaAfter)})`],
        ].map(([label, value]) => (
          <div className="border border-slate-200 bg-slate-50 px-3 py-2" key={label}>
            <dt className="text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-500">{label}</dt>
            <dd className="mt-0.5 break-words text-phx-sm font-black text-slate-900">{value}</dd>
          </div>
        ))}
      </dl>

      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col style={{ width: "34%" }} />
          <col style={{ width: "33%" }} />
          <col style={{ width: "33%" }} />
        </colgroup>
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50">
            {["Month", "Brick", "Area"].map((heading) => (
              <th
                className="px-2 py-2 text-left text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-500"
                key={heading}
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {allPeriods.map((period, index) => {
            const isWindow = index >= baselineCount;
            return (
              <tr
                className={
                  isWindow
                    ? "border-b border-slate-100 bg-sky-50/60"
                    : "border-b border-slate-100"
                }
                key={period}
              >
                <td className="break-words px-2 py-2 text-phx-sm font-bold text-slate-700">
                  {monthLabel(period)}
                  <span className="mt-0.5 block text-phx-2xs font-medium text-slate-500">
                    {isWindow ? "In the window" : "Baseline"}
                  </span>
                </td>
                <td className="break-words px-2 py-2 text-phx-sm font-bold text-slate-800">
                  {money(series.brick[index]?.totalValue ?? 0)}
                </td>
                <td className="break-words px-2 py-2 text-phx-sm font-bold text-slate-800">
                  {money(series.area[index]?.totalValue ?? 0)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ActivityForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [types, setTypes] = useState<ActivityType[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [bricks, setBricks] = useState<BrickOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [activityTypeId, setActivityTypeId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [venue, setVenue] = useState("");
  const [city, setCity] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [expectedAttendees, setExpectedAttendees] = useState("");
  const [speakers, setSpeakers] = useState("");
  const [primaryLineId, setPrimaryLineId] = useState<number | null>(null);
  const [extraLineIds, setExtraLineIds] = useState<number[]>([]);
  const [productCodes, setProductCodes] = useState<string[]>([]);
  const [regionCode, setRegionCode] = useState("");
  const [areaCode, setAreaCode] = useState("");
  const [primaryBrickId, setPrimaryBrickId] = useState("");
  const [extraBrickIds, setExtraBrickIds] = useState<string[]>([]);
  const [estimatedCost, setEstimatedCost] = useState("");
  const [durationMonths, setDurationMonths] = useState("3");
  const [baselineMonths, setBaselineMonths] = useState("3");
  const [expectedUpliftPct, setExpectedUpliftPct] = useState("");

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/market-awareness/options", { cache: "no-store" });
      const payload = await response.json();
      if (payload.success) {
        setTypes(payload.activityTypes ?? []);
        setLines(payload.lines ?? []);
      }
    })();
  }, []);

  const primaryLine = useMemo(
    () => lines.find((line) => line.id === primaryLineId) ?? null,
    [lines, primaryLineId],
  );

  // The cascade is driven by the PRIMARY line: the region map is per line, so an area sits in a
  // different region depending on which line you ask.
  useEffect(() => {
    void (async () => {
      if (!primaryLine) {
        setRegions([]);
        setProducts([]);
        return;
      }
      const response = await fetch(
        `/api/market-awareness/options?lineCode=${encodeURIComponent(primaryLine.lineCode)}`,
        { cache: "no-store" },
      );
      const payload = await response.json();
      if (payload.success) {
        setRegions(payload.regions ?? []);
        setProducts(payload.products ?? []);
      }
    })();
    // The region and area resets live in the line picker's onChange, not here. Changing the line is
    // what invalidates them, and doing it in the handler keeps this effect free of a synchronous
    // setState.
  }, [primaryLine]);

  useEffect(() => {
    void (async () => {
      if (!areaCode) {
        setBricks([]);
        return;
      }
      const response = await fetch(
        `/api/market-awareness/options?areaCode=${encodeURIComponent(areaCode)}`,
        { cache: "no-store" },
      );
      const payload = await response.json();
      if (payload.success) setBricks(payload.bricks ?? []);
    })();
    // Brick resets live in the area picker's onChange, for the same reason as above.
  }, [areaCode]);

  const areas = useMemo(
    () => regions.find((region) => region.regionCode === regionCode)?.areas ?? [],
    [regionCode, regions],
  );
  const selectedArea = useMemo(
    () => areas.find((area) => area.areaCode === areaCode) ?? null,
    [areaCode, areas],
  );

  const submit = async () => {
    setSaving(true);
    setFormError(null);
    try {
      const lineIds = [...new Set([primaryLineId, ...extraLineIds].filter((id): id is number => id !== null))];
      const response = await fetch("/api/market-awareness", {
        body: JSON.stringify({
          activityTypeId,
          areaCode,
          baselineMonths: Number(baselineMonths),
          brickIds: [...new Set([primaryBrickId, ...extraBrickIds])].filter(Boolean),
          city: city.trim() || null,
          durationMonths: Number(durationMonths),
          endDate: endDate || null,
          estimatedCost: Number(estimatedCost),
          expectedAttendees: expectedAttendees ? Number(expectedAttendees) : null,
          expectedUpliftPct: expectedUpliftPct ? Number(expectedUpliftPct) : null,
          lineIds,
          primaryBrickId,
          primaryLineId,
          productCodes: productCodes.map((code) => {
            const product = products.find((entry) => entry.productCode === code);
            return {
              lineId: primaryLineId,
              productCode: code,
              productName: product?.productName ?? null,
            };
          }),
          regionCode,
          speakers: speakers.trim() || null,
          startDate,
          title: title.trim() || null,
          venue: venue.trim() || null,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok || payload.success === false) {
        throw new Error(payload.message ?? "Could not create the activity.");
      }
      onCreated();
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Could not create the activity.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title="New awareness activity">
      <div className="flex w-full min-w-0 flex-col gap-4">
        {formError ? (
          <p className="border border-amber-300 bg-amber-50 px-3 py-2 text-phx-sm font-bold text-amber-900">
            {formError}
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Activity type">
            <select
              className={INPUT_CLASS}
              onChange={(event) => setActivityTypeId(Number(event.target.value) || null)}
              value={activityTypeId ?? ""}
            >
              <option value="">Pick a type</option>
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </Field>

          <Field hint="Optional, but it is what makes this findable in a year." label="Title">
            <input className={INPUT_CLASS} onChange={(e) => setTitle(e.target.value)} value={title} />
          </Field>

          <Field
            hint="Drives the region list and the sales tracking. Several lines can be targeted, but only one orders the geography."
            label="Primary line"
          >
            <select
              className={INPUT_CLASS}
              onChange={(event) => {
                setPrimaryLineId(Number(event.target.value) || null);
                // Changing the line invalidates the geography below it: the region map is per line.
                setRegionCode("");
                setAreaCode("");
                setPrimaryBrickId("");
                setExtraBrickIds([]);
              }}
              value={primaryLineId ?? ""}
            >
              <option value="">Pick the primary line</option>
              {lines.map((line) => (
                <option key={line.id} value={line.id}>
                  {line.name}
                </option>
              ))}
            </select>
          </Field>

          <Field hint="Optional. Reported apart from the primary line, never added to it." label="Other lines targeted">
            <select
              className="min-h-24 w-full border border-slate-200 bg-white px-3 py-2 text-phx-md font-bold text-slate-800"
              multiple
              onChange={(event) =>
                setExtraLineIds(Array.from(event.target.selectedOptions, (option) => Number(option.value)))
              }
              value={extraLineIds.map(String)}
            >
              {lines
                .filter((line) => line.id !== primaryLineId)
                .map((line) => (
                  <option key={line.id} value={line.id}>
                    {line.name}
                  </option>
                ))}
            </select>
          </Field>

          <Field label="Region">
            <select
              className={INPUT_CLASS}
              disabled={!primaryLine}
              onChange={(event) => {
                setRegionCode(event.target.value);
                setAreaCode("");
              }}
              value={regionCode}
            >
              <option value="">{primaryLine ? "Pick a region" : "Pick the primary line first"}</option>
              {regions.map((region) => (
                <option key={region.regionCode} value={region.regionCode}>
                  {region.regionName}
                </option>
              ))}
            </select>
          </Field>

          <Field
            hint={
              selectedArea
                ? selectedArea.repVacant
                  ? "Medical rep: Vacant — will hire"
                  : `Medical rep: ${selectedArea.repName ?? "Not recorded"}`
                : undefined
            }
            label="Area"
          >
            <select
              className={INPUT_CLASS}
              disabled={!regionCode}
              onChange={(event) => {
                setAreaCode(event.target.value);
                setPrimaryBrickId("");
                setExtraBrickIds([]);
              }}
              value={areaCode}
            >
              <option value="">{regionCode ? "Pick an area" : "Pick a region first"}</option>
              {areas.map((area) => (
                // Non-territory areas are SHOWN and disabled rather than hidden (owner answer 30) —
                // a greyed row with a reason beats a list that silently lacks what someone expects.
                <option disabled={!area.selectable} key={area.areaCode} value={area.areaCode}>
                  {area.areaName}
                  {area.selectable ? (area.repVacant ? " — vacant, will hire" : "") : " — not a territory"}
                </option>
              ))}
            </select>
          </Field>

          <Field hint="The brick the activity is held in. Its sales are tracked separately from the area." label="Main brick">
            <select
              className={INPUT_CLASS}
              disabled={!areaCode}
              onChange={(event) => setPrimaryBrickId(event.target.value)}
              value={primaryBrickId}
            >
              <option value="">{areaCode ? "Pick the main brick" : "Pick an area first"}</option>
              {bricks.map((brick) => (
                <option key={brick.brickId} value={brick.brickId}>
                  {brick.brickName}
                </option>
              ))}
            </select>
          </Field>

          <Field hint="Optional. Other bricks the activity is expected to reach." label="Other bricks">
            <select
              className="min-h-24 w-full border border-slate-200 bg-white px-3 py-2 text-phx-md font-bold text-slate-800"
              multiple
              onChange={(event) =>
                setExtraBrickIds(Array.from(event.target.selectedOptions, (option) => option.value))
              }
              value={extraBrickIds}
            >
              {bricks
                .filter((brick) => brick.brickId !== primaryBrickId)
                .map((brick) => (
                  <option key={brick.brickId} value={brick.brickId}>
                    {brick.brickName}
                  </option>
                ))}
            </select>
          </Field>

          <Field
            hint="Head Office products are not offered — they are absent from monthly closing tracking, so they could never show a figure."
            label="Targeted products"
          >
            <select
              className="min-h-32 w-full border border-slate-200 bg-white px-3 py-2 text-phx-md font-bold text-slate-800"
              multiple
              onChange={(event) =>
                setProductCodes(Array.from(event.target.selectedOptions, (option) => option.value))
              }
              value={productCodes}
            >
              {products.map((product) => (
                <option key={product.productCode} value={product.productCode}>
                  {product.productName}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Estimated cost (EGP)">
            <input
              className={INPUT_CLASS}
              inputMode="decimal"
              onChange={(event) => setEstimatedCost(event.target.value)}
              value={estimatedCost}
            />
          </Field>

          <Field label="Start date">
            <input
              className={INPUT_CLASS}
              onChange={(event) => setStartDate(event.target.value)}
              type="date"
              value={startDate}
            />
          </Field>

          <Field hint="Optional." label="End date">
            <input
              className={INPUT_CLASS}
              onChange={(event) => setEndDate(event.target.value)}
              type="date"
              value={endDate}
            />
          </Field>

          <Field hint="How many months you expect awareness, and then sales, to rise for." label="Measurement window (months)">
            <input
              className={INPUT_CLASS}
              inputMode="numeric"
              onChange={(event) => setDurationMonths(event.target.value)}
              value={durationMonths}
            />
          </Field>

          <Field hint="Months before the activity, to judge the rise against." label="Baseline (months)">
            <input
              className={INPUT_CLASS}
              inputMode="numeric"
              onChange={(event) => setBaselineMonths(event.target.value)}
              value={baselineMonths}
            />
          </Field>

          <Field hint="Optional." label="Expected uplift (%)">
            <input
              className={INPUT_CLASS}
              inputMode="decimal"
              onChange={(event) => setExpectedUpliftPct(event.target.value)}
              value={expectedUpliftPct}
            />
          </Field>

          <Field hint="Optional." label="Venue">
            <input className={INPUT_CLASS} onChange={(e) => setVenue(e.target.value)} value={venue} />
          </Field>

          <Field hint="Optional." label="City">
            <input className={INPUT_CLASS} onChange={(e) => setCity(e.target.value)} value={city} />
          </Field>

          <Field hint="Optional." label="Expected attendees">
            <input
              className={INPUT_CLASS}
              inputMode="numeric"
              onChange={(event) => setExpectedAttendees(event.target.value)}
              value={expectedAttendees}
            />
          </Field>

          <Field hint="Optional." label="Speakers">
            <input className={INPUT_CLASS} onChange={(e) => setSpeakers(e.target.value)} value={speakers} />
          </Field>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            className="border border-slate-900 bg-slate-900 px-4 py-2.5 text-phx-sm font-black uppercase tracking-[0.08em] text-white disabled:opacity-50"
            disabled={saving}
            onClick={() => void submit()}
            type="button"
          >
            {saving ? "Saving" : "Save as draft"}
          </button>
          <button
            className="border border-slate-300 bg-white px-4 py-2.5 text-phx-sm font-black uppercase tracking-[0.08em] text-slate-600"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>
    </Panel>
  );
}
