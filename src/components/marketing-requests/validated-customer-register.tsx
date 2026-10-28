"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, RefreshCcw, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalFilterBar,
  PortalMetricCard,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
  PortalSection,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { cairoDateTime as sharedCairoDateTime } from "@/lib/format/cairo-datetime";
import type { ValidatedCustomerListRow } from "@/lib/marketing-requests/validated-customer-transfer";

/**
 * Every timestamp on this screen is Africa/Cairo. Formatted here, never handed to the DOM as a
 * raw ISO string: the marketing approval timeline shipped exactly that way and rendered UTC on
 * screen against the standing rule.
 *
 * NOW DELEGATES to `@/lib/format/cairo-datetime`, and the delegation is the fix rather than tidying.
 *
 * This built the string itself with `Intl.DateTimeFormat("en-GB", { month: "short" })`. That is the
 * one construct the shared helper exists to avoid, and it says so in its own source: it spells
 * `CAIRO_MONTHS` out by hand "because the ANSWER IS NOT THE SAME ON EVERY" runtime — CLDR 42
 * (ICU 72, late 2022) renamed abbreviated September from "Sep" to "Sept" — and takes only the
 * numeric month from `Intl`, which every ICU version agrees on.
 *
 * This is a `"use client"` component, so every timestamp on this screen is formatted TWICE: once by
 * Node when the HTML is rendered, again by the browser when React hydrates it. Two engines, two
 * independently-versioned copies of the locale data. When they disagree by one character React
 * throws the server HTML away and re-renders — hydration error #418.
 *
 * Not hypothetical. `app/password-setup/[token]/page.tsx` carries the diagnosis of the same bug from
 * the same cause ("the Railway server and a reader on Samsung Internet 20 built different strings
 * for the same instant"), was fixed on 2026-08-12 by formatting once, and has been silent since.
 * #418 is still arriving from elsewhere — 24 of the last 35 production errors, 7 people, 8 routes.
 * This screen was a live instance waiting for two readers on different ICU versions.
 *
 * The "Not recorded" copy is kept deliberately. The shared helper answers "—" for an absent instant,
 * which is right for a dense grid and wrong here, where the column reads as a fact about the
 * customer rather than a gap in a table.
 */
export function cairoDateTime(value: string | null | undefined): string {
  const formatted = sharedCairoDateTime(value);
  return formatted === "—" ? "Not recorded" : formatted;
}

type Workspace = {
  rows: ValidatedCustomerListRow[];
  summary: { total: number; transferred: number; owners: number };
};

function emptyWorkspace(): Workspace {
  return { rows: [], summary: { owners: 0, total: 0, transferred: 0 } };
}

function statusBadge(row: ValidatedCustomerListRow) {
  if (!row.transfer) {
    return <Badge variant="neutral">Not transferred</Badge>;
  }
  const decided = row.transfer.directOrderValidationStatus;
  if (!decided || decided === "pending") {
    return <Badge variant="warning">On Direct Order desk</Badge>;
  }
  if (decided === "rejected") return <Badge variant="danger">Rejected there</Badge>;
  return <Badge variant="success">Validated there</Badge>;
}

/**
 * The admin register — "a list of validated customers and by whom and when" (owner, 2026-08-22).
 *
 * Company-wide across every rep, which is the entire reason it exists: the marketing validation
 * workspace both the rep AND the admin currently open is scoped to the signed-in user's own
 * captures, so nobody could see two reps having captured the same doctor. That case is live in
 * production today and the duplicate column below is what surfaces it.
 */
