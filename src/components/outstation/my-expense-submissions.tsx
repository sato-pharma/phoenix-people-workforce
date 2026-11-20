"use client";

import {
  CalendarDays,
  Camera,
  Check,
  ChevronDown,
  CircleDollarSign,
  Clock,
  ImageOff,
  Loader2,
  MapPin,
  Route,
  Ticket,
  TriangleAlert,
  Wallet,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { DeparturePhotoCard } from "@/components/outstation/departure-photo-card";
import { JourneyRouteLine } from "@/components/outstation/journey-route-line";
import { MissingTicketCard } from "@/components/outstation/missing-ticket-card";
import type { MyOutstationSubmission } from "@/lib/outstation/service";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { humanizeCode } from "@/lib/format/code-label";
import { claimMoneyRows } from "@/lib/outstation/claim-money-rows";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";
import { tidyOutstationAddress } from "@/lib/outstation/description-format";
import { claimsLabel, isPassedValidation, summarizeMyClaims } from "@/lib/outstation/my-claims-summary";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  LANDING_FOCUS,
  LANDING_INK,
  LANDING_NAVY_TILE,
  LandingFigure,
  LandingNavyBoard,
  LandingTitle,
  landingActionClassName,
} from "@/components/employee-portal/landing-kit";
import { cn } from "@/lib/utils";

/** A stored address with its leading plus code ("2C2Q+R4 …") and trailing "Egypt" removed; the raw text when nothing readable is left. */
function readableAddress(value: string | null | undefined): string {
  return tidyOutstationAddress(value) ?? (value ?? "");
}

/**
 * The submitter's own outstation submissions.
 *
 * Two rules shape this file, both owner decisions:
 *   - He sees BOTH figures and the HR comment (2026-08-08). Showing only the approved amount hides
 *     that a claim was cut; showing only the claim hides what he will actually be paid. Neither
 *     alone is honest, so an adjustment is always rendered as claimed -> approved with the reason.
 *   - Nothing here decides anything. There is no approve control and no editable amount — this is
 *     his own claim, and the one write the page offers is the departure photo.
 *
 * The departure capture is the EXISTING DeparturePhotoCard rather than a second implementation of
 * the camera glue: that component already owns the watermark, the geolocation fallback and the
 * one-shot rule, and a money-bearing capture path must not exist twice.
 */

const EGP = stableCurrencyFormatter("en-EG", {
  currency: "EGP",
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
  style: "currency",
});

export function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return EGP.format(value);
}

type PhotoState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; arrivalUrl: string | null; departureUrl: string | null }
  | { kind: "error"; message: string };

/** Where a submission has got to. Drives both the row pill and the timeline. */
export type StageKey = "submitted" | "arrival" | "departure" | "workload" | "decision" | "paid";

export type Stage = {
  detail: string;
  key: StageKey;
  label: string;
  state: "done" | "current" | "waiting";
};

/**
 * The journey of one submission, resolved from the same gate the payroll release consults.
 *
 * Every stage carries its own sentence. "Pending" on its own is what made an employee ask why his
 * money had not arrived; the whole point of this strip is that the answer is already on screen.
 */
/**
 * AM · PM · Pharmacies, three figures apart. A trip stamped before the split (or typed by hand)
 * carries its pharmacy visits inside AM/PM and has no third figure, so it reads AM · PM only.
 */
function fieldWorkloadLabel(submission: MyOutstationSubmission): string {
  const pair = `AM ${submission.amWorkload} · PM ${submission.pmWorkload}`;
  return submission.pharmacyWorkload === null || submission.pharmacyWorkload === undefined
    ? pair
    : `${pair} · Pharmacies ${submission.pharmacyWorkload}`;
}

/** Today's date in Africa/Cairo as YYYY-MM-DD, so a deadline is judged in the employee's own day. */
function cairoToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date());
}

/**
 * Reconcile the strip so it reads as a journey rather than a scoreboard.
 *
 * A stage may only show as DONE once everything before it is done, and exactly one stage — the
 * first unfinished one — is current. Without this the row rendered "HR decision ✓" above "Field
 * workload — waiting", because the expense row carries an approval while the request is still held
 * by the gate. Both facts are true, but shown as a sequence they say the money is further along
 * than it is. The detail sentences are left untouched, so nothing is hidden.
 */
function sequenceStages(stages: Stage[]): Stage[] {
  let blocked = false;
  return stages.map((stage) => {
    if (blocked) return { ...stage, state: "waiting" as const };
    if (stage.state === "done") return stage;
    blocked = true;
    return { ...stage, state: "current" as const };
  });
}

