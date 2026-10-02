"use client";

/**
 * Phoenix CRM — a rep's ask for a visit with somebody (owner, 2026-10-02), on the two screens it lives on.
 *
 *   CustomerVisitAsks  the customer's page: the rep's own asks for this customer, each in plain words —
 *                      "Waiting for Dina Hamdy", "Accepted, Tue 6 Oct", "Declined" — and his one action,
 *                      "Ask for a visit with…": My manager, A product manager, or Chain visit. One tap and
 *                      a confirm; the wished day is optional and nothing is typed (Golden Rule #1: easy).
 *   VisitAskInbox      the people asked: the district manager's "Asked by your reps" in the Team tab's
 *                      Double visits section — apart from his own plan, which the rep never sees — and a
 *                      product manager's "Visit asks" above his Reports. Accept with a day, or decline.
 *                      SFE and the Super Admin read every ask in their scope here.
 *
 * Nothing here judges the rep: an ask is HIS request, and its status is his to see. The server decides
 * who is asked, who may answer and who may read (server/visit-asks.ts); this file only lays it out.
 */

import { useState } from "react";

import { crmPost, crmUrl, errorCodeOf, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { cairoStamp, countText, dayLabel, plural } from "@/components/phoenix-crm/format";
import {
  CrmBlock,
  CrmButton,
  CrmCard,
  CrmChoice,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmSelect,
  CrmShowMore,
  type CrmChoiceOption,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import {
  VISIT_ASK_CHOICE_LABELS,
  visitAskInboxText,
  visitAskStatusText,
  visitAskWithText,
  type VisitAskKind,
  type VisitAskStatus,
} from "@/lib/phoenix-crm/visit-ask-rules";
import type { VisitAskCustomerView, VisitAskInboxView, VisitAskOffer, VisitAskView } from "@/lib/phoenix-crm/view-types";

/** Read again rather than shown a sentence alone: the ask moved on another screen. */
const RELOAD_CODES = new Set([
  "phoenix_crm_visit_ask_not_found",
  "phoenix_crm_visit_ask_answered",
  "phoenix_crm_visit_ask_cancelled",
  "phoenix_crm_visit_ask_already_open",
  "phoenix_crm_conflict",
]);

const STATUS_TONE: Record<VisitAskStatus, PillTone> = {
  waiting: "info",
  accepted: "good",
  declined: "neutral",
  cancelled: "neutral",
};

/** Settled asks on the inbox, a page at a time. */
const PAGE = 10;

/** "Waiting for Dina Hamdy", "Accepted, Tue 6 Oct", "Declined", "Cancelled". */
function statusText(ask: VisitAskView): string {
  return visitAskStatusText({ status: ask.status, askedName: ask.askedName, visitOnText: ask.visitOn ? dayLabel(ask.visitOn) : null });
}

/** The smaller line under an ask: when it was asked, the day wished for, and whether a visit raised it. */
function askDetails(ask: VisitAskView): string {
  const parts = [`Asked ${cairoStamp(ask.raisedAt)}`];
  parts.push(ask.wishedOn ? `wished day ${dayLabel(ask.wishedOn)}` : "any day");
  if (ask.fromVisit) parts.push("from a visit's next step");
  return parts.join(" · ");
}

// ── The customer's page ─────────────────────────────────────────────────────────────────────────

/** What the choice says under each kind: who it goes to, why it cannot be asked, or that it already was. */
function offerNote(offer: VisitAskOffer, view: VisitAskCustomerView): string {
  if (offer.open) return `Already asked: ${statusText(offer.open)}`;
  if (!offer.available) return offer.reason ?? "Not available";
  if (offer.kind === "product_manager") {
    // One product manager on the line: name him, there is nothing to pick.
    if (view.productManagers.length === 1) return view.productManagers[0].name;
    return `${plural(view.productManagers.length, "product manager", "product managers")} of your line`;
  }
  if (offer.kind === "chain") return offer.toldName ? `${offer.askedName ?? "Your manager"} and ${offer.toldName}` : (offer.askedName ?? "Your managers");
  return offer.askedName ?? "Your manager";
}

export function CustomerVisitAsks({
  customerId,
  customerName,
  seatId,
  test,
}: {
  customerId: string;
  customerName: string;
  seatId: string;
  test: boolean;
}) {
  const resource = useCrmGet<VisitAskCustomerView>(crmUrl("/api/phoenix-crm/visit-asks", { customerId, seatId, test }), "asks");
  const [choosing, setChoosing] = useState(false);
  const [kind, setKind] = useState<VisitAskKind | null>(null);
  const [productManager, setProductManager] = useState<string | null>(null);
  const [wishedOn, setWishedOn] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const view = resource.data;
  if (!view) {
    return (
      <div className="border-t border-slate-100">
        {resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Loading the visit asks" />}
      </div>
    );
  }
  // A manager reading his rep's customer sees the asks, and nothing at all when there are none.
  if (!view.canAsk && view.asks.length === 0) return null;

  function reset() {
    setChoosing(false);
    setKind(null);
    setProductManager(null);
    setWishedOn("");
  }

  function chooseKind(next: VisitAskKind) {
    setProblem(null);
    setNotice(null);
    setKind(next);
    // One product manager on the line: nothing to pick.
    setProductManager(next === "product_manager" && view && view.productManagers.length === 1 ? view.productManagers[0].hrId : null);
  }

  async function send() {
    if (!kind) return;
    setBusy("send");
    setProblem(null);
    try {
      const next = await crmPost<VisitAskCustomerView>(
        "/api/phoenix-crm/visit-asks",
        { seatId, test, customerId, kind, productManagerHrId: kind === "product_manager" ? productManager : null, wishedOn: wishedOn || null },
        "asks",
      );
      resource.replace(next);
      const sent = next.asks.find((ask) => ask.kind === kind && ask.status === "waiting");
      setNotice(sent ? `Asked. ${statusText(sent)}.` : "Asked.");
      reset();
    } catch (error) {
      setProblem(messageOf(error));
      if (RELOAD_CODES.has(errorCodeOf(error) ?? "")) resource.reload();
    } finally {
      setBusy(null);
    }
  }

  async function cancel(ask: VisitAskView) {
    setBusy(`cancel:${ask.askId}`);
    setProblem(null);
    setNotice(null);
    try {
      const next = await crmPost<VisitAskCustomerView>("/api/phoenix-crm/visit-asks/cancel", { askId: ask.askId, test }, "asks");
      resource.replace(next);
      setNotice(`Cancelled: ${visitAskWithText({ kind: ask.kind, askedName: ask.askedName, toldName: ask.toldName })}.`);
      setCancelling(null);
    } catch (error) {
      setProblem(messageOf(error));
      if (RELOAD_CODES.has(errorCodeOf(error) ?? "")) resource.reload();
    } finally {
      setBusy(null);
    }
  }

  const offer = kind ? (view.offers.find((entry) => entry.kind === kind) ?? null) : null;
  const pickedManager = productManager ? (view.productManagers.find((entry) => entry.hrId === productManager) ?? null) : null;
  const ready = Boolean(offer && offer.available && !offer.open && (kind !== "product_manager" || pickedManager));
  const askedName = kind === "product_manager" ? (pickedManager?.name ?? "") : (offer?.askedName ?? "your manager");
  const kindOptions: Array<CrmChoiceOption<VisitAskKind>> = view.offers.map((entry) => ({
    value: entry.kind,
    label: VISIT_ASK_CHOICE_LABELS[entry.kind],
    note: offerNote(entry, view),
    disabled: !entry.available || entry.open !== null || busy !== null,
  }));

  return (
    <CrmBlock className="border-t border-slate-100" title="Visit asks">
      {notice ? (
        <CrmNote className="mb-3" tone="good">
          {notice}
        </CrmNote>
      ) : null}

      {view.asks.length === 0 ? (
        <p className="break-words text-sm font-medium text-slate-500">
          Ask your manager, a product manager of your line, or your manager and the manager above for a visit to this customer with
          you. The answer shows here.
        </p>
      ) : (
        <div className="grid min-w-0 gap-2">
          {view.asks.map((ask) => {
            const canCancel = view.canAsk && ask.status === "waiting";
            return (
              <article className="min-w-0 border border-slate-200 bg-white px-3.5 py-3" key={ask.askId}>
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 flex-1 basis-48 break-words text-sm font-black text-slate-950">
                    {visitAskWithText({ kind: ask.kind, askedName: ask.askedName, toldName: ask.toldName })}
                  </p>
                  <CrmPill tone={STATUS_TONE[ask.status]}>{statusText(ask)}</CrmPill>
                </div>
                <p className="mt-1 break-words text-xs font-semibold leading-5 text-slate-500">{askDetails(ask)}</p>
                {canCancel ? (
                  cancelling === ask.askId ? (
                    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
                      <span className="min-w-0 break-words text-sm font-bold text-slate-700">Cancel this ask?</span>
                      <CrmButton busy={busy === `cancel:${ask.askId}`} onClick={() => void cancel(ask)} size="sm" variant="danger">
                        Cancel it
                      </CrmButton>
                      <CrmButton disabled={busy !== null} onClick={() => setCancelling(null)} size="sm">
                        Keep it
                      </CrmButton>
                    </div>
                  ) : (
                    <div className="mt-2">
                      <CrmButton disabled={busy !== null} onClick={() => setCancelling(ask.askId)} size="sm" variant="ghost">
                        Cancel the ask
                      </CrmButton>
                    </div>
                  )
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {view.canAsk ? (
        <div className="mt-3 grid min-w-0 gap-3">
          {choosing ? (
            <>
              {/* One a row on a phone, where each choice carries a sentence; three across from sm. Never a
                  half-empty last row (the owner called that unfinished on the List, 2026-09-30). */}
              <CrmChoice className="grid-cols-1" columns={3} label="Ask for a visit with" onChange={chooseKind} options={kindOptions} value={kind} />
              {kind === "product_manager" && offer?.available && !offer.open && view.productManagers.length > 1 ? (
                <CrmChoice
                  className={view.productManagers.length % 2 === 1 ? "[&>*:last-child]:col-span-2" : undefined}
                  columns={2}
                  label="Which product manager"
                  onChange={(next) => setProductManager(next)}
                  options={view.productManagers.map((entry) => ({ value: entry.hrId, label: entry.name, note: entry.title, disabled: busy !== null }))}
                  value={productManager}
                />
              ) : null}
              {ready ? (
                <div className="grid min-w-0 gap-3 border border-slate-200 bg-slate-50 px-3 py-3">
                  <p className="break-words text-sm font-bold text-slate-800">
                    {`Ask ${askedName} for this visit? ${visitAskWithText({ kind: kind as VisitAskKind, askedName, toldName: offer?.toldName ?? null })} · `}
                    <span dir="auto">{customerName}</span>
                  </p>
                  <CrmField hint="A wish: the person asked picks the day." htmlFor={`visit-ask-day-${customerId}`} label="Day you would like (optional)">
                    <CrmSelect id={`visit-ask-day-${customerId}`} onChange={(event) => setWishedOn(event.target.value)} value={wishedOn}>
                      <option value="">Any day</option>
                      {view.wishDays.map((day) => (
                        <option key={day} value={day}>
                          {dayLabel(day)}
                        </option>
                      ))}
                    </CrmSelect>
                  </CrmField>
                  <div className="flex min-w-0 flex-wrap gap-2">
                    <CrmButton busy={busy === "send"} onClick={() => void send()} variant="primary">
                      Send the ask
                    </CrmButton>
                    <CrmButton disabled={busy !== null} onClick={reset}>
                      Close
                    </CrmButton>
                  </div>
                </div>
              ) : (
                <div>
                  <CrmButton disabled={busy !== null} onClick={reset} size="sm" variant="ghost">
                    Close
                  </CrmButton>
                </div>
              )}
            </>
          ) : (
            <div className="grid gap-2 sm:flex sm:flex-wrap">
              <CrmButton
                onClick={() => {
                  setNotice(null);
                  setProblem(null);
                  setChoosing(true);
                }}
              >
                Ask for a visit with…
              </CrmButton>
            </div>
          )}
        </div>
      ) : null}

      {problem ? (
        <CrmNote className="mt-3" tone="bad">
          {problem}
        </CrmNote>
      ) : null}
    </CrmBlock>
  );
}

// ── The people asked ────────────────────────────────────────────────────────────────────────────

function inboxIntro(view: VisitAskInboxView, place: "team" | "reports"): string {
  if (view.mode === "all") {
    return view.canAnswer
      ? "Test mode: every test ask. You answer them as the person asked, and nobody real is told."
      : "What the reps asked for, and how each was answered. The person asked answers; you read.";
  }
  if (place === "reports") {
    return "Reps of your line ask you to visit a customer with them. Accept and pick the day, or decline: the rep sees your answer.";
  }
  return "Your reps ask you to join them at a customer. Accept and pick the day, or decline: the rep sees your answer. Your own double visit plan stays yours — the reps never see it.";
}

/** The day offered first when he accepts: the rep's wish when it can still be picked, else the first day. */
function firstDay(ask: VisitAskView, days: ReadonlyArray<string>): string {
  return ask.wishedOn && days.includes(ask.wishedOn) ? ask.wishedOn : (days[0] ?? "");
}

export function VisitAskInbox({
  cairoToday,
  onChanged,
  place,
  test,
}: {
  cairoToday: string;
  /** An answer went through: the page's "waiting for you" counts read again. */
  onChanged?: () => void;
  place: "team" | "reports";
  test: boolean;
}) {
  const resource = useCrmGet<VisitAskInboxView>(crmUrl("/api/phoenix-crm/visit-asks/inbox", { test }), "inbox");
  const [accepting, setAccepting] = useState<{ askId: string; day: string } | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ askId: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const view = resource.data;

  async function answer(ask: VisitAskView, decision: "accept" | "decline", day: string | null) {
    setBusy(`${decision}:${ask.askId}`);
    setProblem(null);
    setNotice(null);
    try {
      const next = await crmPost<VisitAskInboxView>("/api/phoenix-crm/visit-asks/answer", { askId: ask.askId, decision, day, test }, "inbox");
      resource.replace(next);
      setNotice(decision === "accept" && day ? `Accepted: ${ask.customerName}, ${dayLabel(day)}. ${ask.repName} is told.` : `Declined: ${ask.customerName}. ${ask.repName} is told.`);
      setAccepting(null);
      setDeclining(null);
      onChanged?.();
    } catch (error) {
      setProblem({ askId: ask.askId, message: messageOf(error) });
      if (RELOAD_CODES.has(errorCodeOf(error) ?? "")) resource.reload();
    } finally {
      setBusy(null);
    }
  }

  if (!view) {
    if (place === "reports") {
      // Drawn only once it is known there is something to answer; a failed read still says so.
      return resource.error ? (
        <div className="mb-4">
          <CrmPanel eyebrow="Phoenix CRM" title="Visit asks">
            <CrmLoadError message={resource.error} onRetry={resource.reload} />
          </CrmPanel>
        </div>
      ) : null;
    }
    return (
      <div className="border-t border-slate-100">
        {resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Loading the visit asks" />}
      </div>
    );
  }

  const nothing = view.waiting.length === 0 && view.others.length === 0;
  // A product manager who has never been asked sees nothing of this above his Reports.
  if (place === "reports" && nothing) return null;

  const others = view.others.slice(0, limit);
  const title =
    view.mode === "all"
      ? "Visit asks in your scope"
      : place === "reports"
        ? `Visit asks${view.waiting.length > 0 ? ` · ${countText(view.waiting.length)} waiting for you` : ""}`
        : `Asked by your reps${view.waiting.length > 0 ? ` · ${countText(view.waiting.length)} waiting for you` : ""}`;

  const body = (
    <>
      {notice ? (
        <div className="px-4 pt-4 sm:px-5">
          <CrmNote tone="good">{notice}</CrmNote>
        </div>
      ) : null}
      {nothing ? (
        <p className="px-4 pb-4 text-sm font-medium text-slate-500 sm:px-5">Nothing asked yet. When a rep asks, it shows here.</p>
      ) : (
        <div className="divide-y divide-slate-100 border-t border-slate-100">
          {view.waiting.map((ask) => {
            const acceptingThis = accepting?.askId === ask.askId ? accepting : null;
            const locked = busy !== null;
            return (
              <CrmCard
                accent="border-l-amber-500"
                actions={
                  acceptingThis || declining === ask.askId ? null : (
                    <>
                      <CrmButton
                        disabled={locked || view.dayChoices.length === 0}
                        onClick={() => {
                          setProblem(null);
                          setDeclining(null);
                          setAccepting({ askId: ask.askId, day: firstDay(ask, view.dayChoices) });
                        }}
                        size="sm"
                        variant="primary"
                      >
                        Accept and pick the day
                      </CrmButton>
                      <CrmButton
                        disabled={locked}
                        onClick={() => {
                          setProblem(null);
                          setAccepting(null);
                          setDeclining(ask.askId);
                        }}
                        size="sm"
                        variant="danger"
                      >
                        Decline
                      </CrmButton>
                    </>
                  )
                }
                key={ask.askId}
                meta={`${ask.repName} · ${ask.territoryName} · ${ask.customerListType}`}
                status={<CrmPill tone="warn">Waiting for you</CrmPill>}
                title={<span dir="auto">{ask.customerName}</span>}
              >
                <p className="break-words text-sm font-bold text-slate-800">
                  {visitAskInboxText({ kind: ask.kind, part: ask.part, askedName: ask.askedName, toldName: ask.toldName })}
                </p>
                <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-500">{askDetails(ask)}</p>
                {acceptingThis ? (
                  <div className="mt-3 grid min-w-0 gap-2 border border-slate-200 bg-slate-50 px-3 py-3">
                    <CrmField htmlFor={`visit-ask-accept-${ask.askId}`} label="The day of the visit">
                      <CrmSelect
                        id={`visit-ask-accept-${ask.askId}`}
                        onChange={(event) => setAccepting({ askId: ask.askId, day: event.target.value })}
                        value={acceptingThis.day}
                      >
                        {view.dayChoices.map((day) => (
                          <option key={day} value={day}>
                            {day === cairoToday ? `${dayLabel(day)} · today` : dayLabel(day)}
                          </option>
                        ))}
                      </CrmSelect>
                    </CrmField>
                    <div className="flex min-w-0 flex-wrap gap-2">
                      <CrmButton
                        busy={busy === `accept:${ask.askId}`}
                        disabled={!acceptingThis.day}
                        onClick={() => void answer(ask, "accept", acceptingThis.day)}
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
                {declining === ask.askId ? (
                  <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words text-sm font-bold text-slate-700">Decline this ask? {ask.repName} is told.</span>
                    <CrmButton busy={busy === `decline:${ask.askId}`} onClick={() => void answer(ask, "decline", null)} size="sm" variant="danger">
                      Decline it
                    </CrmButton>
                    <CrmButton disabled={locked} onClick={() => setDeclining(null)} size="sm">
                      Keep it
                    </CrmButton>
                  </div>
                ) : null}
                {problem?.askId === ask.askId ? (
                  <CrmNote className="mt-3" title="Not saved" tone="bad">
                    {problem.message}
                  </CrmNote>
                ) : null}
              </CrmCard>
            );
          })}
          {others.map((ask) => (
            <CrmCard
              accent={ask.status === "accepted" ? "border-l-emerald-500" : "border-l-slate-300"}
              key={ask.askId}
              meta={`${ask.repName} · ${ask.territoryName} · ${ask.customerListType}`}
              status={<CrmPill tone={STATUS_TONE[ask.status]}>{ask.status === "cancelled" ? "Cancelled by the rep" : statusText(ask)}</CrmPill>}
              title={<span dir="auto">{ask.customerName}</span>}
            >
              <p className="break-words text-sm font-bold text-slate-800">
                {visitAskInboxText({ kind: ask.kind, part: ask.part, askedName: ask.askedName, toldName: ask.toldName })}
              </p>
              <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-500">{askDetails(ask)}</p>
            </CrmCard>
          ))}
        </div>
      )}
      <CrmShowMore left={view.others.length - others.length} onMore={() => setLimit((value) => value + PAGE)} page={PAGE} />
    </>
  );

  if (place === "reports") {
    return (
      <div className="mb-4">
        <CrmPanel description={inboxIntro(view, place)} eyebrow="Phoenix CRM" title={title}>
          {body}
        </CrmPanel>
      </div>
    );
  }
  return (
    <>
      <CrmBlock className="border-t border-slate-100" title={title}>
        <p className="break-words text-sm font-medium leading-6 text-slate-600">{inboxIntro(view, place)}</p>
      </CrmBlock>
      {body}
    </>
  );
}
