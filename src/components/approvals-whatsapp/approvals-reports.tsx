"use client";

// Approvals WhatsApp — the Reports tab: every bulk send, and for each one every recipient by name with sent,
// delivered, read, failed or replied and the Cairo time of each, with the totals on top.
//
// The ticks come from the messages table (Meta's status updates, matched by wamid); a reply is any message from that
// number after the send. A send that is still going fills in on its own: the open report re-reads every ten seconds
// while the tab is visible.

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, RotateCcw } from "lucide-react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import { getJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { humanizeCode } from "@/lib/format/code-label";
import { cn } from "@/lib/utils";

import { APPROVALS_API, Figure, Notice, Panel } from "./approvals-shared";

export type ApprovalsBroadcastView = {
  id: string;
  templateName: string;
  templateLanguage: string;
  status: string;
  listName: string | null;
  recipientCount: number;
  acceptedCount: number;
  failedCount: number;
  pendingCount: number;
  createdAt: string;
  createdByName: string | null;
};

type Outcome = "pending" | "failed" | "sent" | "delivered" | "read" | "replied";

type ReportRow = {
  waId: string;
  phone: string | null;
  name: string;
  outcome: Outcome;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  repliedAt: string | null;
  failureDetail: string | null;
};

type Report = {
  broadcast: { id: string; templateName: string; status: string; recipientCount: number; createdAt: string; bodyPreview: string | null };
  rows: ReportRow[];
  totals: Record<Outcome, number>;
};

const OUTCOME_LABEL: Record<Outcome, string> = {
  delivered: "Delivered",
  failed: "Failed",
  pending: "Not sent yet",
  read: "Read",
  replied: "Replied",
  sent: "Sent",
};

const STATUS_LABEL: Record<string, string> = { done: "Finished", queued: "Waiting to start", sending: "Sending", stopped: "Stopped" };

function OutcomeMark({ outcome }: { outcome: Outcome }) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center border px-1.5 py-0.5 text-[11px] font-bold leading-none",
        outcome === "failed"
          ? "border-phx-danger-line bg-phx-danger-bg text-phx-danger"
          : outcome === "replied" || outcome === "read"
            ? "border-phx-info-line bg-phx-info-bg text-phx-info"
            : outcome === "pending"
              ? "border-phx-line bg-phx-surface-2 text-phx-ink-soft"
              : "border-phx-line bg-white text-phx-ink-2",
      )}
    >
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}

function when(iso: string | null): string {
  return iso ? cairoDateTime(iso) : "";
}