export function ValidatedCustomerRegister() {
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [transferFilter, setTransferFilter] = useState<"all" | "transferred" | "not_transferred">("all");
  const [search, setSearch] = useState("");

  async function loadWorkspace() {
    setIsLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/marketing-requests/validated-customers", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        setWorkspace(emptyWorkspace());
        setMessage(payload.message ?? "Unable to load the validated customer register.");
        return;
      }
      setWorkspace({ rows: payload.rows ?? [], summary: payload.summary ?? emptyWorkspace().summary });
    } catch {
      setWorkspace(emptyWorkspace());
      setMessage("Unable to load the validated customer register.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadWorkspace();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  // "I want to be able to access the validated customers by the employee or by the user."
  const owners = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of workspace.rows) {
      if (!row.ownerHrId) continue;
      seen.set(row.ownerHrId, row.ownerName ?? row.ownerHrId);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [workspace.rows]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return workspace.rows.filter((row) => {
      if (ownerFilter !== "all" && row.ownerHrId !== ownerFilter) return false;
      if (transferFilter === "transferred" && !row.transfer) return false;
      if (transferFilter === "not_transferred" && row.transfer) return false;
      if (!needle) return true;
      return [row.displayName, row.customerCode, row.ownerName, row.validatedByName, row.areaName, row.governorate]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [ownerFilter, search, transferFilter, workspace.rows]);

  const duplicateCount = useMemo(
    () => workspace.rows.filter((row) => row.duplicateCount > 0).length,
    [workspace.rows],
  );

  return (
    <div className="space-y-6">
      <PortalSection className="p-4 sm:p-5">
        <div className="grid gap-3 md:grid-cols-5">
          <PortalMetricCard label="Validated" value={workspace.summary.total} />
          <PortalMetricCard accent="sky" icon={Users} label="Employees" value={workspace.summary.owners} />
          <PortalMetricCard accent="emerald" label="Transferred" value={workspace.summary.transferred} />
          <PortalMetricCard
            accent={duplicateCount > 0 ? "rose" : "slate"}
            label="Possible duplicates"
            note={duplicateCount > 0 ? "Same name captured more than once" : undefined}
            value={duplicateCount}
          />
          <button
            className="flex min-h-[78px] items-center justify-center gap-2 rounded border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
            onClick={() => void loadWorkspace()}
            type="button"
          >
            {isLoading ? <LoadingSpinner /> : <RefreshCcw className="h-4 w-4" />}
            Refresh
          </button>
        </div>
      </PortalSection>

      <PortalFilterBar countLabel={`${filtered.length} of ${workspace.rows.length} shown`}>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
              Employee
            </span>
            <select
              className={portalInputClassName}
              onChange={(event) => setOwnerFilter(event.target.value)}
              value={ownerFilter}
            >
              <option value="all">All employees</option>
              {owners.map(([hrId, name]) => (
                <option key={hrId} value={hrId}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
              Transfer state
            </span>
            <select
              className={portalInputClassName}
              onChange={(event) => setTransferFilter(event.target.value as typeof transferFilter)}
              value={transferFilter}
            >
              <option value="all">All</option>
              <option value="not_transferred">Not transferred yet</option>
              <option value="transferred">Already transferred</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
              Search
            </span>
            <input
              className={portalInputClassName}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Customer, code, area"
              value={search}
            />
          </label>
        </div>
      </PortalFilterBar>

      {message ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
          {message}
        </div>
      ) : null}

      <PortalSection
        description="Every customer a rep or manager has validated in Marketing. Open one to check its data and hand it to Direct Orders."
        eyebrow="Marketing"
        title="Validated customers"
      >
        {isLoading ? (
          <div className="flex justify-center py-10">
            <LoadingSpinner />
          </div>
        ) : (
          <PortalResponsiveDataList
            empty={
              <PortalEmptyState
                message="No validated customer matches these filters."
                title="Nothing to show"
              />
            }
            getKey={(row) => row.id}
            items={filtered}
            renderCard={(row) => (
              <PortalRecordCard
                accent={row.transfer ? "emerald" : row.duplicateCount > 0 ? "rose" : "slate"}
                actions={
                  <Link
                    className="inline-flex items-center gap-1.5 rounded border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-black text-orange-700"
                    href={`/admin/marketing-requests/validated-customers/${row.id}`}
                  >
                    Check data
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                }
                meta={row.customerCode}
                status={statusBadge(row)}
                title={row.displayName || "Unnamed customer"}
              >
                <PortalRecordFields
                  fields={[
                    { label: "Validated by", value: row.validatedByName },
                    { label: "Manager", value: row.managerName },
                    { label: "Area", value: row.areaName },
                    { label: "Line", value: row.lineName },
                    { label: "Captured", value: row.createdAt ? cairoDateTime(row.createdAt) : null },
                    {
                      label: "Duplicates",
                      value: row.duplicateCount > 0 ? `${row.duplicateCount} same name` : "None",
                    },
                  ].filter((field): field is { label: string; value: string } => Boolean(field.value))}
                />
              </PortalRecordCard>
            )}
            renderTable={() => (
              <PortalDesktopTable
                cols={
                  <colgroup>
                    <col className="w-[20%]" />
                    <col className="w-[13%]" />
                    <col className="w-[13%]" />
                    <col className="w-[12%]" />
                    <col className="w-[14%]" />
                    <col className="w-[11%]" />
                    <col className="w-[10%]" />
                    <col className="w-[7%]" />
                  </colgroup>
                }
              >
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Validated by</th>
                    <th className="px-4 py-3">Manager</th>
                    <th className="px-4 py-3">Area</th>
                    <th className="px-4 py-3">Captured</th>
                    <th className="px-4 py-3">Duplicates</th>
                    <th className="px-4 py-3">Direct Order</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row) => (
                    <tr className="border-b border-slate-100 hover:bg-orange-50/40" key={row.id}>
                      <td className="break-words px-4 py-3">
                        <span className="font-black text-slate-900">{row.displayName || "Unnamed customer"}</span>
                        <span className="ml-2 break-words rounded bg-slate-100 px-1.5 py-0.5 font-mono text-phx-xs font-bold text-slate-600">
                          {row.customerCode || "-"}
                        </span>
                      </td>
                      <td className="break-words px-4 py-3 font-bold text-slate-700">
                        {row.validatedByName || "—"}
                      </td>
                      <td className="break-words px-4 py-3 font-semibold text-slate-600">
                        {row.managerName || "—"}
                      </td>
                      <td className="break-words px-4 py-3 font-semibold text-slate-600">
                        {row.areaName || "—"}
                      </td>
                      <td className="break-words px-4 py-3 font-semibold text-slate-600">
                        {sharedCairoDateTime(row.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        {row.duplicateCount > 0 ? (
                          <Badge variant="danger">{row.duplicateCount} same name</Badge>
                        ) : (
                          <span className="font-semibold text-slate-400">None</span>
                        )}
                      </td>
                      <td className="px-4 py-3">{statusBadge(row)}</td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          className="inline-flex items-center gap-1.5 rounded border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-black text-orange-700 transition hover:bg-orange-100"
                          href={`/admin/marketing-requests/validated-customers/${row.id}`}
                        >
                          Check data
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </PortalDesktopTable>
            )}
          />
        )}
      </PortalSection>
    </div>
  );
}
