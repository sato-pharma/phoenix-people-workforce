"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Loader2, RefreshCw, RotateCcw } from "lucide-react";

import { phxButtonGhostClassName, phxButtonPrimaryClassName, phxTextareaClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { CaseBriefingPanel } from "@/components/disputes/case-briefing-panel";
import { DisputeConversation } from "@/components/disputes/dispute-conversation";
import { DisputeDecisionPanel } from "@/components/disputes/dispute-decision-panel";
import {
  DISPUTE_CASE_KIND_LABELS,
  DISPUTE_CASE_STATE_LABELS,
  type DisputeCase,
  type DisputeCaseEvent,
  type DisputeCaseKind,
  type DisputeCaseState,
} from "@/lib/dispute-center/types.ts";

// THE DISPUTE CENTER — one screen over the three dispute modules, for both sides.
//
// Owner, 2026-10-09: "dispute closed dispute open but never disappeared from me or the employee
// side." So nothing is ever filtered out of this screen: the tabs sort by WHO IT IS WAITING ON, and
// "All" always holds every case either side has ever raised.
//
// The reviewer's view and the employee's view are the SAME component on purpose. Two screens would
// drift, and the one question that matters — who owes the next move — must read identically to both.

const TABS: { key: "waiting_me" | "waiting_them" | "reopen_requested" | "decided" | "all"; employee: string; reviewer: string }[] = [
  { employee: "Waiting for review", key: "waiting_me", reviewer: "Waiting for me" },
  { employee: "Waiting for you", key: "waiting_them", reviewer: "Waiting for the employee" },
  { employee: "Asked to look again", key: "reopen_requested", reviewer: "Reopen requests" },
  { employee: "Decided", key: "decided", reviewer: "Decided" },
  { employee: "All", key: "all", reviewer: "All" },
];

const STATE_CHIP: Record<DisputeCaseState, string> = {
  decided: "border-slate-300 bg-slate-100 text-slate-600",
  needs_attention: "border-rose-300 bg-rose-50 text-rose-800",
  reopen_requested: "border-amber-300 bg-amber-50 text-amber-800",
  waiting_employee: "border-sky-300 bg-sky-50 text-sky-800",
  waiting_reviewer: "border-orange-300 bg-orange-50 text-orange-800",
};

const EVENT_WORDS: Record<DisputeCaseEvent["eventType"], string> = {
  decided: "Decided",
  decision_interrupted: "Decision stopped half-way — needs attention",
  refund_cancelled: "Money back cancelled",
  refund_recommended: "Money back recommended",
  reopen_declined: "Reopen declined — the decision stands",
  reopen_requested: "Asked for another look",
  reopened: "Reopened",
};

function tabOf(dispute: DisputeCase, audience: "employee" | "reviewer"): string[] {
  const keys = ["all"];
  if (dispute.state === "reopen_requested") keys.push("reopen_requested");
  else if (dispute.state === "decided") keys.push("decided");
  else if (dispute.state === "waiting_reviewer" || dispute.state === "needs_attention") keys.push(audience === "reviewer" ? "waiting_me" : "waiting_them");
  else keys.push(audience === "reviewer" ? "waiting_them" : "waiting_me");
  return keys;
}

function CaseRow({
  active,
  audience,
  dispute,
  onPick,
}: {
  active: boolean;
  audience: "employee" | "reviewer";
  dispute: DisputeCase;
  onPick: () => void;
}) {
  return (
    <li>
      <button
        className={`block w-full border-l-2 px-3 py-2.5 text-left transition ${
          active ? "border-l-orange-500 bg-orange-50" : "border-l-transparent hover:bg-slate-50"
        }`}
        onClick={onPick}
        type="button"
      >
        <p className="flex flex-wrap items-center gap-1.5">
          <span className="text-phx-xs font-black uppercase tracking-wide text-slate-400">
            {DISPUTE_CASE_KIND_LABELS[dispute.kind]}
          </span>
          <span className={`border px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide ${STATE_CHIP[dispute.state]}`}>
            {DISPUTE_CASE_STATE_LABELS[dispute.state]}
          </span>
        </p>
        <p className="mt-1 break-words text-sm font-bold text-slate-900">{dispute.title}</p>
        {audience === "reviewer" ? <p className="break-words text-xs text-slate-600">{dispute.employeeName}</p> : null}
        <p className="mt-0.5 text-xs text-slate-400">{cairoDateTime(dispute.lastActivityAt)}</p>
      </button>
    </li>
  );
}

function Facts({ dispute }: { dispute: DisputeCase }) {
  if (dispute.facts.length === 0 && !dispute.factsIncomplete) return null;
  return (
    <section className="@container border border-slate-200 bg-white">
      <h3 className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-phx-xs font-black uppercase tracking-wide text-slate-600">
        What the records show
      </h3>
      <dl className="divide-y divide-slate-100">
        {dispute.facts.map((fact) => (
          <div
            className="grid grid-cols-1 gap-0.5 px-4 py-2 @min-[480px]:grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)] @min-[480px]:gap-3"
            key={`${fact.label}-${fact.value}`}
          >
            <dt className="text-phx-xs font-black uppercase tracking-wide text-slate-500">{fact.label}</dt>
            <dd
              className={`min-w-0 break-words text-sm ${
                fact.tone === "danger"
                  ? "font-bold text-rose-700"
                  : fact.tone === "warning"
                    ? "font-bold text-amber-700"
                    : fact.tone === "success"
                      ? "font-bold text-emerald-700"
                      : "text-slate-800"
              }`}
            >
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
      {dispute.factsIncomplete ? (
        <p className="flex items-start gap-2 border-t border-slate-200 bg-amber-50 px-4 py-2 text-xs font-bold text-amber-800">
          <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Part of the record could not be read. Treat anything missing here as unknown, not as nothing.
        </p>
      ) : null}
    </section>
  );
}

function History({ dispute }: { dispute: DisputeCase }) {
  if (dispute.events.length === 0 && dispute.refunds.length === 0) return null;
  return (
    <section className="border border-slate-200 bg-white">
      <h3 className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-phx-xs font-black uppercase tracking-wide text-slate-600">
        History
      </h3>
      <ol className="divide-y divide-slate-100">
        {dispute.events.map((event) => (
          <li className="px-4 py-2" key={event.id}>
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-bold text-slate-900">{EVENT_WORDS[event.eventType]}</span>
              <span className="text-xs text-slate-400">{cairoDateTime(event.createdAt)}</span>
              {event.actorName ? <span className="text-xs text-slate-500">{event.actorName}</span> : null}
            </p>
            {event.note ? <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-slate-600">{event.note}</p> : null}
          </li>
        ))}
        {dispute.refunds.map((refund) => (
          <li className="px-4 py-2" key={refund.id}>
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-bold text-slate-900">
                {refund.status === "cancelled" ? "Money back cancelled" : "Money back recommended"}
              </span>
              <span className="text-xs text-slate-400">{cairoDateTime(refund.createdAt)}</span>
            </p>
            <p className="mt-0.5 break-words text-xs text-slate-600">{refund.reason}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ReopenRequest({ dispute, onDone }: { dispute: DisputeCase; onDone: () => void | Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  if (dispute.state === "reopen_requested") {
    return (
      <section className="border border-amber-200 bg-amber-50 p-4">
        <p className="text-sm font-bold text-amber-900">You asked for this to be looked at again.</p>
        <p className="mt-1 text-xs text-amber-800">
          It is with the reviewer now. There is no deadline — you will be told here when it is answered.
        </p>
      </section>
    );
  }
  if (dispute.state !== "decided") return null;

  return (
    <section className="border border-slate-200 bg-white">
      <h3 className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-phx-xs font-black uppercase tracking-wide text-slate-600">
        Ask for another look
      </h3>
      <div className="space-y-3 p-4">
        {sent ? (
          <p className="text-sm font-bold text-emerald-700">Sent. The reviewer decides whether to reopen it.</p>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-slate-500">
              This case is decided. Say what is new or what was missed, and the reviewer decides whether to open it again.
            </p>
            <textarea
              className={phxTextareaClassName}
              disabled={busy}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What should be looked at again, and why?"
              rows={3}
              value={note}
            />
            {error ? <p className="text-xs font-bold text-rose-700">{error}</p> : null}
            <button
              className={phxButtonPrimaryClassName}
              disabled={busy || !note.trim()}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const response = await fetch(
                    `/api/dispute-center/cases/${dispute.kind}/${encodeURIComponent(dispute.ref)}/reopen`,
                    {
                      body: JSON.stringify({ action: "request", note }),
                      headers: { "Content-Type": "application/json" },
                      method: "POST",
                    },
                  );
                  const payload = (await response.json().catch(() => ({}))) as { message?: string; success?: boolean };
                  if (!response.ok || payload.success !== true) throw new Error(payload.message || "That was not sent.");
                  setSent(true);
                  setNote("");
                  await onDone();
                } catch (requestError) {
                  setError(requestError instanceof Error ? requestError.message : "That was not sent.");
                } finally {
                  setBusy(false);
                }
              }}
              type="button"
            >
              <RotateCcw aria-hidden className="h-4 w-4" />
              {busy ? "Sending…" : "Ask for another look"}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

export function DisputeCenterWorkspace({
  audience,
  canAssist = false,
  initialCaseRef = null,
  initialKind = null,
  kinds,
}: {
  audience: "employee" | "reviewer";
  canAssist?: boolean;
  initialCaseRef?: string | null;
  initialKind?: DisputeCaseKind | null;
  kinds?: DisputeCaseKind[];
}) {
  const [cases, setCases] = useState<DisputeCase[]>([]);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<string>("all");
  const [selected, setSelected] = useState<{ kind: DisputeCaseKind; ref: string } | null>(
    initialKind && initialCaseRef ? { kind: initialKind, ref: initialCaseRef } : null,
  );
  const [open, setOpen] = useState<DisputeCase | null>(null);
  const [openBusy, setOpenBusy] = useState(false);

  const query = useMemo(() => (kinds && kinds.length > 0 ? `?${kinds.map((kind) => `kind=${kind}`).join("&")}` : ""), [kinds]);

  const loadList = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/dispute-center/cases${query}`);
      const payload = (await response.json().catch(() => ({}))) as {
        cases?: DisputeCase[];
        message?: string;
        success?: boolean;
        unavailable?: string[];
      };
      if (!response.ok || payload.success !== true) throw new Error(payload.message || "The disputes could not be loaded.");
      setCases(payload.cases ?? []);
      setUnavailable(payload.unavailable ?? []);
    } catch (listError) {
      setError(listError instanceof Error ? listError.message : "The disputes could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [query]);

  const loadCase = useCallback(async (kind: DisputeCaseKind, ref: string) => {
    setOpenBusy(true);
    try {
      const response = await fetch(`/api/dispute-center/cases/${kind}/${encodeURIComponent(ref)}`);
      const payload = (await response.json().catch(() => ({}))) as { case?: DisputeCase; message?: string; success?: boolean };
      if (!response.ok || payload.success !== true || !payload.case) {
        throw new Error(payload.message || "This dispute could not be opened.");
      }
      setOpen(payload.case);
    } catch (caseError) {
      setError(caseError instanceof Error ? caseError.message : "This dispute could not be opened.");
      setOpen(null);
    } finally {
      setOpenBusy(false);
    }
  }, []);

  useEffect(() => {
    // The first load, and a reload when the kind filter changes. Both setters run inside the
    // promise, after the fetch, but the rule reads the synchronous call itself.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadList();
  }, [loadList]);

  useEffect(() => {
    // Nothing is cleared here when the selection goes away: the panel renders on `selected`, so a
    // stale case can never be shown, and clearing it in the effect body is the cascading render
    // react-hooks/set-state-in-effect exists to refuse.
    if (!selected) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCase(selected.kind, selected.ref);
  }, [loadCase, selected]);

  const refreshBoth = useCallback(async () => {
    await loadList();
    if (selected) await loadCase(selected.kind, selected.ref);
  }, [loadCase, loadList, selected]);

  const counts = useMemo(() => {
    const tally = new Map<string, number>();
    for (const dispute of cases) {
      for (const key of tabOf(dispute, audience)) tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    return tally;
  }, [audience, cases]);

  const visible = useMemo(() => cases.filter((dispute) => tabOf(dispute, audience).includes(tab)), [audience, cases, tab]);

  // The case on screen is the one that was PICKED, never the one still in state from the last pick:
  // while a new case loads, the old one must not be read as it, and a reader deciding somebody pay
  // must never answer the wrong case.
  const current = open && selected && open.kind === selected.kind && open.ref === selected.ref ? open : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((entry) => (
          <button
            className={`border px-3 py-1.5 text-xs font-black uppercase tracking-wide transition ${
              tab === entry.key
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"
            }`}
            key={entry.key}
            onClick={() => setTab(entry.key)}
            type="button"
          >
            {audience === "reviewer" ? entry.reviewer : entry.employee}
            <span className={`ml-2 font-bold ${tab === entry.key ? "text-white/70" : "text-slate-400"}`}>
              {counts.get(entry.key) ?? 0}
            </span>
          </button>
        ))}
        <button className={cn(phxButtonGhostClassName, "ml-auto")} disabled={loading} onClick={() => void refreshBoth()} type="button">
          <RefreshCw aria-hidden className="h-4 w-4" />
          Reload
        </button>
      </div>

      {unavailable.length > 0 ? (
        <p className="flex items-start gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
          <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {unavailable.map((kind) => DISPUTE_CASE_KIND_LABELS[kind as DisputeCaseKind] ?? kind).join(", ")} could not be read just
          now, so this list is incomplete.
        </p>
      ) : null}
      {error ? <p className="border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{error}</p> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className={`border border-slate-200 bg-white ${selected ? "hidden lg:block" : ""}`}>
          {loading ? (
            <p className="flex items-center gap-2 px-4 py-6 text-sm text-slate-500">
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              Loading the disputes…
            </p>
          ) : visible.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">Nothing in this tab.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {visible.map((dispute) => (
                <CaseRow
                  active={selected?.kind === dispute.kind && selected?.ref === dispute.ref}
                  audience={audience}
                  dispute={dispute}
                  key={`${dispute.kind}-${dispute.ref}`}
                  onPick={() => setSelected({ kind: dispute.kind, ref: dispute.ref })}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          {!selected ? (
            <p className="border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
              Pick a dispute to read it. Nothing is ever removed from this screen — a decided case stays here for both sides.
            </p>
          ) : openBusy && !current ? (
            <p className="flex items-center gap-2 border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              Opening…
            </p>
          ) : current ? (
            <>
              <div className="@container flex flex-wrap items-start gap-2 border border-slate-200 bg-white p-4">
                <button
                  className={cn(phxButtonGhostClassName, "lg:hidden")}
                  onClick={() => {
                    setSelected(null);
                    setOpen(null);
                  }}
                  type="button"
                >
                  <ArrowLeft aria-hidden className="h-4 w-4" />
                  Back
                </button>
                <div className="min-w-0 basis-full @min-[480px]:flex-1 @min-[480px]:basis-auto">
                  <p className="text-phx-xs font-black uppercase tracking-wide text-slate-400">
                    {DISPUTE_CASE_KIND_LABELS[current.kind]}
                  </p>
                  <h2 className="break-words text-lg font-black text-slate-900">{current.title}</h2>
                  <p className="break-words text-sm text-slate-600">{current.employeeName}</p>
                </div>
                <span
                  className={`border px-2 py-1 text-[10px] font-black uppercase tracking-wide ${STATE_CHIP[current.state]}`}
                >
                  {DISPUTE_CASE_STATE_LABELS[current.state]}
                </span>
              </div>

              <Facts dispute={current} />
              {canAssist && current.viewer.isReviewer ? <CaseBriefingPanel dispute={current} /> : null}
              <DisputeConversation dispute={current} onSent={refreshBoth} />
              {current.viewer.isReviewer ? <DisputeDecisionPanel dispute={current} onDone={refreshBoth} /> : null}
              {current.viewer.isOwner && !current.viewer.isReviewer ? <ReopenRequest dispute={current} onDone={refreshBoth} /> : null}
              <History dispute={current} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
