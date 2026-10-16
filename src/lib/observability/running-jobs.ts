// Which background jobs ran in this process during the last minute.
//
// The process-health line names a stall (the worst event-loop delay of the minute) but not its cause.
// On 2026-10-16 the cause of three 4.3-second freezes was found by reading the log lines printed just
// before each one: every time, the biggest slice of the doctor-list scrape. This register makes that
// answer part of the stall line itself, so the next freeze names its own culprit.
//
// A job is registered for the whole window it was active in, not only when the report fires: the job
// that froze the loop has usually finished by the time the minute's line is written.

const active = new Map<number, string>();
let nextId = 1;
let windowNames = new Set<string>();

/** Marks a job as running until the returned function is called. Safe to call the end twice. */
export function beginJob(name: string): () => void {
  const id = nextId++;
  active.set(id, name);
  windowNames.add(name);
  return () => {
    active.delete(id);
  };
}

/** Runs `run` registered under `name`, ending the registration however it finishes. */
export async function trackJob<T>(name: string, run: () => Promise<T>): Promise<T> {
  const end = beginJob(name);
  try {
    return await run();
  } finally {
    end();
  }
}

/**
 * The names of every job active at any moment since the last drain, sorted, and the window restarted
 * with the jobs still running now (so a job spanning two minutes is named in both).
 */
export function drainJobWindow(): string[] {
  const names = [...windowNames].sort();
  windowNames = new Set(active.values());
  return names;
}
