"use client";

/**
 * Phoenix CRM — the Doctors tab: every validated customer the viewer may see, across territories.
 *
 * Owner, 2026-09-22: "BUILD the cross-territory validated-doctors list", and "give SFE and Training
 * Manager the full company list too".
 *
 * The Team tab reaches a customer through his rep's territory, which is the right door when you know
 * whose rep he is. This is the other door: type a name and find him wherever he sits. Only validated
 * customers are here — a carried-over one still waiting for his rep at the clinic belongs to that
 * rep's own list, not to a company directory. Scope is settled on the server
 * (src/lib/phoenix-crm/server/doctors.ts), never here.
 *
 * Where the viewer's own page offers that territory, the row opens its list; where it does not (a
 * directory role who holds no seat), the row still says everything the directory knows about him.
 */

import { useId, useMemo, useState } from "react";

import { crmUrl, useCrmGet } from "@/components/phoenix-crm/api";
import { countText, dayLabelWithYear, plural } from "@/components/phoenix-crm/format";
import { customerMetaText, matchesWords } from "@/components/phoenix-crm/labels";
import {
  CrmBlock,
  CrmButton,
  CrmCard,
  CrmCardsOnPhone,
  CrmChoice,
  CrmEmpty,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmPanel,
  CrmSearchField,
  CrmShowMore,
  CrmStat,
  CrmStatGrid,
  CrmTable,
  crmTdClassName,
  crmThClassName,
  type CrmChoiceOption,
} from "@/components/phoenix-crm/ui";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import type { DoctorDirectoryRow, DoctorDirectoryView } from "@/lib/phoenix-crm/view-types";

type TypeFilter = "all" | PhoenixCrmListType;

const PAGE = 25;

/** Search shows once the directory holds more rows than this. */
const SEARCH_FROM = 8;

function rowWords(row: DoctorDirectoryRow): Array<string | null> {
  return [row.name, row.speciality, row.grade, row.territoryName, row.repName, row.areaName, row.regionName, row.lineName];
}

/** "Faisal · Pedia · Mona Adel", the territory by its place, line and rep — never its seat code. */
function territoryText(row: DoctorDirectoryRow): string {
  return `${row.territoryName} · ${row.repName ?? "No rep in this territory"}`;
}

/** "Validated 14 Sep 2026 by Mona Adel". */
function validatedText(row: DoctorDirectoryRow): string {
  const day = dayLabelWithYear(row.validatedAt.slice(0, 10));
  return row.validatedByName ? `Validated ${day} by ${row.validatedByName}` : `Validated ${day}`;
}

/** "2 places on record" — the captured location and live photo are on the customer's own page. */
function placesText(row: DoctorDirectoryRow): string {
  return row.placeCount > 0 ? `${plural(row.placeCount, "place", "places")} on record` : "No place on record";
}

