"use client";

/**
 * Phoenix CRM — a rep's request for a double visit (owner, 2026-10-16), on the two screens it lives on.
 *
 *   CustomerDoubleVisitRequests  the customer's page: the rep's own requests for this customer, each with
 *                                the answer of every person he asked — "Waiting for Dina Hamdy",
 *                                "Mona Adel: accepted, Tue 6 Oct", "Sara Fathy: declined" — and one
 *                                action, "Change the days". THERE IS NO CANCEL: the owner's rule is that
 *                                he edits the days and never takes the request back.
 *   DoubleVisitReport            the managers' sidebar report: what was asked of the viewer (accept one
 *                                of the rep's days, or decline) and, for everyone whose scope reaches the
 *                                rep, how every request stands. Shared by the admin page (the Super
 *                                Admin, the CEO, SFE) and the employee portal (every other manager and
 *                                the product managers).
 *
 * Who is asked, who may answer and who may read is decided on the server
 * (server/double-visit-requests.ts); this file only lays it out. Cards, not a table: each request carries
 * a different number of people, and a card wraps at any width — nothing here scrolls sideways.
 */

import { useState } from "react";

import { crmPost, crmUrl, errorCodeOf, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { cairoStamp, countText, dayLabel, plural } from "@/components/phoenix-crm/format";
import {
  CrmBlock,
  CrmButton,
  CrmCard,
  CrmEmpty,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmSelect,
  CrmShowMore,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import {
  DOUBLE_VISIT_MAX_DAYS,
  doubleVisitPersonStatusText,
  toggleDoubleVisitDay,
  type DoubleVisitPersonStatus,
} from "@/lib/phoenix-crm/double-visit-request-rules";
import type { DoubleVisitCustomerView, DoubleVisitPersonView, DoubleVisitReport, DoubleVisitRequestView } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

/** Read again rather than shown a sentence alone: the request moved on another screen. */
const RELOAD_CODES = new Set([
  "phoenix_crm_double_visit_not_found",
  "phoenix_crm_double_visit_bad_day",
  "phoenix_crm_double_visit_bad_days",
  "phoenix_crm_conflict",
]);

const STATUS_TONE: Record<DoubleVisitPersonStatus, PillTone> = {
  waiting: "info",
  accepted: "good",
  declined: "neutral",
};

/** Requests with nothing waiting for the viewer, a page at a time. */
const PAGE = 10;

/** "Waiting" / "Accepted, Tue 6 Oct" / "Declined" — the person's name is already printed beside it. */
function answerText(person: DoubleVisitPersonView): string {
  const full = doubleVisitPersonStatusText({ status: person.status, name: person.name, visitOnText: person.visitOn ? dayLabel(person.visitOn) : null });
  if (person.status === "waiting") return "Waiting";
  return full.slice(person.name.length + 2).replace(/^./, (letter) => letter.toUpperCase());
}

function daysText(days: ReadonlyArray<string>): string {
  return days.map((day) => dayLabel(day)).join(" · ");
}

/** The smaller line under a request: when it was asked, the days offered, and whether the days were changed. */
function requestDetails(request: DoubleVisitRequestView): string {
  const parts = [`Asked ${cairoStamp(request.raisedAt)}`, `days offered: ${daysText(request.days)}`];
  if (request.editedAt) parts.push(`days changed ${cairoStamp(request.editedAt)}`);
  return parts.join(" · ");
}

/** One person asked, with his answer, as a line of a request. */
function PersonLine({ person }: { person: DoubleVisitPersonView }) {
  return (
    <li className="flex min-w-0 flex-wrap items-start justify-between gap-x-2 gap-y-1 border-t border-slate-100 py-2 first:border-t-0">
      <span className="min-w-0 flex-1 basis-48 break-words text-sm font-bold text-slate-800">
        {person.name}
        {person.title ? <span className="block text-xs font-semibold text-slate-500">{person.title}</span> : null}
      </span>
      <CrmPill tone={STATUS_TONE[person.status]}>{answerText(person)}</CrmPill>
    </li>
  );
}

// ── The customer's page ─────────────────────────────────────────────────────────────────────────

export function CustomerDoubleVisitRequests({ customerId, seatId, test }: { customerId: string; seatId: string; test: boolean }) {
  const resource = useCrmGet<DoubleVisitCustomerView>(crmUrl("/api/phoenix-crm/double-visit-requests", { customerId, seatId, test }), "view");
  const [editing, setEditing] = useState<{ requestId: string; days: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const view = resource.data;
  if (!view) {
    // Drawn only once it is known there is something to show; a failed read still says so.
    return resource.error ? (
      <div className="border-t border-slate-100">
        <CrmLoadError message={resource.error} onRetry={resource.reload} />
      </div>
    ) : null;
  }
  if (view.requests.length === 0) return null;

  async function saveDays(requestId: string, days: string[]) {
    setBusy(requestId);
    setProblem(null);
    setNotice(null);
    try {
      const next = await crmPost<DoubleVisitCustomerView>("/api/phoenix-crm/double-visit-requests/edit", { requestId, days, test }, "view");
      resource.replace(next);
      setNotice("The new days are saved. Anyone still waiting is told.");
      setEditing(null);
    } catch (error) {
      setProblem(messageOf(error));
      if (RELOAD_CODES.has(errorCodeOf(error) ?? "")) resource.reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <CrmBlock className="border-t border-slate-100" title="Double visit requests">
      {notice ? (
        <CrmNote className="mb-3" tone="good">
          {notice}
        </CrmNote>
      ) : null}
      <div className="grid min-w-0 gap-2">
        {view.requests.map((request) => {
          const editingThis = editing?.requestId === request.requestId ? editing : null;
          return (
            <article className="min-w-0 border border-slate-200 bg-white px-3.5 py-3" key={request.requestId}>
              <p className="break-words text-sm font-black text-slate-950">Double visit asked of {plural(request.people.length, "person", "people")}</p>
              <p className="mt-1 break-words text-xs font-semibold leading-5 text-slate-500">{requestDetails(request)}</p>
              <ul className="mt-2 min-w-0">
                {request.people.map((person) => (
                  <PersonLine key={person.personId} person={person} />
                ))}
              </ul>
              {view.canEdit && request.isMine ? (
                editingThis ? (
                  <div className="mt-2 grid min-w-0 gap-2 border border-slate-200 bg-slate-50 px-3 py-3">
                    <p className="text-sm font-black text-slate-800">Which days suit you? Choose up to {DOUBLE_VISIT_MAX_DAYS}.</p>
                    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                      {view.dayChoices.map((day) => {
                        const chosen = editingThis.days.includes(day);
                        return (
                          <button
                            aria-pressed={chosen}
                            className={cn(
                              "min-h-11 min-w-0 break-words rounded-none border px-3 py-2 text-left text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-50",
                              chosen ? "border-orange-500 bg-orange-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                            )}
                            disabled={busy !== null || (!chosen && editingThis.days.length >= DOUBLE_VISIT_MAX_DAYS)}
                            key={day}
                            onClick={() => setEditing({ requestId: request.requestId, days: toggleDoubleVisitDay(editingThis.days, day) })}
                            type="button"
                          >
                            {dayLabel(day)}
                          </button>
                        );
                      })}
                    </div>
                    <p className="break-words text-xs font-semibold text-slate-500">
                      Anyone who accepted a day you take out is asked again. The request itself stays.
                    </p>
                    <div className="flex min-w-0 flex-wrap gap-2">
                      <CrmButton
                        busy={busy === request.requestId}
                        disabled={editingThis.days.length === 0}
                        onClick={() => void saveDays(request.requestId, editingThis.days)}
                        size="sm"
                        variant="primary"
                      >
                        Save the days
                      </CrmButton>
                      <CrmButton disabled={busy !== null} onClick={() => setEditing(null)} size="sm">
                        Close
                      </CrmButton>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2">
                    <CrmButton
                      disabled={busy !== null}
                      onClick={() => {
                        setNotice(null);
                        setProblem(null);
                        setEditing({ requestId: request.requestId, days: [...request.days] });
                      }}
                      size="sm"
                    >
                      Change the days
                    </CrmButton>
                  </div>
                )
              ) : null}
            </article>
          );
        })}
      </div>
      {problem ? (
        <CrmNote className="mt-3" tone="bad">
          {problem}
        </CrmNote>
      ) : null}
    </CrmBlock>
  );
}

// ── The managers' report ────────────────────────────────────────────────────────────────────────

function reportIntro(report: DoubleVisitReport): string {
  if (report.audience === "own") {
    return "Reps ask you to join them at a customer. Accept one of the days they offer, or decline: the rep sees your answer.";
  }
  return "Double visits your reps ask for, and how each person asked has answered. A request addressed to you is first: accept one of the rep's days, or decline.";
}

function totalsText(report: DoubleVisitReport): string {
  const { requests, waiting, accepted, declined } = report.totals;
  if (requests === 0) return "No requests in the last 60 days.";
  return `${plural(requests, "request", "requests")} · ${countText(waiting)} waiting · ${countText(accepted)} accepted · ${countText(declined)} declined`;
}

export function DoubleVisitReportView({ cairoToday, test }: { cairoToday: string; test: boolean }) {
  const resource = useCrmGet<DoubleVisitReport>(crmUrl("/api/phoenix-crm/double-visit-requests/report", { test }), "report");
  const [accepting, setAccepting] = useState<{ requestId: string; day: string } | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ requestId: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const report = resource.data;
  if (!report) {
    return (
      <CrmPanel eyebrow="Phoenix CRM" title="Double visit requests">
        {resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Loading the double visit requests" />}
      </CrmPanel>
    );
  }

  async function answer(request: DoubleVisitRequestView, decision: "accept" | "decline", day: string | null) {
    setBusy(`${decision}:${request.requestId}`);
    setProblem(null);
    setNotice(null);
    try {
      const next = await crmPost<DoubleVisitReport>("/api/phoenix-crm/double-visit-requests/answer", { requestId: request.requestId, decision, day, test }, "report");
      resource.replace(next);
      setNotice(
        decision === "accept" && day
          ? `Accepted: ${request.customerName}, ${dayLabel(day)}. ${request.repName} is told.`
          : `Declined: ${request.customerName}. ${request.repName} is told.`,
      );
      setAccepting(null);
      setDeclining(null);
    } catch (error) {
      setProblem({ requestId: request.requestId, message: messageOf(error) });
      if (RELOAD_CODES.has(errorCodeOf(error) ?? "")) resource.reload();
    } finally {
      setBusy(null);
    }
  }

  /** The days still open to the viewer: the rep's days that have not passed. */
  const openDays = (request: DoubleVisitRequestView) => request.days.filter((day) => day >= cairoToday);

  function card(request: DoubleVisitRequestView) {
    const acceptingThis = accepting?.requestId === request.requestId ? accepting : null;
    const locked = busy !== null;
    const days = openDays(request);
    const yourTurn = request.canAnswer && request.you?.status === "waiting";
    const canChange = request.canAnswer && request.you !== null && request.you.status !== "waiting";
    return (
      <CrmCard
        accent={yourTurn ? "border-l-amber-500" : request.tally.waiting > 0 ? "border-l-sky-400" : request.tally.accepted > 0 ? "border-l-emerald-500" : "border-l-slate-300"}
        actions={
          (yourTurn || canChange) && !acceptingThis && declining !== request.requestId ? (
            <>
              <CrmButton
                disabled={locked || days.length === 0}
                onClick={() => {
                  setProblem(null);
                  setDeclining(null);
                  setAccepting({ requestId: request.requestId, day: request.you?.visitOn && days.includes(request.you.visitOn) ? request.you.visitOn : (days[0] ?? "") });
                }}
                size="sm"
                variant={yourTurn ? "primary" : "secondary"}
              >
                {yourTurn ? "Accept and pick the day" : "Change my answer"}
              </CrmButton>
              <CrmButton
                disabled={locked || request.you?.status === "declined"}
                onClick={() => {
                  setProblem(null);
                  setAccepting(null);
                  setDeclining(request.requestId);
                }}
                size="sm"
                variant="danger"
              >
                Decline
              </CrmButton>
            </>
          ) : null
        }
        key={request.requestId}
        meta={`${request.repName} · ${request.territoryName} · ${request.customerListType}`}
        status={yourTurn ? <CrmPill tone="warn">Waiting for you</CrmPill> : <CrmPill tone="neutral">{countText(request.tally.accepted)} of {countText(request.people.length)} accepted</CrmPill>}
        title={<span dir="auto">{request.customerName}</span>}
      >
        <p className="break-words text-xs font-semibold leading-5 text-slate-500">{requestDetails(request)}</p>
        <ul className="mt-2 min-w-0">
          {request.people.map((person) => (
            <PersonLine key={person.personId} person={{ ...person, name: person.isYou ? `${person.name} (you)` : person.name }} />
          ))}
        </ul>
        {days.length === 0 && yourTurn ? (
          <CrmNote className="mt-2" tone="info">
            Every day the rep offered has passed. The rep can offer new days.
          </CrmNote>
        ) : null}
        {acceptingThis ? (
          <div className="mt-3 grid min-w-0 gap-2 border border-slate-200 bg-slate-50 px-3 py-3">
            <CrmField htmlFor={`double-visit-accept-${request.requestId}`} label="The day of the visit">
              <CrmSelect
                id={`double-visit-accept-${request.requestId}`}
                onChange={(event) => setAccepting({ requestId: request.requestId, day: event.target.value })}
                value={acceptingThis.day}
              >
                {days.map((day) => (
                  <option key={day} value={day}>
                    {day === cairoToday ? `${dayLabel(day)} · today` : dayLabel(day)}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>
            <div className="flex min-w-0 flex-wrap gap-2">
              <CrmButton
                busy={busy === `accept:${request.requestId}`}
                disabled={!acceptingThis.day}
                onClick={() => void answer(request, "accept", acceptingThis.day)}
                size="sm"
                variant="primary"
              >
                {acceptingThis.day ? `Accept for ${dayLabel(acceptingThis.day)}` : "Accept"}
              </CrmButton>
              <CrmButton disabled={locked} onClick={() => setAccepting(null)} size="sm">
                Close
              </CrmButton>
            </div>
          </div>
        ) : null}
        {declining === request.requestId ? (
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 break-words text-sm font-bold text-slate-700">Decline this request? {request.repName} is told.</span>
            <CrmButton busy={busy === `decline:${request.requestId}`} onClick={() => void answer(request, "decline", null)} size="sm" variant="danger">
              Decline it
            </CrmButton>
            <CrmButton disabled={locked} onClick={() => setDeclining(null)} size="sm">
              Keep it
            </CrmButton>
          </div>
        ) : null}
        {problem?.requestId === request.requestId ? (
          <CrmNote className="mt-3" title="Not saved" tone="bad">
            {problem.message}
          </CrmNote>
        ) : null}
      </CrmCard>
    );
  }

  const others = report.others.slice(0, limit);
  const nothing = report.toAnswer.length === 0 && report.others.length === 0;
  return (
    <CrmPanel
      description={reportIntro(report)}
      eyebrow="Phoenix CRM"
      title={`Double visit requests${report.toAnswer.length > 0 ? ` · ${countText(report.toAnswer.length)} waiting for you` : ""}`}
    >
      {notice ? (
        <div className="px-4 pt-4 sm:px-5">
          <CrmNote tone="good">{notice}</CrmNote>
        </div>
      ) : null}
      <p className="break-words px-4 py-3 text-xs font-semibold text-slate-500 sm:px-5">{totalsText(report)}</p>
      {nothing ? (
        <CrmEmpty message="When a rep asks for a double visit, it shows here." title="Nothing asked yet" />
      ) : (
        <div className="divide-y divide-slate-100 border-t border-slate-100">
          {report.toAnswer.map((request) => card(request))}
          {others.map((request) => card(request))}
        </div>
      )}
      <CrmShowMore left={report.others.length - others.length} onMore={() => setLimit((value) => value + PAGE)} page={PAGE} />
    </CrmPanel>
  );
}
