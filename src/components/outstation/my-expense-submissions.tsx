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
  TriangleAlert,
  Wallet,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { DeparturePhotoCard } from "@/components/outstation/departure-photo-card";
import type { MyOutstationSubmission } from "@/lib/outstation/service";
import { formatPhoenixLongDate } from "@/lib/i18n/format";

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

const EGP = new Intl.NumberFormat("en-EG", {
  currency: "EGP",
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
  style: "currency",
});

function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return EGP.format(value);
}

type PhotoState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; arrivalUrl: string | null; departureUrl: string | null }
  | { kind: "error"; message: string };

/** Where a submission has got to. Drives both the row pill and the timeline. */
type StageKey = "submitted" | "arrival" | "departure" | "workload" | "decision" | "paid";

type Stage = {
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

function buildStages(submission: MyOutstationSubmission): Stage[] {
  const { decision, gateBlocker } = submission;

  const arrivalDone = submission.hasArrivalPhoto;
  const departureDone = submission.hasDeparturePhoto;
  const workloadDone = gateBlocker !== "workload" && submission.isPayrollEligible;
  const decided = decision?.hrApproved === true || decision?.approvedAmount !== null;
  const paid = Boolean(decision?.paidAt);

  // A grandfathered row never had a photo step. Saying "waiting for the arrival photo" about a
  // trip nobody can photograph any more is exactly the message that sent people looking for a
  // control that does not exist.
  const photoExempt = !arrivalDone && submission.isPayrollEligible;

  const stage = (
    key: StageKey,
    label: string,
    done: boolean,
    current: boolean,
    detail: string,
  ): Stage => ({ detail, key, label, state: done ? "done" : current ? "current" : "waiting" });

  const overdue = submission.departureDeadline.slice(0, 10) < cairoToday();

  return sequenceStages([
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
          : "Missing. This one cannot be added later — ask HR to release the request",
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
        ? `AM ${submission.amWorkload} · PM ${submission.pmWorkload}${
            submission.workloadSource === "override" ? " (entered by an administrator)" : ""
          }`
        : "Waiting for your visits to be matched from the CRM",
    ),
    stage(
      "decision",
      "HR decision",
      decided,
      submission.isPayrollEligible && !decided,
      decided
        ? decision?.approvedAt
          ? `Decided ${formatPhoenixLongDate(decision.approvedAt)}`
          : "Decided"
        : submission.isPayrollEligible
          ? "In the approval queue"
          : "Not reviewed yet — the trip is still held above",
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
  ]);
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
function headlineStatus(submission: MyOutstationSubmission): {
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
  if (submission.decision?.hrApproved === true) return { label: "Approved by HR", tone: "emerald" };
  return { label: "In review", tone: "slate" };
}

const TONE_CLASSES: Record<"amber" | "emerald" | "rose" | "slate", string> = {
  amber: "bg-amber-100 text-amber-800",
  emerald: "bg-emerald-100 text-emerald-800",
  rose: "bg-rose-100 text-rose-800",
  slate: "bg-slate-100 text-slate-700",
};

function Fact({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-sm font-bold text-slate-900">{value}</p>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-black uppercase tracking-wider text-slate-500">{children}</h3>
  );
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

  const totals = useMemo(() => {
    let claimed = 0;
    let approved = 0;
    let approvedCount = 0;
    let awaiting = 0;
    for (const submission of submissions) {
      claimed += submission.claimedTotalAmount;
      const amount = submission.decision?.approvedAmount;
      // Counted, not just summed. With nothing decided the sum is 0, and "EGP 0" reads as "HR
      // approved nothing" rather than "HR has not looked at this yet" — on a screen about his own
      // pay, those two must never render the same.
      if (amount !== null && amount !== undefined) {
        approved += amount;
        approvedCount += 1;
      }
      if (!submission.isPayrollEligible) awaiting += 1;
    }
    return { approved, approvedCount, awaiting, claimed };
  }, [submissions]);

  if (submissions.length === 0) {
    return (
      <section className="rounded-lg border border-slate-200 bg-white p-8 text-center">
        <Route className="mx-auto h-8 w-8 text-slate-300" />
        <p className="mt-3 text-sm font-bold text-slate-900">No outstation submissions yet</p>
        <p className="mt-1 text-[13px] text-slate-500">
          Trips you submit from Submit Expense appear here, with their evidence and what HR decided.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">You claimed</p>
          <p className="mt-1 text-2xl font-black text-slate-900">{money(totals.claimed)}</p>
          <p className="mt-0.5 text-xs text-slate-500">{submissions.length} submissions</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">HR approved</p>
          <p className="mt-1 text-2xl font-black text-emerald-700">
            {totals.approvedCount > 0 ? money(totals.approved) : "—"}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {totals.approvedCount > 0
              ? `${totals.approvedCount} of ${submissions.length} decided`
              : "Nothing decided yet"}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Still held</p>
          <p className="mt-1 text-2xl font-black text-amber-700">{totals.awaiting}</p>
          <p className="mt-0.5 text-xs text-slate-500">Waiting on evidence or workload</p>
        </div>
      </section>

      <div className="space-y-3">
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

          return (
            <article
              className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)]"
              key={submission.id}
            >
              <button
                aria-expanded={isOpen}
                className="flex w-full items-start justify-between gap-3 p-4 text-left hover:bg-slate-50 sm:p-5"
                onClick={() => toggle(submission.id)}
                type="button"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-black tracking-wider text-white">
                      OUTSTATION-{submission.id}
                    </span>
                    <span
                      className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${TONE_CLASSES[status.tone]}`}
                    >
                      {status.label}
                    </span>
                    {departureDue ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-orange-500 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-white">
                        <Camera className="h-3 w-3" />
                        Action needed
                      </span>
                    ) : null}
                  </div>

                  <p className="mt-2 text-sm font-black text-slate-900">{submission.destination}</p>
                  <p className="mt-0.5 text-xs font-semibold text-slate-500">
                    {formatPhoenixLongDate(submission.tripStartDate)}
                    {submission.tripStartDate !== submission.tripEndDate
                      ? ` – ${formatPhoenixLongDate(submission.tripEndDate)}`
                      : ""}
                    {" · "}
                    {submission.transportationType}
                  </p>
                  {!submission.isPayrollEligible ? (
                    <p className="mt-1.5 text-[13px] leading-relaxed text-amber-800">
                      {submission.gateMessage}
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  <div className="text-right">
                    <p className="text-sm font-black text-slate-900">
                      {money(submission.claimedTotalAmount)}
                    </p>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      You claimed
                    </p>
                    {submission.decision?.approvedAmount !== null &&
                    submission.decision?.approvedAmount !== undefined ? (
                      <>
                        <p
                          className={`mt-1 text-sm font-black ${adjusted ? "text-amber-700" : "text-emerald-700"}`}
                        >
                          {money(submission.decision.approvedAmount)}
                        </p>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                          HR approved
                        </p>
                      </>
                    ) : null}
                  </div>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
                  />
                </div>
              </button>

              {isOpen ? (
                <div className="space-y-6 border-t border-slate-200 bg-slate-50/60 p-4 sm:p-5">
                  {/* ── Where this trip has got to ─────────────────────────── */}
                  <section>
                    <SectionTitle>Progress</SectionTitle>
                    <ol className="mt-3 space-y-2.5">
                      {stages.map((stage) => (
                        <li className="flex items-start gap-3" key={stage.key}>
                          <span
                            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-black ${
                              stage.state === "done"
                                ? "bg-emerald-500 text-white"
                                : stage.state === "current"
                                  ? "bg-amber-500 text-white"
                                  : "bg-slate-200 text-slate-500"
                            }`}
                          >
                            {stage.state === "done" ? <Check className="h-3 w-3" /> : null}
                          </span>
                          <div className="min-w-0">
                            <p
                              className={`text-[13px] font-bold ${
                                stage.state === "waiting" ? "text-slate-400" : "text-slate-900"
                              }`}
                            >
                              {stage.label}
                            </p>
                            <p className="text-xs leading-relaxed text-slate-500">{stage.detail}</p>
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

                  {/* ── The trip ───────────────────────────────────────────── */}
                  <section>
                    <SectionTitle>Trip</SectionTitle>
                    <div className="mt-3 grid gap-4 sm:grid-cols-3">
                      <Fact icon={<MapPin className="h-3 w-3" />} label="From" value={submission.origin} />
                      <Fact icon={<MapPin className="h-3 w-3" />} label="To" value={submission.destination} />
                      <Fact
                        icon={<CalendarDays className="h-3 w-3" />}
                        label="Trip type"
                        value={
                          submission.tripType ??
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
                        value={`AM ${submission.amWorkload} · PM ${submission.pmWorkload}`}
                      />
                      <Fact label="Transport" value={submission.transportationType} />
                    </div>

                    {/* Where the GPS actually landed in Phoenix geography, split into its three
                        levels. The address string above is what the map service called the spot;
                        this is what the business calls it, and it is the one an approver argues
                        about. Derived from the coordinates against TODAY's brick tree. */}
                    <div className="mt-4 rounded-md border border-slate-200 bg-white p-3">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
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
                      <p className="mt-3 whitespace-pre-line rounded-md border border-slate-200 bg-white p-3 text-[13px] leading-relaxed text-slate-700">
                        {submission.notes}
                      </p>
                    ) : null}
                  </section>

                  {/* ── The money, both figures side by side ───────────────── */}
                  <section>
                    <SectionTitle>Money</SectionTitle>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div className="rounded-md border border-slate-200 bg-white p-3">
                        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                          <Wallet className="h-3 w-3" />
                          You claimed
                        </p>
                        <p className="mt-1 text-xl font-black text-slate-900">
                          {money(submission.claimedTotalAmount)}
                        </p>
                        <dl className="mt-3 space-y-1 text-xs text-slate-600">
                          <div className="flex justify-between gap-3">
                            <dt>Travel</dt>
                            <dd className="font-bold text-slate-900">{money(submission.travelCost)}</dd>
                          </div>
                          <div className="flex justify-between gap-3">
                            <dt>Ticket</dt>
                            <dd className="font-bold text-slate-900">{money(submission.ticketAmount)}</dd>
                          </div>
                          <div className="flex justify-between gap-3">
                            <dt>Meeting</dt>
                            <dd className="font-bold text-slate-900">{money(submission.meetingAmount)}</dd>
                          </div>
                          <div className="flex justify-between gap-3">
                            <dt>Other</dt>
                            <dd className="font-bold text-slate-900">{money(submission.otherAmount)}</dd>
                          </div>
                          <div className="flex justify-between gap-3">
                            <dt>Allowance</dt>
                            <dd className="font-bold text-slate-900">{money(submission.allowanceAmount)}</dd>
                          </div>
                        </dl>
                      </div>

                      <div
                        className={`rounded-md border p-3 ${
                          adjusted ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white"
                        }`}
                      >
                        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                          <CircleDollarSign className="h-3 w-3" />
                          HR approved
                        </p>
                        {submission.decision?.approvedAmount !== null &&
                        submission.decision?.approvedAmount !== undefined ? (
                          <>
                            <p
                              className={`mt-1 text-xl font-black ${adjusted ? "text-amber-800" : "text-emerald-700"}`}
                            >
                              {money(submission.decision.approvedAmount)}
                            </p>
                            {adjusted ? (
                              <p className="mt-1 text-xs font-bold text-amber-800">
                                Adjusted from {money(submission.claimedTotalAmount)}
                              </p>
                            ) : null}
                          </>
                        ) : (
                          <p className="mt-1 text-sm font-bold text-slate-400">Not decided yet</p>
                        )}

                        {submission.decision?.hrComment || submission.decision?.hrNotes ? (
                          <div className="mt-3 rounded border border-slate-200 bg-white p-2.5">
                            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                              HR comment
                            </p>
                            <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-slate-800">
                              {submission.decision.hrComment ?? submission.decision.hrNotes}
                            </p>
                          </div>
                        ) : null}

                        {submission.decision?.paidAt ? (
                          <p className="mt-3 text-xs font-bold text-emerald-700">
                            Paid — {formatPhoenixLongDate(submission.decision.paidAt)}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </section>

                  {/* ── The two photos, side by side, as the approver sees them ── */}
                  <section>
                    <SectionTitle>Evidence</SectionTitle>
                    {photoState.kind === "loading" ? (
                      <p className="mt-3 flex items-center gap-2 text-[13px] text-slate-500">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading your photos…
                      </p>
                    ) : null}
                    {photoState.kind === "error" ? (
                      <p className="mt-3 flex items-start gap-2 text-[13px] text-rose-700">
                        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
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
                            className="overflow-hidden rounded-md border border-slate-200 bg-white"
                            key={photo.label}
                          >
                            {photo.url ? (
                              // A short-lived signed storage URL cannot go through next/image:
                              // the optimizer would need to fetch it server-side, and the URL
                              // expires. eslint-disable must be ONE line — split across two it
                              // disables the comment beneath it, not the element.
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                alt={`${photo.label} for OUTSTATION-${submission.id}`}
                                className="max-h-72 w-full object-contain bg-slate-900"
                                src={photo.url}
                              />
                            ) : (
                              <div className="flex h-32 items-center justify-center gap-2 text-xs font-bold text-slate-400">
                                <ImageOff className="h-4 w-4" />
                                Not captured
                              </div>
                            )}
                            <figcaption className="border-t border-slate-200 p-2.5">
                              <p className="text-[11px] font-black uppercase tracking-wider text-slate-600">
                                {photo.label}
                              </p>
                              {photo.at ? (
                                <p className="mt-0.5 text-xs text-slate-500">
                                  {formatPhoenixLongDate(photo.at)}
                                </p>
                              ) : null}
                            </figcaption>
                          </figure>
                        ))}
                      </div>
                    ) : null}

                    {submission.hasDeparturePhoto ? (
                      <p className="mt-2 text-xs text-slate-500">
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
                        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        Flagged for the approver to look at. This does not block your payment.
                      </p>
                    ) : null}
                  </section>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
