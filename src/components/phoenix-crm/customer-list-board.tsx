"use client";

/**
 * Phoenix CRM — the customer sections of the List tab, given the board's own treatment.
 *
 * Owner, 2026-09-25: "make all the list tabs have the same features and tweaks." The list opens on
 * "The list" board — bricks in colour, collapsible, six filters and an export — and the other parts
 * of the list (To validate, Your list, Outside the list, the Archive) read the same customers a plainer
 * way. This renders those the board's way instead: grouped by brick with the same eight hues and the
 * same open/shut headings, the same filter row, and the same XLSX export.
 *
 * WHY A SECOND COMPONENT RATHER THAN THE BOARD ITSELF. The board (`RepsListContacts`) reads the
 * iReports360 mirror — rows keyed on a contact's CRM id, pharmacies and all — while these three read
 * the CRM's own customer list (`ListCustomer`): new customers the rep added with no iReports360 row,
 * customers with no place yet, dropped customers the board no longer carries. Neither population is a
 * subset of the other, so the look is shared here rather than the data being forced through one pipe.
 * The palette, the square edges and the 1px rules are copied verbatim so the two read as one board.
 *
 * ONE BUTTON PER ROW (owner, 2026-09-29): Validate while the customer is not validated, Open once he
 * is — never "Add visit", which starts only from Visits, Today or the portal's "+". The row renders
 * its button itself from `listRowAction` (src/lib/phoenix-crm/list-request-rules.ts), so no section
 * can hand it a second one.
 */

import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";

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
  CrmButton,
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
import { listRowAction, requestKindLabel, type ListRowAction } from "@/lib/phoenix-crm/list-request-rules";
import type { ListCustomer } from "@/lib/phoenix-crm/view-types";
import { brickTintMap, type BrickTint } from "@/components/phoenix-crm/brick-tints";

/**
 * BRICK COLOUR — the same eight hues, in the same order, as the board (reps-list-tables.tsx) and now
 * as the Visits picker, which groups a day by brick too. They live in brick-tints.ts precisely because
 * there are three readers: a brick that is teal here and indigo at the door is no use as a landmark.
 * The wash lands on the block heading, never on a row: a mapped brick gets a left bar and a light
 * fill, an unmapped locality stays amber, exactly as the board draws them.
 */

/**
 * The board's field-surface controls (reps-list-tables.tsx, FIELD_*_CLASS): a thumb's 44px on a phone
 * and 36px from `md`, labels at the house 10px floor, and a square edge written out because a phone's
 * native select draws its own.
 */
const LABEL_CLASS = "block text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-400";
const SELECT_CLASS =
  "h-11 w-full rounded-none border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 md:h-9";

/**
 * Which part of the list this is drawing — it decides the row's detail line, its pills and headers.
 * "pending" is To validate, "active" is Your list, "outside" is Outside the list, "dropped" the Archive.
 */
export type CustomerListVariant = "pending" | "active" | "outside" | "dropped";

/**
 * The one button a customer's row carries, for THIS viewer.
 *
 * `listRowAction` decides it (Validate while not validated, Open once he is). Only the territory's rep
 * validates, and only a customer carried over from iReports360 has an entry the Validate screen opens
 * on — so anyone else, or a row with no such entry, is offered Open, which is exactly what they can do.
 */
export function rowActionFor(customer: ListCustomer, canValidate: boolean): ListRowAction | null {
  const action = listRowAction(customer);
  if (action === "validate" && (!canValidate || customer.referenceContactCrmId === null)) return "open";
  return action;
}

/** The row's one button. Nothing else is ever drawn beside it. */
export function CustomerRowAction({
  canValidate,
  customer,
  onAction,
}: {
  canValidate: boolean;
  customer: ListCustomer;
  onAction: (customer: ListCustomer, action: ListRowAction) => void;
}) {
  const action = rowActionFor(customer, canValidate);
  if (!action) return null;
  return (
    <CrmButton onClick={() => onAction(customer, action)} size="sm" variant={action === "validate" ? "primary" : "secondary"}>
      {action === "validate" ? "Validate" : "Open"}
    </CrmButton>
  );
}

