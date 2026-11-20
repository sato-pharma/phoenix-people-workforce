import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { LANDING_FOCUS, LANDING_INK, LandingPanel, LandingRailLine } from "@/components/employee-portal/landing-kit";
import type { ExcuseApprovalDetail } from "@/lib/approvals-hub/service";
import { requestStatusLabel } from "@/lib/approvals-hub/request-status-label";
import { DecisionActions } from "@/components/approvals-hub/decision-actions";

type Props = {
  detail: ExcuseApprovalDetail;
  backHref: string;
};

/** The white sheet a stand-alone line sits on: the kit's hairline and the soft depth token. */
const SHEET = `min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`;

function Row({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-200 py-2 last:border-b-0">
      <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">{label}</dt>
      <dd className={`break-words text-sm font-semibold ${LANDING_INK}`} dir="auto">
        {value === null || value === undefined || value === "" ? "—" : value}
      </dd>
    </div>
  );
}

function Back({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1.5 text-phx-xs font-bold uppercase tracking-[0.1em] underline-offset-4 transition-colors hover:underline motion-reduce:transition-none ${LANDING_INK} ${LANDING_FOCUS}`}
    >
      <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Back to list
    </Link>
  );
}

export function ExcuseRequestDetail({ detail, backHref }: Props) {
  const req = detail.request;
  if (detail.notFound || !req) {
    return (
      <div className="space-y-4">
        <Back href={backHref} />
        <div className={SHEET}>
          <LandingRailLine rail="bg-amber-500">This excuse request could not be found, or you do not have access to it.</LandingRailLine>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Back href={backHref} />

      {/* The head is the request's code, the name and its standing (no sentence under a header); the
          excuse's half of the day and its date are the first rows of Request details. */}
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1 border-b border-slate-200 pb-3">
        <div className="min-w-0">
          <p className="text-phx-xs font-bold uppercase tracking-[0.1em] tabular-nums text-slate-500">{req.requestCode}</p>
          <h2 className={`break-words text-lg font-black ${LANDING_INK}`} dir="auto">{req.employeeName}</h2>
        </div>
        <span className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-600">{requestStatusLabel(req.status)}</span>
      </div>

      {detail.readOnlyReason ? (
        <div className={SHEET}>
          <LandingRailLine rail="bg-slate-400">{detail.readOnlyReason}</LandingRailLine>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <LandingPanel title="Request details">
          <dl className="px-3 py-1 sm:px-4">
            <Row label="Type" value={`${req.excuseType === "morning" ? "Morning" : "Afternoon"} excuse`} />
            <Row label="Date" value={req.excuseDate} />
            <Row label="Duration" value={`${req.durationHours} hours`} />
            <Row label="Line" value={req.lineName} />
            <Row label="Department" value={req.departmentName} />
            <Row label="Manager" value={req.managerName} />
            <Row label="Manager reply" value={req.managerDecisionComment} />
          </dl>
        </LandingPanel>

        {detail.canAct ? (
          <DecisionActions
            endpoint={`/api/excuses/${encodeURIComponent(req.id)}/decision`}
            commentField="comment"
            actions={{ approve: true, reject: true, return: true }}
            backHref={backHref}
          />
        ) : null}
      </div>
    </div>
  );
}
