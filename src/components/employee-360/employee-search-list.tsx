"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

export type Employee360ListItem = {
  hrId: string;
  displayName: string;
  jobTitle: string | null;
  lineName: string | null;
  areaName: string | null;
};

export function EmployeeSearchList({ employees }: { employees: Employee360ListItem[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) =>
      [e.displayName, e.hrId, e.jobTitle, e.lineName, e.areaName]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q)),
    );
  }, [employees, query]);

  return (
    <div className="space-y-4">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by name, HR ID, job title, line or area…"
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        aria-label="Search employees"
      />
      <div className="text-xs text-muted-foreground">
        {filtered.length} of {employees.length} employees
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {filtered.map((e) => (
          <li key={e.hrId}>
            <Link
              href={`/employee-360/${encodeURIComponent(e.hrId)}`}
              className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/50"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">{e.displayName}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {[e.jobTitle, e.lineName, e.areaName].filter(Boolean).join(" · ") || "—"}
                </div>
              </div>
              <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                {e.hrId.toUpperCase()}
              </span>
            </Link>
          </li>
        ))}
        {filtered.length === 0 ? (
          <li className="px-4 py-6 text-center text-sm text-muted-foreground">No matches.</li>
        ) : null}
      </ul>
    </div>
  );
}
