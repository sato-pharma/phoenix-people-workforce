"use client";

import { useState } from "react";

import type { InboundIntakeAnalytics } from "@/lib/recruitment/inbound/intake-analytics";
import type { DeadLetteredInboundRow } from "@/lib/recruitment/inbound/intake-queue";

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-2xl font-semibold text-slate-900">{value}</div>
      <div className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      {hint ? <div className="mt-1 text-xs text-slate-400">{hint}</div> : null}
    </div>
  );
}

function channelLabel(channel: string): string {
  return channel === "whatsapp" ? "WhatsApp" : channel === "email" ? "Email" : channel;
}

function outcomeLabel(outcome: string): string {
  return outcome
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function IntakeHealthView({
  analytics,
  deadLetters: initialDeadLetters,
}: {
  analytics: InboundIntakeAnalytics;
  deadLetters: DeadLetteredInboundRow[];
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

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Messages" value={String(analytics.total)} hint={`last ${analytics.windowDays} days`} />
        <StatTile label="Candidates" value={String(analytics.candidatesCreated + analytics.candidatesMatched)} hint={`${analytics.candidatesCreated} new · ${analytics.candidatesMatched} matched`} />
        <StatTile label="Capture rate" value={successRate} hint="of CV-bearing messages" />
        <StatTile label="Dead-lettered" value={String(analytics.deadLettered)} hint="need manual retry" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">By channel</h2>
          {analytics.byChannel.length === 0 ? (
            <p className="text-sm text-slate-500">No inbound messages in this window.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="pb-2 font-medium">Channel</th>
                  <th className="pb-2 text-right font-medium">Total</th>
                  <th className="pb-2 text-right font-medium">Candidates</th>
                  <th className="pb-2 text-right font-medium">Errors</th>
                </tr>
              </thead>
              <tbody>
                {analytics.byChannel.map((c) => (
                  <tr key={c.channel} className="border-t border-slate-100">
                    <td className="py-2 text-slate-700">{channelLabel(c.channel)}</td>
                    <td className="py-2 text-right tabular-nums text-slate-700">{c.total}</td>
                    <td className="py-2 text-right tabular-nums text-slate-700">{c.candidates}</td>
                    <td className="py-2 text-right tabular-nums text-slate-700">{c.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">By outcome</h2>
          {analytics.byOutcome.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing to show yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {analytics.byOutcome.map((o) => (
                <li key={o.outcome} className="flex items-center justify-between text-sm">
                  <span className="text-slate-700">{outcomeLabel(o.outcome)}</span>
                  <span className="tabular-nums text-slate-500">{o.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-semibold text-slate-900">Dead-lettered CVs</h2>
        <p className="mb-3 text-xs text-slate-500">
          Inbound CVs the pipeline could not process after retries. Retry re-queues one for the worker to try again.
        </p>
        {error ? <p className="mb-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p> : null}
        {deadLetters.length === 0 ? (
          // Zero dead letters means one of two opposite things, and this page used to render the
          // celebratory one unconditionally: during the 2026-08-01 WhatsApp outage the webhook
          // 500'd before reading the body, so NOTHING was ever enqueued, no failure was recorded,
          // and the page reported a perfect score throughout a total outage. No inbound at all is
          // a warning, not a win.
          analytics.total === 0 ? (
            <p className="text-sm text-amber-700">
              No inbound messages arrived in the last {analytics.windowDays} days, so there is
              nothing to have failed. That is not the same as healthy — if candidates are known to
              be sending CVs, check the WhatsApp and mailbox intake configuration.
            </p>
          ) : (
            <p className="text-sm text-slate-500">None — every inbound CV was processed. 🎉</p>
          )
        ) : (
          <ul className="divide-y divide-slate-100">
            {deadLetters.map((row) => (
              <li key={row.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800">
                    {channelLabel(row.channel)} · <span className="font-normal text-slate-500">{row.provider_message_id}</span>
                  </div>
                  {row.last_error ? <div className="mt-0.5 truncate text-xs text-slate-500">{row.last_error}</div> : null}
                </div>
                <button
                  className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  disabled={Boolean(retrying[row.id])}
                  onClick={() => retry(row.id)}
                  type="button"
                >
                  {retrying[row.id] ? "Retrying…" : "Retry"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
