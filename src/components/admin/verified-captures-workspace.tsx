"use client";

import {
  ArrowUpDown,
  Building2,
  Check,
  Database,
  ImageOff,
  MapPin,
  ShoppingBag,
  Sparkles,
  Store,
  TriangleAlert,
  UserRound,
  Users,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { ZoomHint, ZoomablePhoto } from "@/components/ui/zoomable-photo";
import type { CaptureTrustAssessment, CaptureTrustVerdict } from "@/lib/evidence/capture-trust";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { cn } from "@/lib/utils";
import {
  ALL,
  applyCaptureFilter,
  distinctMonths,
  distinctPeople,
  distinctValues,
  EMPTY_CAPTURE_FILTER,
  type CaptureFilter,
} from "@/lib/verified-captures/filters";
import type {
  VerifiedCaptureDistributorCode,
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
      <p className="mb-1 text-phx-sm font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
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
          <span className="text-phx-sm font-black uppercase tracking-[0.14em]">No photo on file</span>
        </div>
      )}
    </div>
  );
}

/** One labelled part of a location — "Brick شبين الكوم" — rendered only when it has a value. */
function LocationDetail({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <span className="text-phx-sm font-black uppercase tracking-[0.1em] text-slate-400">{label} </span>
      <span className="break-words text-xs font-bold text-slate-800">{value}</span>
    </div>
  );
}

/**
 * The location shown BOTH raw and broken apart (owner, 2026-09-25: "make the customer location raw as
 * it is and also separate it to brick, area, gov, clean address"). The raw captured string leads,
 * unedited; the clean address is shown only when it differs from the raw; then brick / area / region /
 * governorate as their own fields; then the pin as a maps link.
 */
/**
 * THE PHOTO MEASURED AGAINST ITS OWN RECORD’S LOCATION FIX.
 *
 * Two independent GPS readings - one taken when the pin was captured, one at the shutter. Before
 * 2026-09-29 there was only ever ONE reading, copied onto both, so the distance was structurally
 * zero and this panel could not have existed. See src/lib/evidence/capture-trust.ts.
 *
 * “Not measured” is the common answer and the honest one, and it is rendered in the SAME neutral
 * ink as a match on purpose: every capture before that date has no photo coordinates, and reading
 * an absent measurement as suspicion would accuse people the system simply never measured.
 *
 * Integrity signal - Super Admin surface only (AGENTS.md §4, golden rule #1). It is never shown to
 * the person who took the photo, and it is where to look, never a verdict and never an action.
 */
function PhotoTrustBlock({ trust }: { trust: CaptureTrustAssessment }) {
  const wording: Record<CaptureTrustVerdict, { ink: string; text: string }> = {
    agrees: { ink: "text-slate-700", text: "Photo taken at the captured location" },
    disagrees: { ink: "text-rose-700", text: "Photo not taken at the captured location" },
    drifted: { ink: "text-amber-700", text: "Photo taken away from the captured location" },
    unmeasured: { ink: "text-slate-500", text: "Captured before the camera took its own reading (29 Sep 2026)" },
  };
  const { ink } = wording[trust.verdict];
  // An unmeasured capture says WHY, because “not measured” alone makes a 2026-07 row look like a
  // camera that just failed. Both wordings are neutral and neither is a finding: one is a fact
  // about Phoenix (the feature did not exist yet), the other a fact about that handset.
  const text =
    trust.verdict !== "unmeasured"
      ? wording[trust.verdict].text
      : trust.unmeasuredReason === "no_position_recorded"
        ? "No position was recorded with this photo"
        : wording.unmeasured.text;
  const metres = trust.distanceMeters === null
    ? null
    : trust.distanceMeters < 1000
      ? Math.round(trust.distanceMeters) + " m apart"
      : (trust.distanceMeters / 1000).toFixed(1) + " km apart";
  const gap = trust.gapSeconds === null
    ? null
    : Math.abs(trust.gapSeconds) < 90
      ? Math.round(Math.abs(trust.gapSeconds)) + "s between the location and the photo"
      : Math.round(Math.abs(trust.gapSeconds) / 60) + " min between the location and the photo";
  return (
    <div className="space-y-0.5 rounded-none border-l-2 border-slate-200 pl-2">
      <p className="text-phx-sm font-black uppercase tracking-[0.14em] text-slate-500">Photo vs location</p>
      {/* Wrapped, never truncated: an owner rule, and these lines are the whole point of the panel. */}
      <p className={`break-words text-xs font-bold ${ink}`}>{text}</p>
      {metres ? <p className="break-words text-xs text-slate-600">{metres}</p> : null}
      {gap ? (
        <p className={`break-words text-xs ${trust.gapIsLong ? "font-bold text-amber-700" : "text-slate-600"}`}>{gap}</p>
      ) : null}
    </div>
  );
}

