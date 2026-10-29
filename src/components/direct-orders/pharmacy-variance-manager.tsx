"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { PharmacyGeoVariance } from "@/lib/direct-orders/service";
import { adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";

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

  const codesList = (r: PharmacyGeoVariance) =>
    r.codes.map((c, i) => (
      <div key={i}>{c.distributorName}: {c.customerCode} → {c.mappedBrickName ?? "unmapped"}</div>
    ));

  const resolveButtons = (r: PharmacyGeoVariance) => (
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy !== null} className="border border-slate-300 px-2 py-1 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        onClick={() => resolve(r.pharmacyId, "keep")}>Keep submitted</button>
      <button type="button" disabled={busy !== null} className="bg-orange-500 px-2 py-1 text-xs font-bold text-white hover:bg-orange-600 disabled:opacity-50"
        onClick={() => resolve(r.pharmacyId, "apply")}>Apply mapping</button>
    </div>
  );

  if (rows.length === 0) {
    return <p className="border border-emerald-200 bg-emerald-50 px-4 py-6 text-sm text-emerald-800">No geography variances — every pharmacy brick matches its distributor customer-code mapping.</p>;
  }

  return (
    <div className="space-y-3">
      {!canResolve ? (
        <p className="border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">View-only. Only a System Admin can resolve variances.</p>
      ) : null}
      {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
      <PortalResponsiveDataList
        empty={null}
        getKey={(r) => r.pharmacyId}
        items={rows}
        renderCard={(r) => (
          <PortalRecordCard
            accent="amber"
            actions={canResolve ? resolveButtons(r) : undefined}
            title={r.pharmacyName}
          >
            <PortalRecordFields
              fields={[
                { label: "Submitted brick", value: r.submittedBrickName ?? "—" },
                { label: "System-mapped brick", value: r.mappedBrickName ?? "—" },
                { label: "Distributor codes", value: codesList(r) },
              ]}
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable
            cols={
              canResolve ? (
                <colgroup>
                  <col className="w-[20%]" />
                  <col className="w-[15%]" />
                  <col className="w-[15%]" />
                  <col className="w-[28%]" />
                  <col className="w-[22%]" />
                </colgroup>
              ) : (
                <colgroup>
                  <col className="w-[25%]" />
                  <col className="w-[20%]" />
                  <col className="w-[20%]" />
                  <col className="w-[35%]" />
                </colgroup>
              )
            }
          >
            <thead className={`${adminPanelHeaderClassName} text-white`}>
              <tr className="text-left text-phx-xs font-black uppercase tracking-wider">
                <th className="px-3 py-2">Venue</th>
                <th className="px-3 py-2">Submitted brick</th>
                <th className="px-3 py-2">System-mapped brick</th>
                <th className="px-3 py-2">Distributor codes</th>
                {canResolve ? <th className="px-3 py-2">Resolve</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.pharmacyId} className="border-b border-slate-100 align-top">
                  <td className="break-words px-3 py-2 font-semibold text-slate-800">{r.pharmacyName}</td>
                  <td className="break-words px-3 py-2">{r.submittedBrickName ?? "—"}</td>
                  <td className="break-words px-3 py-2 font-semibold text-orange-700">{r.mappedBrickName ?? "—"}</td>
                  <td className="break-words px-3 py-2 text-phx-sm text-slate-600">{codesList(r)}</td>
                  {canResolve ? <td className="px-3 py-2">{resolveButtons(r)}</td> : null}
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </div>
  );
}
