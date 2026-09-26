import type { ModuleJourney, ModuleTotal, ModuleTransition } from "./types";

/**
 * One page view, reduced to the four things a journey needs.
 *
 * Deliberately NOT the service's own `EventRow`: this module is pure so it can
 * be tested without a database, exactly like `dwell-union.ts` beside it, and a
 * structural type keeps the caller free to pass whatever row shape it holds.
 */
export type JourneyEvent = {
  moduleKey: string;
  moduleLabel: string;
  /** When the beacon was recorded. */
  createdAt: string;
  /** When the page became visible; null on the rare row that carried none. */
  enteredAt: string | null;
  /** Wall-clock seconds no other page view of the same person covers. */
  creditedSeconds: number;
};

/**
 * Where one person's time went, and in what ORDER — the owner's 2026-09-26 ask:
 * "know everyone entered which module and track his workflow between modules and
 * stayed how much per module".
 *
 * Built from the SAME credited seconds as every other active figure, so the
 * totals column sums to the person's own Active minutes instead of being a
 * second measurement that disagrees with the first. A module's time is therefore
 * wall-clock time with that module foregrounded, never the sum of two windows.
 *
 * `events` must already be ascending by created_at — getUserTimeline orders the
 * read that way, and the run collapse below is meaningless on unsorted rows.
 */
export function buildModuleJourney(events: JourneyEvent[]): ModuleJourney {
  // ── Runs ────────────────────────────────────────────────────────────────────
  // Consecutive views of the SAME module collapse into one run. Leaving a module
  // and coming back is deliberately two runs: that return is the switching the
  // journey exists to show, and merging them would hide it.
  type Run = { key: string; label: string; startIso: string; endIso: string; seconds: number; views: number };
  const runs: Run[] = [];
  for (const event of events) {
    const seconds = event.creditedSeconds;
    const last = runs[runs.length - 1];
    if (last && last.key === event.moduleKey) {
      last.seconds += seconds;
      last.views += 1;
      if (event.createdAt > last.endIso) last.endIso = event.createdAt;
      continue;
    }
    runs.push({
      key: event.moduleKey,
      label: event.moduleLabel,
      // enteredAt when the beacon carried one — it is when the page was actually
      // opened, while created_at is when the browser got round to reporting it.
      startIso: event.enteredAt ?? event.createdAt,
      endIso: event.createdAt,
      seconds,
      views: 1,
    });
  }

  // ── Totals ──────────────────────────────────────────────────────────────────
  const totalSeconds = runs.reduce((sum, run) => sum + run.seconds, 0);
  const totalsByKey = new Map<string, ModuleTotal & { key: string }>();
  for (const run of runs) {
    const existing = totalsByKey.get(run.key);
    if (existing) {
      existing.seconds += run.seconds;
      existing.views += run.views;
      existing.visits += 1;
      if (run.startIso < existing.firstAtIso) existing.firstAtIso = run.startIso;
      if (run.endIso > existing.lastAtIso) existing.lastAtIso = run.endIso;
      continue;
    }
    totalsByKey.set(run.key, {
      key: run.key,
      moduleLabel: run.label,
      seconds: run.seconds,
      views: run.views,
      visits: 1,
      firstAtIso: run.startIso,
      lastAtIso: run.endIso,
      sharePct: 0,
    });
  }
  const totals = Array.from(totalsByKey.values())
    .map(({ key: _key, ...total }) => ({
      ...total,
      // Against the person's OWN total, never the company's — this answers "how
      // much of YOUR time went here", which is the only share that is meaningful
      // on one person's drawer.
      sharePct: totalSeconds > 0 ? Math.round((total.seconds / totalSeconds) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.seconds - a.seconds || b.views - a.views);

  // ── Transitions ─────────────────────────────────────────────────────────────
  // Every move from one module straight into another. A run never follows itself,
  // so no self-transition can be counted.
  const transitionCounts = new Map<string, ModuleTransition>();
  for (let i = 1; i < runs.length; i += 1) {
    const from = runs[i - 1];
    const to = runs[i];
    // JSON, not a delimiter character: a module key is free text, and the
    // separator that looked safest here was a raw NUL, which git and grep then
    // treat as a binary file and skip SILENTLY (tests/ pins exactly that).
    const key = JSON.stringify([from.key, to.key]);
    const existing = transitionCounts.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    transitionCounts.set(key, { fromLabel: from.label, toLabel: to.label, count: 1 });
  }
  const transitions = Array.from(transitionCounts.values()).sort(
    (a, b) => b.count - a.count || a.fromLabel.localeCompare(b.fromLabel) || a.toLabel.localeCompare(b.toLabel),
  );

  return {
    totals,
    // Newest first, matching the session list the drawer already reads that way.
    visits: runs
      .map((run) => ({
        moduleLabel: run.label,
        startedAtIso: run.startIso,
        endedAtIso: run.endIso,
        seconds: run.seconds,
        views: run.views,
      }))
      .reverse(),
    transitions,
  };
}
