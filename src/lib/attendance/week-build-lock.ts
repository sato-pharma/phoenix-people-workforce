// One piece of work on a weekly attendance review week at a time, in this server: bringing it up to
// date (the daily job, or a Refresh click) or releasing it.
//
// A release checks that the days waiting are the days the page showed, then releases them; a refresh
// running in between would add a day after the check. With the lock, the second starts only after the
// first has finished, whether it succeeded or failed. Different weeks never wait for each other.
//
// The locks live on globalThis, so every route in the process shares one set however the routes are
// bundled. Production runs one replica (docs/environment.md). A second replica would not share them,
// and the database is then the guard: phx_attendance_sync_digest_days and phx_attendance_release_digest
// both lock the employee's week, and the release refuses a day the page did not show.

type WeekBuildLocks = Map<string, Promise<void>>;

export async function withWeekBuildLock<T>(cycleKey: string, weekIndex: number, build: () => Promise<T>): Promise<T> {
  const holder = globalThis as { phoenixAttendanceWeekBuildLocks?: WeekBuildLocks };
  if (!holder.phoenixAttendanceWeekBuildLocks) holder.phoenixAttendanceWeekBuildLocks = new Map();
  const locks = holder.phoenixAttendanceWeekBuildLocks;
  const key = `${cycleKey}:${weekIndex}`;
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(build);
  // Settles either way, so a build that throws never leaves the next one waiting on its rejection.
  const finished = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, finished);
  try {
    return await run;
  } finally {
    if (locks.get(key) === finished) locks.delete(key);
  }
}
