"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Gauge,
  Inbox,
  Layers,
  Loader2,
  PauseCircle,
  RotateCw,
  ShieldAlert,
  Users,
  Waypoints,
} from "lucide-react";

import type { HeldBackIntakeRow, InboundIntakeAnalytics } from "@/lib/recruitment/inbound/intake-analytics";
import type { DeadLetteredInboundRow } from "@/lib/recruitment/inbound/intake-queue";
import { humanizeCode } from "@/lib/format/code-label";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { adminControlDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  RecruitmentEmptyState,
  RecruitmentKpiStrip,
  RecruitmentPanel,
  RecruitmentPill,
} from "@/components/recruitment/recruitment-premium";

// THE LOOK (owner, 2026-10-19, the full-module premium sweep): the four headline counts are the
// module's KPI strip, and each section is a panel under the house dark band. Desktop shows the channel
// table, a phone shows one card per channel, and nothing on either can push the page sideways.

function channelLabel(channel: string): string {
  return channel === "whatsapp" ? "WhatsApp" : channel === "email" ? "Email" : channel;
}

function outcomeLabel(outcome: string): string {
  return humanizeCode(outcome) || "—";
}

function inboxLabel(channel: string, mailboxLabel: string | null): string {
  if (channel === "whatsapp") return "WhatsApp";
  return mailboxLabel ? `${mailboxLabel} inbox` : "Email";
}

// Every moment this module shows a person is Cairo local time, never a raw UTC string. Written
// here, matching recruitment-workspace.tsx, rather than imported across a domain boundary — the
// same convention request-report-columns.ts states for its own copy.
function cairoDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";
  const date = formatStableEnGb(value, {
    day: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
  const time = value.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone: "Africa/Cairo",
  });
  return `${date}, ${time}`;
}

