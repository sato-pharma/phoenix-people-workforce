"use client";

/**
 * Shared bold org-chart renderer used by BOTH the admin `/organogram` page and the
 * employee-portal Organogram tab. It turns the scoped `organogramRows` (already
 * filtered + visibility-checked by each surface) into a top-down chart:
 *
 *   Executive spine (CEO → Line → NSM)
 *     → tier of DSM lanes reporting to NSM ("Reports to NSM")
 *     → each RSM banner with its child DSM lanes (`childLanes`)
 *       → per-lane collapsible member trees with drawn connector lines
 *
 * All hierarchy math lives in `organogram-view-model.ts` / `organogram-safety.ts`
 * (untouched). This module is presentation only. The `theme` prop tunes labels and a
 * couple of paddings; both admin and portal shells force square corners globally, so
 * the two surfaces read as one consistent chart.
 */

import {
  Building2,
  ChevronDown,
  ChevronRight,
  Crown,
  ImageDown,
  Layers,
  Loader2,
  MapPin,
  Minus,
  Network,
  Pencil,
  Plus,
  Printer,
  UserMinus,
  UserRound,
  Users,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import { OrganogramAudienceDialog } from "@/components/organogram/organogram-audience-dialog";
import { OrganogramAsOfBanner } from "@/components/organogram/organogram-as-of";
import { OrganogramNodeDetailModal } from "@/components/organogram/organogram-node-detail-modal";
import { OrganogramWhatsAppButton } from "@/components/organogram/whatsapp-button";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { Switch } from "@/components/ui/switch";
import { formatDateOnly } from "@/lib/date-only";
import { buildEmployeeMasterHref, employeeMasterBasePath } from "@/lib/employees/employee-master-link";
import {
  ORGANOGRAM_EXPORT_COLUMNS,
  buildOrganogramExportRows,
} from "@/lib/reports/organogram-audience";
import { fetchOrganogramMobileNumbers } from "@/lib/reports/organogram-contact-numbers-client";
import {
  buildOrganogramChartCounts,
  countLaneSeats,
  countRegionOpenSeats,
  describeOrganogramCounts,
  formatDistrictLaneCount,
  formatLaneSeatSummary,
} from "@/lib/reports/organogram-counts";
import { isLaneHidden, visibleLaneMembers } from "@/lib/reports/organogram-hide-vacant";
import { calculateOrganogramStructureKpis } from "@/lib/reports/organogram-safety";
import {
  type ManagerLane,
  type MemberNode,
  type OrganogramRow,
  type TopManagerLane,
  buildMemberTree,
  buildOrganogramLanes,
  isMedicalRep,
  rowKey,
} from "@/lib/reports/organogram-view-model";
import { cn, formatEmployeeDisplayName } from "@/lib/utils";
import { formatSeatOfferOut } from "@/lib/offers/seat-offer-label";

export type OrgChartTheme = "admin" | "portal";

/**
 * Every pressable node fires this to open the employee-master detail popup. Threaded
 * from OrgChartTree down through the spine, manager lanes, and member trees so one
 * click target (the person's identity block) opens the same modal everywhere. Kept
 * optional so a node with no backing row (e.g. the "Line" spine box, or a fallback
 * group named only by string) simply renders un-pressable.
 */
type OnSelectNode = (row: OrganogramRow) => void;

export type OrgChartKpiLabels = {
  medicalRep: string;
  dsm: string;
  rsm: string;
  nsm: string;
  total: string;
};

/**
 * Default (full) KPI labels. The admin surface uses these; the portal passes shorter
 * variants for its narrower column. Kept as a constant here so the wording lives with
 * the chart it labels.
 */
export const DEFAULT_ORG_KPI_LABELS: OrgChartKpiLabels = {
  dsm: "District Sales Managers",
  medicalRep: "Medical Sales Representatives",
  nsm: "National Sales Managers",
  rsm: "Regional Sales Managers",
  total: "Total Line Structure",
};

type OrgChartTreeProps = {
  rows: OrganogramRow[];
  lineName: string | null;
  theme?: OrgChartTheme;
  kpiLabels?: OrgChartKpiLabels;
  /**
   * Whether this viewer may add employees (`employees:create` — `update` until 2026-10-20, when the
   * HR Operations Specialist seat began editing the master without adding to it). Decides whether
   * a vacancy popup offers "Add employee to this seat" and whether each person's tile carries the
   * Edit and Resign buttons into Employee Master; resolved server-side on the page, never
   * inferred here.
   */
  canAddEmployee?: boolean;
  /**
   * Whether this viewer may read anybody's CV (`canDownloadEmployeeCv`), resolved server-side on the
   * page and handed to the person popup, which skips its CV probe when it is false. Absent asks the
   * CV route, as before.
   */
  canReadEmployeeCv?: boolean;
  /**
   * `YYYY-MM` of a finished month when `rows` are a past picture of the structure (the screen
   * fetched `?asOf=`); null or absent for the live chart. A past picture is read-only: it drops
   * Edit, Resign, "Add employee to this seat", the spreadsheet export and the email picker, because
   * each acts on people and seats as they are TODAY and would read as acting on the date shown.
   */
  asOfMonth?: string | null;
};

/**
 * Where a tile's Edit and Resign buttons lead. Provided once by OrgChartTree and read by every
 * tile that can hold a person, so the permission and the shell's Employee Master route are
 * decided in one place instead of threaded through the spine, the manager lanes and the member
 * trees. `null` (no provider, or a viewer who may not change employees) renders no buttons.
 */
const EmployeeActionsContext = React.createContext<{ basePath: string } | null>(null);

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */

function initials(name: string | null | undefined) {
  const parts = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  const joined = parts.map((part) => part[0] ?? "").join("");
  return joined ? joined.toUpperCase() : "—";
}

function formatHireDate(value: string | null | undefined) {
  return formatDateOnly(value, "en", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * One-line "Joined <date> · <area>" summary shown under a manager/executive name.
 * Area falls back to region; the whole line is omitted when neither a hire date nor a
 * place is known, so a sparsely-populated row never shows an empty chip. (The member
 * cards render the same facts as chips instead — see PersonNode.)
 */
function personFactsLine(row: OrganogramRow | null | undefined): string {
  if (!row) return "";
  const place = row.areaName ?? row.regionName ?? null;
  return [row.hireDate ? `Joined ${formatHireDate(row.hireDate)}` : null, place]
    .filter(Boolean)
    .join(" · ");
}

function countDescendants(node: MemberNode): number {
  return node.children.reduce((total, child) => total + 1 + countDescendants(child), 0);
}

/**
 * Stable per-lane identity key for a DSM/RSM-anchored lane. Prefers the lane's
 * manager/vacancy-slot identity (already unique via rowKey) over the array
 * position, so collapse state doesn't cross-bind onto a different lane when
 * the underlying rows are reordered or filtered (e.g. by search). Falls back
 * to a positional key only for the rare lane with neither a dsm nor an rsm.
 */
function tierLaneKey(tier: "t1" | "t2", group: TopManagerLane, index: number) {
  const identity = group.dsm ?? group.rsm ?? null;
  return identity ? `${tier}-${rowKey(identity)}` : `${tier}-${group.name}-${index}`;
}

function childLaneKey(parentKey: string, lane: ManagerLane, index: number) {
  return lane.dsm ? `${parentKey}-child-${rowKey(lane.dsm)}` : `${parentKey}-child-${lane.name}-${index}`;
}

// Lane-grid column count: a plain `auto-fit` grid packs as many 240px+ lanes
// as the viewport allows per row, so the same line renders a different,
// unbalanced split (e.g. 5 then 2) depending on screen width. Fixing the
// column count at ceil(count/2) instead always wraps into two even-ish rows
// (7 -> 4+3, 6 -> 3+3) regardless of viewport, matching how a manually laid
// out org chart reads. Below 5 lanes there's no wrap to balance, so show
// them all on one row.
function laneGridColumnCount(count: number) {
  return count > 4 ? Math.ceil(count / 2) : Math.max(count, 1);
}

// The lanes STACK on a phone (the fits-the-screen golden rule, 2026-10-26). The grid used to be
// `repeat(n, minmax(240px, 1fr))` at every width, so seven lanes needed 1,008px and a 375px phone
// scrolled sideways, each lane squeezed until a district manager's name wrapped to four lines.
// The columns now follow the CANVAS's own width (`@container` on it): one column of full-width
// cards on a phone, two on a tablet, three on a narrow desktop, and the balanced count above.
const LANE_GRID_CLASS_NAME =
  "grid grid-cols-1 gap-3 @xl:[grid-template-columns:repeat(var(--lane-cols-sm),minmax(0,1fr))] @4xl:[grid-template-columns:repeat(var(--lane-cols-md),minmax(0,1fr))] @5xl:[grid-template-columns:repeat(var(--lane-cols),minmax(0,1fr))] print:[grid-template-columns:repeat(var(--lane-cols),minmax(0,1fr))]";

function laneGridStyle(count: number): React.CSSProperties {
  const columns = laneGridColumnCount(count);
  return {
    "--lane-cols": columns,
    "--lane-cols-md": Math.min(columns, 3),
    "--lane-cols-sm": Math.min(columns, 2),
  } as React.CSSProperties;
}

/* ------------------------------------------------------------------ */
/*  Edit / Resign buttons on a person's tile                          */
/* ------------------------------------------------------------------ */

/**
 * The two ways out of a person's tile into Employee Master: Edit opens that employee's edit form,
 * Resign opens their resignation dialog. Plain links, so the chart holds neither form and the
 * resignation still goes through the one endpoint that checks the viewer's scope and opens the
 * vacancy. Rendered ONLY for an employee row (a vacancy has nobody to edit — its popup offers
 * "Add employee to this seat") and only when the chart's viewer may change employees.
 *
 * Always a DOM sibling of the tile's own press target, never inside it: an anchor within a button
 * resolves unpredictably. Left out of print and of the PNG export (`data-organogram-action`), where
 * a row of buttons on every box would only be clutter.
 */
function EmployeeTileActions({
  row,
  tone = "light",
  className,
}: {
  row: OrganogramRow | null | undefined;
  tone?: "light" | "dark";
  className?: string;
}) {
  const actions = React.useContext(EmployeeActionsContext);
  if (!actions || !row || row.type !== "employee" || !row.hrId) return null;

  const name = formatEmployeeDisplayName(row.displayName);
  const buttonClass =
    "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-phx-2xs font-bold transition focus-visible:outline-none focus-visible:ring-2";

  return (
    <div
      className={cn("flex flex-wrap items-center gap-1.5 print:hidden", className)}
      data-organogram-action=""
    >
      <Link
        aria-label={`Edit ${name} in Employee Master`}
        className={cn(
          buttonClass,
          "focus-visible:ring-orange-400/50",
          tone === "dark"
            ? "border-white/20 bg-white/10 text-white hover:bg-white/20"
            : "border-slate-200 bg-white text-slate-600 shadow-sm hover:border-orange-300 hover:text-orange-600",
        )}
        href={buildEmployeeMasterHref(actions.basePath, "edit", row.hrId)}
        title={`Open ${name}'s record in Employee Master`}
      >
        <Pencil className="h-3 w-3" />
        Edit
      </Link>
      <Link
        aria-label={`Resign ${name} in Employee Master`}
        className={cn(
          buttonClass,
          "focus-visible:ring-rose-400/50",
          tone === "dark"
            ? "border-rose-300/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/30"
            : "border-rose-200 bg-white text-rose-600 shadow-sm hover:border-rose-300 hover:bg-rose-50",
        )}
        href={buildEmployeeMasterHref(actions.basePath, "resign", row.hrId)}
        title={`Start ${name}'s resignation in Employee Master`}
      >
        <UserMinus className="h-3 w-3" />
        Resign
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Avatar + person / vacancy card                                    */
/* ------------------------------------------------------------------ */

function Avatar({
  name,
  vacancy,
}: {
  name: string | null | undefined;
  vacancy: boolean;
}) {
  if (vacancy) {
    return (
      <span
        aria-hidden
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-orange-400 bg-orange-50 text-orange-500"
      >
        <UserRound className="h-4 w-4" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-slate-700 to-slate-900 text-phx-xs font-black text-white"
    >
      {initials(name)}
    </span>
  );
}

function PersonNode({
  row,
  collapsed,
  onToggle,
  onSelect,
  hiddenCount,
}: {
  row: OrganogramRow;
  collapsed?: boolean;
  onToggle?: () => void;
  onSelect?: OnSelectNode;
  hiddenCount?: number;
}) {
  const isVacancy = row.type === "vacancy";
  const showRepFields = isVacancy || isMedicalRep(row);
  const title = row.positionTitle ?? row.jobTitle;
  const place = row.areaName ?? row.regionName ?? null;

  // Avatar + text block — the single press target. Wrapped in a button when a
  // selection handler is supplied so it opens the employee-master popup; the
  // collapse chevron stays a separate sibling button (never nested).
  const identity = (
    <>
      <Avatar name={row.displayName} vacancy={isVacancy} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="whitespace-normal break-words text-phx-sm font-bold leading-tight text-slate-900">
            {isVacancy ? "Open Vacancy" : formatEmployeeDisplayName(row.displayName)}
          </p>
          {isVacancy ? (
            <span className="shrink-0 rounded-md bg-orange-100 px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-[0.12em] text-orange-700">
              Vacant
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-phx-2xs text-slate-500">
          {/* A vacancy normally hides its title because the PLACE already says which seat is
              open — "Open Vacancy" over a Cairo pin reads correctly on a sales chart. A Head
              Office vacancy has no area, so hiding the title left it as "Open Vacancy" and a
              seat code and nothing else: the HR seats added 2026-08-28 were unreadable. Show
              the title whenever there is no place to carry the meaning; sales vacancies, which
              all have one, look exactly as they did. */}
          {title && (!showRepFields || !place) ? (
            <span className="break-words font-medium text-slate-600">{title}</span>
          ) : null}
        </div>
        {/* Change #1 — hire date + area on EVERY person, not just reps. Each chip
            is shown only when its value exists, so managers/office staff without
            an area never render an empty pill. */}
        {row.hireDate || place ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-phx-2xs text-slate-500">
            {row.hireDate ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-medium">
                <span aria-hidden className="h-1 w-1 rounded-full bg-slate-400" />
                {formatHireDate(row.hireDate)}
              </span>
            ) : null}
            {place ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-medium">
                <MapPin className="h-2.5 w-2.5 text-orange-400" />
                {place}
              </span>
            ) : null}
          </div>
        ) : null}
        {/* The letter already out against this empty chair (owner, 2026-09-29).
            BESIDE the orange "Vacant" chip, never instead of it: the seat IS still vacant, and
            replacing the word would say it is filled when nobody has been hired. What this adds is
            the difference between an empty chair nobody has touched and one with a signed offer and
            a start date on it — measured 2026-09-29, four of the forty-three open seats were
            already spoken for and looked identical to the other thirty-nine.
            Emerald for an accepted offer, sky for one still awaiting an answer, so the two read
            apart at a glance and both read apart from the node's own orange. It wraps rather than
            truncating: a half-shown candidate name is exactly what the no-ellipsis rule forbids. */}
        {isVacancy && row.pendingOffer ? (
          <p
            className={cn(
              "mt-1.5 whitespace-normal break-words rounded-md px-1.5 py-1 text-phx-2xs font-bold leading-tight",
              row.pendingOffer.status === "accepted"
                ? "bg-emerald-50 text-emerald-800"
                : "bg-sky-50 text-sky-800",
            )}
          >
            {formatSeatOfferOut(row.pendingOffer)}
          </p>
        ) : null}
      </div>
    </>
  );

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border px-3 py-2.5 shadow-[0_2px_10px_rgba(15,23,42,0.05)] transition-all duration-150 hover:-translate-y-px hover:shadow-md",
        isVacancy
          ? "border-orange-300 bg-orange-50/70 [border-style:dashed]"
          : "border-slate-200 bg-white hover:border-slate-300",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-1",
          isVacancy ? "bg-orange-400" : "bg-slate-300",
        )}
      />
      <div className="flex items-start gap-2.5">
        {onSelect ? (
          <button
            aria-label={`View details for ${isVacancy ? "this open vacancy" : formatEmployeeDisplayName(row.displayName)}`}
            className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-400/50"
            onClick={() => onSelect(row)}
            type="button"
          >
            {identity}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-2.5">{identity}</div>
        )}
        {/* Sibling of the press target, never nested inside it — an anchor within a button
            resolves unpredictably. Hidden for vacancies (nobody to message) and for anyone
            whose stored number cannot be dialled, which hasWhatsApp already answers. */}
        {!isVacancy && row.hasWhatsApp ? (
          <OrganogramWhatsAppButton hrId={row.hrId} name={formatEmployeeDisplayName(row.displayName)} />
        ) : null}
        {onToggle ? (
          <button
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand reports" : "Collapse reports"}
            className="ml-1 inline-flex shrink-0 items-center gap-1 self-center rounded-md border border-slate-200 bg-white px-1.5 py-1 text-phx-2xs font-bold text-slate-500 shadow-sm transition hover:border-orange-300 hover:text-orange-600"
            onClick={onToggle}
            type="button"
          >
            {collapsed ? (
              <>
                <ChevronRight className="h-3 w-3" />
                {hiddenCount ? <span>{hiddenCount}</span> : null}
              </>
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </button>
        ) : null}
      </div>
      {/* Under the identity block, lined up with the name (avatar 32px + 10px gap). */}
      <EmployeeTileActions
        className="mt-2 border-t border-slate-100 pt-2 pl-[42px]"
        row={row}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Collapsible member branch (drawn connector lines)                 */
/* ------------------------------------------------------------------ */

function MemberBranch({
  node,
  collapsedKeys,
  onToggle,
  onSelect,
  level = 1,
}: {
  node: MemberNode;
  collapsedKeys: Set<string>;
  onToggle: (key: string) => void;
  onSelect?: OnSelectNode;
  level?: number;
}) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsedKeys.has(node.key);

  return (
    <li
      aria-expanded={hasChildren ? !isCollapsed : undefined}
      aria-level={level}
      aria-selected={false}
      className="relative before:absolute before:-left-4 before:top-5 before:h-px before:w-4 before:bg-orange-200/80"
      role="treeitem"
    >
      <PersonNode
        collapsed={isCollapsed}
        hiddenCount={hasChildren ? countDescendants(node) : undefined}
        onSelect={onSelect}
        onToggle={hasChildren ? () => onToggle(node.key) : undefined}
        row={node.row}
      />
      {hasChildren && !isCollapsed ? (
        <ul
          className="ml-4 mt-2 space-y-2 border-l-2 border-orange-200/80 pl-4"
          role="group"
        >
          {node.children.map((child) => (
            <MemberBranch
              collapsedKeys={collapsedKeys}
              key={child.key}
              level={level + 1}
              node={child}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/*  Manager lane                                                       */
/* ------------------------------------------------------------------ */

function ManagerLane({
  group,
  laneKey,
  collapsedKeys,
  onToggle,
  onSelect,
  hideVacantResigned = false,
}: {
  group: ManagerLane;
  laneKey: string;
  collapsedKeys: Set<string>;
  onToggle: (key: string) => void;
  onSelect?: OnSelectNode;
  hideVacantResigned?: boolean;
}) {
  const isVacantManagerSeat = group.dsm?.type === "vacancy";
  const laneCollapsed = collapsedKeys.has(laneKey);
  // Seats, not rows: a seat in handover carries two people and is one filled seat.
  const seatCount = countLaneSeats(group);
  const managerScope = isVacantManagerSeat
    ? [group.dsm?.lineName, group.dsm?.areaName ?? group.dsm?.regionName]
        .filter(Boolean)
        .join(" / ")
    : null;
  // Change #1 — a filled DSM header shows Joined + area under the name (the vacant
  // seat already shows its scope via managerScope above). Change #2 — the header is
  // pressable when it is backed by a real DSM row, opening that person's popup.
  const dsmRow = group.dsm ?? null;
  const dsmFacts = isVacantManagerSeat ? "" : personFactsLine(dsmRow);
  const canOpenManager = Boolean(onSelect && dsmRow);
  // "Hide vacant and resigned" drops the boxes before the tree is built, so a hidden seat's
  // reports move up to the lane root instead of vanishing with it. Counts read every row.
  const memberTree = React.useMemo(
    () => buildMemberTree(visibleLaneMembers(group.members, hideVacantResigned)),
    [group.members, hideVacantResigned],
  );
  // Filled seats are dark slate, vacant seats warm orange — shared by the header row and the
  // Edit/Resign strip under it.
  const headerSurface = isVacantManagerSeat
    ? "bg-gradient-to-r from-orange-50 to-orange-100/60 text-slate-800"
    : "bg-gradient-to-br from-slate-800 to-slate-950 text-white";

  return (
    <div className="min-w-0 overflow-hidden border border-slate-200 bg-white shadow-[0_2px_12px_rgba(15,23,42,0.06)] transition-shadow duration-300 hover:shadow-[0_10px_28px_rgba(15,23,42,0.1)]">
      {/* Manager header — filled seats are dark slate, vacant seats warm orange */}
      <div className={cn("flex items-start gap-2.5 px-3 py-2.5", headerSurface)}>
        {(() => {
          const headerInner = (
            <>
              <span
                aria-hidden
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-phx-xs font-black",
                  isVacantManagerSeat
                    ? "border border-dashed border-orange-400 bg-white text-orange-500"
                    : "bg-white/10 text-white ring-1 ring-white/20",
                )}
              >
                {isVacantManagerSeat ? <Building2 className="h-4 w-4" /> : initials(group.name)}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-phx-3xs font-black uppercase tracking-[0.14em]",
                    isVacantManagerSeat ? "text-orange-600" : "text-orange-300",
                  )}
                >
                  {group.title}
                </p>
                <p className="mt-0.5 break-words text-phx-md font-bold leading-snug">
                  {isVacantManagerSeat ? "Open Seat" : formatEmployeeDisplayName(group.name)}
                </p>
                {managerScope ? (
                  <p
                    className={cn(
                      "mt-0.5 break-words text-phx-2xs font-semibold",
                      isVacantManagerSeat ? "text-orange-600" : "text-orange-200",
                    )}
                  >
                    {managerScope}
                  </p>
                ) : null}
                {dsmFacts ? (
                  <p className="mt-0.5 break-words text-phx-2xs font-semibold text-orange-200">
                    {dsmFacts}
                  </p>
                ) : null}
              </div>
            </>
          );
          return canOpenManager && dsmRow ? (
            <button
              aria-label={`View details for ${formatEmployeeDisplayName(group.name)}`}
              className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-400/60"
              onClick={() => onSelect?.(dsmRow)}
              type="button"
            >
              {headerInner}
            </button>
          ) : (
            <div className="flex min-w-0 flex-1 items-start gap-2.5">{headerInner}</div>
          );
        })()}
        <div className="flex shrink-0 items-center gap-1.5">
          {!isVacantManagerSeat && dsmRow?.hasWhatsApp ? (
            <OrganogramWhatsAppButton
              hrId={dsmRow.hrId}
              name={formatEmployeeDisplayName(group.name)}
              tone="dark"
            />
          ) : null}
          <span
            className={cn(
              "rounded-md px-1.5 py-1 text-center text-phx-2xs font-black leading-none ring-1",
              isVacantManagerSeat
                ? "bg-white text-orange-600 ring-orange-200"
                : "bg-white/10 text-white ring-white/20",
            )}
          >
            {isVacantManagerSeat ? "Vacant" : seatCount.seats}
          </span>
          {group.members.length > 0 ? (
            <button
              aria-expanded={!laneCollapsed}
              aria-label={laneCollapsed ? "Expand team" : "Collapse team"}
              className={cn(
                "inline-flex items-center rounded-md px-1 py-1 transition",
                isVacantManagerSeat
                  ? "text-orange-500 hover:bg-orange-100"
                  : "text-white/70 hover:bg-white/10 hover:text-white",
              )}
              onClick={() => onToggle(laneKey)}
              type="button"
            >
              {laneCollapsed ? (
                <ChevronRight className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
          ) : null}
        </div>
      </div>
      {/* Under the header row, lined up with the name (avatar 32px + 10px gap) and wearing the
          header's own surface so the two read as one block. A vacant manager seat has no row of
          its own to act on, so nothing renders for it. */}
      <EmployeeTileActions
        className={cn("border-t border-white/10 px-3 pb-2.5 pl-[54px] pt-2", headerSurface)}
        row={isVacantManagerSeat ? null : dsmRow}
        tone="dark"
      />

      {/* Team summary */}
      <div className="flex items-center justify-between border-y border-slate-100 bg-slate-50/70 px-3 py-1.5 text-phx-2xs">
        <span className="font-semibold text-slate-500">{formatLaneSeatSummary(seatCount)}</span>
        {seatCount.vacant > 0 ? (
          <span className="font-black uppercase tracking-[0.08em] text-orange-600">
            {seatCount.vacant} vacant
          </span>
        ) : seatCount.seats > 0 ? (
          <span className="font-semibold text-emerald-600">Fully staffed</span>
        ) : null}
      </div>

      {/* Team members with drawn connectors + collapse */}
      {!laneCollapsed ? (
        <div className="px-3 py-3">
          {group.members.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-center text-phx-xs text-slate-400">
              No team rows under this manager.
            </div>
          ) : (
            <ul aria-label="Team reporting tree" className="space-y-2" role="tree">
              {memberTree.map((node) => (
                <MemberBranch
                  collapsedKeys={collapsedKeys}
                  key={node.key}
                  node={node}
                  onSelect={onSelect}
                  onToggle={onToggle}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Executive spine (CEO → Line → NSM)                                 */
/* ------------------------------------------------------------------ */

function SpineNode({
  icon,
  label,
  name,
  tone,
  row,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  name: string;
  tone: "dark" | "line" | "leader";
  row?: OrganogramRow | null;
  onSelect?: OnSelectNode;
}) {
  const facts = personFactsLine(row);
  const canOpen = Boolean(onSelect && row);

  const cardClass = cn(
    "relative w-full max-w-md border px-4 py-3 text-center transition-shadow duration-300",
    tone === "dark"
      ? "border-slate-900 bg-gradient-to-br from-slate-800 to-slate-950 text-white shadow-[0_16px_36px_rgba(15,23,42,0.35)]"
      : tone === "leader"
        ? "border-orange-300 bg-gradient-to-r from-orange-50 via-orange-50/70 to-orange-50 shadow-[0_10px_26px_rgba(249,115,22,0.14)]"
        : "border-slate-200 bg-white shadow-sm",
  );

  const body = (
    <>
      <div
        className={cn(
          "mb-1 flex items-center justify-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.16em]",
          tone === "dark" ? "text-orange-300" : "text-orange-600",
        )}
      >
        {icon}
        {label}
      </div>
      <p
        className={cn(
          "break-words text-sm font-bold leading-snug",
          tone === "dark" ? "text-white" : "text-slate-900",
        )}
      >
        {name}
      </p>
      {facts ? (
        <p
          className={cn(
            "mt-1 break-words text-phx-2xs font-semibold",
            tone === "dark" ? "text-orange-200" : "text-orange-600",
          )}
        >
          {facts}
        </p>
      ) : null}
    </>
  );

  // The CEO and NSM boxes are backed by a real row → pressable; the "Line" box is
  // just the line name → rendered as a plain div.
  if (canOpen && row && onSelect) {
    // The card itself IS the press target here, so the WhatsApp link cannot live inside
    // it. A relative wrapper carrying the card's own width keeps the flex centering of
    // the spine identical while giving the anchor somewhere to sit as a true sibling.
    return (
      <div className="relative w-full max-w-md">
        <button
          aria-label={`View details for ${name}`}
          className={cn(cardClass, "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-400/60")}
          onClick={() => onSelect(row)}
          type="button"
        >
          {body}
        </button>
        {row.type === "employee" && row.hasWhatsApp ? (
          <span className="absolute right-2 top-2">
            <OrganogramWhatsAppButton
              hrId={row.hrId}
              name={name}
              tone={tone === "dark" ? "dark" : "light"}
            />
          </span>
        ) : null}
        {/* Below the card, on the page's own ground, so it stays the light variant whatever the
            card's tone is. */}
        <EmployeeTileActions className="mt-1.5 justify-center" row={row} />
      </div>
    );
  }

  return <div className={cardClass}>{body}</div>;
}

function Trunk() {
  return <div aria-hidden className="h-5 w-0.5 bg-orange-300/80" />;
}

/* ------------------------------------------------------------------ */
/*  KPI strip + completion bar                                        */
/* ------------------------------------------------------------------ */

type KpiTone = "emerald" | "sky" | "amber" | "orange" | "slate";

const TONE_ACCENT: Record<KpiTone, string> = {
  amber: "bg-amber-400",
  emerald: "bg-emerald-400",
  orange: "bg-orange-400",
  sky: "bg-sky-400",
  slate: "bg-slate-400",
};

const TONE_ICON: Record<KpiTone, string> = {
  amber: "bg-gradient-to-br from-amber-50 to-amber-100 text-amber-600 ring-amber-200",
  emerald: "bg-gradient-to-br from-emerald-50 to-emerald-100 text-emerald-600 ring-emerald-200",
  orange: "bg-gradient-to-br from-orange-50 to-orange-100 text-orange-600 ring-orange-200",
  sky: "bg-gradient-to-br from-sky-50 to-sky-100 text-sky-600 ring-sky-200",
  slate: "bg-gradient-to-br from-slate-50 to-slate-100 text-slate-600 ring-slate-200",
};

const TONE_GLOW: Record<KpiTone, string> = {
  amber: "bg-amber-300/30",
  emerald: "bg-emerald-300/30",
  orange: "bg-orange-300/30",
  sky: "bg-sky-300/30",
  slate: "bg-slate-300/30",
};

const TONE_FILL: Record<KpiTone, string> = {
  amber: "bg-amber-500",
  emerald: "bg-emerald-500",
  orange: "bg-orange-500",
  sky: "bg-sky-500",
  slate: "bg-slate-500",
};

function KpiCard({
  actual,
  icon,
  label,
  tone,
  total,
  vacant,
}: {
  actual: number;
  icon: React.ReactNode;
  label: string;
  tone: KpiTone;
  total: number;
  vacant: number;
}) {
  const pct = total > 0 ? Math.round((actual / total) * 100) : 0;
  return (
    <div className="group relative overflow-hidden border border-slate-200 bg-white p-4 shadow-[0_2px_12px_rgba(15,23,42,0.05)] transition-all duration-300 ease-out hover:-translate-y-1 hover:border-slate-300 hover:shadow-[0_18px_40px_rgba(15,23,42,0.1)]">
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-1", TONE_ACCENT[tone])} />
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-6 -top-8 h-24 w-24 rounded-full blur-2xl transition-opacity duration-300 group-hover:opacity-90",
          TONE_GLOW[tone],
        )}
      />
      <div className="relative flex items-start justify-between gap-2">
        <p className="break-words text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
          {label}
        </p>
        <span
          aria-hidden
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center ring-1 transition-transform duration-300 group-hover:scale-110",
            TONE_ICON[tone],
          )}
        >
          {icon}
        </span>
      </div>
      <div className="relative mt-1.5 flex items-end gap-1.5">
        <span className="text-2xl font-black leading-none text-slate-900">{actual}</span>
        <span className="pb-0.5 text-sm font-bold leading-none text-slate-400">/ {total}</span>
      </div>
      <div className="relative mt-2.5 flex items-center gap-2">
        <div
          aria-label={`${label} completion ${pct}%`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={pct}
          className="h-1.5 flex-1 overflow-hidden bg-slate-100"
          role="progressbar"
        >
          <div className={cn("h-full transition-all duration-500", TONE_FILL[tone])} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-phx-2xs font-black text-slate-400">{pct}%</span>
      </div>
      {vacant > 0 ? (
        <p className="relative mt-1.5 text-phx-2xs font-black uppercase tracking-[0.08em] text-orange-600">
          {vacant} vacant
        </p>
      ) : null}
    </div>
  );
}

function CompletionBar({
  actual,
  total,
  vacant,
  summary,
}: {
  actual: number;
  total: number;
  vacant: number;
  summary: string;
}) {
  const filledPct = total > 0 ? Math.round((actual / total) * 100) : 0;
  const vacantPct = 100 - filledPct;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_2px_12px_rgba(15,23,42,0.05)] sm:p-5">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div className="flex items-center gap-2">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <div>
            <h3 className="text-sm font-black text-slate-900">Structure Completion</h3>
            <p className="mt-0.5 text-phx-xs text-slate-500">
              {summary}
            </p>
          </div>
        </div>
        {total > 0 ? (
          <div className="text-right">
            <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
              Filled
            </p>
            <p className="text-base font-black text-slate-900">{filledPct}%</p>
          </div>
        ) : null}
      </div>
      {total > 0 ? (
        <>
          <div
            aria-label="Structure completion chart"
            className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100"
            role="img"
          >
            <div
              className="bg-gradient-to-r from-emerald-500 to-emerald-400"
              style={{ width: `${filledPct}%`, minWidth: actual > 0 ? "3px" : "0" }}
            />
            <div
              className="bg-gradient-to-r from-orange-400 to-orange-500"
              style={{ width: `${vacantPct}%`, minWidth: vacant > 0 ? "3px" : "0" }}
            />
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-3 text-phx-xs">
            <span className="inline-flex items-center gap-1.5 text-slate-600">
              <span aria-hidden className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
              <span className="font-medium">Filled {filledPct}%</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-slate-600">
              <span aria-hidden className="inline-block h-2 w-2 rounded-sm bg-orange-400" />
              <span className="font-medium">Vacant {vacantPct}%</span>
            </span>
            <span className="ml-auto text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-400">
              Total {total} {total === 1 ? "seat" : "seats"}
            </span>
          </div>
        </>
      ) : (
        <div className="flex h-3 w-full items-center justify-center rounded-full bg-slate-100">
          <span className="text-phx-2xs text-slate-400">No data</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tier label                                                         */
/* ------------------------------------------------------------------ */

function TierLabel({
  count,
  dotClassName,
  text,
  textClassName,
}: {
  count?: string;
  dotClassName: string;
  text: string;
  textClassName: string;
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", dotClassName)} />
      <p className={cn("text-phx-2xs font-black uppercase tracking-[0.14em]", textClassName)}>
        {text}
      </p>
      {count ? (
        <span className="text-phx-2xs font-semibold text-slate-400">
          · {count}
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main tree                                                          */
/* ------------------------------------------------------------------ */

export function OrgChartTree(props: OrgChartTreeProps) {
  const pathname = usePathname();
  const { asOfMonth = null, canAddEmployee = false } = props;
  // Decided once, here, for every consumer below: the tile buttons AND the seat popup. A past
  // picture never offers a way to change somebody's record.
  const mayChangeEmployees = canAddEmployee && !asOfMonth;
  const employeeActions = React.useMemo(
    () => (mayChangeEmployees ? { basePath: employeeMasterBasePath(pathname) } : null),
    [mayChangeEmployees, pathname],
  );

  return (
    <EmployeeActionsContext.Provider value={employeeActions}>
      <OrgChartTreeBody {...props} canAddEmployee={mayChangeEmployees} />
    </EmployeeActionsContext.Provider>
  );
}

function OrgChartTreeBody({
  rows,
  lineName,
  theme = "admin",
  kpiLabels = DEFAULT_ORG_KPI_LABELS,
  canAddEmployee = false,
  canReadEmployeeCv = true,
  asOfMonth = null,
}: OrgChartTreeProps) {
  // Change #2 — the pressed node's row; non-null opens the employee-master popup.
  const [selectedRow, setSelectedRow] = React.useState<OrganogramRow | null>(null);
  const [hideVacantResigned, setHideVacantResigned] = React.useState(false);
  const handleSelectNode = React.useCallback((row: OrganogramRow) => {
    setSelectedRow(row);
  }, []);

  // "Select & email" — pick a slice of this (already server-scoped) chart, copy their
  // work emails, or export just that slice.
  const [audienceOpen, setAudienceOpen] = React.useState(false);

  const [collapsedKeys, setCollapsedKeys] = React.useState<Set<string>>(new Set());
  const collapsedKeysRef = React.useRef(collapsedKeys);
  React.useEffect(() => {
    collapsedKeysRef.current = collapsedKeys;
  }, [collapsedKeys]);
  const toggle = React.useCallback((key: string) => {
    setCollapsedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // Zoom: scales only the chart canvas (spine + lanes), not the KPI summary
  // above it. Ctrl/Cmd+wheel matches the conventional "don't hijack normal
  // page scroll" pattern; panning stays on the existing native overflow-x
  // scroll rather than a custom drag handler, so it can't interfere with the
  // per-node collapse click targets.
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 1.75;
  const clampZoom = React.useCallback(
    (value: number) => Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)) * 100) / 100,
    [],
  );
  const [zoom, setZoom] = React.useState(1);
  const zoomIn = React.useCallback(() => setZoom((z) => clampZoom(z + 0.1)), [clampZoom]);
  const zoomOut = React.useCallback(() => setZoom((z) => clampZoom(z - 0.1)), [clampZoom]);
  const resetZoom = React.useCallback(() => setZoom(1), []);
  const handleCanvasWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      setZoom((z) => clampZoom(z + (event.deltaY < 0 ? 0.1 : -0.1)));
    },
    [clampZoom],
  );

  // Print: unroll every collapsed lane for the duration of printing (a
  // collapsed lane's members aren't in the DOM at all when collapsed, so no
  // print-only CSS override could resurrect them — this has to happen in
  // JS), then restore whatever was collapsed before. Listens for the actual
  // beforeprint/afterprint events rather than only the toolbar button's
  // onClick, so it also covers the browser's native Ctrl+P / File > Print.
  const [isPrinting, setIsPrinting] = React.useState(false);
  const collapsedKeysBeforePrintRef = React.useRef<Set<string> | null>(null);
  React.useEffect(() => {
    const handleBeforePrint = () => {
      collapsedKeysBeforePrintRef.current = collapsedKeysRef.current;
      setCollapsedKeys(new Set());
      setIsPrinting(true);
    };
    const handleAfterPrint = () => {
      if (collapsedKeysBeforePrintRef.current) {
        setCollapsedKeys(collapsedKeysBeforePrintRef.current);
        collapsedKeysBeforePrintRef.current = null;
      }
      setIsPrinting(false);
    };

    window.addEventListener("beforeprint", handleBeforePrint);
    window.addEventListener("afterprint", handleAfterPrint);
    return () => {
      window.removeEventListener("beforeprint", handleBeforePrint);
      window.removeEventListener("afterprint", handleAfterPrint);
    };
  }, []);
  const handlePrint = React.useCallback(() => window.print(), []);

  // PNG export target — deliberately the chart canvas only (spine + lanes),
  // excluding the toolbar/KPI cards above it, which live in sibling elements
  // outside this ref.
  const chartCanvasRef = React.useRef<HTMLDivElement>(null);
  const [isExportingPng, setIsExportingPng] = React.useState(false);

  const structureKpis = React.useMemo(() => calculateOrganogramStructureKpis(rows), [rows]);
  const { chiefExecutive, groups, laneLeaderName, lineLeader } = React.useMemo(() => {
    const lanes = buildOrganogramLanes(rows);
    return {
      ...lanes,
      laneLeaderName: lanes.lineLeader
        ? formatEmployeeDisplayName(lanes.lineLeader.displayName)
        : (lineName ?? "Line Leadership"),
    };
  }, [rows, lineName]);

  // Every figure the chart prints comes from this one count (src/lib/reports/organogram-counts.ts).
  const chartCounts = React.useMemo(() => buildOrganogramChartCounts(rows, groups), [rows, groups]);
  const resolvedLineName = lineName ?? "Selected line";

  const directDsms = groups.filter((group) => group.dsm && !group.rsm);
  const rsmGroups = groups.filter((group) => group.rsm);
  const otherGroups = groups.filter((group) => !group.dsm && !group.rsm);
  const hasContent = rows.length > 0;

  const handleExportPng = React.useCallback(async () => {
    if (!chartCanvasRef.current || isExportingPng) return;
    setIsExportingPng(true);
    const previousCollapsedKeys = collapsedKeysRef.current;
    try {
      // Unroll every lane so the exported image shows the full structure,
      // not whatever happens to be collapsed on screen — then wait two
      // animation frames for React to actually commit that DOM before
      // capturing it (a single setState doesn't paint synchronously).
      setCollapsedKeys(new Set());
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });

      const { toPng } = await import("html-to-image");
      const dataUrl = await toPng(chartCanvasRef.current, {
        backgroundColor: "#ffffff",
        // The Edit and Resign buttons are controls, not part of the structure being exported.
        filter: (node) => !(node instanceof HTMLElement && "organogramAction" in node.dataset),
        pixelRatio: 2,
      });

      const link = document.createElement("a");
      const safeLineName = resolvedLineName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      link.download = `organogram-${safeLineName || "structure"}${asOfMonth ? `-${asOfMonth}` : ""}.png`;
      link.href = dataUrl;
      link.click();
    } catch (error) {
      console.error("Organogram PNG export failed:", error);
    } finally {
      setCollapsedKeys(previousCollapsedKeys);
      setIsExportingPng(false);
    }
  }, [asOfMonth, isExportingPng, resolvedLineName]);

  // Every collapsible top-level lane key — mirrors the keys the tiers below use —
  // so "Collapse all" can fold every lane in one click.
  const collapsibleLaneKeys = [
    ...directDsms.map((group, index) => tierLaneKey("t1", group, index)),
    ...rsmGroups.flatMap((group, index) => {
      const laneKey = tierLaneKey("t2", group, index);
      return (group.childLanes ?? []).map((lane, laneIndex) => childLaneKey(laneKey, lane, laneIndex));
    }),
    ...otherGroups.map((group, index) => `other-${group.name}-${index}`),
  ];

  // Flat structure export — the same rows the chart renders (already server-scoped to
  // the viewer), downloaded as a premium Phoenix-styled sheet. Columns and cell values
  // come from the shared audience module so this sheet and the picker's filtered sheet
  // are the same sheet, never two drifting definitions of "the organogram export".
  const exportRows = React.useMemo(() => buildOrganogramExportRows(rows), [rows]);
  // The Mobile column is fetched when Export is pressed, never carried on the rows the
  // chart holds — see the header of organogram-audience.ts for why that distinction is
  // the whole point.
  const resolveExportRows = React.useCallback(async () => {
    const mobileByHrId = await fetchOrganogramMobileNumbers();
    return buildOrganogramExportRows(rows, mobileByHrId);
  }, [rows]);

  const kpiIconClassName = "h-4 w-4";
  const kpiCards: Array<{ actual: number; icon: React.ReactNode; label: string; tone: KpiTone; total: number; vacant: number }> = [
    { actual: structureKpis.medicalRep.actual, icon: <UserRound className={kpiIconClassName} />, label: kpiLabels.medicalRep, tone: "emerald", total: structureKpis.medicalRep.total, vacant: structureKpis.medicalRep.vacant },
    { actual: structureKpis.dsm.actual, icon: <MapPin className={kpiIconClassName} />, label: kpiLabels.dsm, tone: "sky", total: structureKpis.dsm.total, vacant: structureKpis.dsm.vacant },
    { actual: structureKpis.rsm.actual, icon: <Layers className={kpiIconClassName} />, label: kpiLabels.rsm, tone: "amber", total: structureKpis.rsm.total, vacant: structureKpis.rsm.vacant },
    { actual: structureKpis.nsm.actual, icon: <UsersRound className={kpiIconClassName} />, label: kpiLabels.nsm, tone: "orange", total: structureKpis.nsm.total, vacant: structureKpis.nsm.vacant },
    { actual: structureKpis.total.actual, icon: <Network className={kpiIconClassName} />, label: kpiLabels.total, tone: "slate", total: structureKpis.total.total, vacant: structureKpis.total.vacant },
  ];

  return (
    <div className="space-y-5" dir="auto">
      {asOfMonth ? <OrganogramAsOfBanner month={asOfMonth} /> : null}

      {/* Whole-tree controls + structure export */}
      {hasContent ? (
        <div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
          <label className="inline-flex h-9 items-center gap-2 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink shadow-sm">
            <Switch checked={hideVacantResigned} label="Hide vacant and resigned" onChange={setHideVacantResigned} />
            <span>Hide vacant and resigned</span>
          </label>
          <div className="inline-flex h-9 items-center gap-0.5 border border-phx-line bg-white px-1 text-phx-ink shadow-sm">
            <button
              aria-label="Zoom out"
              className="inline-flex h-7 w-7 items-center justify-center text-slate-500 transition hover:text-phx-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/40 disabled:cursor-not-allowed disabled:opacity-30"
              disabled={zoom <= MIN_ZOOM}
              onClick={zoomOut}
              type="button"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <button
              aria-label="Reset zoom to 100%"
              className="min-w-[3.5rem] px-1 text-center text-xs font-bold tabular-nums text-slate-500 transition hover:text-phx-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/40"
              onClick={resetZoom}
              type="button"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              aria-label="Zoom in"
              className="inline-flex h-7 w-7 items-center justify-center text-slate-500 transition hover:text-phx-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/40 disabled:cursor-not-allowed disabled:opacity-30"
              disabled={zoom >= MAX_ZOOM}
              onClick={zoomIn}
              type="button"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <button
            className="inline-flex h-9 items-center gap-1 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink shadow-sm transition hover:border-phx-accent-line hover:text-phx-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/40"
            onClick={() => setCollapsedKeys(new Set())}
            type="button"
          >
            Expand all
          </button>
          <button
            className="inline-flex h-9 items-center gap-1 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink shadow-sm transition hover:border-phx-accent-line hover:text-phx-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/40"
            onClick={() => setCollapsedKeys(new Set(collapsibleLaneKeys))}
            type="button"
          >
            Collapse all
          </button>
          <button
            className="inline-flex h-9 items-center gap-1.5 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink shadow-sm transition hover:border-phx-accent-line hover:text-phx-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/40"
            onClick={handlePrint}
            type="button"
          >
            <Printer className="h-3.5 w-3.5" />
            Print
          </button>
          <button
            className="inline-flex h-9 items-center gap-1.5 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink shadow-sm transition hover:border-phx-accent-line hover:text-phx-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/40 disabled:opacity-50"
            disabled={isExportingPng}
            onClick={handleExportPng}
            type="button"
          >
            {isExportingPng ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ImageDown className="h-3.5 w-3.5" />
            )}
            PNG
          </button>
          {/* The spreadsheet and the email picker read people's CURRENT records and work emails,
              so on a past picture they would pair today's contact details with a past month's seat. */}
          {asOfMonth ? null : (
            <>
              <ExportXlsxButton
                columns={ORGANOGRAM_EXPORT_COLUMNS}
                resolveRows={resolveExportRows}
                rows={exportRows}
                sheetName="Organogram"
                subtitle={`${resolvedLineName} · ${chartCounts.people.shown} people`}
                title={`Organogram — ${resolvedLineName}`}
              />
              <button
                className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap border border-phx-accent bg-phx-accent px-3 text-xs font-bold text-white shadow-sm transition hover:bg-phx-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/40"
                onClick={() => setAudienceOpen(true)}
                type="button"
              >
                <Users className="h-3.5 w-3.5" />
                Select &amp; email
              </button>
            </>
          )}
        </div>
      ) : null}

      {audienceOpen && !asOfMonth ? (
        <OrganogramAudienceDialog
          onClose={() => setAudienceOpen(false)}
          rows={rows}
          scopeLabel={resolvedLineName}
        />
      ) : null}

      {/* KPI strip */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {kpiCards.map((card) => (
          <KpiCard
            actual={card.actual}
            icon={card.icon}
            key={card.label}
            label={card.label}
            tone={card.tone}
            total={card.total}
            vacant={card.vacant}
          />
        ))}
      </div>

      <CompletionBar
        actual={structureKpis.total.actual}
        summary={describeOrganogramCounts(chartCounts)}
        total={structureKpis.total.total}
        vacant={structureKpis.total.vacant}
      />

      {/* Chart canvas — overflow-x-auto (not -hidden) so a structure wider than the
          viewport (common on mobile, where zooming out to 50% often still isn't
          enough to fit every lane) can be panned into view by touch/scroll instead
          of just clipping the extra lanes with no way to reach them. */}
      <div
        className={cn(
          "@container overflow-x-auto overscroll-x-contain rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-6 sm:px-5 print:overflow-visible print:rounded-none print:border-none print:bg-white print:p-0 print:shadow-none",
          theme === "admin" ? "shadow-[0_2px_16px_rgba(15,23,42,0.06)] print:shadow-none" : "",
        )}
        onWheel={handleCanvasWheel}
        ref={chartCanvasRef}
        style={
          isPrinting
            ? undefined
            : {
                WebkitOverflowScrolling: "touch",
                backgroundImage:
                  "linear-gradient(rgba(226,232,240,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(226,232,240,0.6) 1px, transparent 1px)",
                backgroundSize: "48px 48px",
              }
        }
      >
        {/* Zoom scales everything below; print always renders at 100% so the
            full structure fits the page regardless of the on-screen zoom. */}
        <div className="print:!scale-100" style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}>
        {/* Executive spine */}
        <div className="flex flex-col items-center">
          <SpineNode
            icon={<Crown className="h-3.5 w-3.5" />}
            label={
              chiefExecutive
                ? chiefExecutive.positionTitle ?? chiefExecutive.jobTitle ?? "CEO"
                : "CEO"
            }
            name={
              chiefExecutive
                ? formatEmployeeDisplayName(chiefExecutive.displayName)
                : "Executive Leadership"
            }
            onSelect={handleSelectNode}
            row={chiefExecutive}
            tone="dark"
          />
          <Trunk />
          <SpineNode
            icon={<Network className="h-3.5 w-3.5" />}
            label="Line"
            name={resolvedLineName}
            tone="line"
          />
          <Trunk />
          <SpineNode
            icon={<UsersRound className="h-3.5 w-3.5" />}
            label={
              lineLeader
                ? lineLeader.positionTitle ?? lineLeader.jobTitle ?? "National Sales Manager"
                : "National Sales Manager"
            }
            name={laneLeaderName}
            onSelect={handleSelectNode}
            row={lineLeader}
            tone="leader"
          />
          <Trunk />
          <div aria-hidden className="relative h-0.5 w-[92%] max-w-5xl bg-orange-300/70">
            <span className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-orange-500" />
          </div>
        </div>

        {groups.length === 0 ? (
          <div className="mx-auto mt-8 max-w-md rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            No manager lanes found for this line.
          </div>
        ) : (
          <div className="mt-6 space-y-8 pb-2">
            {/* Tier 1 — DSMs reporting directly to the NSM */}
            {directDsms.length > 0 ? (
              <div>
                <TierLabel
                  count={formatDistrictLaneCount(directDsms.length)}
                  dotClassName="bg-slate-400"
                  text="Reports to NSM"
                  textClassName="text-slate-500"
                />
                <div
                  className={LANE_GRID_CLASS_NAME}
                  style={laneGridStyle(directDsms.length)}
                >
                  {directDsms.map((group, index) => {
                    const laneKey = tierLaneKey("t1", group, index);
                    if (isLaneHidden(group, hideVacantResigned)) return null;
                    return (
                      <div className="flex flex-col" key={laneKey}>
                        <div aria-hidden className="mx-auto h-3 w-0.5 bg-orange-300/70" />
                        <ManagerLane
                          collapsedKeys={collapsedKeys}
                          group={group}
                          hideVacantResigned={hideVacantResigned}
                          laneKey={laneKey}
                          onSelect={handleSelectNode}
                          onToggle={toggle}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* Tier 2 — each RSM banner + its child DSM lanes */}
            {rsmGroups.map((group, index) => {
              const childLanes = group.childLanes ?? [];
              const laneKey = tierLaneKey("t2", group, index);
              const rsmRow = group.rsm ?? null;
              const rsmFacts = personFactsLine(rsmRow);
              const groupVacancies = countRegionOpenSeats(childLanes);
              return (
                <div key={laneKey}>
                  <TierLabel
                    dotClassName="bg-orange-500"
                    text={`Reports to NSM · ${laneLeaderName}`}
                    textClassName="text-orange-700"
                  />
                  <div className="overflow-hidden rounded-xl border border-orange-200 bg-white shadow-[0_2px_12px_rgba(15,23,42,0.06)]">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-orange-200 bg-gradient-to-r from-orange-100/60 via-orange-50 to-orange-100/60 px-4 py-3">
                      {(() => {
                        const rsmInner = (
                          <>
                            <span
                              aria-hidden
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-500 text-phx-xs font-black text-white"
                            >
                              {initials(group.name)}
                            </span>
                            <div className="min-w-0">
                              <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-orange-700">
                                {group.title}
                              </p>
                              <p className="mt-0.5 break-words text-phx-md font-bold text-slate-900">
                                {formatEmployeeDisplayName(group.name)}
                              </p>
                              {rsmFacts ? (
                                <p className="mt-0.5 break-words text-phx-2xs font-semibold text-orange-700">
                                  {rsmFacts}
                                </p>
                              ) : null}
                            </div>
                          </>
                        );
                        return rsmRow ? (
                          <button
                            aria-label={`View details for ${formatEmployeeDisplayName(group.name)}`}
                            className="flex items-center gap-2.5 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-400/60"
                            onClick={() => handleSelectNode(rsmRow)}
                            type="button"
                          >
                            {rsmInner}
                          </button>
                        ) : (
                          <div className="flex items-center gap-2.5">{rsmInner}</div>
                        );
                      })()}
                      <EmployeeTileActions row={rsmRow} />
                      <div className="flex items-center gap-1.5 text-phx-2xs">
                        <span className="inline-flex items-center gap-1 rounded-md bg-white px-1.5 py-1 font-bold text-slate-600 ring-1 ring-orange-200">
                          <Layers className="h-3 w-3 text-orange-500" />
                          {formatDistrictLaneCount(childLanes.length)}
                        </span>
                        {groupVacancies > 0 ? (
                          <span className="rounded-md bg-orange-200/70 px-1.5 py-1 font-black text-orange-700">
                            {groupVacancies} open {groupVacancies === 1 ? "seat" : "seats"}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div
                      className={cn(LANE_GRID_CLASS_NAME, "bg-orange-50/30 p-3")}
                      style={laneGridStyle(childLanes.length)}
                    >
                      {childLanes.length > 0 ? (
                        childLanes.map((lane, laneIndex) => {
                          const childKey = childLaneKey(laneKey, lane, laneIndex);
                          if (isLaneHidden(lane, hideVacantResigned)) return null;
                          return (
                            <div className="flex flex-col" key={childKey}>
                              <div aria-hidden className="mx-auto h-3 w-0.5 bg-orange-300/70" />
                              <ManagerLane
                                collapsedKeys={collapsedKeys}
                                group={lane}
                                hideVacantResigned={hideVacantResigned}
                                laneKey={childKey}
                                onSelect={handleSelectNode}
                                onToggle={toggle}
                              />
                            </div>
                          );
                        })
                      ) : (
                        <div className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-phx-xs text-slate-400">
                          No DSM lanes under this regional manager.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Marketing / fallback groups */}
            {otherGroups.length > 0 ? (
              <div>
                <TierLabel
                  count={`${otherGroups.length} ${otherGroups.length === 1 ? "group" : "groups"}`}
                  dotClassName="bg-slate-400"
                  text="Other reporting groups"
                  textClassName="text-slate-500"
                />
                <div
                  className={LANE_GRID_CLASS_NAME}
                  style={laneGridStyle(otherGroups.length)}
                >
                  {otherGroups.map((group, index) => {
                    const laneKey = `other-${group.name}-${index}`;
                    if (isLaneHidden(group, hideVacantResigned)) return null;
                    return (
                      <div className="flex flex-col" key={laneKey}>
                        <div aria-hidden className="mx-auto h-3 w-0.5 bg-orange-300/70" />
                        <ManagerLane
                          collapsedKeys={collapsedKeys}
                          group={group}
                          hideVacantResigned={hideVacantResigned}
                          laneKey={laneKey}
                          onSelect={handleSelectNode}
                          onToggle={toggle}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <p className="pt-1 text-phx-2xs font-semibold text-slate-400">
              {formatDistrictLaneCount(chartCounts.lanes.district)} shown
              {chartCounts.lanes.other > 0
                ? ` and ${chartCounts.lanes.other} other reporting ${chartCounts.lanes.other === 1 ? "group" : "groups"}`
                : ""}
            </p>
          </div>
        )}
        </div>
      </div>

      {/* Change #2 — pressing any node opens the full employee-master record. The
          modal fetches the role-gated detail itself; a vacancy renders from the row
          alone. Rendered here (portaled to <body>) so it overlays the whole chart. */}
      {selectedRow ? (
        <OrganogramNodeDetailModal
          canAddEmployee={canAddEmployee}
          canReadEmployeeCv={canReadEmployeeCv}
          onClose={() => setSelectedRow(null)}
          row={selectedRow}
        />
      ) : null}
    </div>
  );
}