/** A request waiting on the customer, and the step it is on: "Drop from the list · Waiting for SFE". */
function waitingPills(customer: ListCustomer): ReactNode {
  const steps = customer.waiting.filter((entry) => entry.kind !== "grade");
  if (steps.length === 0) return null;
  return steps.map((entry) => (
    <CrmPill key={entry.requestId} tone="info">
      {entry.stageLabel ? `${requestKindLabel(entry.kind)} · ${entry.stageLabel}` : requestKindLabel(entry.kind)}
    </CrmPill>
  ));
}

/**
 * A brick's colour, keyed off its place in the WHOLE list rather than the filtered or sorted one — a
 * brick that changes hue as you search, or as the display order changes, is not a brick anyone can
 * learn. Only mapped bricks are tinted; an unmapped locality keeps amber, which is a statement.
 */
function tintsFor(groups: readonly CustomerGroup[]): Map<string, BrickTint> {
  return brickTintMap(groups.filter((group) => group.mapped).map((group) => group.key));
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
        {waitingPills(customer)}
      </>
    );
  }
  if (variant === "outside") {
    // Met and validated at the door, not on the list: he counts once the add is approved.
    return (
      <>
        <CrmPill tone="orange">Outside the list</CrmPill>
        {customer.waiting.some((entry) => entry.kind === "add") ? waitingPills(customer) : <CrmPill>Not asked to add yet</CrmPill>}
      </>
    );
  }
  if (variant === "dropped") return waitingPills(customer);
  const standing = monthStanding(customer.visitsThisMonth, customer.target);
  return (
    <>
      <CrmPill tone={standing.tone}>{standing.label}</CrmPill>
      {customer.origin === "new" ? <CrmPill tone="orange">New customer</CrmPill> : null}
      {customer.pendingGradeRequestId ? (
        <CrmPill tone="info">{customer.pendingGrade ? `Grade ${customer.pendingGrade} proposed` : "Grade proposed"}</CrmPill>
      ) : null}
      {waitingPills(customer)}
    </>
  );
}

/** The detail line under a row — where he is (or was), said the way that part of the list says it. */
function detailText(customer: ListCustomer, variant: CustomerListVariant): string {
  if (variant === "pending") return referenceAddressText(customer.reference) ?? "No address in iReports360";
  if (variant === "dropped") return customer.droppedReason ?? "Reason not recorded";
  return placesDaysText(customer);
}

/**
 * The month line beside a row. Pending and outside never say "not visited" — their visits are saved and
 * count once the customer is validated and on the list. The Archive says since when.
 */
function monthText(customer: ListCustomer, variant: CustomerListVariant): string {
  if (variant === "pending" || variant === "outside") return pendingVisitsText(customer.visitsThisMonth);
  if (variant === "dropped") return `In the Archive since ${cairoStamp(customer.statusChangedAt)}`;
  return monthVisitsText(customer.visitsThisMonth, customer.target);
}

const DETAIL_HEADER: Record<CustomerListVariant, string> = {
  pending: "Address in iReports360",
  active: "Places and days",
  outside: "Places and days",
  dropped: "Why it is in the Archive",
};
const MONTH_HEADER: Record<CustomerListVariant, string> = {
  pending: "This month",
  active: "This month",
  outside: "This month",
  dropped: "In the Archive",
};

