"use client";

import { ImageOff, MapPin, ShoppingBag, Sparkles, Store, UserRound, Users } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { ZoomHint, ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { cn } from "@/lib/utils";
import {
  ALL,
  applyCaptureFilter,
  distinctPeople,
  EMPTY_CAPTURE_FILTER,
  type CaptureFilter,
} from "@/lib/verified-captures/filters";
import type {
  VerifiedCaptureLocation,
  VerifiedDirectOrderCaptureRow,
  VerifiedMarketingCaptureRow,
} from "@/lib/verified-captures/types";

import {
  PortalEmptyState,
  PortalFilterBar,
  PortalMetricCard,
  PortalRecordCard,
  PortalResponsiveDataList,
  PortalSection,
  PortalSkeleton,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";

// ─────────────────────────────────────────────────────────────────────────────
// Verified Captures — the Super Admin gallery of every customer captured in the field.
//
// Two tabs, one shape each: Direct Orders and validated Marketing Requests. Every row leads with the
// live photo and the location — the two things the owner asked to see first — and every row can be
// filtered by rep and by district manager. Photos open full-screen through `ZoomablePhoto`; the
// design follows the sibling admin surfaces (square edges, Phoenix orange, mobile cards / desktop
// tables, no horizontal scroll, names never codes, Cairo times).
// ─────────────────────────────────────────────────────────────────────────────

type TabKey = "direct-orders" | "marketing";

const TABS: Array<{ key: TabKey; label: string; icon: typeof ShoppingBag }> = [
  { key: "direct-orders", label: "Direct Orders", icon: ShoppingBag },
  { key: "marketing", label: "Marketing Requests", icon: Sparkles },
];

function TabButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: typeof ShoppingBag;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded px-3 py-2 text-sm font-black transition sm:flex-none",
        active
          ? "bg-orange-500 text-white shadow-[0_8px_20px_rgba(249,115,22,0.28)]"
          : "text-slate-600 hover:bg-white hover:text-slate-900",
      )}
      onClick={onClick}
      type="button"
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

/** A signed-URL photo, or an honest "no photo" tile — never a broken image icon. */
function PhotoTile({ alt, caption, label, src }: { alt: string; caption?: string | null; label: string; src: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="min-w-0">
      <p className="mb-1 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      {src && !failed ? (
        <div className="relative overflow-hidden rounded border border-slate-200 bg-slate-50">
          <ZoomablePhoto
            alt={alt}
            caption={caption ?? alt}
            className="h-40 w-full object-cover"
            onError={() => setFailed(true)}
            src={src}
          />
          <ZoomHint className="absolute bottom-1 right-1 rounded" />
        </div>
      ) : (
        <div className="flex h-40 w-full flex-col items-center justify-center gap-1 rounded border border-dashed border-slate-200 bg-slate-50 text-slate-400">
          <ImageOff className="h-5 w-5" />
          <span className="text-phx-2xs font-black uppercase tracking-[0.14em]">No photo on file</span>
        </div>
      )}
    </div>
  );
}

/** Coordinates + address, with a maps link when there is a pin. Matches the validation-desk idiom. */
function LocationBlock({ heading = "Location", location }: { heading?: string; location: VerifiedCaptureLocation }) {
  const hasPin = location.latitude !== null && location.longitude !== null;
  return (
    <div className="rounded border border-slate-100 bg-slate-50 px-3 py-2">
      <p className="flex items-center gap-1 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">
        <MapPin className="h-3 w-3" />
        {heading}
      </p>
      {location.address ? (
        <p className="mt-1 break-words text-xs font-bold text-slate-800">{location.address}</p>
      ) : null}
      {hasPin ? (
        <a
          className="mt-1 inline-flex items-center gap-1 break-all text-xs font-black text-orange-600 hover:text-orange-700 hover:underline"
          href={`https://www.google.com/maps?q=${location.latitude},${location.longitude}`}
          rel="noreferrer"
          target="_blank"
        >
          {location.latitude?.toFixed(5)}, {location.longitude?.toFixed(5)}
        </a>
      ) : location.address ? null : (
        <p className="mt-1 text-xs font-bold text-slate-400">No location captured</p>
      )}
    </div>
  );
}

function FieldPair({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded border border-slate-100 bg-slate-50 px-2.5 py-2">
      <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">{label}</dt>
      <dd className="mt-0.5 min-w-0 break-words text-xs font-bold text-slate-800">{value ?? "—"}</dd>
    </div>
  );
}