/**
 * Exported so the manager's read-only single-request review (manager-outstation-review.tsx)
 * renders the SAME stage sequence and headline logic as the employee's own view — a trip's
 * status must never have two competing definitions depending on who is looking at it.
 */
export function buildStages(submission: MyOutstationSubmission): Stage[] {
  const { decision, gateBlocker } = submission;

  const arrivalDone = submission.hasArrivalPhoto;
  const departureDone = submission.hasDeparturePhoto;
  const workloadDone = gateBlocker !== "workload" && submission.isPayrollEligible;
  // The Validated card above the rows counts with the same test, so the two always agree.
  const decided = isPassedValidation(submission);
  const rejected = submission.status.toLowerCase().includes("reject");
  const paid = Boolean(decision?.paidAt);

  // A grandfathered row never had a photo step. Saying "waiting for the arrival photo" about a
  // trip nobody can photograph any more is exactly the message that sent people looking for a
  // control that does not exist.
  const photoExempt = !arrivalDone && submission.isPayrollEligible;
  // A role with no photo evidence at all is asked for none, so no stage names one (owner, 2026-11-03:
  // "nsms/pms should not have evidence photo"). A photo it does hold is still shown as captured.
  const noPhotoStages = submission.photosWaived && !arrivalDone && !departureDone;

  const stage = (
    key: StageKey,
    label: string,
    done: boolean,
    current: boolean,
    detail: string,
  ): Stage => ({ detail, key, label, state: done ? "done" : current ? "current" : "waiting" });

  const overdue = submission.departureDeadline.slice(0, 10) < cairoToday();

  const stages = [
    stage(
      "submitted",
      "Submitted",
      true,
      false,
      submission.submittedAt
        ? formatPhoenixLongDate(submission.submittedAt)
        : "Recorded on your behalf",
    ),
    stage(
      "arrival",
      "Arrival photo",
      arrivalDone || photoExempt,
      gateBlocker === "arrival_photo",
      photoExempt
        ? "Not required — this trip was entered by an administrator, not submitted from the app"
        : arrivalDone
          ? "Captured at the destination"
          : "Missing. This one cannot be added later — ask a system administrator to release the request",
    ),
    stage(
      "departure",
      "Departure photo",
      departureDone || photoExempt,
      gateBlocker === "departure_photo",
      photoExempt
        ? "Not required for an administrator-entered trip"
        : departureDone
          ? submission.departureCapturedAt
            ? `Captured ${formatPhoenixLongDate(submission.departureCapturedAt)}`
            : "Captured"
          : overdue
            ? // Still offered, never withheld: the capture is accepted after the window and simply
              // reaches the approver flagged as late. Telling him it is too late would strand money
              // the system is perfectly willing to release.
              `Overdue — the window closed on ${formatPhoenixLongDate(submission.departureDeadline)}. You can still take it; it reaches your approver marked as late.`
            : `Take it before the end of ${formatPhoenixLongDate(submission.departureDeadline)}`,
    ),
    stage(
      "workload",
      "Field workload",
      workloadDone,
      gateBlocker === "workload",
      workloadDone
        ? `${fieldWorkloadLabel(submission)}${
            submission.workloadSource === "override" ? " (entered by an administrator)" : ""
          }`
        : "Phoenix reads your AM, PM and pharmacy visits for the trip days from Phoenix CRM. Visits saved later the same evening are picked up the next morning.",
    ),
    // Named "Validation", not "HR decision" (owner decision 2026-08-08). HR still owns this step
    // and nothing about who controls it has changed — but a manager reading his own expense should
    // see the STATE of his claim, not the department sitting in judgement on it. The vocabulary is
    // deliberately the same three words everywhere on this page: passed validation, pending,
    // rejected.
    stage(
      "decision",
      "Validation",
      decided,
      submission.isPayrollEligible && !decided,
      rejected
        ? "Rejected"
        : decided
          ? decision?.approvedAt
            ? `Passed validation — ${formatPhoenixLongDate(decision.approvedAt)}`
            : "Passed validation"
          : submission.isPayrollEligible
            ? "Pending"
            : "Pending — the trip is still held above",
    ),
    stage(
      "paid",
      "In payroll",
      paid,
      decided && !paid,
      paid
        ? decision?.payoutMonth && decision?.payoutYear
          ? `Included in ${String(decision.payoutMonth).padStart(2, "0")}/${decision.payoutYear} payroll`
          : "Included in a payroll batch"
        : "Not yet pulled into a payroll batch",
    ),
  ];
  return sequenceStages(
    noPhotoStages ? stages.filter((entry) => entry.key !== "arrival" && entry.key !== "departure") : stages,
  );
}

