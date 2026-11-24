"use client";

import { Check, HelpCircle, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { type AttachmentsData, TripAttachments } from "@/components/outstation/trip-attachments";
import { TripWorkloadEvidencePanel } from "@/components/outstation/trip-workload-evidence";
import { CrmLoadError, CrmLoading, CrmNote } from "@/components/phoenix-crm/ui";
import { formatDateValue, formatNumberValue } from "@/lib/i18n/format";
import { decidedChange } from "@/lib/outstation/approvals/decided-change";
import type { DeskNotice } from "@/lib/outstation/approvals/press-queue";
import { TRIP_STANDING_MEANING } from "@/lib/outstation/approvals/standing";
import type { ClaimCheck, DeskClaim } from "@/lib/outstation/approvals/types";
import type { CrmTripReading } from "@/lib/outstation/crm-trip-evidence";
import { tripKmText } from "@/lib/outstation/trip-km";

import { DeskAmounts, type OnEdited, amountsOpen } from "./desk-amounts";
import { DeskDays } from "./desk-days";
import { type DecisionMode, DecisionButtons, DecisionPanel, type OnPress } from "./desk-decision";
import { StandingPill, TripLine, WaitFigure, egp } from "./desk-parts";

/** What `GET /api/admin/outstation/approvals/:requestId` answers (src/lib/outstation/approvals/trip-file.ts). */
type TripFile = {
  attachments: AttachmentsData | null;
  claim: DeskClaim;
  crm: { found: boolean; reading: CrmTripReading | null; unavailable: string[] } | null;
  evidenceWithheld: boolean;
  unavailable: string[];
};

type FileState = { error: string | null; file: TripFile | null; gone: boolean };

const ROUTE = "/api/admin/outstation/approvals";

const CHECK_LOOK: Record<ClaimCheck["answer"], { icon: typeof Check; text: string; word: string }> = {
  fail: { icon: X, text: "text-rose-700", word: "Failed" },
  pass: { icon: Check, text: "text-emerald-700", word: "Passed" },
  unknown: { icon: HelpCircle, text: "text-amber-700", word: "Could not be checked" },
};

/**
 * The reviewer's one scroll and its pinned decision — one trip, read with ONE request.
 *
 * Top to bottom: who and what is claimed; what the system found, every check in one sentence; the
 * trip day by day, each day on its own map; the photos and the tickets. The decision is pinned at
 * the foot and is the row's own (desk-decision.tsx). Mounted once per trip (keyed by the reviewer),
 * so a new trip starts empty and a slow answer for the trip before can never be drawn on this one.
 *
 * A trip with days from before its team moved to Phoenix CRM also draws the OLD system's record of
 * those days (the shared verified-workload panel, which reads it in one more request) — otherwise a
 * claim for an October trip would open with no field work on it at all.
 *
 * A reader who is not the approver gets the claim and its checks; the photos and the Phoenix CRM
 * reading are withheld by the server and the page says so, rather than drawing empty sections.
 */
export function DeskTripFile({
  canDecide,
  mode,
  notice,
  onEdited,
  onGo,
  onMode,
  onPress,
  pressed,
  requestId,
  titleId,
}: {
  canDecide: boolean;
  mode: DecisionMode;
  notice: DeskNotice | null;
  onEdited: OnEdited;
  onGo: (requestId: number) => void;
  onMode: (mode: DecisionMode) => void;
  onPress: OnPress;
  /** This claim is inside a press right now: nothing more can be pressed on it until it is answered. */
  pressed: boolean;
  requestId: number;
  titleId: string;
}) {
  const [state, setState] = useState<FileState>({ error: null, file: null, gone: false });
  const [readCount, setReadCount] = useState(0);

  useEffect(() => {
    let live = true;
    fetch(`${ROUTE}/${requestId}`, { cache: "no-store", headers: { accept: "application/json" } })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as (Partial<TripFile> & { message?: string }) | null;
        if (!live) return;
        if (!response.ok || !body || !body.claim) {
          setState((current) => ({ error: body?.message || "Unable to open this trip.", file: current.file, gone: response.status === 404 }));
          return;
        }
        setState({ error: null, file: body as TripFile, gone: false });
      })
      .catch(() => {
        if (live) setState((current) => ({ ...current, error: "Could not reach the server. Check the connection and try again." }));
      });
    return () => {
      live = false;
    };
  }, [readCount, requestId]);

  const readAgain = () => {
    setState((current) => ({ ...current, error: null }));
    setReadCount((current) => current + 1);
  };

  const file = state.file;
  if (!file) {
    return (
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-trip-file="loading">
        <div className="mx-auto w-full max-w-5xl px-3 py-4 sm:px-4">
          <h2 className="sr-only" id={titleId}>
            Expense claim
          </h2>
          <section className="min-w-0 border border-slate-200 bg-white">
            {state.error ? <CrmLoadError message={state.error} onRetry={state.gone ? undefined : readAgain} /> : <CrmLoading label="Reading the trip" />}
          </section>
        </div>
      </div>
    );
  }

  const claim = file.claim;
  const waiting = claim.standing === "waiting";
  const cut = waiting && claim.preCut && !claim.holdReason ? claim.preCut : null;
  // A decided claim: the one press still open on it (Reject an approval, Approve a rejection), or why none.
  const change = decidedChange(claim);
  const again = canDecide ? change.offer : null;
  // Days Phoenix CRM cannot speak for: before the team moved to it, or a trip it holds no person for.
  const daysBeforePhoenix = file.crm?.reading?.days.filter((day) => day.beforePhoenix).length ?? 0;
  const oldRecord = claim.declaredWorkload && (daysBeforePhoenix > 0 || (file.crm !== null && !file.crm.reading)) ? claim.declaredWorkload : null;

  return (
    <>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-trip-file={claim.requestId}>
        <div className="mx-auto grid w-full max-w-5xl min-w-0 gap-3 px-3 py-3 sm:px-4">
          {notice ? (
            <CrmNote tone={notice.tone === "bad" ? "bad" : "warn"}>{notice.message}</CrmNote>
          ) : null}
          {state.error ? <CrmNote tone="warn">{state.error} What is shown is the last reading.</CrmNote> : null}

          <section className="min-w-0 border border-slate-200 bg-white px-4 py-3" data-trip-summary>
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div className="min-w-0">
                <h2 className="break-words text-lg font-black leading-tight text-slate-950" id={titleId}>
                  <bdi dir="auto">{claim.employeeName}</bdi>
                </h2>
                {claim.employeeRole ? <p className="break-words text-xs font-semibold text-slate-500">{claim.employeeRole}</p> : null}
                <div className="mt-1.5 min-w-0">
                  <TripLine claim={claim} />
                </div>
              </div>
              <StandingPill standing={claim.standing} />
            </div>
            <dl className="mt-3 grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 border-t border-slate-100 pt-3 sm:grid-cols-4 [&>*]:min-w-0">
              <Figure label="Claim" value={egp(claim.total)} />
              <Figure label="Allowance in it" value={claim.allowance > 0 ? egp(claim.allowance) : "None"} />
              {waiting ? (
                <Figure label="Waited" value={<WaitFigure days={claim.daysWaiting} />} />
              ) : (
                <Figure label={claim.standing === "rejected" ? "Pays" : "Pays as it stands"} value={claim.standing === "rejected" ? "Nothing" : egp(claim.payable)} />
              )}
              {waiting ? (
                <Figure label="Sent on" value={claim.submittedAt ? formatDateValue(claim.submittedAt) : "Not recorded"} />
              ) : (
                <Figure label="Decided on" value={claim.decidedAt ? formatDateValue(claim.decidedAt) : "Not recorded"} />
              )}
            </dl>
            {claim.distance ? <DistanceFigures distance={claim.distance} /> : null}
            {claim.employeeNote ? (
              <p className="mt-3 min-w-0 break-words border-l-[3px] border-l-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800" data-employee-note>
                <span className="block text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">The employee wrote</span>
                <bdi dir="auto">{claim.employeeNote}</bdi>
              </p>
            ) : null}
            {!waiting && claim.hrComment ? (
              <p className="mt-2 min-w-0 break-words border-l-[3px] border-l-orange-400 bg-slate-50 px-3 py-2 text-sm text-slate-800" data-decision-reason>
                <span className="block text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">The reason on the decision</span>
                <bdi dir="auto">{claim.hrComment}</bdi>
              </p>
            ) : null}
          </section>

          {canDecide && amountsOpen(claim) ? (
            <DeskAmounts
              claim={claim}
              disabled={pressed}
              onSaved={(after) => {
                onEdited(claim, after);
                readAgain();
              }}
            />
          ) : null}

          <Sheet name="found" title="What the system found">
            <p className="min-w-0 break-words text-sm font-black text-slate-950" data-found-lane={claim.verdict.lane}>
              {claim.verdict.lane === "ready" ? "Ready — every check passed." : `Your call — ${claim.verdict.reason ?? "one of the checks did not pass."}`}
            </p>
            <ul className="mt-2 grid min-w-0 gap-1.5" data-checks>
              {claim.verdict.checks.map((check) => {
                const look = CHECK_LOOK[check.answer];
                const Icon = look.icon;
                return (
                  <li className="flex min-w-0 items-start gap-2 text-sm" data-check={check.key} data-check-answer={check.answer} key={check.key}>
                    <Icon aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${look.text}`} />
                    <p className="min-w-0 break-words text-slate-700">
                      <span className="font-black text-slate-950">{check.label}</span>
                      <span className="sr-only"> — {look.word}</span>
                      {" · "}
                      {check.sentence}
                    </p>
                  </li>
                );
              })}
            </ul>
            {claim.verdict.idleDates.length > 0 ? (
              <p className="mt-2 min-w-0 break-words text-sm text-slate-700" data-idle-days>
                <span className="font-black text-slate-950">
                  {formatNumberValue(claim.verdict.idleDates.length)} {claim.verdict.idleDates.length === 1 ? "day" : "days"} with no visit and no recorded meeting
                </span>
                {" · "}
                {claim.verdict.idleDates.map((date) => formatDateValue(date, null, { weekday: "short", year: undefined })).join(", ")}
              </p>
            ) : null}
            {cut ? (
              <p className="mt-1 min-w-0 break-words text-sm font-semibold text-orange-800" data-pre-cut>
                {cut.reason} Approve pays {egp(cut.payable)}; Keep full claim pays {egp(claim.total)}.
              </p>
            ) : null}
            {claim.holdReason ? (
              <p className="mt-1 min-w-0 break-words text-sm font-semibold text-amber-800" data-hold-reason>
                Approving it holds it out of payroll for now: {claim.holdReason}
              </p>
            ) : null}
            {claim.relatedRequestIds.length > 0 ? (
              <div className="mt-2 flex min-w-0 flex-wrap gap-1.5" data-related-claims>
                {claim.relatedRequestIds.map((related, index) => (
                  <button
                    className="inline-flex min-h-11 items-center border border-slate-300 bg-white px-3 py-1.5 text-sm font-black text-slate-700 transition hover:border-orange-400 hover:text-orange-700"
                    key={related}
                    onClick={() => onGo(related)}
                    type="button"
                  >
                    {claim.relatedRequestIds.length === 1 ? "Open the other claim" : `Open the other claim ${formatNumberValue(index + 1)}`}
                  </button>
                ))}
              </div>
            ) : null}
          </Sheet>

          {file.unavailable.length > 0 ? (
            <CrmNote title="Not read this time" tone="warn">
              {file.unavailable.join(", ")}. What is shown below is not the whole picture.
            </CrmNote>
          ) : null}

          {file.evidenceWithheld ? (
            <CrmNote title="The evidence is the approver's" tone="info">
              The photos, the tickets and the Phoenix CRM reading of this trip are shown to the Super Admin only. The claim and every check are above.
            </CrmNote>
          ) : (
            <>
              <Sheet name="days" title="The trip, day by day">
                {file.crm && !file.crm.reading ? <p className="mb-2 text-sm text-slate-600">Phoenix CRM holds no employee or no dates to read this trip against, so only the photos and stops are drawn.</p> : null}
                <DeskDays attachments={file.attachments} reading={file.crm?.reading ?? null} tripEnd={claim.tripEnd} tripStart={claim.tripStart} />
              </Sheet>
              {oldRecord ? (
                <Sheet name="old-record" title="Before Phoenix CRM: the old system's record">
                  <p className="mb-2 min-w-0 break-words text-sm text-slate-600">
                    {daysBeforePhoenix > 0
                      ? `${formatNumberValue(daysBeforePhoenix)} ${daysBeforePhoenix === 1 ? "day of this trip was" : "days of this trip were"} before this team moved to Phoenix CRM.`
                      : "Phoenix CRM has no reading of this trip."}{" "}
                    These are the visits and check-ins the old system holds for it.
                  </p>
                  <TripWorkloadEvidencePanel
                    alwaysOpen
                    dayOrder="data-first"
                    declaredAm={oldRecord.am}
                    declaredPharmacies={oldRecord.pharmacies}
                    declaredPm={oldRecord.pm}
                    hrId={claim.hrId}
                    storedMatchStatus={oldRecord.matchStatus}
                    tripEndDate={claim.tripEnd}
                    tripStartDate={claim.tripStart}
                  />
                </Sheet>
              ) : null}
              <Sheet name="attachments" title="Photos and tickets">
                <TripAttachments data={file.attachments} onChanged={readAgain} tripId={claim.tripId} />
              </Sheet>
            </>
          )}
        </div>
      </div>

      <footer className="min-w-0 border-t border-slate-300 bg-white" data-reviewer-decision>
        <div className="mx-auto w-full max-w-5xl min-w-0 px-3 py-2.5 sm:px-4">
          {mode !== "idle" && canDecide && !claim.locked && (waiting || again === "reject") && !pressed ? (
            <div className="mb-2 max-h-[50vh] min-w-0 overflow-y-auto">
              <DecisionPanel claim={claim} mode={mode} onClose={() => onMode("idle")} onPress={onPress} />
            </div>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="min-w-0 break-words text-sm font-black tabular-nums text-slate-950">
              {egp(claim.total)}
              {cut ? <span className="ml-2 font-bold text-orange-700">{egp(cut.payable)} without the idle days</span> : null}
            </p>
            {pressed ? (
              <p className="min-w-0 break-words text-sm font-bold text-slate-600" data-decision-state="pressed">
                Your decision on this claim is being saved.
              </p>
            ) : claim.locked ? (
              <p className="min-w-0 break-words text-sm font-bold text-slate-600" data-decision-state="locked">
                A payroll already took this trip, so nothing here can change it.
              </p>
            ) : !waiting && !again ? (
              <p className="min-w-0 break-words text-sm font-bold text-slate-600" data-decision-state="decided">
                {/* Where it stands, in words: a pill's tooltip is not readable on a phone. */}
                {TRIP_STANDING_MEANING[claim.standing]} {change.why ?? "It is read here, not changed."}
              </p>
            ) : !canDecide ? (
              <p className="min-w-0 break-words text-sm font-bold text-slate-600" data-decision-state="read-only">
                You can read this claim. The decision is the Super Admin&apos;s.
              </p>
            ) : (
              <DecisionButtons canDecide={canDecide} claim={claim} everyAction mode={mode} onMode={onMode} onPress={onPress} size="regular" />
            )}
          </div>
        </div>
      </footer>
    </>
  );
}

function Sheet({ children, name, title }: { children: ReactNode; name: string; title: string }) {
  return (
    <section className="min-w-0 border border-slate-200 bg-white" data-trip-sheet={name}>
      <h3 className="min-w-0 break-words border-b border-slate-200 px-4 py-2 text-sm font-black text-slate-950">
        <span aria-hidden className="mr-2 inline-block h-2 w-2 bg-orange-500 align-middle" />
        {title}
      </h3>
      <div className="min-w-0 px-4 py-3">{children}</div>
    </section>
  );
}

// Whole km, except a distance under the trip minimum that rounding would carry up to it (`trip-km.ts`).
const kmFigure = (km: number | null, minimumKm: number | null) => (km === null ? "Not measured" : tripKmText(km, minimumKm));

/**
 * A District Manager's trip, priced from his home to the first double visit (owner, 2026-11-23: "show
 * me in expense approvals both the distance from where he captured and the calculated distance from
 * his home to the first double visit he made"). Both road distances, side by side; wraps on a phone.
 */
function DistanceFigures({ distance }: { distance: NonNullable<DeskClaim["distance"]> }) {
  const priced =
    distance.basis === "first_double_visit" ? (
      <>
        {kmFigure(distance.visitKm, distance.minimumKm)}
        {distance.visitWords ? <span className="block text-xs font-semibold text-slate-600">{distance.visitWords}</span> : null}
      </>
    ) : distance.basis === "no_double_visit" ? (
      <span className="text-amber-800">No double visit on this trip</span>
    ) : (
      <>
        <span className="text-amber-800">Not measured</span>
        {distance.visitWords ? <span className="block text-xs font-semibold text-slate-600">{distance.visitWords}</span> : null}
      </>
    );
  return (
    <dl
      className="mt-2 grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 border-t border-slate-100 pt-2 sm:grid-cols-2 [&>*]:min-w-0"
      data-trip-distance={distance.basis}
    >
      <Figure label="Home to the capture point" value={kmFigure(distance.capturedKm, distance.minimumKm)} />
      <Figure label={distance.basis === "first_double_visit" ? "Priced: home to the first double visit" : "First double visit"} value={priced} />
    </dl>
  );
}

function Figure({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-black tabular-nums text-slate-950">{value}</dd>
    </div>
  );
}
