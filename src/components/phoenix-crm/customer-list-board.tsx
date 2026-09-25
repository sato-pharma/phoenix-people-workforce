"use client";

/**
 * Phoenix CRM — the customer sections of the List tab, given the board's own treatment.
 *
 * Owner, 2026-09-25: "make all the list tabs have the same features and tweaks." The list opens on
 * "The list" board — bricks in colour, collapsible, six filters and an export — and the other parts
 * of the list (To validate, Customers, Left the list) read the same customers a plainer way. This
 * renders those three the board's way instead: grouped by brick with the same eight hues and the
 * same open/shut headings, the same filter row, and the same XLSX export.
 *
 * WHY A SECOND COMPONENT RATHER THAN THE BOARD ITSELF. The board (`RepsListContacts`) reads the
 * iReports360 mirror — rows keyed on a contact's CRM id, pharmacies and all — while these three read
 * the CRM's own customer list (`ListCustomer`): new customers the rep added with no iReports360 row,
 * customers with no place yet, dropped customers the board no longer carries. Neither population is a
 * subset of the other, so the look is shared here rather than the data being forced through one pipe.
 * The palette, the square edges and the 1px rules are copied verbatim so the two read as one board.
 */

import { useCallback, useId, useMemo, useState, type ReactNode } from "react";