/**
 * The single headline for a row: what is happening to this trip right now.
 *
 * The GATE outranks the HR decision, and that order is the whole point. An expense row can carry
 * hr_approved while the request is still held for a photo — the two live in different tables and
 * answer different questions — and showing "Approved by HR" next to "waiting for the departure
 * photo" tells an employee his money is coming when nothing is moving. Whatever is actually
 * blocking the payment wins the headline; the approval is still shown in full in the detail.
 */
export function headlineStatus(submission: MyOutstationSubmission): {
  label: string;
  tone: "amber" | "emerald" | "rose" | "slate";
} {
  if (submission.decision?.paidAt) return { label: "Paid", tone: "emerald" };
  if (submission.status.toLowerCase().includes("reject")) return { label: "Rejected", tone: "rose" };
  if (submission.gateBlocker === "departure_photo") {
    return { label: "Departure photo needed", tone: "amber" };
  }
  if (submission.gateBlocker === "arrival_photo") return { label: "Held — no arrival photo", tone: "rose" };
  if (submission.gateBlocker === "workload") return { label: "Waiting on CRM workload", tone: "amber" };
  if (submission.gateBlocker === "inconsistent") return { label: "Held for an administrator", tone: "rose" };
  if (submission.decision?.hrApproved === true) return { label: "Passed validation", tone: "emerald" };
  return { label: "In review", tone: "slate" };
}

/**
 * A status is coloured small text on a thin rail at its left, never a filled pill. The rail colour
 * and the text colour travel together; STATUS_TEXT_CLASS carries the `border-l-2 pl-1.5` that shows it.
 */
export const TONE_CLASSES: Record<"amber" | "emerald" | "rose" | "slate", string> = {
  amber: "border-amber-400 text-amber-800",
  emerald: "border-emerald-500 text-emerald-700",
  rose: "border-rose-500 text-rose-700",
  slate: "border-slate-300 text-slate-600",
};

/** The status words themselves: small capitals, the tone's rail at the left. */
export const STATUS_TEXT_CLASS =
  "inline-flex max-w-full items-center break-words border-l-2 pl-1.5 text-phx-xs font-bold uppercase leading-tight tracking-[0.06em]";

/**
 * The row's answer to "what now, and what after", readable without opening the claim (owner,
 * 2026-10-22: "in every step, show him what should he do in this step and the next"). Something
 * the employee must do leads; otherwise the current stage says where the claim is. Null once every
 * stage is done.
 */
export function rowNowAndNext(
  stages: Stage[],
  action: { departureDue: boolean; ticketDue: boolean },
): { next: string | null; now: string; yours: boolean } | null {
  const currentIndex = stages.findIndex((stage) => stage.state === "current");
  if (currentIndex === -1) return null;
  const current = stages[currentIndex];
  const after = stages[currentIndex + 1] ?? null;
  if (action.departureDue) {
    return {
      next: action.ticketDue ? "Attach the ticket" : (stages.find((stage) => stage.key === "workload")?.label ?? null),
      now: "Take the departure photo before you leave the destination",
      yours: true,
    };
  }
  if (action.ticketDue) {
    return { next: current.label, now: "Attach the ticket this claim arrived without", yours: true };
  }
  return {
    next: after ? after.label : null,
    now: current.key === "workload" ? "Log your visits for the trip days in Phoenix CRM" : current.label,
    yours: current.key === "workload",
  };
}