function LocationBlock({ heading = "Location", location }: { heading?: string; location: VerifiedCaptureLocation }) {
  const hasPin = location.latitude !== null && location.longitude !== null;
  const cleanDiffers = Boolean(location.address && location.address !== location.rawLocation);
  const hasParts = Boolean(location.brick || location.area || location.region || location.governorate);
  const nothing = !location.rawLocation && !location.address && !hasParts && !hasPin;
  return (
    <div className="space-y-1.5 rounded border border-slate-100 bg-slate-50 px-3 py-2">
      <p className="flex items-center gap-1 text-phx-sm font-black uppercase tracking-[0.14em] text-slate-400">
        <MapPin className="h-3 w-3" />
        {heading}
      </p>
      {location.rawLocation ? (
        <div className="min-w-0">
          <span className="text-phx-sm font-black uppercase tracking-[0.1em] text-slate-400">Raw </span>
          <span className="break-words text-xs font-bold text-slate-800">{location.rawLocation}</span>
        </div>
      ) : null}
      {cleanDiffers ? <LocationDetail label="Clean address" value={location.address} /> : null}
      {hasParts ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <LocationDetail label="Brick" value={location.brick} />
          <LocationDetail label="Area" value={location.area} />
          <LocationDetail label="Region" value={location.region} />
          <LocationDetail label="Governorate" value={location.governorate} />
        </div>
      ) : null}
      {hasPin ? (
        <a
          className="inline-flex items-center gap-1 break-all text-xs font-black text-orange-600 hover:text-orange-700 hover:underline"
          href={`https://www.google.com/maps?q=${location.latitude},${location.longitude}`}
          rel="noreferrer"
          target="_blank"
        >
          {location.latitude?.toFixed(5)}, {location.longitude?.toFixed(5)}
        </a>
      ) : null}
      {nothing ? <p className="text-xs font-bold text-slate-400">No location captured</p> : null}
    </div>
  );
}

function FieldPair({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded border border-slate-100 bg-slate-50 px-2.5 py-2">
      <dt className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-400">{label}</dt>
      <dd className="mt-0.5 min-w-0 break-words text-xs font-bold text-slate-800">{value ?? "—"}</dd>
    </div>
  );
}

/**
 * A person shown by NAME and their REAL job title — never an assumed position (owner, 2026-09-25:
 * "you are writing titles and job positions wrong"). `highlight` marks the requester in orange, the
 * one name the owner asked to stand out.
 */
function PersonField({
  highlight = false,
  label,
  name,
  title,
}: {
  highlight?: boolean;
  label: string;
  name: string | null;
  title: string | null;
}) {
  return (
    <div
      className={cn(
        "rounded border px-2.5 py-2",
        highlight ? "border-orange-300 bg-orange-50" : "border-slate-100 bg-slate-50",
      )}
    >
      <dt
        className={cn(
          "flex items-center gap-1 text-phx-sm font-black uppercase tracking-[0.12em]",
          highlight ? "text-orange-600" : "text-slate-400",
        )}
      >
        {highlight ? <UserRound className="h-3 w-3" /> : null}
        {label}
      </dt>
      <dd
        className={cn(
          "mt-0.5 min-w-0 break-words text-xs font-black",
          highlight ? "text-orange-700" : "text-slate-900",
        )}
      >
        {name ?? "—"}
      </dd>
      <dd className="min-w-0 break-words text-phx-sm font-bold text-slate-500">{title ?? "Title not on file"}</dd>
    </div>
  );
}

