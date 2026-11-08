"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  adminPanelClassName,
  adminPanelHeaderClassName,
  adminSoftPanelClassName,
} from "@/components/admin/admin-design-tokens";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxCheckInputClassName,
  phxFieldClassName,
  phxLabelClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { cairoDate, cairoDateTime, cairoMonthDayTime12h, utcDate } from "@/lib/format/cairo-datetime";
import {
  CEO_APPROVAL_LISTED_AS_LABEL,
  summarizeCeoApprovals,
  type CeoApprovalFinanceState,
  type CeoApprovalsRange,
  type MarketingCeoApprovalRow,
  type MarketingCeoApprovals,
} from "@/lib/marketing-requests/ceo-approvals";
import {
  APPROVED_REQUESTS_MAX_NOTE_CHARS,
  APPROVED_REQUESTS_MAX_ROWS,
  defaultMarkFor,
  type ApprovedRequestMark,
} from "@/lib/marketing-requests/ceo-approvals-email";

const money = (value: number): string => Math.round(value).toLocaleString("en-US");

/** "11:03 AM" — built from digits by the shared formatter, never asked of the browser. */
function cairoTime12h(iso: string | null | undefined): string {
  return cairoMonthDayTime12h(iso).split(", ").at(-1) ?? "-";
}

/** Only the paint is decided here; the state itself is `buildCeoApprovalRows`, pinned by a test. */
const FINANCE_TONE: Record<CeoApprovalFinanceState, string> = {
  closed_out: "bg-slate-100 text-slate-600",
  executed: "bg-emerald-50 text-emerald-800",
  held: "bg-amber-100 text-amber-800",
  waiting_finance: "bg-amber-50 text-amber-800",
  waiting_other: "bg-sky-50 text-sky-800",
};

function StatusCell({ row }: { row: MarketingCeoApprovalRow }) {
  return (
    <div className="min-w-0 space-y-1">
      <span className={`inline-block px-1.5 py-0.5 text-phx-xs font-black ${FINANCE_TONE[row.financeState]}`}>{row.statusLabel}</span>
      {row.financeState === "executed" ? (
        <p className="break-words text-phx-xs text-slate-600">
          Executed{row.executedByName ? ` by ${row.executedByName}` : ""}
          {row.executedAtIso ? ` · ${cairoDate(row.executedAtIso)}, ${cairoTime12h(row.executedAtIso)}` : ""}
        </p>
      ) : (
        <p className="break-words text-phx-xs text-slate-600">{row.financeLabel}</p>
      )}
    </div>
  );
}

function PayDateCell({ row }: { row: MarketingCeoApprovalRow }) {
  return (
    <div className="min-w-0">
      <p className="text-slate-700">{utcDate(row.payDate)}</p>
      {row.payDateOverdue ? <p className="text-phx-xs font-bold text-rose-700">Passed, not paid</p> : null}
    </div>
  );
}

function ApprovalCell({ row }: { row: MarketingCeoApprovalRow }) {
  return (
    <div className="min-w-0">
      <p className="font-semibold text-slate-800">{cairoDate(row.approvedAtIso)}</p>
      <p className="text-phx-xs text-slate-500">{cairoTime12h(row.approvedAtIso)}</p>
      {row.approvedOnBehalfBy ? <p className="break-words text-phx-xs text-slate-500">pressed by {row.approvedOnBehalfBy}</p> : null}
    </div>
  );
}

/**
 * Why the row is in this period (owner, 2026-11-08): approved inside the dates, or approved earlier and
 * still waiting for Finance — the difference his manual email never showed.
 */
const LISTED_AS_TONE = {
  approved_in_period: "bg-slate-900 text-white",
  carried_over: "bg-amber-100 text-amber-900",
} as const;

