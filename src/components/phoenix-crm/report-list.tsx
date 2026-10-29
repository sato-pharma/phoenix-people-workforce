"use client";

/**
 * Phoenix CRM — the pieces every Reports section is drawn with: the waiting and refresh-failed states,
 * the days a row opens onto, and the one list every section shares (the show filter, the search, a
 * page at a time, cards on a phone and a fixed-width table from `md`).
 *
 * Lifted out of reports-tab.tsx on 2026-10-02 when the four insight boards arrived
 * (insight-reports.tsx), so they are drawn with THESE pieces rather than a copy of them — two copies
 * of the list would be two looks within a week, and the fits-the-screen rule enforced on one of them.
 */

import { Fragment, useState, type ReactNode } from "react";

import { countText, dayLabel } from "@/components/phoenix-crm/format";
import { matchesWords } from "@/components/phoenix-crm/labels";
import {
  CrmBlock,
  CrmButton,
  CrmCardsOnPhone,
  CrmChoice,
  CrmEmpty,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmSearchField,
  CrmShowMore,
  CrmTable,
  crmThClassName,
  type CrmChoiceOption,
} from "@/components/phoenix-crm/ui";
import { TableRowDetail, rowDetailToggleProps } from "@/components/ui/table-row-detail";
import { cn } from "@/lib/utils";

type Presence = "all" | "with" | "without";

const PAGE = 25;
const SEARCH_FROM = 8;

/** A section's figures while they load, or the sentence saying why they did not. */
export function SectionWaiting({ error, label, onRetry }: { error: string | null; label: string; onRetry: () => void }) {
  return <div className="border-t border-slate-100">{error ? <CrmLoadError message={error} onRetry={onRetry} /> : <CrmLoading label={label} />}</div>;
}

/**
 * Figures still on screen after a refresh that failed: they stay, with the reason above them.
 *
 * `onRetry` is REQUIRED, not optional: a read can always be asked again, and every caller already
 * holds the `reload` that does it. Before this the reason stood alone, so a rep on a dropped
 * connection was left looking at figures he could see were stale with nothing to press.
 */
