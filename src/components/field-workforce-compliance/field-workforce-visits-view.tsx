"use client";

import { ChevronLeft, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { FieldWorkforceRouteMap, type DayRoute, type RouteCheckin } from "@/components/field-workforce-compliance/field-workforce-route-map";
import { Card } from "@/components/ui/card";

type Visit = {
  ampm: string | null;
  callType: number | null;
  comment: string | null;
  contactName: string | null;
  customerName: string | null;
  id: number;
  kind: "campaign" | "regular";
  mode: "single" | "double";
  partnerName: string | null;
  role: "primary" | "double";
  visitType: number;
  visitTypeDescription: string | null;
};

type VisitsResponse = {
  data?: {
    checkins: RouteCheckin[];
    date: string;
    rep: { crmId: string | null; fullName: string | null; hrId: string } | null;
    route: DayRoute | null;
    visits: Visit[];
  };
  error?: string;
  message?: string;
  success: boolean;
};

export function FieldWorkforceVisitsView({ date, hrId }: { date: string; hrId: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<VisitsResponse["data"] | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/admin/field-workforce-compliance/visits?hrId=${encodeURIComponent(hrId)}&date=${encodeURIComponent(date)}`);
        const payload = (await response.json()) as VisitsResponse;
        if (!active) return;
        if (payload.success && payload.data) setData(payload.data);
        else setError(payload.message ?? payload.error ?? "Could not load the day's visits.");
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "Could not load the day's visits.");
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [date, hrId]);

  const repName = data?.rep?.fullName ?? hrId;
  const visits = data?.visits ?? [];
  const checkins = data?.checkins ?? [];
  const route = data?.route ?? null;

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div>
        <Link
          className="inline-flex items-center gap-1 text-sm font-bold text-orange-700 hover:underline"
          href="/admin/field-workforce-compliance"
        >
          <ChevronLeft className="h-4 w-4" /> Back to compliance
        </Link>
        <h1 className="mt-2 text-2xl font-black text-slate-950">Visits — {repName}</h1>
        <p className="mt-1 text-sm font-semibold text-slate-500">{hrId} &middot; {date}</p>
      </div>

      <Card className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {loading ? (
          <div className="flex items-center gap-2 p-6 text-sm font-semibold text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading this day&apos;s visits from iReports360&hellip;
          </div>
        ) : error ? (
          <div className="p-6 text-sm font-semibold text-rose-700">{error}</div>
        ) : visits.length === 0 ? (
          <div className="p-6 text-sm font-semibold text-slate-500">No visit records for this rep on {date}.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-950 text-left text-xs font-black uppercase tracking-wide text-white">
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Customer / Facility</th>
                <th className="px-4 py-3">Visit</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">AM/PM</th>
                <th className="px-4 py-3">Comment</th>
              </tr>
            </thead>
            <tbody>
              {visits.map((visit, index) => (
                <tr className="border-t border-orange-100 align-top text-slate-700" key={visit.id}>
                  <td className="px-4 py-3 font-bold text-slate-900">{index + 1}</td>
                  <td className="px-4 py-3 font-semibold text-slate-900">{visit.contactName || "—"}</td>
                  <td className="px-4 py-3">{visit.customerName || "—"}</td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        visit.kind === "campaign"
                          ? "inline-flex rounded-md border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs font-bold text-violet-700"
                          : "inline-flex rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-700"
                      }
                    >
                      {visit.kind === "campaign" ? "Campaign" : "Regular"}
                    </span>
                    <div className="mt-0.5 text-[10px] text-slate-400">
                      {visit.visitTypeDescription ?? `type:${visit.visitType}`}
                      {visit.callType != null ? ` · ct:${visit.callType}` : ""}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-700">
                    {visit.visitTypeDescription ?? (visit.visitType === 0 ? "Regular Visit" : `Type ${visit.visitType}`)}
                  </td>
                  <td className="px-4 py-3">{visit.ampm || "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{visit.comment || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {!loading && !error ? <FieldWorkforceRouteMap checkins={checkins} route={route} /> : null}

      <p className="text-xs font-semibold text-slate-400">
        {visits.length} visit(s) &middot; {checkins.length} GPS check-in(s) &middot; pulled live from iReports360 &middot; read-only.
      </p>
    </div>
  );
}