function ListedAsCell({ range, row }: { range: CeoApprovalsRange; row: MarketingCeoApprovalRow }) {
  return (
    <div className="min-w-0 space-y-1">
      <span className={`inline-block px-1.5 py-0.5 text-phx-xs font-black ${LISTED_AS_TONE[row.listedAs]}`}>
        {CEO_APPROVAL_LISTED_AS_LABEL[row.listedAs]}
      </span>
      {row.listedAs === "carried_over" ? (
        <p className="break-words text-phx-xs text-slate-600">Approved before {utcDate(range.from)}</p>
      ) : null}
    </div>
  );
}

function RequestCodeLink({ row }: { row: MarketingCeoApprovalRow }) {
  return (
    <Link className="break-all font-bold text-slate-900 hover:text-orange-700 hover:underline" href={row.href}>
      {row.requestCode}
    </Link>
  );
}

// ── The email's notes and marks ─────────────────────────────────────────────
//
// A note and a mark per request, kept in this browser so a half-written email survives a reload.
// Only the sender's convenience: the server re-reads every row, and what was SENT is in the audit log.

type RowDraft = { mark?: ApprovedRequestMark; note?: string };
const DRAFTS_KEY = "phx.marketing.ceoApprovals.emailDrafts.v1";

function readDrafts(): Record<string, RowDraft> {
  try {
    const raw = window.localStorage.getItem(DRAFTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, RowDraft>) : {};
  } catch {
    return {};
  }
}

function writeDrafts(drafts: Record<string, RowDraft>) {
  try {
    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // Private window or full storage: the notes still work, they just do not outlive the page.
  }
}

const MARK_LABEL: Record<ApprovedRequestMark, string> = {
  executed: "Executed (shows in red)",
  hold: "Finance hold",
  none: "No mark",
};

/** The colour his own email uses for the rows Finance already executed. */
const EXECUTED_RED = "text-[#B91C1C]";

function NotesCell({
  mark,
  note,
  onMark,
  onNote,
  row,
}: {
  mark: ApprovedRequestMark;
  note: string;
  onMark: (mark: ApprovedRequestMark) => void;
  onNote: (note: string) => void;
  row: MarketingCeoApprovalRow;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <textarea
        aria-label={`Note for ${row.requestCode}`}
        className={phxTextareaClassName}
        dir="auto"
        maxLength={APPROVED_REQUESTS_MAX_NOTE_CHARS}
        onChange={(event) => onNote(event.target.value)}
        placeholder="Note for the email"
        rows={2}
        value={note}
      />
      <select
        aria-label={`Mark for ${row.requestCode}`}
        className={phxSelectClassName}
        onChange={(event) => onMark(event.target.value as ApprovedRequestMark)}
        value={mark}
      >
        {(["none", "executed", "hold"] as const).map((value) => (
          <option key={value} value={value}>
            {MARK_LABEL[value]}
          </option>
        ))}
      </select>
    </div>
  );
}

type EmailPerson = { email: string; name: string };
type EmailPreview = {
  cc: EmailPerson[];
  holdNames: string[];
  redCount: number;
  rowCount: number;
  subject: string;
  to: EmailPerson[];
  totalValue: number;
  warnings: string[];
};
type EmailResult = EmailPreview & { sent: boolean; sentAtIso: string | null; skippedReason: string | null };

type SendState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "preview"; preview: EmailPreview }
  | { phase: "sending"; preview: EmailPreview }
  | { phase: "done"; result: EmailResult }
  | { phase: "error"; message: string };

function PeopleLine({ label, people }: { label: string; people: EmailPerson[] }) {
  return (
    <div className="min-w-0">
      <dt className="text-phx-xs font-bold uppercase tracking-wider text-slate-500">
        {label} · {people.length}
      </dt>
      <dd className="break-words text-phx-sm text-slate-800">
        {people.length ? people.map((person) => person.name).join(" · ") : "Nobody"}
      </dd>
    </div>
  );
}