export function DoctorsTab({
  onOpenList,
  openableSeatIds,
  test,
}: {
  /** A territory's List tab. Absent where this viewer's page offers no territory to open. */
  onOpenList?: (seatId: string) => void;
  /** The territories this viewer's page can actually open, so a row never offers a door that is shut. */
  openableSeatIds: ReadonlyArray<string>;
  test: boolean;
}) {
  const idPrefix = useId();
  const directory = useCrmGet<DoctorDirectoryView>(crmUrl("/api/phoenix-crm/doctors", { test }), "directory");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [limit, setLimit] = useState(PAGE);

  const all = useMemo(() => directory.data?.rows ?? [], [directory.data]);
  const rows = useMemo(
    () => all.filter((row) => (typeFilter === "all" || row.listType === typeFilter) && matchesWords(query, rowWords(row))),
    [all, query, typeFilter],
  );

  function filterBy(update: () => void) {
    update();
    setLimit(PAGE);
  }

  if (directory.error) return <CrmLoadError message={directory.error} onRetry={directory.reload} />;
  if (!directory.data) return <CrmLoading label="Reading the doctors" />;

  const view = directory.data;
  const counts = {
    AM: all.filter((row) => row.listType === "AM").length,
    PM: all.filter((row) => row.listType === "PM").length,
  };
  const shown = rows.slice(0, limit);
  const searchable = all.length > SEARCH_FROM;
  const typeOptions: ReadonlyArray<CrmChoiceOption<TypeFilter>> = [
    { value: "all", label: "All", note: `${countText(all.length)} validated` },
    { value: "PM", label: "Doctors", note: `${countText(counts.PM)} PM` },
    { value: "AM", label: "Accounts", note: `${countText(counts.AM)} AM` },
  ];

  /** A row offers the list only where this viewer's own page really has that territory. */
  function canOpen(seatId: string): boolean {
    return Boolean(onOpenList) && openableSeatIds.includes(seatId);
  }

  function openListButton(seatId: string) {
    if (!onOpenList || !canOpen(seatId)) return null;
    return (
      <CrmButton onClick={() => onOpenList(seatId)} size="sm">
        Open the list
      </CrmButton>
    );
  }

  return (
    <CrmPanel
      description={
        view.scope === "company"
          ? "Every validated customer in the company, across all open lines."
          : `Every validated customer in ${plural(view.territoryCount, "territory", "territories")} beneath you.`
      }
      eyebrow="Doctors"
      title="Validated customers"
    >
      <CrmBlock>
        {/* Accounts and doctors side by side, never added together (the AM · PM golden rule). */}
        <CrmStatGrid>
          <CrmStat label="Doctors · PM" value={countText(counts.PM)} />
          <CrmStat label="Accounts · AM" value={countText(counts.AM)} />
          <CrmStat label="Territories" note="Open lines only" value={countText(view.territoryCount)} />
        </CrmStatGrid>
        <p className="mt-3 break-words text-sm font-medium leading-6 text-slate-600">
          A customer appears here once his rep has validated him at the door. One still waiting to be validated stays on his own rep&apos;s
          list.
        </p>
        <div className={searchable ? "mt-3 grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-end" : "mt-3 grid min-w-0 gap-3"}>
          <CrmField label="Show">
            <CrmChoice columns={3} label="Show" onChange={(next) => filterBy(() => setTypeFilter(next))} options={typeOptions} value={typeFilter} />
          </CrmField>
          {searchable ? (
            <CrmSearchField
              id={`${idPrefix}-doctors-search`}
              label="Find a customer"
              onChange={(next) => filterBy(() => setQuery(next))}
              placeholder="Name, speciality, territory or rep"
              value={query}
            />
          ) : null}
        </div>
      </CrmBlock>

      {all.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty
            message="A customer appears here once his rep has validated him at the door."
            title="No validated customer to show yet"
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="Clear the search or choose another filter." title="No customer matches" />
        </div>
      ) : (
        <div className="border-t border-slate-100">
          <CrmCardsOnPhone>
            {shown.map((row) => (
              <CrmCard
                accent="border-l-emerald-500"
                actions={openListButton(row.seatId)}
                key={row.customerId}
                meta={customerMetaText(row)}
                title={row.name}
              >
                <p className="break-words text-sm font-semibold leading-6 text-slate-700">{territoryText(row)}</p>
                <p className="break-words text-xs font-semibold leading-5 text-slate-500">{validatedText(row)}</p>
                <p className="break-words text-xs font-semibold leading-5 text-slate-500">{placesText(row)}</p>
              </CrmCard>
            ))}
          </CrmCardsOnPhone>
          <CrmTable columns={["28%", "18%", null, "24%"]}>
            <thead>
              <tr>
                <th className={crmThClassName} scope="col">
                  Customer
                </th>
                <th className={crmThClassName} scope="col">
                  Type and grade
                </th>
                <th className={crmThClassName} scope="col">
                  Territory
                </th>
                <th className={crmThClassName} scope="col">
                  Validated
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.customerId}>
                  <td className={crmTdClassName}>
                    <p className="font-black text-slate-950">{row.name}</p>
                    {row.speciality ? <p className="mt-0.5 text-xs text-slate-500">{row.speciality}</p> : null}
                  </td>
                  {/* The speciality already has its own line under the name; it is not repeated here. */}
                  <td className={crmTdClassName}>{customerMetaText({ grade: row.grade, listType: row.listType, speciality: null })}</td>
                  <td className={crmTdClassName}>
                    <p>{row.territoryName}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{row.repName ?? "No rep in this territory"}</p>
                    {canOpen(row.seatId) ? <div className="mt-2">{openListButton(row.seatId)}</div> : null}
                  </td>
                  <td className={crmTdClassName}>
                    <p>{validatedText(row)}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{placesText(row)}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </CrmTable>
          <CrmShowMore left={rows.length - limit} onMore={() => setLimit((value) => value + PAGE)} page={PAGE} />
        </div>
      )}
    </CrmPanel>
  );
}
