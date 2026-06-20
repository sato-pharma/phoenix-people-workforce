"use client";

import * as React from "react";

// Lightweight, opt-in client-side table sort + search. Each table keeps its own bespoke <tbody>
// markup (orange bars, badges, sparklines); this hook only reorders/filters the rows array and the
// table swaps its <th>s for <SortableTh>. Purely view-only — never touches the server data contract,
// and exports must always use the ORIGINAL source array, not the filtered `rows` returned here.

export type SortDir = "asc" | "desc";
export type SortType = "number" | "string" | "date";
export type SortState = { key: string; dir: SortDir };

export type SortableColumn<T> = {
  key: string;
  accessor: (row: T) => unknown;
  type: SortType;
  /** First-click direction. Defaults: number/date -> "desc", string -> "asc". */
  defaultDir?: SortDir;
};

export type UseSortableTableOptions<T> = {
  columns: SortableColumn<T>[];
  /** Case-insensitive OR substring across these string accessors. */
  searchAccessors?: ((row: T) => string | null | undefined)[];
  /** Initial sort; pass the server pre-sort (e.g. {key:"salesValue",dir:"desc"}) to preserve it. */
  initialSort?: SortState | null;
  /** Stable tiebreaker, always applied ascending. */
  secondarySort?: { key: string; accessor: (row: T) => unknown; type: "string" | "number" };
};

export type UseSortableTableResult<T> = {
  rows: T[];
  sort: SortState | null;
  toggleSort: (key: string) => void;
  setSort: (next: SortState | null) => void;
  query: string;
  setQuery: (next: string) => void;
  clearQuery: () => void;
  total: number;
  visible: number;
  isFiltered: boolean;
};

const isMissing = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  (typeof value === "number" && Number.isNaN(value)) ||
  (typeof value === "string" && value.trim() === "");

function toComparable(value: unknown, type: SortType): number | string | null {
  if (isMissing(value)) return null;
  if (type === "number") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (type === "date") {
    const t = value instanceof Date ? value.getTime() : Date.parse(String(value));
    return Number.isNaN(t) ? null : t;
  }
  return String(value);
}

function compare(a: number | string | null, b: number | string | null): number {
  // Missing values always sink to the bottom regardless of direction (handled by the caller via the
  // pre-direction marker). Here, when both present, compare like-for-like.
  if (a === null && b === null) return 0;
  if (a === null) return 1; // a after b
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

export function useSortableTable<T>(
  source: readonly T[],
  options: UseSortableTableOptions<T>,
): UseSortableTableResult<T> {
  const { columns, searchAccessors, initialSort = null, secondarySort } = options;
  const [sort, setSort] = React.useState<SortState | null>(initialSort);
  const [query, setQuery] = React.useState("");

  const columnByKey = React.useMemo(() => {
    const map = new Map<string, SortableColumn<T>>();
    for (const column of columns) map.set(column.key, column);
    return map;
  }, [columns]);

  const toggleSort = React.useCallback(
    (key: string) => {
      const column = columnByKey.get(key);
      if (!column) return;
      setSort((current) => {
        if (current && current.key === key) {
          return { key, dir: current.dir === "asc" ? "desc" : "asc" };
        }
        return { key, dir: column.defaultDir ?? (column.type === "string" ? "asc" : "desc") };
      });
    },
    [columnByKey],
  );

  const clearQuery = React.useCallback(() => setQuery(""), []);

  const normalizedQuery = query.trim().toLowerCase();

  const result = React.useMemo(() => {
    // Filter first so counts reflect what's shown.
    let working = source as readonly T[];
    if (normalizedQuery && searchAccessors && searchAccessors.length > 0) {
      working = working.filter((row) =>
        searchAccessors.some((accessor) => {
          const text = accessor(row);
          return typeof text === "string" && text.toLowerCase().includes(normalizedQuery);
        }),
      );
    }

    const filtered = [...working];

    if (sort) {
      const column = columnByKey.get(sort.key);
      if (column) {
        const sign = sort.dir === "asc" ? 1 : -1;
        // Decorate with original index for a stable sort.
        const decorated = filtered.map((row, index) => ({ row, index }));
        decorated.sort((left, right) => {
          const a = toComparable(column.accessor(left.row), column.type);
          const b = toComparable(column.accessor(right.row), column.type);
          // Missing always last, independent of direction.
          if (a === null && b !== null) return 1;
          if (a !== null && b === null) return -1;
          const primary = compare(a, b) * sign;
          if (primary !== 0) return primary;
          if (secondarySort) {
            const sa = toComparable(secondarySort.accessor(left.row), secondarySort.type);
            const sb = toComparable(secondarySort.accessor(right.row), secondarySort.type);
            if (sa === null && sb !== null) return 1;
            if (sa !== null && sb === null) return -1;
            const sec = compare(sa, sb); // always ascending
            if (sec !== 0) return sec;
          }
          return left.index - right.index;
        });
        return { rows: decorated.map((entry) => entry.row), filteredCount: filtered.length };
      }
    }

    return { rows: filtered, filteredCount: filtered.length };
  }, [source, normalizedQuery, searchAccessors, sort, columnByKey, secondarySort]);

  return {
    rows: result.rows,
    sort,
    toggleSort,
    setSort,
    query,
    setQuery,
    clearQuery,
    total: source.length,
    visible: result.filteredCount,
    isFiltered: normalizedQuery.length > 0,
  };
}

/** Largest value of `pick` across the visible rows, floored at 1 — for normalizing inline bars. */
export function visibleMax<T>(rows: readonly T[], pick: (row: T) => number): number {
  let max = 1;
  for (const row of rows) {
    const value = pick(row);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}