function SendPanel({ onClose, onSend, state }: { onClose: () => void; onSend: () => void; state: SendState }) {
  if (state.phase === "idle") return null;
  if (state.phase === "checking") {
    return <div className={`${adminSoftPanelClassName} p-4 text-phx-sm text-slate-700`}>Working out who the email reaches</div>;
  }
  if (state.phase === "error") {
    return (
      <div className={`${adminSoftPanelClassName} flex flex-wrap items-center justify-between gap-3 p-4`}>
        <p className="min-w-0 break-words text-phx-sm font-bold text-rose-800">{state.message}</p>
        <button className={phxButtonGhostClassName} onClick={onClose} type="button">
          Close
        </button>
      </div>
    );
  }
  if (state.phase === "done") {
    const { result } = state;
    return (
      <div className={`${adminSoftPanelClassName} flex flex-wrap items-start justify-between gap-3 p-4`}>
        <div className="min-w-0 space-y-1">
          {result.sent ? (
            <>
              <p className="break-words text-phx-md font-bold text-emerald-800">
                Sent “{result.subject}” to {result.to.length + result.cc.length} people
                {result.sentAtIso ? ` at ${cairoDateTime(result.sentAtIso)} Cairo` : ""}
              </p>
              <p className="text-phx-sm text-slate-700">
                {result.rowCount} request{result.rowCount === 1 ? "" : "s"}, EGP {money(result.totalValue)}. Everyone on it
                also gets the same notice in Phoenix and on Telegram.
              </p>
            </>
          ) : (
            <p className="break-words text-phx-md font-bold text-rose-800">
              Not sent: {result.skippedReason ?? "the email service refused it"}
            </p>
          )}
        </div>
        <button className={phxButtonGhostClassName} onClick={onClose} type="button">
          Close
        </button>
      </div>
    );
  }

  const { preview } = state;
  const sending = state.phase === "sending";
  return (
    <section className={`${adminSoftPanelClassName} space-y-3 p-4`}>
      <div className="min-w-0">
        <p className="text-phx-xs font-bold uppercase tracking-wider text-slate-500">Subject</p>
        <p className="break-words text-phx-md font-bold text-slate-900">{preview.subject}</p>
        <p className="break-words text-phx-sm text-slate-600">
          {preview.rowCount} request{preview.rowCount === 1 ? "" : "s"}, EGP {money(preview.totalValue)}
          {preview.redCount ? ` · ${preview.redCount} in red` : ""}
          {preview.holdNames.length ? ` · Finance hold: ${preview.holdNames.join(", ")}` : ""}
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-3">
        <PeopleLine label="To" people={preview.to} />
        <PeopleLine label="Cc" people={preview.cc} />
      </dl>
      {preview.warnings.length ? (
        <ul className="space-y-1 border border-amber-300 bg-amber-50 p-3 text-phx-sm text-amber-900">
          {preview.warnings.map((warning) => (
            <li className="break-words" key={warning}>
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-phx-xs text-slate-500">
        It goes out in your name through Phoenix, and replies come back to you. Each of them also gets the same notice in
        Phoenix and on Telegram.
      </p>
      <div className="flex flex-wrap gap-2">
        <button className={phxButtonAccentClassName} disabled={sending} onClick={onSend} type="button">
          {sending ? "Sending" : "Send now"}
        </button>
        <button className={phxButtonGhostClassName} disabled={sending} onClick={onClose} type="button">
          Cancel
        </button>
      </div>
    </section>
  );
}

function RangeForm({ from, to }: { from: string; to: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = new URLSearchParams({ from: draftFrom, to: draftTo });
    router.push(`${pathname}?${query.toString()}`);
  }

  return (
    <form className={`${adminSoftPanelClassName} flex flex-wrap items-end gap-3 p-4`} onSubmit={submit}>
      <label className="min-w-0 flex-1 basis-40">
        <span className={phxLabelClassName}>From (Cairo)</span>
        <input
          className={phxFieldClassName}
          max={draftTo || undefined}
          onChange={(event) => setDraftFrom(event.target.value)}
          required
          type="date"
          value={draftFrom}
        />
      </label>
      <label className="min-w-0 flex-1 basis-40">
        <span className={phxLabelClassName}>To (Cairo)</span>
        <input
          className={phxFieldClassName}
          min={draftFrom || undefined}
          onChange={(event) => setDraftTo(event.target.value)}
          required
          type="date"
          value={draftTo}
        />
      </label>
      <button className={phxButtonPrimaryClassName} type="submit">
        Show report
      </button>
    </form>
  );
}

/**
 * Every request the CEO approved between two Cairo dates, plus every earlier approval Finance has not
 * paid yet, each labelled in the "Listed as" column (owner, 2026-11-08). Every row starts ticked; unticking one
 * takes it out of the tiles and the total, which both read `summarizeCeoApprovals` over the ticked
 * set. Read-only: a request code opens the request, nothing here decides or pays.
 *
 * The parent keys this component by the range, so a new range starts with every row ticked again.
 *
 * `canSend` (the Marketing Manager and the Super Admin) adds the Notes column — a note and a mark per
 * row — and, while at least one row is ticked, the "Send email" button (owner, 2026-11-08). The button
 * first asks the server who the email would reach, shows that, and sends only on "Send now".
 */
export function MarketingCeoApprovalsReport({ canSend = false, report }: { canSend?: boolean; report: MarketingCeoApprovals }) {
  const { rows, range } = report;
  const allIds = useMemo(() => rows.map((row) => row.requestId), [rows]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allIds));
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const draftsLoaded = useRef(false);
  const [sendState, setSendState] = useState<SendState>({ phase: "idle" });
  const headerBox = useRef<HTMLInputElement>(null);

  const allTicked = rows.length > 0 && selected.size === rows.length;
  const noneTicked = selected.size === 0;

  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = !allTicked && !noneTicked;
  }, [allTicked, noneTicked]);

  // The browser's copy can only be read after mount; restoring it once is the whole effect.
  useEffect(() => {
    if (!canSend || draftsLoaded.current) return;
    draftsLoaded.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrafts(readDrafts());
  }, [canSend]);

  const totals = useMemo(() => summarizeCeoApprovals(rows, selected), [rows, selected]);

  const markOf = (row: MarketingCeoApprovalRow): ApprovedRequestMark => drafts[row.requestId]?.mark ?? defaultMarkFor(row);
  const noteOf = (row: MarketingCeoApprovalRow): string => drafts[row.requestId]?.note ?? "";

  function updateDraft(requestId: string, change: RowDraft) {
    setDrafts((current) => {
      const next = { ...current, [requestId]: { ...current[requestId], ...change } };
      writeDrafts(next);
      return next;
    });
  }

  /** A changed tick changes who the email reaches, so a preview already on screen is dropped. */
  function dropStalePreview() {
    setSendState((current) => (current.phase === "sending" || current.phase === "checking" ? current : { phase: "idle" }));
  }

  function toggle(requestId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(requestId)) next.delete(requestId);
      else next.add(requestId);
      return next;
    });
    dropStalePreview();
  }

  function toggleAll() {
    setSelected(allTicked ? new Set() : new Set(allIds));
    dropStalePreview();
  }

  const tooMany = selected.size > APPROVED_REQUESTS_MAX_ROWS;

  async function postEmail(dryRun: boolean): Promise<EmailResult> {
    const response = await fetch("/api/marketing-requests/ceo-approvals/email", {
      body: JSON.stringify({
        dryRun,
        from: range.from,
        rows: rows
          .filter((row) => selected.has(row.requestId))
          .map((row) => ({ mark: markOf(row), note: noteOf(row), requestId: row.requestId })),
        to: range.to,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const payload = (await response.json().catch(() => null)) as { message?: string; result?: EmailResult } | null;
    if (!response.ok || !payload?.result) {
      throw new Error(payload?.message || "The approved requests email could not be prepared. Try again.");
    }
    return payload.result;
  }

  async function checkEmail() {
    setSendState({ phase: "checking" });
    try {
      setSendState({ phase: "preview", preview: await postEmail(true) });
    } catch (error) {
      setSendState({ phase: "error", message: error instanceof Error ? error.message : "The email could not be prepared." });
    }
  }

  async function sendEmail() {
    if (sendState.phase !== "preview") return;
    setSendState({ phase: "sending", preview: sendState.preview });
    try {
      setSendState({ phase: "done", result: await postEmail(false) });
    } catch (error) {
      setSendState({ phase: "error", message: error instanceof Error ? error.message : "The email could not be sent." });
    }
  }

  const widths = canSend
    ? ["w-[3%]", "w-[3%]", "w-[10%]", "w-[11%]", "w-[12%]", "w-[7%]", "w-[8%]", "w-[9%]", "w-[11%]", "w-[8%]", "w-[18%]"]
    : ["w-[4%]", "w-[3%]", "w-[12%]", "w-[15%]", "w-[16%]", "w-[8%]", "w-[10%]", "w-[10%]", "w-[13%]", "w-[9%]"];

  const rangeLabel = `${utcDate(range.from)} to ${utcDate(range.to)}`;

  const tiles = [
    {
      hint: `of ${rows.length} listed${totals.carriedOverCount ? ` · ${totals.carriedOverCount} carried over` : ""}`,
      label: "Selected",
      value: String(totals.count),
    },
    { hint: "requested value of the selected", label: "Total value (EGP)", value: money(totals.totalValue) },
    {
      hint: `${totals.executedCount} request${totals.executedCount === 1 ? "" : "s"} paid out`,
      label: "Executed by Finance (EGP)",
      value: money(totals.executedValue),
    },
    {
      hint: `${totals.waitingCount} request${totals.waitingCount === 1 ? "" : "s"} still open${totals.overdueCount ? ` · ${totals.overdueCount} past pay date` : ""}`,
      label: "Not yet executed (EGP)",
      value: money(totals.waitingValue),
    },
  ];

  return (
    <div className="space-y-6">
      <RangeForm from={range.from} to={range.to} />

      {rows.length === 0 ? (
        <div className={`${adminSoftPanelClassName} p-6`}>
          <p className="text-phx-md font-bold text-slate-900">
            The CEO approved no marketing request from {rangeLabel}, and nothing approved earlier is waiting for Finance
          </p>
          <p className="mt-1 text-phx-sm text-slate-600">Pick other dates above. Read {cairoDateTime(report.generatedAtIso)} Cairo.</p>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {tiles.map((tile) => (
              <div className={`${adminSoftPanelClassName} p-4`} key={tile.label}>
                <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">{tile.label}</dt>
                <dd className="mt-1 text-phx-lg font-bold text-slate-900">
                  {tile.value}
                  <span className="mt-0.5 block text-phx-xs font-normal text-slate-500">{tile.hint}</span>
                </dd>
              </div>
            ))}
          </dl>

          <section className={`${adminPanelClassName} @container`}>
            <header className={`${adminPanelHeaderClassName} flex flex-wrap items-center justify-between gap-3 px-4 py-3`}>
              <div className="min-w-0">
                <p className="text-phx-sm font-bold uppercase tracking-[0.12em] text-white">Approved by the CEO · {rangeLabel}</p>
                <p className="mt-0.5 text-phx-xs text-slate-300">With every earlier approval Finance has not paid yet</p>
                <p className="mt-0.5 text-phx-xs text-slate-300">Read {cairoDateTime(report.generatedAtIso)} Cairo</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-phx-xs font-bold text-slate-200">
                  {selected.size} of {rows.length} selected
                </span>
                <button className={phxButtonGhostClassName} onClick={toggleAll} type="button">
                  {allTicked ? "Clear all" : "Select all"}
                </button>
                {canSend && selected.size > 0 ? (
                  <button
                    className={phxButtonAccentClassName}
                    disabled={tooMany || sendState.phase === "checking" || sendState.phase === "sending"}
                    onClick={checkEmail}
                    title={tooMany ? `One email carries at most ${APPROVED_REQUESTS_MAX_ROWS} requests` : undefined}
                    type="button"
                  >
                    Send email ({selected.size})
                  </button>
                ) : null}
              </div>
            </header>

            {canSend && sendState.phase !== "idle" ? (
              <div className="border-b border-phx-line p-3">
                <SendPanel onClose={() => setSendState({ phase: "idle" })} onSend={sendEmail} state={sendState} />
              </div>
            ) : null}
            {canSend && tooMany ? (
              <p className="border-b border-phx-line bg-amber-50 px-4 py-2 text-phx-sm font-bold text-amber-900">
                One email carries at most {APPROVED_REQUESTS_MAX_ROWS} requests. Untick some to send.
              </p>
            ) : null}

            <table className="hidden w-full table-fixed text-left text-sm @min-[1100px]:table">
              <colgroup>
                {widths.map((width, index) => (
                  <col className={width} key={index} />
                ))}
              </colgroup>
              <thead>
                <tr className="border-b border-phx-line text-phx-xs font-black uppercase tracking-wider text-slate-500">
                  <th className="px-2 py-2" scope="col">
                    <input
                      aria-label="Select every request"
                      checked={allTicked}
                      className={phxCheckInputClassName}
                      onChange={toggleAll}
                      ref={headerBox}
                      type="checkbox"
                    />
                  </th>
                  <th className="px-1 py-2" scope="col">#</th>
                  <th className="px-2 py-2" scope="col">Request code</th>
                  <th className="px-2 py-2" scope="col">Customer</th>
                  <th className="px-2 py-2" scope="col">Requester · line · type</th>
                  <th className="px-2 py-2 text-right" scope="col">Value (EGP)</th>
                  <th className="px-2 py-2" scope="col">Dr Anwar approval</th>
                  <th className="px-2 py-2" scope="col">Listed as</th>
                  <th className="px-2 py-2" scope="col">Live report status</th>
                  <th className="px-2 py-2" scope="col">Pay date</th>
                  {canSend ? <th className="px-2 py-2" scope="col">Notes for the email</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const ticked = selected.has(row.requestId);
                  const red = canSend && markOf(row) === "executed";
                  return (
                    <tr
                      className={`border-b border-[#f1f4f6] align-top hover:bg-orange-50/40 ${ticked ? "" : "opacity-45"}`}
                      key={row.requestId}
                    >
                      <td className="px-2 py-2">
                        <input
                          aria-label={`Select ${row.requestCode}`}
                          checked={ticked}
                          className={phxCheckInputClassName}
                          onChange={() => toggle(row.requestId)}
                          type="checkbox"
                        />
                      </td>
                      <td className="px-1 py-2 text-slate-500">{index + 1}</td>
                      <td className="px-2 py-2"><RequestCodeLink row={row} /></td>
                      <td className={`break-words px-2 py-2 font-semibold ${red ? EXECUTED_RED : "text-slate-900"}`} dir="auto">
                        {row.customerName}
                      </td>
                      <td className="px-2 py-2">
                        <p className={`break-words font-semibold ${red ? EXECUTED_RED : "text-slate-800"}`}>{row.requesterName}</p>
                        <p className="break-words text-phx-xs text-slate-600">
                          {row.lineName} · <span dir="auto">{row.requestType}</span>
                        </p>
                      </td>
                      <td className={`px-2 py-2 text-right font-bold ${red ? EXECUTED_RED : "text-slate-900"}`}>{money(row.estimatedCost)}</td>
                      <td className="px-2 py-2"><ApprovalCell row={row} /></td>
                      <td className="px-2 py-2"><ListedAsCell range={range} row={row} /></td>
                      <td className="px-2 py-2"><StatusCell row={row} /></td>
                      <td className="px-2 py-2"><PayDateCell row={row} /></td>
                      {canSend ? (
                        <td className="px-2 py-2">
                          <NotesCell
                            mark={markOf(row)}
                            note={noteOf(row)}
                            onMark={(mark) => updateDraft(row.requestId, { mark })}
                            onNote={(note) => updateDraft(row.requestId, { note })}
                            row={row}
                          />
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="hidden flex-wrap items-baseline justify-between gap-3 border-t-2 border-slate-900 bg-slate-50 px-3 py-3 @min-[1100px]:flex">
              <p className="font-black text-slate-900">
                Total of {totals.count} selected: EGP {money(totals.totalValue)}
              </p>
              <p className="text-phx-xs font-bold text-slate-600">
                Executed {money(totals.executedValue)} · not yet executed {money(totals.waitingValue)}
              </p>
            </div>

            <div className="space-y-2 p-3 @min-[1100px]:hidden">
              <label className="flex items-center gap-2 border border-phx-line bg-slate-50 px-3 py-2 text-phx-sm font-bold text-slate-800">
                <input checked={allTicked} className={phxCheckInputClassName} onChange={toggleAll} type="checkbox" />
                Select every request ({selected.size} of {rows.length})
              </label>
              {rows.map((row, index) => {
                const ticked = selected.has(row.requestId);
                const red = canSend && markOf(row) === "executed";
                return (
                  <article className={`border border-phx-line p-3 ${ticked ? "" : "opacity-45"}`} key={row.requestId}>
                    <div className="flex items-start gap-3">
                      <input
                        aria-label={`Select ${row.requestCode}`}
                        checked={ticked}
                        className={`${phxCheckInputClassName} mt-1`}
                        onChange={() => toggle(row.requestId)}
                        type="checkbox"
                      />
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-phx-xs text-slate-500">#{index + 1}</p>
                            <RequestCodeLink row={row} />
                            <p className={`break-words font-semibold ${red ? EXECUTED_RED : "text-slate-900"}`} dir="auto">{row.customerName}</p>
                          </div>
                          <p className={`shrink-0 text-right font-bold ${red ? EXECUTED_RED : "text-slate-900"}`}>EGP {money(row.estimatedCost)}</p>
                        </div>
                        <p className="break-words text-phx-sm text-slate-700">
                          {row.requesterName} · {row.lineName} · <span dir="auto">{row.requestType}</span>
                        </p>
                        <dl className="grid grid-cols-1 gap-2 text-phx-sm @min-[420px]:grid-cols-2 @min-[700px]:grid-cols-4">
                          <div className="min-w-0">
                            <dt className="text-phx-xs font-bold uppercase tracking-wider text-slate-500">Dr Anwar approval</dt>
                            <dd><ApprovalCell row={row} /></dd>
                          </div>
                          <div className="min-w-0">
                            <dt className="text-phx-xs font-bold uppercase tracking-wider text-slate-500">Listed as</dt>
                            <dd><ListedAsCell range={range} row={row} /></dd>
                          </div>
                          <div className="min-w-0">
                            <dt className="text-phx-xs font-bold uppercase tracking-wider text-slate-500">Live report status</dt>
                            <dd><StatusCell row={row} /></dd>
                          </div>
                          <div className="min-w-0">
                            <dt className="text-phx-xs font-bold uppercase tracking-wider text-slate-500">Pay date</dt>
                            <dd><PayDateCell row={row} /></dd>
                          </div>
                        </dl>
                        {canSend ? (
                          <div className="min-w-0">
                            <p className="mb-1 text-phx-xs font-bold uppercase tracking-wider text-slate-500">Notes for the email</p>
                            <NotesCell
                              mark={markOf(row)}
                              note={noteOf(row)}
                              onMark={(mark) => updateDraft(row.requestId, { mark })}
                              onNote={(note) => updateDraft(row.requestId, { note })}
                              row={row}
                            />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })}
              <div className="border-t-2 border-slate-900 bg-slate-50 px-3 py-3 font-black text-slate-900">
                Total of {totals.count} selected: EGP {money(totals.totalValue)}
                <p className="text-phx-xs font-bold text-slate-600">
                  Executed {money(totals.executedValue)} · not yet executed {money(totals.waitingValue)}
                </p>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