export function RefreshFailed({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  if (!error) return null;
  return (
    <div className="px-4 pt-4 sm:px-5">
      <CrmNote title="These figures could not be refreshed" tone="warn">
        <span className="block">{error}</span>
        <span className="mt-2 block">
          <CrmButton onClick={onRetry} size="sm">
            Try again
          </CrmButton>
        </span>
      </CrmNote>
    </div>
  );
}

export function DaysToggle({ onToggle, open }: { onToggle: () => void; open: boolean }) {
  return (
    <CrmButton aria-expanded={open} onClick={onToggle} size="sm" variant="ghost">
      {open ? "Hide the days" : "Show the days"}
    </CrmButton>
  );
}

export type DayLine = { date: string; lines: string[]; muted?: boolean };

/** One row per day: the day, then what happened on it; today is marked as still running. */
export function DayList({ days, today }: { days: ReadonlyArray<DayLine>; today: string }) {
  if (days.length === 0) return <p className="text-sm font-semibold text-slate-500">No day to show.</p>;
  return (
    <ul className="divide-y divide-slate-100 border border-slate-200">
      {days.map((day) => (
        <li className="grid min-w-0 gap-1 px-3 py-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:gap-3" key={day.date}>
          <p className="break-words text-xs font-black leading-6 text-slate-600">
            {dayLabel(day.date)}
            {day.date === today ? " · today, still running" : ""}
          </p>
          <div className={cn("min-w-0 text-sm font-semibold leading-6", day.muted ? "text-slate-400" : "text-slate-700")}>
            {day.lines.map((line, index) => (
              <p className="break-words" key={index}>
                {line}
              </p>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── The list every section shares: show filter, search, pages, open days ────────────────────────

export type ReportListWords = {
  title: string;
  all: string;
  with: string;
  without: string;
  searchLabel: string;
  searchPlaceholder: string;
  noneMatch: string;
};

export type ReportListProps<T> = {
  columns: ReadonlyArray<string | null>;
  explain?: ReactNode;
  /** Whether the row has anything to report (the "with" side of the show filter). */
  hasData: (item: T) => boolean;
  headers: ReadonlyArray<ReactNode>;
  idPrefix: string;
  items: ReadonlyArray<T>;
  keyOf: (item: T) => string;
  /** The row as a phone card; `open` says whether its days show. */
  renderCard: (item: T, open: boolean, onToggle: () => void) => ReactNode;
  /** The row's table cells. */
  renderCells: (item: T, open: boolean, onToggle: () => void) => ReactNode;
  /** The row's days, drawn under the row while open. */
  renderOpen?: (item: T) => ReactNode;
  searchWords: (item: T) => ReadonlyArray<string | null | undefined>;
  words: ReportListWords;
};

export function ReportList<T>({
  columns,
  explain,
  hasData,
  headers,
  idPrefix,
  items,
  keyOf,
  renderCard,
  renderCells,
  renderOpen,
  searchWords,
  words,
}: ReportListProps<T>) {
  const [presence, setPresence] = useState<Presence>("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());

  const withCount = items.filter(hasData).length;
  const hasBoth = withCount > 0 && withCount < items.length;
  const currentPresence: Presence = hasBoth ? presence : "all";
  const searchable = items.length > SEARCH_FROM;
  const rows = items.filter(
    (item) =>
      (currentPresence === "all" || hasData(item) === (currentPresence === "with")) &&
      (!searchable || matchesWords(query, searchWords(item))),
  );
  const shown = rows.slice(0, limit);
  const presenceOptions: Array<CrmChoiceOption<Presence>> = [
    { value: "all", label: words.all, note: countText(items.length) },
    { value: "with", label: words.with, note: countText(withCount) },
    { value: "without", label: words.without, note: countText(items.length - withCount) },
  ];

  function toggle(key: string) {
    setOpenKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <>
      <CrmBlock className="border-t border-slate-100" title={words.title}>
        {explain ? <div className="break-words text-sm font-medium leading-6 text-slate-600">{explain}</div> : null}
        {hasBoth || searchable ? (
          <div
            className={cn(
              "grid min-w-0 gap-3",
              explain ? "mt-3" : undefined,
              hasBoth && searchable ? "md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-end" : undefined,
            )}
          >
            {hasBoth ? (
              <CrmField label="Show">
                <CrmChoice
                  columns={3}
                  label="Show"
                  onChange={(next) => {
                    setPresence(next);
                    setLimit(PAGE);
                  }}
                  options={presenceOptions}
                  value={currentPresence}
                />
              </CrmField>
            ) : null}
            {searchable ? (
              <CrmSearchField
                id={`${idPrefix}-search`}
                label={words.searchLabel}
                onChange={(next) => {
                  setQuery(next);
                  setLimit(PAGE);
                }}
                placeholder={words.searchPlaceholder}
                value={query}
              />
            ) : null}
          </div>
        ) : null}
      </CrmBlock>

      {rows.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="Clear the search or choose another filter." title={words.noneMatch} />
        </div>
      ) : (
        <div className="border-t border-slate-100">
          <CrmCardsOnPhone>
            {shown.map((item) => {
              const key = keyOf(item);
              return <Fragment key={key}>{renderCard(item, openKeys.has(key), () => toggle(key))}</Fragment>;
            })}
          </CrmCardsOnPhone>
          <CrmTable columns={columns}>
            <thead>
              <tr>
                {headers.map((header, index) => (
                  <th className={crmThClassName} key={index} scope="col">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => {
                const key = keyOf(item);
                const open = openKeys.has(key);
                return (
                  <Fragment key={key}>
                    <tr {...(renderOpen ? rowDetailToggleProps(`${idPrefix}-${key}-days`, open) : {})}>{renderCells(item, open, () => toggle(key))}</tr>
                    {open && renderOpen ? (
                      <TableRowDetail colSpan={columns.length} id={`${idPrefix}-${key}-days`}>
                        {renderOpen(item)}
                      </TableRowDetail>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </CrmTable>
          <CrmShowMore left={rows.length - limit} onMore={() => setLimit((value) => value + PAGE)} page={PAGE} />
        </div>
      )}
    </>
  );
}

export const LIST_WORDS = {
  all: "All",
  searchLabel: "Find a territory or rep",
  searchPlaceholder: "Territory, line or rep",
  noneMatch: "Nothing matches",
} as const;
