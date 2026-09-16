// One build of a weekly attendance review week at a time, in this server.
//
// The daily job and a Build this week click (or two runs of the job) would otherwise interleave on the
// same week: one skips the employees the other has just created, and when the other then fails, its
// undo deletes them and nobody builds them again, because Build this week refuses a week that already
// has a digest in it. With the lock, a second build of the same week starts only after the first has
// finished, whether it succeeded or failed. Builds of different weeks never wait for each other.
//
// The locks live on globalThis, so every route in the process shares one set however the routes are
// bundled. Production runs one replica (docs/environment.md). A second replica would not share them,
// and the build's 23505 skip is then all that is left.

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