export function IntakeHealthView({
  analytics,
  deadLetters: initialDeadLetters,
  heldBack,
}: {
  analytics: InboundIntakeAnalytics;
  deadLetters: DeadLetteredInboundRow[];
  heldBack: HeldBackIntakeRow[];
}) {
  const [deadLetters, setDeadLetters] = useState(initialDeadLetters);
  const [retrying, setRetrying] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  async function retry(id: string) {
    setError(null);
    setRetrying((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await fetch("/api/recruitment/intake/retry", {
        body: JSON.stringify({ id }),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(body.message || "Retry failed.");
      // Re-queued — drop it from the dead-letter list; the worker will pick it up on the next tick.
      setDeadLetters((prev) => prev.filter((row) => row.id !== id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Retry failed.");
    } finally {
      setRetrying((prev) => ({ ...prev, [id]: false }));
    }
  }

  const successRate = analytics.successRatePct === null ? "—" : `${analytics.successRatePct}%`;
  // The largest outcome sets the scale of the little bars beside each one, so the biggest reads full.
  const largestOutcome = analytics.byOutcome.reduce((max, o) => Math.max(max, o.count), 0);

  return (
    <div className="space-y-5">
      <RecruitmentKpiStrip
        items={[
          {
            description: `last ${analytics.windowDays} days`,
            icon: <Inbox aria-hidden="true" className="h-4 w-4" />,
            label: "Messages",
            tone: "blue",
            value: <span className="tabular-nums">{String(analytics.total)}</span>,
          },
          {
            description: `${analytics.candidatesCreated} new · ${analytics.candidatesMatched} matched`,
            icon: <Users aria-hidden="true" className="h-4 w-4" />,
            label: "Candidates",
            tone: "emerald",
            value: (
              <span className="tabular-nums">{String(analytics.candidatesCreated + analytics.candidatesMatched)}</span>
            ),
          },
          {
            description: "of CV-bearing messages",
            icon: <Gauge aria-hidden="true" className="h-4 w-4" />,
            label: "Capture rate",
            tone: "orange",
            value: <span className="tabular-nums">{successRate}</span>,
          },
          {
            description: "need manual retry",
            icon: <AlertTriangle aria-hidden="true" className="h-4 w-4" />,
            label: "Dead-lettered",
            tone: "rose",
            value: <span className="tabular-nums">{String(analytics.deadLettered)}</span>,
          },
        ]}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <RecruitmentPanel
          count={analytics.byChannel.length}
          icon={<Waypoints aria-hidden="true" className="h-4 w-4" />}
          title="By channel"
        >
          {analytics.byChannel.length === 0 ? (
            <RecruitmentEmptyState
              icon={<Inbox aria-hidden="true" className="h-5 w-5" />}
              message="No inbound messages in this window."
              title="Nothing arrived"
            />
          ) : (
            <>
              {/* Phone: one block per channel, each number carrying its own label. Four
                  columns fit a 375px screen only by dropping the headers off the top as
                  you scroll the numbers — and an unlabelled column of counts is the one
                  thing this panel must never show. Mirrors the "By outcome" list beside
                  it, which is already the right shape for a phone. */}
              <div className="divide-y divide-slate-100 md:hidden">
                {analytics.byChannel.map((c) => (
                  <div className="px-4 py-3" key={c.channel}>
                    <p className="text-sm font-black text-slate-900">{channelLabel(c.channel)}</p>
                    <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                      {[
                        ["Total", c.total, "text-slate-800"],
                        ["Candidates", c.candidates, "text-slate-800"],
                        ["Errors", c.errors, c.errors > 0 ? "text-rose-600" : "text-slate-800"],
                      ].map(([label, value, tone]) => (
                        <div className="flex items-baseline gap-1.5" key={String(label)}>
                          <dt className="text-phx-2xs font-bold uppercase tracking-wide text-slate-400">{label}</dt>
                          <dd className={`font-black tabular-nums ${tone}`}>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
              <table className="hidden w-full table-fixed text-sm md:table" data-portal-desktop-table>
                <colgroup>
                  <col className="w-[40%]" />
                  <col className="w-[20%]" />
                  <col className="w-[22%]" />
                  <col className="w-[18%]" />
                </colgroup>
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide">
                    <th className="px-4 py-2.5 font-bold">Channel</th>
                    <th className="px-4 py-2.5 text-right font-bold">Total</th>
                    <th className="px-4 py-2.5 text-right font-bold">Candidates</th>
                    <th className="px-4 py-2.5 text-right font-bold">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.byChannel.map((c) => (
                    <tr key={c.channel} className="border-t border-slate-100 transition-colors hover:bg-slate-50/70">
                      <td className="break-words px-4 py-2.5 font-semibold text-slate-800">{channelLabel(c.channel)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{c.total}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{c.candidates}</td>
                      <td
                        className={`px-4 py-2.5 text-right tabular-nums ${c.errors > 0 ? "font-bold text-rose-600" : "text-slate-700"}`}
                      >
                        {c.errors}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </RecruitmentPanel>

        <RecruitmentPanel
          count={analytics.byOutcome.length}
          icon={<Layers aria-hidden="true" className="h-4 w-4" />}
          title="By outcome"
        >
          {analytics.byOutcome.length === 0 ? (
            <RecruitmentEmptyState
              icon={<Layers aria-hidden="true" className="h-5 w-5" />}
              message="Nothing to show yet."
              title="No outcomes yet"
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {analytics.byOutcome.map((o) => (
                <li key={o.outcome} className="px-4 py-2.5">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 break-words font-semibold text-slate-800">{outcomeLabel(o.outcome)}</span>
                    <span className="font-black tabular-nums text-slate-900">{o.count}</span>
                  </div>
                  {/* The share of the largest outcome, so the eye finds the big ones without reading. */}
                  <div aria-hidden="true" className="mt-1.5 h-1 w-full bg-slate-100">
                    <div
                      className="h-1 bg-orange-500"
                      style={{ width: `${largestOutcome > 0 ? Math.max(2, Math.round((o.count / largestOutcome) * 100)) : 0}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </RecruitmentPanel>
      </div>

      {/* Every attachment the gate turned away, with the reason — because a filter nobody can see
          is how a real applicant disappears without anyone finding out. The stricter check on the
          general HR mailbox (src/lib/recruitment/inbound/inbox-cv-gate.ts) writes its reason onto
          the intake event, and this is the screen that reads it back. */}
      <RecruitmentPanel
        count={heldBack.length}
        description="Files that arrived but were not turned into a candidate, newest first. The general HR mailbox holds back anything that does not read like a CV; the careers address and WhatsApp do not. Nothing is deleted — the message is still in the mailbox."
        icon={<PauseCircle aria-hidden="true" className="h-4 w-4" />}
        title="Held back"
      >
        {heldBack.length === 0 ? (
          <RecruitmentEmptyState
            icon={<CheckCircle2 aria-hidden="true" className="h-5 w-5" />}
            message={`Nothing held back in the last ${analytics.windowDays} days.`}
            title="Nothing held back"
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {heldBack.map((row) => (
              <li className="px-4 py-3 sm:px-5" key={row.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <RecruitmentPill tone={row.channel === "whatsapp" ? "emerald" : "sky"}>
                    {inboxLabel(row.channel, row.mailboxLabel)}
                  </RecruitmentPill>
                  <span className="min-w-0 break-words text-sm font-bold text-slate-900" dir="auto">
                    {row.subject || "No subject"}
                  </span>
                </div>
                <div className="mt-1 break-words text-xs text-slate-500">
                  {[row.sender, cairoDateTime(row.createdAt)].filter(Boolean).join(" · ")}
                </div>
                {row.reason ? (
                  <div className="mt-1 break-words text-xs font-medium text-amber-800">{row.reason}</div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </RecruitmentPanel>

      <RecruitmentPanel
        count={deadLetters.length}
        description="Inbound CVs the pipeline could not process after retries. Retry re-queues one for the worker to try again."
        icon={<ShieldAlert aria-hidden="true" className="h-4 w-4" />}
        title="Dead-lettered CVs"
      >
        {error ? (
          <p className="mx-4 mt-4 border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 sm:mx-5" role="alert">
            {error}
          </p>
        ) : null}
        {deadLetters.length === 0 ? (
          // Zero dead letters means one of two opposite things, and this page used to render the
          // celebratory one unconditionally: during the 2026-08-01 WhatsApp outage the webhook
          // 500'd before reading the body, so NOTHING was ever enqueued, no failure was recorded,
          // and the page reported a perfect score throughout a total outage. No inbound at all is
          // a warning, not a win.
          analytics.total === 0 ? (
            <div className="p-4 sm:p-5">
              <div className={`flex items-start gap-3 border border-amber-300 bg-amber-50 px-4 py-3 ${adminSoftDepthClassName}`} role="status">
                <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 flex-none text-amber-600" />
                <p className="min-w-0 break-words text-sm text-amber-900">
                  No inbound messages arrived in the last {analytics.windowDays} days, so there is
                  nothing to have failed. That is not the same as healthy — if candidates are known to
                  be sending CVs, check the WhatsApp and mailbox intake configuration.
                </p>
              </div>
            </div>
          ) : (
            <RecruitmentEmptyState
              icon={<CheckCircle2 aria-hidden="true" className="h-5 w-5" />}
              message="None — every inbound CV was processed."
              title="Nothing dead-lettered"
            />
          )
        ) : (
          <ul className="divide-y divide-slate-100">
            {deadLetters.map((row) => (
              <li key={row.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
                <div className="min-w-0 grow basis-64">
                  <div className="flex flex-wrap items-center gap-2">
                    <RecruitmentPill tone="rose">{channelLabel(row.channel)}</RecruitmentPill>
                    <span className="min-w-0 break-all font-mono text-xs text-slate-500">{row.provider_message_id}</span>
                  </div>
                  {row.last_error ? (
                    <div className="mt-1 break-words text-xs text-slate-600">{row.last_error}</div>
                  ) : null}
                </div>
                <button
                  className={`inline-flex items-center gap-1.5 border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:border-orange-300 hover:text-orange-700 disabled:opacity-50 ${adminControlDepthClassName} disabled:shadow-none`}
                  disabled={Boolean(retrying[row.id])}
                  onClick={() => retry(row.id)}
                  type="button"
                >
                  {retrying[row.id] ? (
                    <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCw aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  {retrying[row.id] ? "Retrying…" : "Retry"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </RecruitmentPanel>
    </div>
  );
}
