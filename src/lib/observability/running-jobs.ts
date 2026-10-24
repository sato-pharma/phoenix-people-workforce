// Which background jobs ran in this process during the last minute.
//
// The process-health line names a stall (the worst event-loop delay of the minute) but not its cause.
// On 2026-10-16 the cause of three 4.3-second freezes was found by reading the log lines printed just
// before each one: every time, the biggest slice of the doctor-list scrape. This register makes that
// answer part of the stall line itself, so the next freeze names its own culprit.
//
// A job is registered for the whole window it was active in, not only when the report fires: the job
// that froze the loop has usually finished by the time the minute's line is written.

//
// Held on `globalThis`, like timings.ts: the jobs are started from bundles other than the one
// instrumentation.ts drains from, and a module-level register gave each bundle its own empty copy.

type JobRegister = { active: Map<number, string>; nextId: number; windowNames: Set<string> };

const REGISTER_KEY = Symbol.for("phoenix.runningJobs");

function register(): JobRegister {
  const holder = globalThis as unknown as Record<symbol, JobRegister | undefined>;
  const existing = holder[REGISTER_KEY];
  if (existing) return existing;
  const created: JobRegister = { active: new Map(), nextId: 1, windowNames: new Set() };
  holder[REGISTER_KEY] = created;
  return created;
}

/** Marks a job as running until the returned function is called. Safe to call the end twice. */
export function beginJob(name: string): () => void {
  const jobs = register();
  const id = jobs.nextId++;
  jobs.active.set(id, name);
  jobs.windowNames.add(name);
  return () => {
    jobs.active.delete(id);
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
  const jobs = register();
  const names = [...jobs.windowNames].sort();
  jobs.windowNames = new Set(jobs.active.values());
  return names;
}
