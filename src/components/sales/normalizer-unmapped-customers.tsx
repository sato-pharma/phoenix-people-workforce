"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { phxButtonGhostClassName, phxFieldClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import type { UnmappedCustomer, UnmappedCustomersResult } from "@/lib/sales/normalizer/unmapped-customers";
import { cn } from "@/lib/utils";

// Every customer with no ACTIVE mapping, whatever file is or is not open. The Needs mapping tab beside it only
// lists what the one analyzed file does not know, so a customer switched off in the database never showed there.

type WhyFilter = "all" | UnmappedCustomer["why"];

function when(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : stableEnGbFormatter({ timeZone: "Africa/Cairo", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function salesSummary(c: UnmappedCustomer): string {
  if (c.salesRows === 0) return "No sales rows";
  const span = c.firstPeriod && c.lastPeriod && c.firstPeriod !== c.lastPeriod ? `${c.firstPeriod} to ${c.lastPeriod}` : (c.lastPeriod ?? "");
  return `${c.salesRows.toLocaleString("en-US")} sales rows${span ? ` · ${span}` : ""}`;
}

function status(c: UnmappedCustomer): string {
  if (c.why === "never mapped") return "Never mapped";
  const was = [c.lastBrickId, c.lastAreaCode].filter(Boolean).join(" · ");
  return `Switched off${was ? ` — was ${was}` : ""}`;
}

export function NormalizerUnmappedCustomers() {
  const [result, setResult] = useState<UnmappedCustomersResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [distributor, setDistributor] = useState("all");
  const [why, setWhy] = useState<WhyFilter>("all");
  const [query, setQuery] = useState("");

  const [reloads, setReloads] = useState(0);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    setReloads((n) => n + 1);
  }, []);

  // The panel starts in the loading state, so every state change here happens in a callback after the answer.
  useEffect(() => {
    let live = true;
    fetch("/api/sales/normalizer/unmapped-customers", { cache: "no-store" })
      .then(async (response) => {
        const json = (await response.json()) as { success: boolean; data?: UnmappedCustomersResult; error?: string };
        if (!json.success || !json.data) throw new Error(json.error ?? "Could not load the unmapped customers.");
        if (live) setResult(json.data);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : "Could not load the unmapped customers.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [reloads]);

  const customers = useMemo(() => result?.customers ?? [], [result]);
  const distributors = useMemo(() => [...new Set(customers.map((c) => c.distributorCode))].sort(), [customers]);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return customers.filter((c) => {
      if (distributor !== "all" && c.distributorCode !== distributor) return false;
      if (why !== "all" && c.why !== why) return false;
      if (!needle) return true;
      return [c.customerName, c.customerCode, c.address, c.distributorCode].some((v) => v.toLowerCase().includes(needle));
    });
  }, [customers, distributor, why, query]);
  const switchedOff = customers.filter((c) => c.why === "switched off").length;

  return (
    <div className="space-y-3">
      <div className="space-y-3 border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        <p>
          Every customer with no active mapping, whatever file is open: <b>{switchedOff.toLocaleString("en-US")}</b> switched off and{" "}
          <b>{(customers.length - switchedOff).toLocaleString("en-US")}</b> in imported sales but never mapped. Map one in{" "}
          <b>Master Database</b>, then upload again or reconcile its history.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Search customers"
            className={cn(phxFieldClassName, "h-9 w-full sm:w-64")}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, code or address"
            value={query}
          />
          <select aria-label="Distributor" className={cn(phxSelectClassName, "h-9 w-auto")} onChange={(e) => setDistributor(e.target.value)} value={distributor}>
            <option value="all">All distributors</option>
            {distributors.map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </select>
          <select aria-label="Status" className={cn(phxSelectClassName, "h-9 w-auto")} onChange={(e) => setWhy(e.target.value as WhyFilter)} value={why}>
            <option value="all">Switched off and never mapped</option>
            <option value="switched off">Switched off</option>
            <option value="never mapped">Never mapped</option>
          </select>
          <button className={cn(phxButtonGhostClassName, "ml-auto inline-flex h-9 items-center gap-2 px-3 text-xs")} disabled={loading} onClick={refresh} type="button">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
          </button>
        </div>
      </div>

      {error ? <p className="border border-rose-300 bg-rose-50 p-3 text-sm font-bold text-rose-800">{error}</p> : null}
      {result?.possiblyTruncated ? (
        <p className="border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">The database returned its row ceiling exactly, so this list may be cut. Filter by distributor to see the rest.</p>
      ) : null}
      {loading && !result ? <p className="p-4 text-sm text-slate-600">Loading…</p> : null}

      {result ? (
        <>
          <p className="text-xs font-bold text-slate-600">
            Showing {shown.length.toLocaleString("en-US")} of {customers.length.toLocaleString("en-US")}
          </p>

          <div className="hidden border border-phx-line md:block">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col className="w-[32%]" />
                <col className="w-[28%]" />
                <col className="w-[22%]" />
                <col className="w-[18%]" />
              </colgroup>
              <thead className="bg-[#0B0B0B] text-phx-paper-2">
                <tr>
                  {["Customer", "Address", "Status", "Sales"].map((h) => (
                    <th className="px-3 py-2 text-left" key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((c, i) => (
                  <tr className={cn("hover:bg-orange-50/50", i % 2 && "bg-slate-50/60")} key={`${c.distributorCode}-${c.customerCode}`}>
                    <td className="break-words px-3 py-1.5 align-top text-slate-600">
                      <span className="block font-semibold text-slate-900" dir="auto">{c.customerName || "(no name)"}</span>
                      <span className="block font-mono text-xs">{c.distributorCode} · {c.customerCode}</span>
                    </td>
                    <td className="break-words px-3 py-1.5 align-top text-slate-600" dir="auto">{c.address}</td>
                    <td className="break-words px-3 py-1.5 align-top text-slate-600">
                      <span className="block font-semibold text-slate-900">{status(c)}</span>
                      {c.switchedOffAt ? <span className="block text-xs">{when(c.switchedOffAt)}</span> : null}
                    </td>
                    <td className="break-words px-3 py-1.5 align-top text-slate-600">
                      <span className="block">{salesSummary(c)}</span>
                      {c.lines ? <span className="block text-xs">{c.lines}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="space-y-2 md:hidden">
            {shown.map((c) => (
              <li className="space-y-1 border border-phx-line bg-white p-3 text-sm text-slate-600" key={`${c.distributorCode}-${c.customerCode}`}>
                <p className="font-semibold text-slate-900" dir="auto">{c.customerName || "(no name)"}</p>
                <p className="font-mono text-xs">{c.distributorCode} · {c.customerCode}</p>
                {c.address ? <p className="break-words" dir="auto">{c.address}</p> : null}
                <p className="font-semibold text-slate-900">{status(c)}{c.switchedOffAt ? ` · ${when(c.switchedOffAt)}` : ""}</p>
                <p>{salesSummary(c)}{c.lines ? ` · ${c.lines}` : ""}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