export function ApprovalsReports({
  broadcasts,
  initialOpenId,
  onChanged,
}: {
  broadcasts: ApprovalsBroadcastView[];
  initialOpenId: string | null;
  onChanged: () => Promise<void>;
}) {
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    try {
      const data = (await getJson(`${APPROVALS_API}/broadcasts/${id}`)) as unknown as Report;
      setReport(data);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The report could not be read.");
    }
  }, []);

  function openReport(id: string | null) {
    setReport(null);
    setNotice(null);
    setOpenId(id);
  }

  // The report is read when it opens and every 10 seconds while the tab is in view. Every setState in `load` runs after
  // its awaited fetch, never in this effect's own body.
  useEffect(() => {
    if (!openId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState in load() runs after the awaited fetch
    void load(openId);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(openId);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [load, openId]);

  async function resume(id: string) {
    setBusy(true);
    setNotice(null);
    try {
      const data = await postJson(`${APPROVALS_API}/broadcasts/${id}/resume`, {});
      setNotice(`Sending to the ${typeof data.pending === "number" ? data.pending : ""} people not yet tried.`);
      await Promise.all([load(id), onChanged()]);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "The send could not be resumed.");
    } finally {
      setBusy(false);
    }
  }

  if (openId) {
    const pending = report?.totals.pending ?? 0;
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Action onClick={() => openReport(null)} tone="ghost">
            <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
            Every send
          </Action>
          {report ? (
            <span className="text-[13px] font-bold text-phx-ink">
              {humanizeCode(report.broadcast.templateName)} · {cairoDateTime(report.broadcast.createdAt)} · {STATUS_LABEL[report.broadcast.status] ?? humanizeCode(report.broadcast.status)}
            </span>
          ) : null}
        </div>
        {error ? <Notice tone="warn">{error}</Notice> : null}
        {!report && !error ? <p className="text-[12px] text-phx-ink-soft">Reading the report</p> : null}
        {report ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Figure label="Recipients" value={report.broadcast.recipientCount} />
              <Figure label="Sent" value={report.totals.sent} />
              <Figure label="Delivered" value={report.totals.delivered} />
              <Figure label="Read" value={report.totals.read} />
              <Figure label="Replied" value={report.totals.replied} />
              <Figure label="Failed" tone={report.totals.failed > 0 ? "bad" : "plain"} value={report.totals.failed} />
              <Figure label="Not sent yet" tone={pending > 0 ? "warn" : "plain"} value={pending} />
            </div>
            {pending > 0 && report.broadcast.status !== "sending" ? (
              <div className="flex flex-wrap items-center gap-2">
                <Notice tone="warn">This send stopped before everyone was tried. Resume sends to the rest; nobody is sent twice.</Notice>
                <Action disabled={busy} onClick={() => void resume(report.broadcast.id)} tone="primary">
                  <RotateCcw aria-hidden className="h-3.5 w-3.5" />
                  Resume
                </Action>
              </div>
            ) : null}
            {notice ? <Notice>{notice}</Notice> : null}
            {report.broadcast.bodyPreview ? (
              <p className="whitespace-pre-wrap break-words border border-phx-line bg-phx-surface-2 p-3 text-[13px] leading-relaxed text-phx-ink" dir="auto">
                {report.broadcast.bodyPreview}
              </p>
            ) : null}

            {/* Desktop: the full table. Phone: one card per person. Neither scrolls sideways. */}
            <table className="hidden w-full table-fixed border border-phx-line text-left text-[12px] md:table">
              <colgroup>
                <col className="w-[26%]" />
                <col className="w-[12%]" />
                <col className="w-[15%]" />
                <col className="w-[15%]" />
                <col className="w-[15%]" />
                <col className="w-[17%]" />
              </colgroup>
              <thead className="bg-phx-surface-2 text-[10px] font-black uppercase tracking-[0.12em] text-phx-ink-soft">
                <tr>
                  <th className="px-2.5 py-2">Person</th>
                  <th className="px-2.5 py-2">Now</th>
                  <th className="px-2.5 py-2">Sent</th>
                  <th className="px-2.5 py-2">Delivered</th>
                  <th className="px-2.5 py-2">Read</th>
                  <th className="px-2.5 py-2">Replied or failed</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr className="border-t border-phx-line align-top" key={row.waId}>
                    <td className="px-2.5 py-2">
                      <span className="block break-words font-bold text-phx-ink" dir="auto">
                        {row.name}
                      </span>
                      <span className="block tabular-nums text-phx-ink-soft" dir="ltr">
                        {row.phone}
                      </span>
                    </td>
                    <td className="px-2.5 py-2">
                      <OutcomeMark outcome={row.outcome} />
                    </td>
                    <td className="px-2.5 py-2 tabular-nums">{when(row.sentAt)}</td>
                    <td className="px-2.5 py-2 tabular-nums">{when(row.deliveredAt)}</td>
                    <td className="px-2.5 py-2 tabular-nums">{when(row.readAt)}</td>
                    <td className="px-2.5 py-2">
                      {row.repliedAt ? <span className="tabular-nums">Replied {when(row.repliedAt)}</span> : null}
                      {row.outcome === "failed" ? (
                        <span className="block break-words text-phx-danger">
                          {row.failedAt ? `${when(row.failedAt)}: ` : ""}
                          {row.failureDetail ?? "Meta gave no reason."}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="flex flex-col border border-phx-line md:hidden">
              {report.rows.map((row) => (
                <li className="flex flex-col gap-1.5 border-b border-phx-line p-3 last:border-b-0" key={row.waId}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="break-words text-[13px] font-bold text-phx-ink" dir="auto">
                      {row.name}
                    </span>
                    <OutcomeMark outcome={row.outcome} />
                  </div>
                  <span className="text-[11px] tabular-nums text-phx-ink-soft" dir="ltr">
                    {row.phone}
                  </span>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                    {row.sentAt ? (
                      <>
                        <dt className="text-phx-ink-soft">Sent</dt>
                        <dd className="tabular-nums text-phx-ink">{when(row.sentAt)}</dd>
                      </>
                    ) : null}
                    {row.deliveredAt ? (
                      <>
                        <dt className="text-phx-ink-soft">Delivered</dt>
                        <dd className="tabular-nums text-phx-ink">{when(row.deliveredAt)}</dd>
                      </>
                    ) : null}
                    {row.readAt ? (
                      <>
                        <dt className="text-phx-ink-soft">Read</dt>
                        <dd className="tabular-nums text-phx-ink">{when(row.readAt)}</dd>
                      </>
                    ) : null}
                    {row.repliedAt ? (
                      <>
                        <dt className="text-phx-ink-soft">Replied</dt>
                        <dd className="tabular-nums text-phx-ink">{when(row.repliedAt)}</dd>
                      </>
                    ) : null}
                  </dl>
                  {row.outcome === "failed" ? <p className="break-words text-[12px] text-phx-danger">{row.failureDetail ?? "Meta gave no reason."}</p> : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <Panel title="Every bulk send">
      {broadcasts.length === 0 ? <p className="text-[12px] text-phx-ink-soft">No bulk send yet. Each one you start appears here with a report per person.</p> : null}
      <ul className="flex flex-col">
        {broadcasts.map((broadcast) => (
          <li className="border-b border-phx-line last:border-b-0" key={broadcast.id}>
            <button className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-left hover:bg-phx-paper" onClick={() => openReport(broadcast.id)} type="button">
              <span className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
                <span className="break-words text-[13px] font-bold text-phx-ink">{humanizeCode(broadcast.templateName)}</span>
                <span className="break-words text-[11px] text-phx-ink-soft">
                  {cairoDateTime(broadcast.createdAt)}
                  {broadcast.createdByName ? ` · by ${broadcast.createdByName}` : ""}
                  {broadcast.listName ? ` · list ${broadcast.listName}` : ""}
                </span>
              </span>
              <span className="flex flex-wrap gap-x-3 text-[12px] tabular-nums text-phx-ink-2">
                <span>{broadcast.recipientCount} people</span>
                <span>{broadcast.acceptedCount} sent</span>
                {broadcast.failedCount > 0 ? <span className="text-phx-danger">{broadcast.failedCount} failed</span> : null}
                {broadcast.pendingCount > 0 ? <span className="text-phx-warn">{broadcast.pendingCount} not sent yet</span> : null}
                <span className="font-bold">{STATUS_LABEL[broadcast.status] ?? humanizeCode(broadcast.status)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
