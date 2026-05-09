"use client";

import type { GeoTripRouteRecord } from "@/lib/geo-intelligence/types";

import {
  AdminSectionHeader,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";
import { Card } from "@/components/ui/card";

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(value);
}

function tone(status: GeoTripRouteRecord["status"]) {
  if (status === "high_risk") return "bg-red-50 text-red-700 ring-red-100";
  if (status === "review_required") return "bg-amber-50 text-amber-700 ring-amber-100";
  return "bg-emerald-50 text-emerald-700 ring-emerald-100";
}

export function TripAnomalyTable({
  routes,
  title = "Trip anomalies",
}: {
  routes: GeoTripRouteRecord[];
  title?: string;
}) {
  return (
    <Card className={`${adminPanelClassName} overflow-hidden p-0`}>
      <AdminSectionHeader
        description="Investigate route-level differences between claimed and expected metrics."
        title={title}
      />
      <div className="overflow-x-auto pb-1">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-[#F8FAFC] text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]">
            <tr>
              <th className="px-4 py-3">Employee</th>
              <th className="px-4 py-3">Route</th>
              <th className="px-4 py-3">Claimed</th>
              <th className="px-4 py-3">Expected</th>
              <th className="px-4 py-3">Variance</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {routes.length === 0 ? (
              <tr>
                <td className="px-4 py-7 text-sm text-[#64748B]" colSpan={6}>
                  No suspicious trips in the current scope.
                </td>
              </tr>
            ) : (
              routes.map((route) => (
                <tr className="border-b border-[#E2E8F0] transition hover:bg-[#FCFDFE]" key={route.id}>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-900">{route.employeeName ?? "Unknown"}</p>
                    <p className="text-xs text-slate-500">{route.employeeHrId ?? "No HR ID"}</p>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {route.fromText} to {route.toText}
                  </td>
                  <td className="px-4 py-3 text-slate-700">{egp(route.claimedAmount)}</td>
                  <td className="px-4 py-3 text-slate-700">{egp(route.expectedAmount)}</td>
                  <td className="px-4 py-3 text-slate-700">
                    {egp(route.varianceAmount)} ({route.variancePercent.toFixed(1)}%)
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${tone(route.status)}`}>
                      {route.status.replace(/_/g, " ")}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
