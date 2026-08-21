import { terminalApplicationStages } from "@/lib/recruitment/types";

// Recruitment / ATS — the three numbers that say whether hiring is actually moving.
//
// Everything the module counted before this was a size: how many requisitions, how many
// applications, how many candidates. None of them answer the question a hiring manager asks, which
// is "is this taking too long, and where is it stuck". These three do:
//
//   · how long a hire takes, end to end;
//   · how many applications nobody has touched in a fortnight;
//   · how many offers went out, and how many came back accepted.
//
// All three are derived from the applications the dashboard already loads. No extra query, no
// stored aggregate, nothing to keep in step — the pipeline has held 7 applications in its lifetime,
// so anything heavier than arithmetic over an array in memory would be building for a load that
// does not exist.

/** An application untouched for this long is stalled. Two working weeks, and a round number. */
export const STALLED_AFTER_DAYS = 14;

export type PipelineMeasurement = {
  createdAt: string;
  lastStageChangedAt: string;
  stage: string;
};

export type PipelineMetrics = {
  /** Hires the time-to-hire figure was measured from. Shown so a median of 1 never reads as a rule. */
  hiresMeasured: number;
  medianDaysToHire: number | null;
  offersAccepted: number;
  offersSent: number;
  stalled: number;
  stalledAfterDays: number;
};

/**
 * An offer has left the building by the time an application reaches any of these.
 *
 * This reads the application's CURRENT stage, which is the honest limit of it: an offer that was
 * sent and then went to `application_rejected` is not counted, because the stage no longer says an
 * offer happened. The full answer lives in ats_application_events and costs a query and a scan per
 * application — not worth it against a pipeline that has held 7 applications in its lifetime, and
 * the moment it is, this is the one comment to come back to.
 */
const offerSentStages = new Set<string>([
  "offer_sent",
  "offer_negotiation",
  "offer_accepted",
  "offer_declined",
  "offer_expired",
  "pre_boarding",
  "hired",
]);

/** Accepted, and everything that can only be reached by accepting. */
const offerAcceptedStages = new Set<string>(["offer_accepted", "pre_boarding", "hired"]);
// The one list of finished stages, not a copy of it — a second list here would drift the day a
// stage is added, and "stalled" would quietly start counting applications nobody is waiting on.
const finishedStages = new Set<string>(terminalApplicationStages);

/** Whole days between two timestamps, or null if either is unreadable. Never negative. */
export function wholeDaysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  const start = from ? new Date(from).getTime() : Number.NaN;
  const end = to ? new Date(to).getTime() : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

/** How long this application has been sitting where it is. */
export function daysInStage(application: PipelineMeasurement, nowIso: string): number | null {
  return wholeDaysBetween(application.lastStageChangedAt, nowIso);
}

/**
 * The middle value, not the average.
 *
 * One application that sat for eight months would drag a mean far enough to describe a pipeline
 * nobody recognises, and with a handful of hires that outlier is guaranteed to be over-represented.
 */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function computePipelineMetrics(
  applications: readonly PipelineMeasurement[],
  nowIso: string,
): PipelineMetrics {
  const daysToHire: number[] = [];
  let offersSent = 0;
  let offersAccepted = 0;
  let stalled = 0;

  for (const application of applications) {
    if (offerSentStages.has(application.stage)) offersSent += 1;
    if (offerAcceptedStages.has(application.stage)) offersAccepted += 1;

    if (application.stage === "hired") {
      // `hired` is terminal, so the last stage change IS the moment of the hire — no event history
      // needed to date it.
      const days = wholeDaysBetween(application.createdAt, application.lastStageChangedAt);
      if (days !== null) daysToHire.push(days);
      continue;
    }

    // Only live applications can stall. A rejected one is not waiting for anybody, and counting it
    // would leave the number climbing forever on work that is finished.
    if (finishedStages.has(application.stage)) continue;
    const waiting = daysInStage(application, nowIso);
    if (waiting !== null && waiting >= STALLED_AFTER_DAYS) stalled += 1;
  }

  return {
    hiresMeasured: daysToHire.length,
    medianDaysToHire: median(daysToHire),
    offersAccepted,
    offersSent,
    stalled,
    stalledAfterDays: STALLED_AFTER_DAYS,
  };
}
