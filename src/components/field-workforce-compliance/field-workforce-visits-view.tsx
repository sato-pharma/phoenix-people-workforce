"use client";

import { ChevronLeft, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { FieldWorkforceRouteMap, type DayRoute, type RouteCheckin } from "@/components/field-workforce-compliance/field-workforce-route-map";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { Card } from "@/components/ui/card";
import { resolveVisitTypeLabel } from "@/lib/crm/visit-types";

/**
 * The visit's type, as a human reads it.
 *
 * NEVER render `visitTypeDescription` raw here. The vendor stores the literal string "Unknown" for
 * eight distinct codes — Field Visit (-30), BRM (-21), Admin Work (-20), Meeting (-19), Training
 * (-16), Ambiguous (-7), Casual Leave (-6) and Public Holiday (-5) — so it is never null and the
 * `?? "Type N"` fallback this replaced could not fire even once. Measured on production
 * 2026-09-21: 3,077 rows since January, 0 of them null, across 2,311 rep-days. On the Prophet's
 * Birthday (2026-08-27) all 156 of the day's rows read "Unknown" on this screen; they now read
 * "Vacations & Leaves", which is the label the resolver actually returns for -5 — it groups
 * Public Holiday with Casual Leave rather than naming the holiday.
 *
 * `resolveVisitTypeLabel` reads the comment, which `rep-day.ts` already selects, and the comment is
 * what separates the two codes that share one: a -7 row routes to Health Day / Vacations & Leaves /
 * Meetings / Admin Work by its text, and a -30 row to Pharmacy Visit or Regular.
 */
function visitTypeLabel(visit: Visit): string {
  return resolveVisitTypeLabel(visit.visitType, visit.visitTypeDescription, visit.comment);
}

function VisitKindBadge({ kind }: { kind: Visit["kind"] }) {
  return (
    <span
      className={
        kind === "campaign"
          ? "inline-flex rounded-md border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs font-bold text-violet-700"
          : kind === "regular"
            ? "inline-flex rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-700"
            : "inline-flex rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-bold text-slate-600"
      }
    >
      {kind === "campaign" ? "Campaign" : kind === "regular" ? "Regular" : "Other"}
    </span>
  );
}

type Visit = {
  ampm: string | null;
  callType: number | null;
  comment: string | null;
  contactName: string | null;
  customerName: string | null;
  id: number;
  kind: "campaign" | "regular" | "other";
  mode: "single" | "double";
  partnerName: string | null;
  role: "primary" | "double";
  visitType: number;
  visitTypeDescription: string | null;
};

type PunchSummary = {
  firstPunchTime: string | null;
  lastPunchTime: string | null;
  visiblePunchCount: number;
};

type VisitsResponse = {
  data?: {
    checkins: RouteCheckin[];
    date: string;
    /** Fingerprint punch summary for this employee/day, independent of CRM visits — null when
     * there's no punch that day (or the employee isn't device-mapped). */
    punches: PunchSummary | null;
    rep: { crmId: string | null; fullName: string | null; hrId: string } | null;
    route: DayRoute | null;
    visits: Visit[];
  };
  error?: string;
  message?: string;
  success: boolean;
};

export function FieldWorkforceVisitsView({
  backHref = "/admin/field-workforce-compliance",
  backLabel = "Back to compliance",
  date,
  endpoint = "/api/admin/field-workforce-compliance/visits",
  hrId,
}: {
  backHref?: string;
  backLabel?: string;
  date: string;
  endpoint?: string;
  hrId: string;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<VisitsResponse["data"] | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`${endpoint}?hrId=${encodeURIComponent(hrId)}&date=${encodeURIComponent(date)}`);
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
  }, [date, endpoint, hrId]);

  const repName = data?.rep?.fullName ?? hrId;
  const visits = data?.visits ?? [];
  const checkins = data?.checkins ?? [];
  const route = data?.route ?? null;
  const punches = data?.punches ?? null;

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div>
        <Link
          className="inline-flex items-center gap-1 text-sm font-bold text-orange-700 hover:underline"
          href={backHref}
        >
          <ChevronLeft className="h-4 w-4" /> {backLabel}
        </Link>
        <h1 className="mt-2 text-2xl font-black text-slate-950">Visits — {repName}</h1>
        <p className="mt-1 text-sm font-semibold text-slate-500">{hrId} &middot; {date}</p>
      </div>

      {!loading && !error && punches ? (
        <Card className="rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm font-semibold text-teal-900">
          Fingerprint punch: {punches.firstPunchTime ?? "—"}
          {punches.lastPunchTime && punches.lastPunchTime !== punches.firstPunchTime ? `–${punches.lastPunchTime}` : ""}
          {" "}({punches.visiblePunchCount} punch{punches.visiblePunchCount === 1 ? "" : "es"})
        </Card>
      ) : null}

      <Card className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {loading ? (
          <div className="flex items-center gap-2 p-6 text-sm font-semibold text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading this day&apos;s visits from Phoenix CRM&hellip;
          </div>
        ) : error ? (
          <div className="p-6 text-sm font-semibold text-rose-700">{error}</div>
        ) : visits.length === 0 ? (
          <div className="p-6 text-sm font-semibold text-slate-500">
            {punches
              ? `No CRM visit records for this rep on ${date} — a fingerprint punch was recorded (see above).`
              : `No visit records for this rep on ${date}.`}
          </div>
        ) : (
          <PortalResponsiveDataList
            empty={null}
            getKey={(visit) => String(visit.id)}
            items={visits}
            renderCard={(visit, index) => (
              <PortalRecordCard
                meta={`Visit #${index + 1}${visit.customerName ? ` · ${visit.customerName}` : ""}`}
                status={<VisitKindBadge kind={visit.kind} />}
                title={visit.contactName || "—"}
              >
                <PortalRecordFields
                  fields={[
                    { label: "Type", value: visitTypeLabel(visit) },
                    { label: "AM/PM", value: visit.ampm || "—" },
                    { label: "Comment", value: visit.comment || "—" },
                  ]}
                />
              </PortalRecordCard>
            )}
            renderTable={() => (
              <PortalDesktopTable
                cols={
                  <colgroup>
                    <col className="w-[6%]" />
                    <col className="w-[22%]" />
                    <col className="w-[18%]" />
                    <col className="w-[18%]" />
                    <col className="w-[10%]" />
                    <col className="w-[26%]" />
                  </colgroup>
                }
              >
                <thead>
                  <tr className="bg-slate-950 text-left text-xs font-black uppercase tracking-wide text-white">
                    <th className="px-4 py-3">#</th>
                    <th className="px-4 py-3">Contact</th>
                    {/* No Customer / Facility column - customerName is empty on every visit (see master.ts). */}
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
                      <td className="px-4 py-3">
                        <VisitKindBadge kind={visit.kind} />
                        <div className="mt-0.5 text-phx-2xs text-slate-400">
                          {visitTypeLabel(visit)}
                          {visit.callType != null ? ` · ct:${visit.callType}` : ""}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-700">{visitTypeLabel(visit)}</td>
                      <td className="px-4 py-3">{visit.ampm || "—"}</td>
                      <td className="px-4 py-3 text-slate-600">{visit.comment || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </PortalDesktopTable>
            )}
          />
        )}
      </Card>

      {!loading && !error ? <FieldWorkforceRouteMap checkins={checkins} route={route} /> : null}

      <p className="text-xs font-semibold text-slate-400">
        {visits.length} visit(s) &middot; {checkins.length} GPS check-in(s) &middot; read live from Phoenix CRM (the iReports360 archive before the team&apos;s start) &middot; read-only.
      </p>
    </div>
  );
}