import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { TableSearchInput } from "@/components/ui/sortable-table";
import { cairoStamp } from "@/components/phoenix-crm/format";
import {
  customerMetaText,
  monthStanding,
  monthVisitsText,
  PENDING_PILL,
  pendingVisitsText,
  referenceAddressText,
  referenceLastVisitText,
} from "@/components/phoenix-crm/labels";
import { placesDaysText } from "@/components/phoenix-crm/list-screens";
import {
  CrmCard,
  CrmCardsOnPhone,
  CrmPill,
  CrmTable,
  crmTdClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import {
  buildGroups,
  displayOrder,
  distinct,
  gradeOf,
  matchesActivity,
  matchesQuery,
  specialityOf,
  type CustomerGroup,
} from "@/lib/phoenix-crm/customer-list-grouping";
import type { ListCustomer } from "@/lib/phoenix-crm/view-types";

/**
 * BRICK COLOUR — the same eight hues, in the same order, as the board (reps-list-tables.tsx). Kept
 * here too because the colour is "Phoenix CRM's List tab only" and these sections are that tab. The
 * wash lands on the block heading, never on a row: a mapped brick gets a left bar and a light fill,
 * an unmapped locality stays amber, exactly as the board draws them.
 */
const BRICK_TINTS = [
  { bar: "border-l-sky-500", fill: "bg-sky-50" },
  { bar: "border-l-emerald-500", fill: "bg-emerald-50" },
  { bar: "border-l-indigo-500", fill: "bg-indigo-50" },
  { bar: "border-l-teal-500", fill: "bg-teal-50" },
  { bar: "border-l-fuchsia-500", fill: "bg-fuchsia-50" },
  { bar: "border-l-cyan-500", fill: "bg-cyan-50" },
  { bar: "border-l-lime-500", fill: "bg-lime-50" },
  { bar: "border-l-stone-500", fill: "bg-stone-100" },
] as const;
type BrickTint = (typeof BRICK_TINTS)[number];

/**
 * The board's field-surface controls (reps-list-tables.tsx, FIELD_*_CLASS): a thumb's 44px on a phone
 * and 36px from `md`, labels at the house 10px floor, and a square edge written out because a phone's
 * native select draws its own.
 */
const LABEL_CLASS = "block text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-400";
const SELECT_CLASS =
  "h-11 w-full rounded-none border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 md:h-9";

/** Which part of the list this is drawing — it decides the row's detail line, its pills and headers. */
export type CustomerListVariant = "pending" | "active" | "dropped";

/**
 * A brick's colour, keyed off its place in the WHOLE list rather than the filtered or sorted one — a
 * brick that changes hue as you search, or as the display order changes, is not a brick anyone can
 * learn. Only mapped bricks are tinted; an unmapped locality keeps amber, which is a statement.
 */
function tintsFor(groups: readonly CustomerGroup[]): Map<string, BrickTint> {
  const tints = new Map<string, BrickTint>();
  let index = 0;
  for (const group of groups) {
    if (!group.mapped) continue;
    tints.set(group.key, BRICK_TINTS[index % BRICK_TINTS.length]);
    index += 1;
  }
  return tints;
}

function GroupCaret({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      className={`h-3 w-3 shrink-0 self-center text-slate-500 transition-transform ${open ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="square"
      strokeLinejoin="miter"
      strokeWidth="2.5"
      viewBox="0 0 24 24"
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

/** The block heading — the board's heading shape, so the two read as one board. */
function GroupHeading({
  collapsed,
  group,
  onToggle,
  shown,
  tint,
}: {
  collapsed: boolean;
  group: CustomerGroup;
  onToggle: () => void;
  shown: number;
  tint: BrickTint | null;
}) {
  const mappedTone = tint ? `border-slate-200 border-l-4 ${tint.bar} ${tint.fill}` : "border-slate-200 bg-slate-50";
  const tone = group.mapped ? mappedTone : "border-amber-200 bg-amber-50";
  return (
    <button
      aria-expanded={!collapsed}
      className={`flex w-full flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-y px-4 py-2.5 text-left sm:px-5 ${tone}`}
      onClick={onToggle}
      type="button"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <GroupCaret open={!collapsed} />
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-900" dir="auto">
          {group.heading}
        </h3>
        {group.mapped && group.areaName ? (
          <span className="text-phx-2xs font-semibold text-slate-500">{group.areaName}</span>
        ) : group.mapped ? null : (
          <span className="text-phx-2xs font-black uppercase tracking-[0.1em] text-amber-700">
            Locality not yet mapped to a brick
          </span>
        )}
      </div>
      <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">
        {shown === group.customers.length ? `${group.customers.length}` : `${shown} of ${group.customers.length} shown`}
      </span>
    </button>
  );
}

/** The row's pills — the same standing chip an active customer carries on the board, or the pending mark. */
function rowPills(customer: ListCustomer, variant: CustomerListVariant): ReactNode {
  if (variant === "pending") {
    return (
      <>
        <CrmPill tone="orange">{PENDING_PILL}</CrmPill>
        {customer.pendingDropRequestId ? <CrmPill tone="warn">Drop waiting</CrmPill> : null}
      </>
    );
  }
  if (variant === "dropped") return null;
  const standing = monthStanding(customer.visitsThisMonth, customer.target);
  return (
    <>
      <CrmPill tone={standing.tone}>{standing.label}</CrmPill>
      {customer.origin === "new" ? <CrmPill tone="orange">New customer</CrmPill> : null}
      {customer.pendingGradeRequestId ? (
        <CrmPill tone="info">{customer.pendingGrade ? `Grade ${customer.pendingGrade} proposed` : "Grade proposed"}</CrmPill>
      ) : null}
      {customer.pendingDropRequestId ? <CrmPill tone="warn">Drop waiting</CrmPill> : null}
    </>
  );
}

/** The detail line under a row — where he is (or was), said the way that part of the list says it. */
function detailText(customer: ListCustomer, variant: CustomerListVariant): string {
  if (variant === "pending") return referenceAddressText(customer.reference) ?? "No address in iReports360";
  if (variant === "dropped") return customer.droppedReason ?? "Reason not recorded";
  return placesDaysText(customer);
}

/** The month line beside a row — pending never says "not visited", dropped says when it left. */
function monthText(customer: ListCustomer, variant: CustomerListVariant): string {
  if (variant === "pending") return pendingVisitsText(customer.visitsThisMonth);
  if (variant === "dropped") return `Left the list ${cairoStamp(customer.statusChangedAt)}`;
  return monthVisitsText(customer.visitsThisMonth, customer.target);
}

const DETAIL_HEADER: Record<CustomerListVariant, string> = {
  pending: "Address in iReports360",
  active: "Places and days",
  dropped: "Why it left",
};
const MONTH_HEADER: Record<CustomerListVariant, string> = {
  pending: "This month",
  active: "This month",
  dropped: "Left the list",
};

export function CustomerListBoard({
  customers,
  exportTitle,
  repName,
  rowActions,
  variant,
}: {
  /** The whole status subset for this part of the list, unfiltered — the board does its own filtering. */
  customers: readonly ListCustomer[];
  /** The download's sheet name and title, e.g. "Customers". */
  exportTitle: string;
  /** Whose list this is, by name — heads the export (owner's standing rule: names, never seat codes). */
  repName: string;
  /** The section's own buttons on a row: Validate / Add a visit / Open, or Bring back / Open. */
  rowActions: (customer: ListCustomer) => ReactNode;
  variant: CustomerListVariant;
}) {
  const [brick, setBrick] = useState("");
  const [listType, setListType] = useState("");
  const [grade, setGrade] = useState("");
  const [speciality, setSpeciality] = useState("");
  const [activity, setActivity] = useState("");
  const [query, setQuery] = useState("");
  // Phones only: whether the filter row is unfolded. Shut by default, as on the board — the toggle
  // names how many filters are on, so a narrowed list never passes for the whole one.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Built from ALL the customers, in appearance order, so a brick keeps its hue as a filter narrows
  // the board — the same discipline the board itself keeps.
  const allGroups = useMemo(() => buildGroups(customers), [customers]);
  const tints = useMemo(() => tintsFor(allGroups), [allGroups]);
  const gradeOptions = useMemo(() => distinct(customers.map(gradeOf)), [customers]);
  const specialityOptions = useMemo(() => distinct(customers.map(specialityOf)), [customers]);

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      displayOrder(allGroups)
        .filter((group) => !brick || group.key === brick)
        .map((group) => ({
          group,
          rows: group.customers.filter(
            (customer) =>
              (!listType || customer.listType === listType) &&
              (!grade || gradeOf(customer) === grade) &&
              (!speciality || specialityOf(customer) === speciality) &&
              matchesActivity(customer, activity) &&
              matchesQuery(customer, needle),
          ),
        }))
        .filter((entry) => entry.rows.length > 0),
    [activity, allGroups, brick, grade, listType, needle, speciality],
  );

  const shownCount = visible.reduce((sum, entry) => sum + entry.rows.length, 0);
  const brickCount = visible.filter((entry) => entry.group.mapped).length;
  const localityCount = visible.length - brickCount;

  const exportRows = visible.flatMap((entry) =>
    entry.rows.map((customer) => ({
      brick: entry.group.mapped ? entry.group.heading : `${entry.group.heading} (not yet mapped to a brick)`,
      area: entry.group.areaName ?? "",
      customer: customer.name,
      grade: customer.grade ?? "",
      speciality: customer.speciality ?? "",
      list: customer.listType,
      detail: detailText(customer, variant),
      visits: customer.visitsThisMonth,
      target: customer.target ?? "",
      standing: variant === "active" ? monthStanding(customer.visitsThisMonth, customer.target).label : "",
      left_on: variant === "dropped" ? cairoStamp(customer.statusChangedAt) : "",
    })),
  );

  const filtersOn = [brick, listType, activity, grade, speciality, needle].filter(Boolean).length;

  return (
    <div className="space-y-3 border-t border-slate-100 px-4 py-5 sm:px-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {/* On a phone the filter row folds behind this one toggle, which says how many filters are
            on; from `md` up the row is always open and the toggle is gone. */}
        <button
          aria-controls={filtersId}
          aria-expanded={filtersOpen}
          className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2 rounded-none border border-slate-200 bg-white px-3 text-left text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-600 md:hidden"
          onClick={() => setFiltersOpen((open) => !open)}
          type="button"
        >
          <span className="min-w-0 break-words">{filtersOn > 0 ? `Filters · ${filtersOn} on` : "Filters"}</span>
          <GroupCaret open={filtersOpen} />
        </button>
        {/* `hidden` and `flex` are never written together: which of two display utilities wins is
            the stylesheet's order, not the class list's. */}
        <div className={filtersOpen ? "flex flex-wrap items-end gap-3" : "hidden flex-wrap items-end gap-3 md:flex"} id={filtersId}>
          <label className="block w-full sm:w-56">
            <span className={LABEL_CLASS}>Brick</span>
            <select className={`mt-1 ${SELECT_CLASS}`} onChange={(event) => setBrick(event.target.value)} value={brick}>
              <option value="">All bricks</option>
              {displayOrder(allGroups).map((group) => (
                <option key={group.key} value={group.key}>
                  {group.mapped ? group.heading : `${group.heading} — no brick yet`}
                </option>
              ))}
            </select>
          </label>
          <label className="block w-full sm:w-44">
            <span className={LABEL_CLASS}>List</span>
            <select className={`mt-1 ${SELECT_CLASS}`} onChange={(event) => setListType(event.target.value)} value={listType}>
              <option value="">PM and AM lists</option>
              <option value="PM">PM list only</option>
              <option value="AM">AM list only</option>
            </select>
          </label>
          <label className="block w-full sm:w-52">
            <span className={LABEL_CLASS}>This month</span>
            <select className={`mt-1 ${SELECT_CLASS}`} onChange={(event) => setActivity(event.target.value)} value={activity}>
              <option value="">All activity</option>
              <option value="unvisited">Not visited this month</option>
              <option value="visited">Visited this month</option>
            </select>
          </label>
          <label className="block w-full sm:w-40">
            <span className={LABEL_CLASS}>Grade</span>
            <select className={`mt-1 ${SELECT_CLASS}`} onChange={(event) => setGrade(event.target.value)} value={grade}>
              <option value="">All grades</option>
              {gradeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="block w-full sm:w-56">
            <span className={LABEL_CLASS}>Specialty</span>
            <select className={`mt-1 ${SELECT_CLASS}`} onChange={(event) => setSpeciality(event.target.value)} value={speciality}>
              <option value="">All specialties</option>
              {specialityOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="block w-full sm:w-64">
            <span className={LABEL_CLASS}>Search</span>
            <TableSearchInput
              className="mt-1"
              onChange={setQuery}
              onClear={() => setQuery("")}
              placeholder="Customer, specialty or address"
              size="md"
              value={query}
            />
          </label>
        </div>
        <ExportXlsxButton
          columns={[
            { key: "brick", label: "Brick" },
            { key: "area", label: "Area" },
            { key: "customer", label: "Customer" },
            { key: "grade", label: "Grade" },
            { key: "speciality", label: "Specialty" },
            { key: "list", label: "List" },
            { key: "detail", label: DETAIL_HEADER[variant] },
            { key: "visits", label: "Visits this month", numeric: true },
            { key: "target", label: "Target", numeric: true },
            ...(variant === "active" ? [{ key: "standing", label: "Standing" }] : []),
            ...(variant === "dropped" ? [{ key: "left_on", label: "Left the list" }] : []),
          ]}
          rows={exportRows}
          sheetName={exportTitle}
          subtitle={`${repName} · grouped by brick, as held by the CRM`}
          title={exportTitle}
        />
      </div>

      <p className="text-phx-2xs font-semibold text-slate-400">
        {`${shownCount} shown across ${brickCount} ${brickCount === 1 ? "brick" : "bricks"}`}
        {localityCount > 0 ? ` and ${localityCount} ${localityCount === 1 ? "locality" : "localities"} awaiting one` : ""}
      </p>

      {visible.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-slate-400">Nothing matches this filter.</p>
      ) : (
        <div className="border border-slate-200">
          {visible.map((entry) => {
            const isCollapsed = collapsed.has(entry.group.key);
            return (
              <div key={entry.group.key}>
                <GroupHeading
                  collapsed={isCollapsed}
                  group={entry.group}
                  onToggle={() => toggleGroup(entry.group.key)}
                  shown={entry.rows.length}
                  tint={tints.get(entry.group.key) ?? null}
                />
                {isCollapsed ? null : (
                  <>
                    <CrmCardsOnPhone>
                      {entry.rows.map((customer) => (
                        <CrmCard
                          actions={rowActions(customer)}
                          key={customer.customerId}
                          meta={customerMetaText(customer)}
                          status={rowPills(customer, variant)}
                          title={customer.name}
                        >
                          <p className="break-words text-xs font-semibold leading-5 text-slate-600">{detailText(customer, variant)}</p>
                          {variant === "pending" ? (
                            <p className="break-words text-xs font-semibold leading-5 text-slate-500">
                              Last visit in iReports360: {referenceLastVisitText(customer.reference)}
                            </p>
                          ) : null}
                          {variant === "dropped" && customer.droppedNote ? (
                            <p className="whitespace-pre-line break-words text-xs font-semibold leading-5 text-slate-600">{customer.droppedNote}</p>
                          ) : null}
                          <p className="break-words text-xs font-semibold leading-5 text-slate-500">{monthText(customer, variant)}</p>
                        </CrmCard>
                      ))}
                    </CrmCardsOnPhone>
                    <CrmTable columns={["30%", "34%", "18%", "18%"]}>
                      <thead>
                        <tr>
                          <th className={crmThClassName} scope="col">
                            Customer
                          </th>
                          <th className={crmThClassName} scope="col">
                            {DETAIL_HEADER[variant]}
                          </th>
                          <th className={crmThClassName} scope="col">
                            {MONTH_HEADER[variant]}
                          </th>
                          <th className={crmThClassName} scope="col">
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {entry.rows.map((customer) => (
                          <tr key={customer.customerId}>
                            <td className={crmTdClassName}>
                              <p className="font-black text-slate-950">{customer.name}</p>
                              <p className="mt-0.5 text-xs text-slate-500">{customerMetaText(customer)}</p>
                            </td>
                            <td className={crmTdClassName}>
                              <p className="break-words">{detailText(customer, variant)}</p>
                              {variant === "pending" ? (
                                <p className="mt-0.5 text-xs text-slate-500">
                                  Last visit in iReports360: {referenceLastVisitText(customer.reference)}
                                </p>
                              ) : null}
                              {variant === "dropped" && customer.droppedNote ? (
                                <p className="mt-0.5 whitespace-pre-line text-xs text-slate-500">{customer.droppedNote}</p>
                              ) : null}
                            </td>
                            <td className={crmTdClassName}>
                              <div className="flex flex-wrap gap-1">{rowPills(customer, variant)}</div>
                              <p className="mt-1 text-xs text-slate-500">{monthText(customer, variant)}</p>
                            </td>
                            <td className={crmTdClassName}>
                              {/* Stacked, each the column's full width — the board's Actions column does the same. */}
                              <div className="grid gap-1.5 [&>button]:w-full">{rowActions(customer)}</div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </CrmTable>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
