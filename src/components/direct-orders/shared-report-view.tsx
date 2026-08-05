"use client";

import { useState } from "react";

import type { DirectOrderReportRow } from "@/lib/direct-orders/types";

type Props = { token: string };

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;
const cairo = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(
        new Date(iso),
      )
    : "—";

/**
 * The recipient's view of a shared Direct Orders report.
 *
 * Holds nothing until the passcode is accepted server-side — the gate is the API, not this
 * component, so viewing the page source reveals no data. Every load re-fetches, which is what
 * makes the link "live" rather than a snapshot someone has to remember to resend.
 */
export function SharedDirectOrderReport({ token }: Props) {
  const [passcode, setPasscode] = useState("");
  const [rows, setRows] = useState<DirectOrderReportRow[] | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open(code: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/share/direct-orders/${encodeURIComponent(token)}/live`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode: code }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        message?: string;
        rows?: DirectOrderReportRow[];
        label?: string | null;
        generatedAt?: string;
      };
      if (!res.ok || !data.success) throw new Error(data.message || "This link is not available.");
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setLabel(data.label ?? null);
      setGeneratedAt(data.generatedAt ?? null);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadCsv() {
    const res = await fetch(`/api/share/direct-orders/${encodeURIComponent(token)}/live`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode, format: "csv" }),
    });
    if (!res.ok) {
      setError("Could not download the file.");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "direct-orders.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!rows) {
    return (
      <section className="mx-auto max-w-md border border-[#e4e9ec] bg-white">
        <header className="border-b border-[#e4e9ec] bg-slate-900 px-4 py-3">
          <p className="text-[11px] font-black uppercase tracking-[0.14em] text-orange-400">Phoenix</p>
          <h1 className="text-base font-black text-white">Direct Orders Report</h1>
        </header>
        <div className="space-y-3 px-4 py-5">
          <p className="text-[13px] text-slate-600">Enter the passcode you were given to open this report.</p>
          <input
            type="password"
            className="w-full border border-slate-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void open(passcode);
            }}
            placeholder="Passcode"
          />
          {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
          <button
            type="button"
            onClick={() => open(passcode)}
            disabled={busy || passcode.trim().length === 0}
            className="w-full bg-orange-500 px-4 py-2.5 text-[13px] font-black uppercase tracking-wider text-white hover:bg-orange-600 disabled:bg-slate-300"
          >
            {busy ? "Opening…" : "Open report"}
          </button>
        </div>
      </section>
    );
  }

  const total = rows.reduce((sum, r) => sum + (Number(r.salesValue) || 0), 0);

  return (
    <section className="border border-[#e4e9ec] bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e4e9ec] bg-slate-900 px-4 py-3">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.14em] text-orange-400">Phoenix</p>
          <h1 className="text-base font-black text-white">{label ?? "Direct Orders Report"}</h1>
        </div>
        <div className="text-right">
          <p className="text-[11px] text-slate-300">Updated {cairo(generatedAt)}</p>
          <button type="button" onClick={downloadCsv} className="mt-1 bg-orange-500 px-3 py-1 text-[11px] font-black uppercase tracking-wider text-white hover:bg-orange-600">
            Download spreadsheet
          </button>
        </div>
      </header>

      <div className="flex flex-wrap gap-4 border-b border-[#eef1f3] bg-slate-50 px-4 py-2.5 text-[12px]">
        <span><span className="font-black uppercase tracking-wider text-slate-400">Rows </span>{rows.length.toLocaleString("en-US")}</span>
        <span><span className="font-black uppercase tracking-wider text-slate-400">Total value </span>{money(total)}</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-[12px]">
          <thead>
            <tr className="border-b border-[#eef1f3] bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-500">
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Requester</th>
              <th className="px-3 py-2">Pharmacy</th>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Value</th>
              <th className="px-3 py-2">Area</th>
              <th className="px-3 py-2">Sales month</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-[#f1f4f6]">
                <td className="whitespace-nowrap px-3 py-1.5 text-slate-700">{r.status.replace(/_/g, " ")}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-slate-800">{r.requesterName}</td>
                <td className="whitespace-nowrap px-3 py-1.5 font-semibold text-slate-900" dir="auto">{r.pharmacyName}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-slate-700">{r.productName}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{r.qty.toLocaleString("en-US")}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right font-bold tabular-nums">{money(r.salesValue)}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-slate-600">{r.areaName || "—"}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-slate-600">{r.salesMonth ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-[#eef1f3] px-4 py-2 text-[11px] text-slate-400">
        This view is read-only and reflects the data at the time shown above. Reload for the latest.
      </p>
    </section>
  );
}