/** The rep + district-manager + search filter row, shared by both tabs. */
function CaptureFilters({
  filter,
  managers,
  reps,
  onChange,
  countLabel,
}: {
  filter: CaptureFilter;
  managers: Array<{ hrId: string; name: string }>;
  reps: Array<{ hrId: string; name: string }>;
  onChange: (next: CaptureFilter) => void;
  countLabel: string;
}) {
  return (
    <PortalFilterBar countLabel={countLabel}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="min-w-0 space-y-1">
          <span className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">Rep</span>
          <select
            className={portalInputClassName}
            onChange={(event) => onChange({ ...filter, rep: event.target.value })}
            value={filter.rep}
          >
            <option value={ALL}>All reps</option>
            {reps.map((rep) => (
              <option key={rep.hrId} value={rep.hrId}>
                {rep.name}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 space-y-1">
          <span className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">District manager</span>
          <select
            className={portalInputClassName}
            onChange={(event) => onChange({ ...filter, manager: event.target.value })}
            value={filter.manager}
          >
            <option value={ALL}>All managers</option>
            {managers.map((manager) => (
              <option key={manager.hrId} value={manager.hrId}>
                {manager.name}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 space-y-1">
          <span className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">Search</span>
          <input
            className={portalInputClassName}
            onChange={(event) => onChange({ ...filter, search: event.target.value })}
            placeholder="Name, code or address"
            type="search"
            value={filter.search}
          />
        </label>
      </div>
    </PortalFilterBar>
  );
}

async function fetchRows<T>(url: string): Promise<T[]> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Request failed (${response.status}).`);
  }
  const body = (await response.json()) as { rows?: T[] };
  return body.rows ?? [];
}

function useCaptures<T>(url: string, enabled: boolean) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || rows !== null || error !== null) return;
    let alive = true;
    fetchRows<T>(url)
      .then((data) => {
        if (alive) setRows(data);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : "Could not load captures.");
      });
    return () => {
      alive = false;
    };
  }, [enabled, error, rows, url]);

  return { error, rows } as const;
}

// ── Marketing tab ────────────────────────────────────────────────────────────

function marketingSearchText(row: VerifiedMarketingCaptureRow): string {
  return [
    row.displayName,
    row.customerCode,
    row.areaName,
    row.lineName,
    row.governorate,
    row.location.address,
    ...row.pharmacies.map((pharmacy) => pharmacy.displayName),
    ...row.pharmacies.map((pharmacy) => pharmacy.location.address),
  ]
    .filter(Boolean)
    .join(" ");
}

function MarketingCaptureBody({ row }: { row: VerifiedMarketingCaptureRow }) {
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-2">
        <FieldPair label="Rep" value={row.repName ?? "—"} />
        <FieldPair label="District manager" value={row.managerName ?? "—"} />
        <FieldPair label="Line" value={row.lineName ?? "—"} />
        <FieldPair label="Area" value={row.areaName ?? "—"} />
        <FieldPair label="Governorate" value={row.governorate ?? "—"} />
        <FieldPair label="Captured" value={row.capturedAt ? cairoDateTime(row.capturedAt) : "—"} />
      </dl>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <PhotoTile alt={`${row.displayName} — customer`} caption={row.displayName} label="Customer photo" src={row.photoUrl} />
        <LocationBlock heading="Customer location" location={row.location} />
      </div>

      <div className="space-y-2">
        <p className="flex items-center gap-1 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
          <Store className="h-3 w-3" />
          Pharmacies ({row.pharmacyCount})
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {row.pharmacies.map((pharmacy) => (
            <div className="space-y-2 rounded border border-slate-100 bg-white p-2" key={pharmacy.id}>
              <p className="break-words text-xs font-black text-slate-900">{pharmacy.displayName}</p>
              <PhotoTile
                alt={`${pharmacy.displayName} — pharmacy`}
                caption={pharmacy.displayName}
                label="Pharmacy photo"
                src={pharmacy.photoUrl}
              />
              <LocationBlock heading="Pharmacy location" location={pharmacy.location} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MarketingTab({ rows }: { rows: VerifiedMarketingCaptureRow[] }) {
  const [filter, setFilter] = useState<CaptureFilter>(EMPTY_CAPTURE_FILTER);

  const filterable = useMemo(
    () => rows.map((row) => ({ ...row, searchText: marketingSearchText(row) })),
    [rows],
  );
  const reps = useMemo(() => distinctPeople(filterable, "rep"), [filterable]);
  const managers = useMemo(() => distinctPeople(filterable, "manager"), [filterable]);
  const filtered = useMemo(() => applyCaptureFilter(filterable, filter), [filterable, filter]);

  const withPhoto = filtered.filter((row) => row.photoUrl).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <PortalMetricCard accent="orange" icon={Sparkles} label="Verified customers" value={rows.length} />
        <PortalMetricCard accent="sky" icon={UserRound} label="Reps" value={reps.length} />
        <PortalMetricCard accent="emerald" icon={Users} label="District managers" value={managers.length} />
        <PortalMetricCard accent="amber" icon={Store} label="With customer photo" value={withPhoto} />
      </div>

      <CaptureFilters
        countLabel={`${filtered.length} of ${rows.length} shown`}
        filter={filter}
        managers={managers}
        onChange={setFilter}
        reps={reps}
      />

      <PortalSection className="overflow-hidden">
        <PortalResponsiveDataList
          empty={
            <PortalEmptyState
              message="No verified marketing customers match these filters yet — a customer appears here once his live photo and every linked pharmacy's photo and location are captured."
              title="Nothing to show"
            />
          }
          getKey={(row) => row.id}
          items={filtered}
          renderCard={(row) => (
            <PortalRecordCard
              accent="orange"
              meta={`${row.customerCode ?? "—"} · ${row.repName ?? "rep unknown"}`}
              title={row.displayName}
            >
              <MarketingCaptureBody row={row} />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <div className="hidden divide-y divide-slate-100 md:block">
              {filtered.map((row) => (
                <div className="px-4 py-4" key={row.id}>
                  <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-base font-black text-slate-950">{row.displayName}</h3>
                    <span className="text-xs font-bold text-slate-500">{row.customerCode ?? "—"}</span>
                  </div>
                  <MarketingCaptureBody row={row} />
                </div>
              ))}
            </div>
          )}
        />
      </PortalSection>
    </div>
  );
}

// ── Direct Orders tab ──────────────────────────────────────────────────────────

function directOrderSearchText(row: VerifiedDirectOrderCaptureRow): string {
  return [row.pharmacyName, row.pharmacyCode, row.location.address].filter(Boolean).join(" ");
}

function routeLabel(route: VerifiedDirectOrderCaptureRow["route"]): string {
  return route === "invoice" ? "Invoice" : "Field capture";
}

function DirectOrderCaptureBody({ row }: { row: VerifiedDirectOrderCaptureRow }) {
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-2">
        <FieldPair label="Rep" value={row.repName ?? "—"} />
        <FieldPair label="District manager" value={row.managerName ?? "—"} />
        <FieldPair label="Route" value={routeLabel(row.route)} />
        <FieldPair label="Verified" value={row.verifiedAt ? cairoDateTime(row.verifiedAt) : "—"} />
        <FieldPair label="Verified by" value={row.verifiedByName ?? "—"} />
        <FieldPair label="Code" value={row.pharmacyCode ?? "—"} />
      </dl>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {row.route === "invoice" ? (
          <div className="min-w-0">
            <p className="mb-1 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">Distributor invoice</p>
            {row.invoiceUrl ? (
              row.invoiceIsPdf ? (
                <a
                  className="flex h-40 w-full flex-col items-center justify-center gap-1 rounded border border-slate-200 bg-slate-50 text-orange-600 hover:bg-orange-50"
                  href={row.invoiceUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ShoppingBag className="h-5 w-5" />
                  <span className="text-phx-2xs font-black uppercase tracking-[0.14em]">Open invoice PDF</span>
                </a>
              ) : (
                <div className="overflow-hidden rounded border border-slate-200 bg-slate-50">
                  <ZoomablePhoto alt="Distributor invoice" caption="Distributor invoice" className="h-40 w-full object-cover" src={row.invoiceUrl} />
                </div>
              )
            ) : (
              <div className="flex h-40 w-full flex-col items-center justify-center gap-1 rounded border border-dashed border-slate-200 bg-slate-50 text-slate-400">
                <ImageOff className="h-5 w-5" />
                <span className="text-phx-2xs font-black uppercase tracking-[0.14em]">No invoice on file</span>
              </div>
            )}
          </div>
        ) : (
          <PhotoTile alt={`${row.pharmacyName} — storefront`} caption={row.pharmacyName} label="Storefront photo" src={row.photoUrl} />
        )}
        <LocationBlock location={row.location} />
      </div>

      {row.licenseUrl ? (
        <a
          className="inline-flex items-center gap-1 text-xs font-black text-orange-600 hover:text-orange-700 hover:underline"
          href={row.licenseUrl}
          rel="noreferrer"
          target="_blank"
        >
          Trade licence on file — open
        </a>
      ) : null}
    </div>
  );
}

function DirectOrdersTab({ rows }: { rows: VerifiedDirectOrderCaptureRow[] }) {
  const [filter, setFilter] = useState<CaptureFilter>(EMPTY_CAPTURE_FILTER);

  const filterable = useMemo(
    () => rows.map((row) => ({ ...row, searchText: directOrderSearchText(row) })),
    [rows],
  );
  const reps = useMemo(() => distinctPeople(filterable, "rep"), [filterable]);
  const managers = useMemo(() => distinctPeople(filterable, "manager"), [filterable]);
  const filtered = useMemo(() => applyCaptureFilter(filterable, filter), [filterable, filter]);

  const fieldCount = filtered.filter((row) => row.route === "field").length;
  const invoiceCount = filtered.filter((row) => row.route === "invoice").length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <PortalMetricCard accent="orange" icon={ShoppingBag} label="Verified pharmacies" value={rows.length} />
        <PortalMetricCard accent="sky" icon={UserRound} label="Reps" value={reps.length} />
        <PortalMetricCard accent="emerald" icon={MapPin} label="Field captures" value={fieldCount} />
        <PortalMetricCard accent="amber" icon={Store} label="By invoice" value={invoiceCount} />
      </div>

      <CaptureFilters
        countLabel={`${filtered.length} of ${rows.length} shown`}
        filter={filter}
        managers={managers}
        onChange={setFilter}
        reps={reps}
      />

      <PortalSection className="overflow-hidden">
        <PortalResponsiveDataList
          empty={
            <PortalEmptyState
              message="No verified direct-order pharmacies match these filters — this tab shows pharmacies the desk confirmed in the field or by distributor invoice."
              title="Nothing to show"
            />
          }
          getKey={(row) => row.id}
          items={filtered}
          renderCard={(row) => (
            <PortalRecordCard
              accent={row.route === "invoice" ? "amber" : "orange"}
              meta={`${routeLabel(row.route)} · ${row.repName ?? "rep unknown"}`}
              title={row.pharmacyName}
            >
              <DirectOrderCaptureBody row={row} />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <div className="hidden divide-y divide-slate-100 md:block">
              {filtered.map((row) => (
                <div className="px-4 py-4" key={row.id}>
                  <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-base font-black text-slate-950">{row.pharmacyName}</h3>
                    <span className="text-xs font-bold text-slate-500">{routeLabel(row.route)}</span>
                  </div>
                  <DirectOrderCaptureBody row={row} />
                </div>
              ))}
            </div>
          )}
        />
      </PortalSection>
    </div>
  );
}

// ── Shell ──────────────────────────────────────────────────────────────────────

function TabLoading() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <PortalSkeleton className="h-20" key={index} />
        ))}
      </div>
      <PortalSkeleton className="h-24" />
      <PortalSkeleton className="h-64" />
    </div>
  );
}

function TabError({ message }: { message: string }) {
  return (
    <PortalSection className="overflow-hidden">
      <PortalEmptyState message={message} title="Could not load captures" />
    </PortalSection>
  );
}

export function VerifiedCapturesWorkspace() {
  const [tab, setTab] = useState<TabKey>("direct-orders");

  const directOrders = useCaptures<VerifiedDirectOrderCaptureRow>(
    "/api/verified-captures/direct-orders",
    tab === "direct-orders",
  );
  const marketing = useCaptures<VerifiedMarketingCaptureRow>(
    "/api/verified-captures/marketing",
    tab === "marketing",
  );

  return (
    <div className="space-y-4">
      <div className="flex w-full gap-1 rounded border border-slate-200 bg-slate-50 p-1">
        {TABS.map((entry) => (
          <TabButton
            active={tab === entry.key}
            icon={entry.icon}
            key={entry.key}
            label={entry.label}
            onClick={() => setTab(entry.key)}
          />
        ))}
      </div>

      {tab === "direct-orders" ? (
        directOrders.error ? (
          <TabError message={directOrders.error} />
        ) : directOrders.rows === null ? (
          <TabLoading />
        ) : (
          <DirectOrdersTab rows={directOrders.rows} />
        )
      ) : marketing.error ? (
        <TabError message={marketing.error} />
      ) : marketing.rows === null ? (
        <TabLoading />
      ) : (
        <MarketingTab rows={marketing.rows} />
      )}
    </div>
  );
}
