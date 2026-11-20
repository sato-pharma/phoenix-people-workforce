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
import {
  LANDING_FOCUS,
  LANDING_INK,
  LandingEmpty,
  LandingRailLine,
  LandingTick,
} from "@/components/employee-portal/landing-kit";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
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

// The landing kit's status rule: the kind is a coloured word, never a filled pill.
function VisitKindBadge({ kind }: { kind: Visit["kind"] }) {
  return (
    <span
      className={`inline-flex text-phx-xs font-bold uppercase tracking-[0.08em] ${
        kind === "campaign" ? "text-violet-700" : kind === "regular" ? "text-emerald-700" : "text-slate-600"
      }`}
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
    <div className="space-y-4 p-4 sm:p-6">
      <div className="min-w-0">
        <Link
          className={`inline-flex min-h-10 items-center gap-1 text-phx-sm font-bold uppercase tracking-[0.08em] ${LANDING_INK} hover:underline sm:min-h-8 ${LANDING_FOCUS}`}
          href={backHref}
        >
          <ChevronLeft aria-hidden="true" className="h-4 w-4" /> {backLabel}
        </Link>
        <h1 className={`mt-2 flex min-w-0 items-center gap-2 break-words text-2xl font-black leading-tight ${LANDING_INK}`} dir="auto">
          <LandingTick />
          <span className="min-w-0">Visits — {repName}</span>
        </h1>
        <p className="mt-1 break-words text-phx-sm font-semibold tabular-nums text-slate-500">{hrId} &middot; {date}</p>
      </div>

      {!loading && !error && punches ? (
        <div className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          <LandingRailLine rail="bg-teal-600">
            <span className={`font-semibold tabular-nums ${LANDING_INK}`}>
              Fingerprint punch: {punches.firstPunchTime ?? "—"}
              {punches.lastPunchTime && punches.lastPunchTime !== punches.firstPunchTime ? `–${punches.lastPunchTime}` : ""}
              {" "}({punches.visiblePunchCount} punch{punches.visiblePunchCount === 1 ? "" : "es"})
            </span>
          </LandingRailLine>
        </div>
      ) : null}

      <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        {loading ? (
          <div aria-busy="true" className="flex items-center gap-2 px-3 py-4 text-phx-sm font-semibold text-slate-500 sm:px-4">
            <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" /> Loading this day&apos;s visits from Phoenix CRM&hellip;
          </div>
        ) : error ? (
          <LandingRailLine rail="bg-rose-600">
            <span className="font-semibold text-rose-700">{error}</span>
          </LandingRailLine>
        ) : visits.length === 0 ? (
          <LandingEmpty>
            {punches
              ? `No CRM visit records for this rep on ${date} — a fingerprint punch was recorded (see above).`
              : `No visit records for this rep on ${date}.`}
          </LandingEmpty>
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
                  <tr className="border-b border-slate-200 bg-white text-left text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">
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
                    <tr className="border-t border-slate-200 align-top text-slate-700" key={visit.id}>
                      <td className={`px-4 py-3 font-bold tabular-nums ${LANDING_INK}`}>{index + 1}</td>
                      <td className={`break-words px-4 py-3 font-semibold ${LANDING_INK}`} dir="auto">{visit.contactName || "—"}</td>
                      <td className="px-4 py-3">
                        <VisitKindBadge kind={visit.kind} />
                        <div className="mt-0.5 break-words text-phx-xs text-slate-500">
                          {visitTypeLabel(visit)}
                          {visit.callType != null ? ` · ct:${visit.callType}` : ""}
                        </div>
                      </td>
                      <td className="break-words px-4 py-3 text-phx-md text-slate-700">{visitTypeLabel(visit)}</td>
                      <td className="px-4 py-3">{visit.ampm || "—"}</td>
                      <td className="break-words px-4 py-3 text-slate-600" dir="auto">{visit.comment || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </PortalDesktopTable>
            )}
          />
        )}
      </section>

      {!loading && !error ? <FieldWorkforceRouteMap checkins={checkins} route={route} /> : null}

      <p className="break-words text-phx-xs font-semibold text-slate-500">
        {visits.length} visit(s) &middot; {checkins.length} GPS check-in(s) &middot; read live from Phoenix CRM (the iReports360 archive before the team&apos;s start) &middot; read-only.
      </p>
    </div>
  );
}