/** The green "in our database" / amber "not in our database" pill the owner asked for. */
function DatabaseBadge({ inDatabase }: { inDatabase: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-phx-sm font-black uppercase tracking-[0.1em]",
        inDatabase ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700",
      )}
    >
      {inDatabase ? <Check className="h-3 w-3" /> : <TriangleAlert className="h-3 w-3" />}
      {inDatabase ? "In our database" : "Not in our database"}
    </span>
  );
}

/**
 * PH code + every distributor code on a captured pharmacy, each told "available in our database or
 * no" (owner ask, 2026-09-25). The distributor is shown by NAME with its short code beside it.
 */
function DistributorCodes({
  codes,
  phoenixCode,
}: {
  codes: VerifiedCaptureDistributorCode[];
  phoenixCode?: string | null;
}) {
  return (
    <div className="space-y-2 rounded border border-slate-100 bg-slate-50 px-3 py-2">
      <p className="flex items-center gap-1 text-phx-sm font-black uppercase tracking-[0.14em] text-slate-500">
        <Database className="h-3 w-3" />
        Codes
      </p>
      {phoenixCode !== undefined ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-100 bg-white px-2 py-1.5">
          <span className="min-w-0 break-words text-xs font-bold text-slate-800">
            <span className="font-black uppercase tracking-[0.1em] text-slate-400">PH code </span>
            {phoenixCode ?? "—"}
          </span>
          {phoenixCode ? <DatabaseBadge inDatabase /> : null}
        </div>
      ) : null}
      {codes.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-100 bg-white px-2 py-1.5">
          <span className="text-xs font-bold text-slate-500">No distributor code on file</span>
          <DatabaseBadge inDatabase={false} />
        </div>
      ) : (
        <ul className="space-y-1.5">
          {codes.map((code, index) => (
            <li
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-100 bg-white px-2 py-1.5"
              key={`${code.distributorCode ?? "d"}-${code.customerCode ?? index}`}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <Building2 className="h-3 w-3 shrink-0 text-slate-400" />
                <span className="min-w-0 break-words text-xs font-bold text-slate-800">
                  <span className="font-black text-slate-900">
                    {code.distributorName ?? code.distributorCode ?? "Distributor"}
                  </span>
                  {code.distributorName && code.distributorCode ? (
                    <span className="text-slate-400"> · {code.distributorCode}</span>
                  ) : null}
                  {code.customerCode ? <span className="text-slate-500"> · {code.customerCode}</span> : null}
                </span>
              </span>
              <DatabaseBadge inDatabase={code.inDatabase} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterFieldLabel({ children }: { children: ReactNode }) {
  return <span className="text-phx-sm font-black uppercase tracking-[0.14em] text-slate-500">{children}</span>;
}

/** A single-value dropdown, rendered only when there is something to choose. */
function ValueSelect({
  allLabel,
  label,
  onChange,
  options,
  value,
}: {
  allLabel: string;
  label: string;
  onChange: (next: string) => void;
  options: string[];
  value: string;
}) {
  if (options.length === 0) return null;
  return (
    <label className="min-w-0 space-y-1">
      <FilterFieldLabel>{label}</FilterFieldLabel>
      <select className={portalInputClassName} onChange={(event) => onChange(event.target.value)} value={value}>
        <option value={ALL}>{allLabel}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Everything a tab can filter and sort by. A dimension with no options hides its picker. */
export type CaptureFilterOptions = {
  reps: Array<{ hrId: string; name: string }>;
  managers: Array<{ hrId: string; name: string }>;
  lines: string[];
  areas: string[];
  bricks: string[];
  regions: string[];
  months: Array<{ key: string; label: string }>;
};

/** The requester + manager + geography + month + search + sort row, shared by both tabs. */
function CaptureFilters({
  filter,
  options,
  onChange,
  countLabel,
}: {
  filter: CaptureFilter;
  options: CaptureFilterOptions;
  onChange: (next: CaptureFilter) => void;
  countLabel: string;
}) {
  const sortNewestFirst = (filter.sort ?? "date-desc") === "date-desc";
  return (
    <PortalFilterBar countLabel={countLabel}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="min-w-0 space-y-1">
          <FilterFieldLabel>Requester</FilterFieldLabel>
          <select
            className={portalInputClassName}
            onChange={(event) => onChange({ ...filter, rep: event.target.value })}
            value={filter.rep}
          >
            <option value={ALL}>All requesters</option>
            {options.reps.map((rep) => (
              <option key={rep.hrId} value={rep.hrId}>
                {rep.name}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 space-y-1">
          <FilterFieldLabel>Manager</FilterFieldLabel>
          <select
            className={portalInputClassName}
            onChange={(event) => onChange({ ...filter, manager: event.target.value })}
            value={filter.manager}
          >
            <option value={ALL}>All managers</option>
            {options.managers.map((manager) => (
              <option key={manager.hrId} value={manager.hrId}>
                {manager.name}
              </option>
            ))}
          </select>
        </label>
        <ValueSelect
          allLabel="All lines"
          label="Line"
          onChange={(value) => onChange({ ...filter, line: value })}
          options={options.lines}
          value={filter.line ?? ALL}
        />
        <ValueSelect
          allLabel="All regions"
          label="Region"
          onChange={(value) => onChange({ ...filter, region: value })}
          options={options.regions}
          value={filter.region ?? ALL}
        />
        <ValueSelect
          allLabel="All areas"
          label="Area"
          onChange={(value) => onChange({ ...filter, area: value })}
          options={options.areas}
          value={filter.area ?? ALL}
        />
        <ValueSelect
          allLabel="All bricks"
          label="Brick"
          onChange={(value) => onChange({ ...filter, brick: value })}
          options={options.bricks}
          value={filter.brick ?? ALL}
        />
        {options.months.length > 0 ? (
          <label className="min-w-0 space-y-1">
            <FilterFieldLabel>Month</FilterFieldLabel>
            <select
              className={portalInputClassName}
              onChange={(event) => onChange({ ...filter, month: event.target.value })}
              value={filter.month ?? ALL}
            >
              <option value={ALL}>All months</option>
              {options.months.map((month) => (
                <option key={month.key} value={month.key}>
                  {month.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="min-w-0 space-y-1">
          <FilterFieldLabel>Sort by date</FilterFieldLabel>
          <button
            className={cn(portalInputClassName, "flex items-center justify-between gap-2 text-left font-bold")}
            onClick={() => onChange({ ...filter, sort: sortNewestFirst ? "date-asc" : "date-desc" })}
            type="button"
          >
            <span>{sortNewestFirst ? "Newest first" : "Oldest first"}</span>
            <ArrowUpDown className="h-4 w-4 shrink-0 text-slate-400" />
          </button>
        </label>
        <label className="min-w-0 space-y-1 sm:col-span-2 lg:col-span-3">
          <FilterFieldLabel>Search</FilterFieldLabel>
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

function locationSearchText(location: VerifiedCaptureLocation): Array<string | null> {
  return [location.rawLocation, location.address, location.brick, location.area, location.region, location.governorate];
}

function marketingSearchText(row: VerifiedMarketingCaptureRow): string {
  return [
    row.displayName,
    row.customerCode,
    row.areaName,
    row.lineName,
    row.governorate,
    ...locationSearchText(row.location),
    ...row.pharmacies.map((pharmacy) => pharmacy.displayName),
    ...row.pharmacies.flatMap((pharmacy) => locationSearchText(pharmacy.location)),
    ...row.pharmacies.flatMap((pharmacy) =>
      pharmacy.distributorCodes.flatMap((code) => [code.distributorName, code.distributorCode, code.customerCode]),
    ),
  ]
    .filter(Boolean)
    .join(" ");
}

function MarketingCaptureBody({ row }: { row: VerifiedMarketingCaptureRow }) {
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-2">
        <PersonField highlight label="Requested by" name={row.repName} title={row.repTitle} />
        <PersonField label="Manager" name={row.managerName} title={row.managerTitle} />
        <FieldPair label="Line" value={row.lineName ?? "—"} />
        <FieldPair label="Area" value={row.areaName ?? "—"} />
        <FieldPair label="Governorate" value={row.governorate ?? "—"} />
        <FieldPair label="Captured" value={row.capturedAt ? cairoDateTime(row.capturedAt) : "—"} />
      </dl>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <PhotoTile alt={`${row.displayName} — customer`} caption={row.displayName} label="Customer photo" src={row.photoUrl} />
        <div className="space-y-2">
          <LocationBlock heading="Customer location" location={row.location} />
          <PhotoTrustBlock trust={row.photoTrust} />
        </div>
      </div>

      <div className="space-y-2">
        <p className="flex items-center gap-1 text-phx-sm font-black uppercase tracking-[0.14em] text-slate-500">
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
              <PhotoTrustBlock trust={pharmacy.photoTrust} />
              <DistributorCodes codes={pharmacy.distributorCodes} />
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
    () =>
      rows.map((row) => ({
        ...row,
        searchText: marketingSearchText(row),
        line: row.lineName,
        area: row.areaName,
        brick: row.location.brick,
        region: row.location.region ?? row.governorate,
        sortDate: row.capturedAt,
      })),
    [rows],
  );
  const options = useMemo<CaptureFilterOptions>(
    () => ({
      reps: distinctPeople(filterable, "rep"),
      managers: distinctPeople(filterable, "manager"),
      lines: distinctValues(filterable, "line"),
      areas: distinctValues(filterable, "area"),
      bricks: distinctValues(filterable, "brick"),
      regions: distinctValues(filterable, "region"),
      months: distinctMonths(filterable),
    }),
    [filterable],
  );
  const filtered = useMemo(() => applyCaptureFilter(filterable, filter), [filterable, filter]);

  const withPhoto = filtered.filter((row) => row.photoUrl).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <PortalMetricCard accent="orange" icon={Sparkles} label="Verified customers" value={rows.length} />
        <PortalMetricCard accent="sky" icon={UserRound} label="Reps" value={options.reps.length} />
        <PortalMetricCard accent="emerald" icon={Users} label="District managers" value={options.managers.length} />
        <PortalMetricCard accent="amber" icon={Store} label="With customer photo" value={withPhoto} />
      </div>

      <CaptureFilters
        countLabel={`${filtered.length} of ${rows.length} shown`}
        filter={filter}
        onChange={setFilter}
        options={options}
      />

      <PortalSection className="overflow-hidden">
        <PortalResponsiveDataList
          empty={
            <PortalEmptyState
              message="No verified marketing customers match these filters yet — a customer appears here once their live photo and every linked pharmacy's photo and location are captured."
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
  return [
    row.pharmacyName,
    row.pharmacyCode,
    ...locationSearchText(row.location),
    ...row.distributorCodes.flatMap((code) => [code.distributorName, code.distributorCode, code.customerCode]),
  ]
    .filter(Boolean)
    .join(" ");
}

function routeLabel(route: VerifiedDirectOrderCaptureRow["route"]): string {
  return route === "invoice" ? "Invoice" : "Field capture";
}

function DirectOrderCaptureBody({ row }: { row: VerifiedDirectOrderCaptureRow }) {
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-2">
        <PersonField highlight label="Requested by" name={row.repName} title={row.repTitle} />
        <PersonField label="Manager" name={row.managerName} title={row.managerTitle} />
        <FieldPair label="Route" value={routeLabel(row.route)} />
        <FieldPair label="Verified" value={row.verifiedAt ? cairoDateTime(row.verifiedAt) : "—"} />
        <PersonField label="Verified by" name={row.verifiedByName} title={row.verifiedByTitle} />
      </dl>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {row.route === "invoice" ? (
          <div className="min-w-0">
            <p className="mb-1 text-phx-sm font-black uppercase tracking-[0.14em] text-slate-400">Distributor invoice</p>
            {row.invoiceUrl ? (
              row.invoiceIsPdf ? (
                <a
                  className="flex h-40 w-full flex-col items-center justify-center gap-1 rounded border border-slate-200 bg-slate-50 text-orange-600 hover:bg-orange-50"
                  href={row.invoiceUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ShoppingBag className="h-5 w-5" />
                  <span className="text-phx-sm font-black uppercase tracking-[0.14em]">Open invoice PDF</span>
                </a>
              ) : (
                <div className="overflow-hidden rounded border border-slate-200 bg-slate-50">
                  <ZoomablePhoto alt="Distributor invoice" caption="Distributor invoice" className="h-40 w-full object-cover" src={row.invoiceUrl} />
                </div>
              )
            ) : (
              <div className="flex h-40 w-full flex-col items-center justify-center gap-1 rounded border border-dashed border-slate-200 bg-slate-50 text-slate-400">
                <ImageOff className="h-5 w-5" />
                <span className="text-phx-sm font-black uppercase tracking-[0.14em]">No invoice on file</span>
              </div>
            )}
          </div>
        ) : (
          <PhotoTile alt={`${row.pharmacyName} — storefront`} caption={row.pharmacyName} label="Storefront photo" src={row.photoUrl} />
        )}
        <LocationBlock location={row.location} />
        {/* Outside the photo/invoice ternary on purpose: the comparison describes the CAPTURE, so
            an invoice-route validation still shows where its pin and its photo stood. */}
        <PhotoTrustBlock trust={row.photoTrust} />
      </div>

      <DistributorCodes codes={row.distributorCodes} phoenixCode={row.pharmacyCode} />

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
    () =>
      rows.map((row) => ({
        ...row,
        searchText: directOrderSearchText(row),
        line: null,
        area: row.location.area,
        brick: row.location.brick,
        region: row.location.region,
        sortDate: row.verifiedAt,
      })),
    [rows],
  );
  const options = useMemo<CaptureFilterOptions>(
    () => ({
      reps: distinctPeople(filterable, "rep"),
      managers: distinctPeople(filterable, "manager"),
      lines: distinctValues(filterable, "line"),
      areas: distinctValues(filterable, "area"),
      bricks: distinctValues(filterable, "brick"),
      regions: distinctValues(filterable, "region"),
      months: distinctMonths(filterable),
    }),
    [filterable],
  );
  const filtered = useMemo(() => applyCaptureFilter(filterable, filter), [filterable, filter]);

  const fieldCount = filtered.filter((row) => row.route === "field").length;
  const invoiceCount = filtered.filter((row) => row.route === "invoice").length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <PortalMetricCard accent="orange" icon={ShoppingBag} label="Verified pharmacies" value={rows.length} />
        <PortalMetricCard accent="sky" icon={UserRound} label="Reps" value={options.reps.length} />
        <PortalMetricCard accent="emerald" icon={MapPin} label="Field captures" value={fieldCount} />
        <PortalMetricCard accent="amber" icon={Store} label="By invoice" value={invoiceCount} />
      </div>

      <CaptureFilters
        countLabel={`${filtered.length} of ${rows.length} shown`}
        filter={filter}
        onChange={setFilter}
        options={options}
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