export function Fact({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">
        {icon}
        {label}
      </p>
      <p className={`mt-1 break-words text-phx-md font-bold ${LANDING_INK}`} dir="auto">{value}</p>
    </div>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  // A step header: the orange tick, then the words in navy capitals.
  return <LandingTitle as="h3">{children}</LandingTitle>;
}

export function MyExpenseSubmissions({
  employeeHrId,
  submissions,
}: {
  employeeHrId: string;
  submissions: MyOutstationSubmission[];
}) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [photos, setPhotos] = useState<Record<number, PhotoState>>({});
  const [captured, setCaptured] = useState<number[]>([]);
  const [retakeFor, setRetakeFor] = useState<number | null>(null);
  // Tracked client-side so the control disappears the moment a retake lands, without a page
  // reload. The server is still the authority — a refresh re-reads the real state.
  const [retaken, setRetaken] = useState<number[]>([]);

  const loadPhotos = useCallback(
    async (id: number) => {
      setPhotos((current) => ({ ...current, [id]: { kind: "loading" } }));
      try {
        const response = await fetch(`/api/outstation/my-submissions/${id}/photos`);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.message || `Failed (${response.status})`);
        setPhotos((current) => ({
          ...current,
          [id]: {
            arrivalUrl: payload.arrivalUrl ?? null,
            departureUrl: payload.departureUrl ?? null,
            kind: "ready",
          },
        }));
      } catch (error) {
        setPhotos((current) => ({
          ...current,
          [id]: {
            kind: "error",
            message: error instanceof Error ? error.message : "The photos could not be loaded.",
          },
        }));
      }
    },
    [],
  );

  const toggle = useCallback(
    (id: number) => {
      const next = openId === id ? null : id;
      setOpenId(next);
      // Fetched only when a detail is actually opened, and only once — signed URLs cost a storage
      // call each, and this page routinely lists dozens of trips.
      if (next !== null && !photos[next]) void loadPhotos(next);
    },
    [loadPhotos, openId, photos],
  );

  // Counted, not just summed. With nothing validated the sum is 0, and "EGP 0" reads as "HR
  // approved nothing" rather than "HR has not looked at this yet" — on a screen about his own pay,
  // those two must never render the same. A claim counts here exactly when its row reads "Passed
  // validation" (isPassedValidation), at what payroll will pay for it.
  const totals = useMemo(() => summarizeMyClaims(submissions), [submissions]);

  if (submissions.length === 0) {
    return (
      <section className={`border border-slate-200 bg-white px-4 py-8 text-center ${adminSoftDepthClassName}`}>
        <Route aria-hidden="true" className="mx-auto h-7 w-7 text-slate-300" />
        <p className={`mt-3 text-phx-md font-bold ${LANDING_INK}`}>No outstation submissions yet</p>
        <p className="mt-1 text-phx-md text-slate-500">
          Claims you submit appear here, with their evidence, what each one waits for, and how it was validated.
        </p>
      </section>
    );
  }

  // The page's ONE navy board: the three totals, each a tile with its tone on a thin rail.
  const totalTileClass = `relative flex min-w-0 flex-col border border-white/[0.08] p-3 pl-3.5 ${LANDING_NAVY_TILE}`;

  return (
    <div className="space-y-3">
      <LandingNavyBoard label="Claim totals">
        <div className="@container">
          <div className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
            <div className={totalTileClass}>
              <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-white/30" />
              <p className="text-phx-xs font-bold uppercase tracking-[0.08em] text-white/65">You claimed</p>
              <div className="mt-1.5">
                <LandingFigure onNavy size="md">{money(totals.claimed)}</LandingFigure>
              </div>
              <p className="mt-1 text-phx-xs font-medium tabular-nums text-white/55">{claimsLabel(submissions.length)}</p>
            </div>
            <div className={totalTileClass}>
              <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-emerald-400" />
              <p className="text-phx-xs font-bold uppercase tracking-[0.08em] text-white/65">Passed validation</p>
              <div className="mt-1.5">
                <LandingFigure onNavy size="md" tone="text-emerald-300">
                  {totals.validatedCount > 0 ? money(totals.validatedAmount) : "—"}
                </LandingFigure>
              </div>
              <p className="mt-1 text-phx-xs font-medium tabular-nums text-white/55">
                {totals.validatedCount > 0
                  ? `${totals.validatedCount} of ${claimsLabel(submissions.length)}`
                  : "None validated yet"}
              </p>
            </div>
            <div className={totalTileClass}>
              <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-amber-400" />
              <p className="text-phx-xs font-bold uppercase tracking-[0.08em] text-white/65">Still held</p>
              <div className="mt-1.5">
                <LandingFigure onNavy size="md" tone="text-amber-300">{totals.awaiting}</LandingFigure>
              </div>
              <p className="mt-1 text-phx-xs font-medium text-white/55">Waiting on evidence or workload</p>
            </div>
          </div>
        </div>
      </LandingNavyBoard>

      <div className="space-y-2">
        {submissions.map((submission) => {
          const isOpen = openId === submission.id;
          const status = headlineStatus(submission);
          const stages = buildStages(submission);
          const photoState = photos[submission.id] ?? { kind: "idle" as const };
          const adjusted =
            submission.decision?.approvedAmount !== null &&
            submission.decision?.approvedAmount !== undefined &&
            Math.abs(submission.decision.approvedAmount - submission.claimedTotalAmount) > 0.005;
          const departureDue =
            submission.canCaptureDeparturePhoto && !captured.includes(submission.id);
          const ticketDue = submission.canAttachMissingTicket;
          const nowAndNext = rowNowAndNext(stages, { departureDue, ticketDue });

          return (
            <article
              className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}
              key={submission.id}
            >
              <button
                aria-expanded={isOpen}
                className={cn(
                  "flex w-full items-start justify-between gap-3 px-3 py-3.5 text-left transition-colors hover:bg-slate-50 motion-reduce:transition-none sm:px-4",
                  LANDING_FOCUS,
                )}
                onClick={() => toggle(submission.id)}
                type="button"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className={`text-phx-xs font-black tabular-nums tracking-[0.08em] ${LANDING_INK}`}>
                      OUTSTATION-{submission.id}
                    </span>
                    <span className={cn(STATUS_TEXT_CLASS, TONE_CLASSES[status.tone])}>
                      {status.label}
                    </span>
                    {departureDue || ticketDue ? (
                      <span className={cn(STATUS_TEXT_CLASS, "gap-1 border-[#08111f] font-black text-[#08111f]")}>
                        {departureDue ? <Camera aria-hidden="true" className="h-3 w-3" /> : <Ticket aria-hidden="true" className="h-3 w-3" />}
                        Action needed
                      </span>
                    ) : null}
                  </div>

                  <p className={`mt-2 break-words text-phx-md font-bold ${LANDING_INK}`} dir="auto">{readableAddress(submission.destination)}</p>
                  <p className="mt-0.5 text-phx-xs font-semibold tabular-nums text-slate-500">
                    {formatPhoenixLongDate(submission.tripStartDate)}
                    {submission.tripStartDate !== submission.tripEndDate
                      ? ` – ${formatPhoenixLongDate(submission.tripEndDate)}`
                      : ""}
                    {" · "}
                    {humanizeCode(submission.transportationType)}
                  </p>
                  {!submission.isPayrollEligible ? (
                    <p className="mt-1.5 break-words border-l-2 border-amber-400 pl-2 text-phx-md leading-relaxed text-amber-800">
                      {submission.gateMessage}
                    </p>
                  ) : null}
                  {nowAndNext ? (
                    <p className="mt-1.5 break-words text-phx-xs leading-relaxed text-slate-600">
                      <span
                        className={`font-black uppercase tracking-[0.08em] ${nowAndNext.yours ? LANDING_INK : "text-slate-500"}`}
                      >
                        Now
                      </span>{" "}
                      {nowAndNext.now}
                      {nowAndNext.next ? (
                        <>
                          {" · "}
                          <span className="font-black uppercase tracking-[0.08em] text-slate-500">Next</span>{" "}
                          {nowAndNext.next}
                        </>
                      ) : null}
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-start gap-2.5">
                  <div className="text-right">
                    <p className={`text-phx-md font-bold tabular-nums ${LANDING_INK}`}>
                      {money(submission.claimedTotalAmount)}
                    </p>
                    <p className="text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">
                      You claimed
                    </p>
                    {submission.decision?.approvedAmount !== null &&
                    submission.decision?.approvedAmount !== undefined ? (
                      <>
                        <p
                          className={`mt-1 text-phx-md font-bold tabular-nums ${adjusted ? "text-amber-700" : "text-emerald-700"}`}
                        >
                          {money(submission.decision.approvedAmount)}
                        </p>
                        <p className="text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">
                          Validated
                        </p>
                      </>
                    ) : null}
                  </div>
                  <ChevronDown
                    aria-hidden="true"
                    className={`mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition-transform motion-reduce:transition-none ${isOpen ? "rotate-180" : ""}`}
                  />
                </div>
              </button>

              {isOpen ? (
                <div className="space-y-5 border-t border-slate-200 bg-slate-50 px-3 py-4 sm:px-4">
                  {/* ── Where this trip has got to ─────────────────────────── */}
                  <section>
                    <SectionTitle>Progress</SectionTitle>
                    <ol className="mt-3 space-y-2.5">
                      {stages.map((stage) => (
                        <li className="flex items-start gap-3" key={stage.key}>
                          {/* An outlined square, never a filled chip: done carries the tick. */}
                          <span
                            aria-hidden="true"
                            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center bg-white ${
                              stage.state === "done"
                                ? "border border-emerald-600 text-emerald-700"
                                : stage.state === "current"
                                  ? "border-2 border-amber-500"
                                  : "border border-slate-300"
                            }`}
                          >
                            {stage.state === "done" ? <Check className="h-3 w-3" /> : null}
                          </span>
                          <div className="min-w-0">
                            <p
                              className={`text-phx-md font-bold ${
                                stage.state === "waiting" ? "text-slate-400" : LANDING_INK
                              }`}
                            >
                              {stage.label}
                            </p>
                            <p className="break-words text-xs leading-relaxed text-slate-500">{stage.detail}</p>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>

                  {/* ── The departure photo, capturable right here ──────────── */}
                  {departureDue ? (
                    <DeparturePhotoCard
                      employeeHrId={employeeHrId}
                      onCaptured={(id) => setCaptured((current) => [...current, id])}
                      requests={[
                        {
                          destination: submission.destination,
                          id: submission.id,
                          tripEndDate: submission.tripEndDate,
                          tripStartDate: submission.tripStartDate,
                        },
                      ]}
                    />
                  ) : null}

                  {/* ── The ticket this claim arrived without, attachable right here ─ */}
                  {ticketDue ? (
                    <MissingTicketCard
                      requests={[
                        {
                          destination: submission.destination,
                          id: submission.id,
                          transportationType: submission.transportationType,
                          tripEndDate: submission.tripEndDate,
                          tripStartDate: submission.tripStartDate,
                        },
                      ]}
                    />
                  ) : null}

                  {/* ── The trip ───────────────────────────────────────────── */}
                  <section>
                    <SectionTitle>Trip</SectionTitle>
                    <div className="mt-3 grid gap-4 sm:grid-cols-3">
                      <Fact icon={<MapPin className="h-3 w-3" />} label="From" value={readableAddress(submission.origin)} />
                      <Fact icon={<MapPin className="h-3 w-3" />} label="To" value={readableAddress(submission.destination)} />
                      <Fact
                        icon={<CalendarDays className="h-3 w-3" />}
                        label="Trip type"
                        value={
                          humanizeCode(submission.tripType) ||
                          (submission.sameDayTrip
                            ? "Same day"
                            : `Overnight · ${submission.overnightDays} night(s)`)
                        }
                      />
                      <Fact
                        icon={<Route className="h-3 w-3" />}
                        label="Distance"
                        value={submission.distanceKm !== null ? `${submission.distanceKm} km` : "—"}
                      />
                      <Fact
                        icon={<Clock className="h-3 w-3" />}
                        label="Field workload"
                        value={fieldWorkloadLabel(submission)}
                      />
                      <Fact label="Transport" value={humanizeCode(submission.transportationType)} />
                    </div>

                    {/* Where the GPS actually landed in Phoenix geography, split into its three
                        levels. The address string above is what the map service called the spot;
                        this is what the business calls it, and it is the one an approver argues
                        about. Derived from the coordinates against TODAY's brick tree. */}
                    <div className="mt-4 border-t border-slate-200 pt-3">
                      <p className="text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">
                        Captured location
                      </p>
                      <div className="mt-2 grid gap-4 sm:grid-cols-3">
                        <Fact
                          icon={<MapPin className="h-3 w-3" />}
                          label="Brick"
                          value={submission.capturedBrick}
                        />
                        <Fact label="Area" value={submission.capturedArea} />
                        <Fact label="Region" value={submission.capturedRegion} />
                      </div>
                      {submission.capturedConfidence ? (
                        // Always shown, never hidden behind a "good enough" threshold: bricks are
                        // stored as single centre points, so every match is a nearest-centroid
                        // guess, and a 40 km match in the desert must not read like a 200 m one.
                        <p className="mt-2 text-xs text-slate-500">
                          Match confidence: {submission.capturedConfidence}
                        </p>
                      ) : null}
                    </div>
                    {submission.notes ? (
                      <p className="mt-3 whitespace-pre-line break-words border-l-2 border-slate-300 pl-3 text-phx-md leading-relaxed text-slate-700" dir="auto">
                        {submission.notes}
                      </p>
                    ) : null}
                  </section>

                  {/* ── The journey's places, read-only: they are captured at the top of the page ── */}
                  {submission.journeyStops.length > 0 ? (
                    <section>
                      <SectionTitle>Journey</SectionTitle>
                      {submission.journey ? (
                        <div className={`mt-3 border border-slate-200 bg-white p-3 ${adminSoftDepthClassName}`}>
                          <p className="break-words text-phx-md leading-relaxed text-slate-700">
                            {submission.journey.modeReason}
                          </p>
                          <div className="mt-2">
                            <JourneyRouteLine legs={submission.journey.legs} />
                          </div>
                          {submission.journey.mode === "ticket_journey" ? null : (
                            <p className="mt-2 text-xs tabular-nums text-slate-600">
                              Fuel {money(submission.journey.fuelAmount)} · home to the first place and back would be{" "}
                              {money(submission.journey.singleDestinationFuelAmount)}
                            </p>
                          )}
                          {submission.journey.flagged ? (
                            <p className="mt-1.5 flex items-start gap-2 text-xs leading-relaxed text-amber-800">
                              <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                              Your approver will review this journey before it is paid.
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                      <ol className="mt-3 space-y-1.5 text-xs text-slate-600">
                        {submission.journeyStops.map((stop) => (
                          <li className="break-words" key={stop.stopNumber}>
                            <span className={`font-bold ${LANDING_INK}`}>{stop.governorate ?? "Next place"}</span>
                            {stop.locationLabel ? ` · ${readableAddress(stop.locationLabel)}` : ""}
                            {` · ${formatPhoenixLongDate(stop.capturedAt)}`}
                            {stop.evidence === "live_photo"
                              ? " · live photo"
                              : stop.evidence === "location_ticket"
                                ? ` · location and ticket, ${money(stop.ticketAmount)}`
                                : " · location"}
                          </li>
                        ))}
                      </ol>
                    </section>
                  ) : null}

                  {/* ── The money, both figures side by side ───────────────── */}
                  <section>
                    <SectionTitle>Money</SectionTitle>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div className={`min-w-0 border border-slate-200 bg-white p-3 ${adminSoftDepthClassName}`}>
                        <p className="flex items-center gap-1.5 text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">
                          <Wallet aria-hidden="true" className="h-3 w-3" />
                          You claimed
                        </p>
                        <div className="mt-1.5">
                          <LandingFigure size="md">{money(submission.claimedTotalAmount)}</LandingFigure>
                        </div>
                        <dl className="mt-3 space-y-1 text-xs text-slate-600">
                          {claimMoneyRows(submission).map((row) => (
                            <div className="flex justify-between gap-3" key={row.label}>
                              <dt className="min-w-0 break-words">{row.label}</dt>
                              <dd className={`shrink-0 font-bold tabular-nums ${LANDING_INK}`}>{money(row.amount)}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>

                      {/* An adjusted figure carries an amber rail at its left, never an amber fill. */}
                      <div className={`relative min-w-0 border border-slate-200 bg-white p-3 ${adminSoftDepthClassName}`}>
                        {adjusted ? <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-amber-400" /> : null}
                        <p className="flex items-center gap-1.5 text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">
                          <CircleDollarSign aria-hidden="true" className="h-3 w-3" />
                          Validated
                        </p>
                        {submission.decision?.approvedAmount !== null &&
                        submission.decision?.approvedAmount !== undefined ? (
                          <>
                            <div className="mt-1.5">
                              <LandingFigure size="md" tone={adjusted ? "text-amber-800" : "text-emerald-700"}>
                                {money(submission.decision.approvedAmount)}
                              </LandingFigure>
                            </div>
                            {adjusted ? (
                              <p className="mt-1 text-xs font-bold tabular-nums text-amber-800">
                                Adjusted from {money(submission.claimedTotalAmount)}
                              </p>
                            ) : null}
                          </>
                        ) : (
                          <p className="mt-1 text-phx-md font-bold text-slate-400">Pending</p>
                        )}

                        {submission.decision?.hrComment || submission.decision?.hrNotes ? (
                          <div className="mt-3 border-l-2 border-slate-300 pl-2.5">
                            <p className="text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">
                              Note
                            </p>
                            <p className="mt-1 whitespace-pre-line break-words text-phx-md leading-relaxed text-slate-800" dir="auto">
                              {submission.decision.hrComment ?? submission.decision.hrNotes}
                            </p>
                          </div>
                        ) : null}

                        {submission.decision?.paidAt ? (
                          <p className="mt-3 text-xs font-bold tabular-nums text-emerald-700">
                            Paid — {formatPhoenixLongDate(submission.decision.paidAt)}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </section>

                  {/* ── The two photos, side by side, as the approver sees them ── */}
                  {submission.photosWaived && !submission.hasArrivalPhoto && !submission.hasDeparturePhoto ? null : (
                  <section>
                    <SectionTitle>Evidence</SectionTitle>
                    {photoState.kind === "loading" ? (
                      <p className="mt-3 flex items-center gap-2 text-phx-md text-slate-500">
                        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                        Loading your photos…
                      </p>
                    ) : null}
                    {photoState.kind === "error" ? (
                      <p className="mt-3 flex items-start gap-2 text-phx-md text-rose-700">
                        <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                        {photoState.message}
                      </p>
                    ) : null}
                    {photoState.kind === "ready" ? (
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        {[
                          {
                            at: null as string | null,
                            label: "Arrival photo",
                            url: photoState.arrivalUrl,
                          },
                          {
                            at: submission.departureCapturedAt,
                            label: "Departure photo",
                            url: photoState.departureUrl,
                          },
                        ].map((photo) => (
                          <figure
                            className={`min-w-0 overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}
                            key={photo.label}
                          >
                            {photo.url ? (
                              // A short-lived signed storage URL cannot go through next/image:
                              // the optimizer would need to fetch it server-side, and the URL
                              // expires. eslint-disable must be ONE line — split across two it
                              // disables the comment beneath it, not the element.
                              <ZoomablePhoto
                                alt={`${photo.label} for OUTSTATION-${submission.id}`}
                                caption={`${photo.label} · OUTSTATION-${submission.id}`}
                                className="max-h-72 w-full object-contain bg-slate-900"
                                src={photo.url}
                              />
                            ) : (
                              <div className="flex h-32 items-center justify-center gap-2 text-xs font-bold text-slate-400">
                                <ImageOff aria-hidden="true" className="h-4 w-4" />
                                Not captured
                              </div>
                            )}
                            <figcaption className="border-t border-slate-200 p-2.5">
                              <p className={`text-phx-xs font-black uppercase tracking-[0.08em] ${LANDING_INK}`}>
                                {photo.label}
                              </p>
                              {photo.at ? (
                                <p className="mt-0.5 text-xs tabular-nums text-slate-500">
                                  {formatPhoenixLongDate(photo.at)}
                                </p>
                              ) : null}
                            </figcaption>
                          </figure>
                        ))}
                      </div>
                    ) : null}

                    {submission.hasDeparturePhoto ? (
                      <p className="mt-2 text-xs tabular-nums text-slate-500">
                        {submission.departureDistanceFromArrivalKm !== null
                          ? `${submission.departureDistanceFromArrivalKm} km from the arrival photo`
                          : "Distance from the arrival photo unknown"}
                        {submission.departureMinutesAfterArrival !== null
                          ? ` · ${submission.departureMinutesAfterArrival} minute(s) later`
                          : ""}
                      </p>
                    ) : null}
                    {submission.departureFlags.length > 0 ? (
                      <p className="mt-1.5 flex items-start gap-2 text-xs leading-relaxed text-amber-800">
                        <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        Flagged for the approver to look at. This does not block your payment.
                      </p>
                    ) : null}

                    {/* Told to the EMPLOYEE, not only the approver. He should know the earlier
                        photo survives BEFORE he decides to retake — a retake that felt like a
                        delete would be the wrong thing to believe about his own evidence. */}
                    {submission.departureRetakeCount > 0 ? (
                      <p className="mt-1.5 text-xs text-slate-500">
                        Retaken {submission.departureRetakeCount}{" "}
                        {submission.departureRetakeCount === 1 ? "time" : "times"} — every version is
                        kept and stays visible to your approver.
                      </p>
                    ) : null}

                    {submission.canRetakeDeparturePhoto && !retaken.includes(submission.id) ? (
                      retakeFor === submission.id ? (
                        <div className="mt-3">
                          <DeparturePhotoCard
                            employeeHrId={employeeHrId}
                            mode="retake"
                            onCaptured={(id) => {
                              setRetaken((current) => [...current, id]);
                              setRetakeFor(null);
                            }}
                            requests={[
                              {
                                destination: submission.destination,
                                id: submission.id,
                                tripEndDate: submission.tripEndDate,
                                tripStartDate: submission.tripStartDate,
                              },
                            ]}
                          />
                          <button
                            className={cn(
                              "mt-2 min-h-10 px-3 text-xs font-bold text-slate-600 transition-colors hover:text-[#08111f] motion-reduce:transition-none",
                              LANDING_FOCUS,
                            )}
                            onClick={() => setRetakeFor(null)}
                            type="button"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          className={landingActionClassName("outline", "mt-3")}
                          onClick={() => setRetakeFor(submission.id)}
                          type="button"
                        >
                          <Camera aria-hidden="true" className="h-3.5 w-3.5" />
                          Retake the departure photo
                        </button>
                      )
                    ) : null}

                    {submission.hasDeparturePhoto && !submission.canRetakeDeparturePhoto ? (
                      // Says WHY instead of just hiding the control. A button that silently is not
                      // there is what sends people to an administrator asking for a waiver.
                      <p className="mt-2 text-xs text-slate-500">
                        The retake window closed at the end of{" "}
                        {formatPhoenixLongDate(submission.departureDeadline)}. Ask a system
                        administrator if this photo needs changing.
                      </p>
                    ) : null}
                  </section>
                  )}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
