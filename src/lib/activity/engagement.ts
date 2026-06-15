// Transparent, explainable engagement scoring for the Activity Control Center.
//
// This is intentionally NOT a surveillance verdict. It blends three observable,
// defensible signals into a 0-100 score and a coarse band, and exposes each
// component so the UI can show exactly how the number was reached:
//   • active ratio  — how much of the logged-in time was spent actively on pages
//   • breadth       — how many distinct modules the person touched
//   • depth         — how many pages they navigated through
//
// It says nothing about WHAT the person did inside a module, the quality of their
// work, or anything off-system. Treat it as a usage indicator, not a performance
// rating.

/** A single page dwell longer than this is treated as "left the tab open", not
 * active work — capped so one forgotten tab can't inflate active time. */
export const ACTIVE_VIEW_CAP_SECONDS = 30 * 60;

const WEIGHTS = {
  activeRatio: 0.55,
  breadth: 0.2,
  depth: 0.25,
} as const;

/** Distinct modules at/above this count earns full breadth credit. */
const BREADTH_TARGET = 5;
/** Page views at/above this count earns full depth credit. */
const DEPTH_TARGET = 25;

export type EngagementBand = "Low" | "Moderate" | "High";

export type EngagementInput = {
  /** Sum of per-page dwell time (each page already capped), in seconds. */
  activeSeconds: number;
  /** Total logged-in time for the period, in seconds (from app_sessions). */
  sessionSeconds: number;
  /** Count of distinct modules visited. */
  distinctModules: number;
  /** Total page views recorded. */
  pageViews: number;
};

export type EngagementResult = {
  score: number;
  band: EngagementBand;
  activeRatio: number;
  breadthScore: number;
  depthScore: number;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

/** Cap a single page dwell so a forgotten open tab cannot dominate active time. */
export function cappedDwellSeconds(durationMs: number | null | undefined): number {
  const seconds = Math.round(Number(durationMs ?? 0) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds, ACTIVE_VIEW_CAP_SECONDS);
}

export function bandForScore(score: number): EngagementBand {
  if (score >= 66) return "High";
  if (score >= 33) return "Moderate";
  return "Low";
}

export function computeEngagement(input: EngagementInput): EngagementResult {
  const activeSeconds = Math.max(0, Number(input.activeSeconds) || 0);
  const sessionSeconds = Math.max(0, Number(input.sessionSeconds) || 0);
  const distinctModules = Math.max(0, Number(input.distinctModules) || 0);
  const pageViews = Math.max(0, Number(input.pageViews) || 0);

  // If we have no session-duration baseline, fall back to "any active time = engaged".
  const activeRatio = sessionSeconds > 0
    ? clamp01(activeSeconds / sessionSeconds)
    : (activeSeconds > 0 ? 1 : 0);

  const breadthScore = clamp01(distinctModules / BREADTH_TARGET);
  const depthScore = clamp01(pageViews / DEPTH_TARGET);

  const weighted =
    WEIGHTS.activeRatio * activeRatio +
    WEIGHTS.breadth * breadthScore +
    WEIGHTS.depth * depthScore;

  const score = Math.round(100 * clamp01(weighted));

  return {
    score,
    band: bandForScore(score),
    activeRatio,
    breadthScore,
    depthScore,
  };
}
