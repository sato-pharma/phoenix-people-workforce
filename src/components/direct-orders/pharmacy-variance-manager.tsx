"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { PharmacyGeoVariance } from "@/lib/direct-orders/service";

export function PharmacyVarianceManager({ rows, canResolve }: { rows: PharmacyGeoVariance[]; canResolve: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(pharmacyId: string, action: "keep" | "apply") {
    setBusy(pharmacyId + action);
    setError(null);
    try {
      const res = await fetch("/api/direct-orders/variances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pharmacyId, action }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) throw new Error(data.message || "Failed.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) {
    return <p className="border border-emerald-200 bg-emerald-50 px-4 py-6 text-sm text-emerald-800">No geography variances — every pharmacy brick matches its distributor customer-code mapping.</p>;
  }

  return (
    <div className="space-y-3">
      {!canResolve ? (
        <p className="border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">View-only. Only a System Admin can resolve variances.</p>
      ) : null}
      {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
      <div className="overflow-x-auto border border-slate-200">
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <thead className="bg-slate-900 text-white">
            <tr className="text-left text-[11px] font-black uppercase tracking-wider">
              <th className="px-3 py-2">Pharmacy</th>
              <th className="px-3 py-2">Submitted brick</th>
              <th className="px-3 py-2">System-mapped brick</th>
              <th className="px-3 py-2">Distributor codes</th>
              {canResolve ? <th className="px-3 py-2">Resolve</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.pharmacyId} className="border-b border-slate-100 align-top">
                <td className="px-3 py-2">
                  <div className="font-semibold text-slate-800">{r.pharmacyName}</div>
                  <div className="text-[11px] text-slate-400">{r.phoenixPharmacyCode}</div>
                </td>
                <td className="px-3 py-2">{r.submittedBrickName ?? "—"} <span className="text-slate-400">({r.submittedBrickId ?? "—"})</span></td>
                <td className="px-3 py-2 font-semibold text-orange-700">{r.mappedBrickName ?? "—"} <span className="text-slate-400">({r.mappedBrickId ?? "—"})</span></td>
                <td className="px-3 py-2 text-[12px] text-slate-600">
                  {r.codes.map((c, i) => (
                    <div key={i}>{c.distributorName}: {c.customerCode} → {c.mappedBrickName ?? "unmapped"}</div>
                  ))}
                </td>
                {canResolve ? (
                  <td className="px-3 py-2">
                    <div className="flex gap-2">
                      <button type="button" disabled={busy !== null} className="border border-slate-300 px-2 py-1 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                        onClick={() => resolve(r.pharmacyId, "keep")}>Keep submitted</button>
                      <button type="button" disabled={busy !== null} className="bg-orange-500 px-2 py-1 text-xs font-bold text-white hover:bg-orange-600 disabled:opacity-50"
                        onClick={() => resolve(r.pharmacyId, "apply")}>Apply mapping</button>
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