export function CustomerListBoard({
  canValidate,
  customers,
  exportTitle,
  onRowAction,
  repName,
  variant,
}: {
  /** The viewer is the territory's rep, who validates. Anyone else is offered Open on every row. */
  canValidate: boolean;
  /** The whole status subset for this part of the list, unfiltered — the board does its own filtering. */
  customers: readonly ListCustomer[];
  /** The download's sheet name and title, e.g. "Your list". */
  exportTitle: string;
  /** The row's one button was pressed: Validate or Open (`rowActionFor`). */
  onRowAction: (customer: ListCustomer, action: ListRowAction) => void;
  /** Whose list this is, by name — heads the export (owner's standing rule: names, never seat codes). */
  repName: string;
  variant: CustomerListVariant;
}) {
  const rowAction = (customer: ListCustomer) => <CustomerRowAction canValidate={canValidate} customer={customer} onAction={onRowAction} />;
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
      archived_on: variant === "dropped" ? cairoStamp(customer.statusChangedAt) : "",
    })),
  );

  // The toggle counts only what it hides. The search stays in sight on a phone, so what it holds is
  // already on screen and is not counted twice.
  const filtersOn = [brick, listType, activity, grade, speciality].filter(Boolean).length;
  const clearAll = () => {
    setBrick("");
    setListType("");
    setActivity("");
    setGrade("");
    setSpeciality("");
    setQuery("");
  };

  return (
    <div className="space-y-3 border-t border-slate-100 px-4 py-5 sm:px-5">
      {/* ONE ROW OF CONTROLS, IN TWO ORDERS. On a phone the search leads — it is what a rep reaches for
          standing in the street — with the Filters toggle and the export beside it, and the five selects
          fold behind the toggle, which says how many are on so a narrowed list never passes for the
          whole one. From `md` up the selects are always open and come first, as they always did.
          The selects' wrapper is `contents` from `md`, so they wrap in the same row as the search
          without the search being drawn twice; `md:order-first` is what puts them ahead of it. */}
      <div className="flex flex-wrap items-end gap-3">
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
        <button
          aria-controls={filtersId}
          aria-expanded={filtersOpen}
          className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2 rounded-none border border-slate-200 bg-white px-3 text-left text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-600 md:hidden"
          onClick={() => setFiltersOpen((open) => !open)}
          type="button"
        >
          <span className="flex min-w-0 items-center gap-2">
            <SlidersHorizontal aria-hidden className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            <span className="min-w-0 break-words">{filtersOn > 0 ? `Filters · ${filtersOn} on` : "Filters"}</span>
          </span>
          <GroupCaret open={filtersOpen} />
        </button>
        <ExportXlsxButton
          className="h-11 md:ml-auto md:h-9"
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
            ...(variant === "dropped" ? [{ key: "archived_on", label: "In the Archive since" }] : []),
          ]}
          rows={exportRows}
          sheetName={exportTitle}
          subtitle={`${repName} · grouped by brick, as held by the CRM`}
          title={exportTitle}
        />
        {/* `hidden` and `contents` are never written together: which of two display utilities wins is
            the stylesheet's order, not the class list's. */}
        <div className={filtersOpen ? "contents" : "hidden md:contents"} id={filtersId}>
          <label className="block w-full sm:w-56 md:order-first">
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
          <label className="block w-full sm:w-44 md:order-first">
            <span className={LABEL_CLASS}>List</span>
            <select className={`mt-1 ${SELECT_CLASS}`} onChange={(event) => setListType(event.target.value)} value={listType}>
              <option value="">PM and AM lists</option>
              <option value="PM">PM list only</option>
              <option value="AM">AM list only</option>
            </select>
          </label>
          <label className="block w-full sm:w-52 md:order-first">
            <span className={LABEL_CLASS}>This month</span>
            <select className={`mt-1 ${SELECT_CLASS}`} onChange={(event) => setActivity(event.target.value)} value={activity}>
              <option value="">All activity</option>
              <option value="unvisited">Not visited this month</option>
              <option value="visited">Visited this month</option>
            </select>
          </label>
          <label className="block w-full sm:w-40 md:order-first">
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
          <label className="block w-full sm:w-56 md:order-first">
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
        </div>
      </div>

      <p className="text-phx-2xs font-semibold text-slate-400">
        {`${shownCount} shown across ${brickCount} ${brickCount === 1 ? "brick" : "bricks"}`}
        {localityCount > 0 ? ` and ${localityCount} ${localityCount === 1 ? "locality" : "localities"} awaiting one` : ""}
      </p>

      {visible.length === 0 ? (
        // One press back to the whole list: a filter the rep set on a phone is folded out of sight, so
        // the way out of "nothing matches" sits where he is looking rather than behind the toggle.
        <div className="grid justify-items-center gap-2 px-3 py-6 text-center">
          <p className="text-xs font-semibold text-slate-500">Nothing matches this filter.</p>
          <CrmButton onClick={clearAll} size="sm">
            Clear the filters
          </CrmButton>
        </div>
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
                          actions={rowAction(customer)}
                          key={customer.customerId}
                          meta={customerMetaText(customer)}
                          status={rowPills(customer, variant)}
                          title={<span dir="auto">{customer.name}</span>}
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
                              <p className="font-black text-slate-950">
                                <span dir="auto">{customer.name}</span>
                              </p>
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
                              {/* The column's full width — the board's Actions column does the same. */}
                              <div className="grid gap-1.5 [&>button]:w-full">{rowAction(customer)}</div>
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
