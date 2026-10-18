"use client";

import { useMemo, useState } from "react";
import { BadgeCheck, Check, CheckCheck, Contact, Eye, Loader2, Mail, Phone } from "lucide-react";

import type { ContactReviewRow } from "@/lib/recruitment/contact-review-service";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { adminControlDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  RecruitmentEmptyState,
  RecruitmentKpiStrip,
  RecruitmentPanel,
  RecruitmentPill,
} from "@/components/recruitment/recruitment-premium";
import { phxButtonAccentClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

// THE LOOK (owner, 2026-10-19, the full-module premium sweep): the three counts are the module's KPI
// strip and the queue is one panel under the house dark band, with the bulk accept on the band.
// Desktop is a fixed table that fits by MERGING columns — where the CV came from and when sit under
// the name — and a phone gets one card per candidate. Nothing scrolls sideways and nothing is cut:
// an address wraps onto as many lines as it needs.

// Every moment this module shows a person is Cairo local time, never a raw UTC string. Written
// here, matching intake-health-view.tsx and recruitment-workspace.tsx, rather than imported across
// a domain boundary.
function cairoDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";
  return formatStableEnGb(value, {
    day: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
}

function sourceLabel(source: string | null): string {
  if (source === "whatsapp") return "WhatsApp";
  if (source === "email") return "Email";
  return source ?? "—";
}

/** The row's own Accept: a hairline control that lifts on hover, never a second loud button. */
const acceptButtonClassName = `inline-flex items-center gap-1.5 border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:border-emerald-400 hover:text-emerald-700 disabled:opacity-40 ${adminControlDepthClassName} disabled:shadow-none`;

/** A proposed value with the AI's own hedge beside it, so "low" is never mistaken for a fact. */
function Proposed({ confidence, value }: { confidence: "high" | "low"; value: string | null }) {
  if (!value) return <span className="text-slate-300">—</span>;
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
      <span className="min-w-0 break-all font-semibold text-slate-800" dir="ltr">
        {value}
      </span>
      {confidence === "low" ? <RecruitmentPill tone="amber">Check</RecruitmentPill> : null}
    </span>
  );
}

/**
 * The unreachable pool, and what their own CVs say about how to reach them.
 *
 * The list is a queue only in the sense that it is derived: a candidate leaves it the moment their
 * column stops being blank, so accepting a row simply drops it. Nothing here is stored, so nothing
 * here can go stale.
 */
export function ContactReviewView({ rows: initialRows }: { rows: ContactReviewRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<{ applied: number; skipped: string[]; failed: string[] } | null>(null);

  const highConfidenceCount = useMemo(
    () =>
      rows.filter((row) => row.proposal.email?.confidence === "high" || row.proposal.phone?.confidence === "high")
        .length,
    [rows],
  );

  async function accept(candidateIds: string[], highConfidenceOnly: boolean, busyKey: string) {
    setBusy(busyKey);
    setError(null);
    setReport(null);
    try {
      const response = await fetch("/api/recruitment/candidates/contact-review", {
        body: JSON.stringify({ candidateIds, highConfidenceOnly }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as {
        message?: string;
        result?: {
          applied: Array<{ candidateId: string }>;
          failed: Array<{ candidateId: string; reason: string }>;
          skipped: Array<{ candidateId: string; reason: string }>;
        };
      };
      if (!response.ok || !payload.result) {
        setError(payload.message ?? "Could not save those contact details.");
        return;
      }
      const result = payload.result;
      const appliedIds = new Set(result.applied.map((entry) => entry.candidateId));
      const nameFor = (id: string) => rows.find((row) => row.candidateId === id)?.name ?? id;
      // Everything not applied is reported with its reason. A count that quietly shrinks is how a
      // partial run gets read as a complete one.
      setReport({
        applied: result.applied.length,
        failed: result.failed.map((entry) => `${nameFor(entry.candidateId)} — ${entry.reason}`),
        skipped: result.skipped.map((entry) => `${nameFor(entry.candidateId)} — ${entry.reason}`),
      });
      setRows((previous) => previous.filter((row) => !appliedIds.has(row.candidateId)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save those contact details.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <RecruitmentKpiStrip
        items={[
          {
            description: "Their CV holds an email or a phone",
            icon: <Contact aria-hidden="true" className="h-4 w-4" />,
            label: "Awaiting review",
            tone: "orange",
            value: <span className="tabular-nums">{String(rows.length)}</span>,
          },
          {
            description: "Safe to accept without opening the CV",
            icon: <BadgeCheck aria-hidden="true" className="h-4 w-4" />,
            label: "High confidence",
            tone: "emerald",
            value: <span className="tabular-nums">{String(highConfidenceCount)}</span>,
          },
          {
            description: "A reading the AI was unsure of",
            icon: <Eye aria-hidden="true" className="h-4 w-4" />,
            label: "Needs a look",
            tone: "violet",
            value: <span className="tabular-nums">{String(rows.length - highConfidenceCount)}</span>,
          },
        ]}
      />

      <RecruitmentPanel
        actions={
          <button
            className={cn(phxButtonAccentClassName, "px-3 text-xs")}
            disabled={busy !== null || highConfidenceCount === 0}
            onClick={() => accept(rows.map((row) => row.candidateId), true, "__bulk__")}
            type="button"
          >
            {busy === "__bulk__" ? (
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCheck aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {busy === "__bulk__" ? "Accepting…" : `Accept ${highConfidenceCount} high-confidence`}
          </button>
        }
        count={rows.length}
        description="These candidates have no email or phone on record, but their own CV does. Accepting fills only the blank column — nothing already on the record is ever overwritten."
        icon={<Contact aria-hidden="true" className="h-4 w-4" />}
        title="Contact details found in CVs"
      >
        {error ? (
          <p className="mx-4 mt-4 border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700 sm:mx-5" role="alert">
            {error}
          </p>
        ) : null}

        {report ? (
          <div className="mx-4 mt-4 space-y-2 border border-emerald-200 bg-emerald-50/70 px-3 py-2.5 text-sm sm:mx-5" role="status">
            <p className="flex items-center gap-1.5 font-bold text-emerald-900">
              <Check aria-hidden="true" className="h-4 w-4" />
              {report.applied} candidate{report.applied === 1 ? "" : "s"} updated.
            </p>
            {report.skipped.length > 0 ? (
              <div>
                <p className="text-xs font-black uppercase tracking-wide text-slate-600">
                  Left for a human ({report.skipped.length})
                </p>
                <ul className="mt-1 space-y-0.5 break-words text-xs text-slate-700">
                  {report.skipped.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {report.failed.length > 0 ? (
              <div>
                <p className="text-xs font-black uppercase tracking-wide text-rose-600">
                  Could not save ({report.failed.length})
                </p>
                <ul className="mt-1 space-y-0.5 break-words text-xs text-rose-700">
                  {report.failed.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {rows.length === 0 ? (
          <RecruitmentEmptyState
            icon={<BadgeCheck aria-hidden="true" className="h-5 w-5" />}
            message="Nothing waiting — every candidate whose CV carries contact details already has them on record."
            title="Nothing waiting"
          />
        ) : (
          <>
            {/* Phone: one card per candidate. Four columns of addresses and numbers cannot fit a
                375px screen without either wrapping or truncating, and both are forbidden here. */}
            <div className="mt-2 divide-y divide-slate-100 md:hidden">
              {rows.map((row) => (
                <div className="px-4 py-3" key={row.candidateId}>
                  <p className="break-words text-sm font-black text-slate-900" dir="auto">
                    {row.name}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {sourceLabel(row.source)} · {cairoDate(row.createdAt)}
                  </p>
                  <dl className="mt-2 space-y-1.5 text-xs">
                    {row.proposal.email ? (
                      <div className="flex items-start gap-2">
                        <dt className="flex flex-none items-center gap-1 pt-px text-phx-2xs font-bold uppercase tracking-wide text-slate-400">
                          <Mail aria-hidden="true" className="h-3 w-3" />
                          Email
                        </dt>
                        <dd className="min-w-0">
                          <Proposed confidence={row.proposal.email.confidence} value={row.proposal.email.value} />
                        </dd>
                      </div>
                    ) : null}
                    {row.proposal.phone ? (
                      <div className="flex items-start gap-2">
                        <dt className="flex flex-none items-center gap-1 pt-px text-phx-2xs font-bold uppercase tracking-wide text-slate-400">
                          <Phone aria-hidden="true" className="h-3 w-3" />
                          Phone
                        </dt>
                        <dd className="min-w-0">
                          <Proposed confidence={row.proposal.phone.confidence} value={row.proposal.phone.value} />
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                  <button
                    className={cn(acceptButtonClassName, "mt-2.5")}
                    disabled={busy !== null}
                    onClick={() => accept([row.candidateId], false, row.candidateId)}
                    type="button"
                  >
                    <Check aria-hidden="true" className="h-3.5 w-3.5" />
                    {busy === row.candidateId ? "Accepting…" : "Accept"}
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-2 hidden md:block">
              <table className="w-full table-fixed text-sm" data-portal-desktop-table>
                <colgroup>
                  <col className="w-[28%]" />
                  <col className="w-[32%]" />
                  <col className="w-[24%]" />
                  <col className="w-[16%]" />
                </colgroup>
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide">
                    <th className="px-4 py-2.5 font-bold">Candidate</th>
                    <th className="px-4 py-2.5 font-bold">Email found</th>
                    <th className="px-4 py-2.5 font-bold">Phone found</th>
                    <th className="px-4 py-2.5">
                      <span className="sr-only">Accept</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      className="border-t border-slate-100 align-top transition-colors hover:bg-slate-50/70"
                      key={row.candidateId}
                    >
                      <td className="px-4 py-3">
                        <span className="block break-words font-bold text-slate-900" dir="auto">
                          {row.name}
                        </span>
                        {/* Source and Received were two columns of their own; they sit under the name
                            now, which is how the table fits without a sideways scroll. */}
                        <span className="mt-0.5 block break-words text-xs text-slate-500">
                          {sourceLabel(row.source)} · Received {cairoDate(row.createdAt)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <Proposed
                          confidence={row.proposal.email?.confidence ?? "high"}
                          value={row.proposal.email?.value ?? null}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <Proposed
                          confidence={row.proposal.phone?.confidence ?? "high"}
                          value={row.proposal.phone?.value ?? null}
                        />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          className={acceptButtonClassName}
                          disabled={busy !== null}
                          onClick={() => accept([row.candidateId], false, row.candidateId)}
                          type="button"
                        >
                          <Check aria-hidden="true" className="h-3.5 w-3.5" />
                          {busy === row.candidateId ? "Accepting…" : "Accept"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </RecruitmentPanel>
    </div>
  );
}
