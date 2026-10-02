// Has the cloud mirror drifted from the laptop's live memory?
//
// WHY THIS EXISTS. A CLOUD session is an isolated clone and never sees `~/.claude`, so
// `.claude/cloud-context/memory-mirror/` IS the Phoenix memory it wakes up with. It is regenerated
// by `scripts/sync-cloud-context.mjs` and committed through the normal PR flow, which means it is
// only ever as fresh as its last MERGED refresh — and nothing anywhere measured that.
//
// 🔴 MEASURED 2026-10-02, AND FOUND BY ACCIDENT RATHER THAN BY A CHECK: five of 1,061 mirrored files
// no longer matched the live memory, and three memories written since the last refresh were missing
// from the mirror entirely. The one that mattered was
// `saginko-repriced-retail-from-october-direct-from-today`: the mirror still carried the copy saying
// the `analytics.sos_fact` flat-price gap was *"OPEN GAP found 2026-10-01, NOT yet fixed"*, while the
// live memory had been overtaken 86 minutes later — the gap fixed and its migration applied to
// staging and production. A cloud session sent at that area would have been told to go and fix
// something already done, and because it cannot see the live memory, nothing on its side would ever
// have corrected it.
//
// Pure on purpose: the caller reads both directories and this classifies, so the whole decision
// table is testable without a home directory, a clone, or a network.

/**
 * Line endings are normalised before comparing, and that is load-bearing rather than tidiness.
 *
 * `sync-cloud-context.mjs` copies BUFFERS, so a freshly synced mirror file is byte-identical to its
 * live original on disk — but git normalises CRLF to LF on the way into the index, so the COMMITTED
 * blob (which is what a cloud session actually clones) differs from the working-tree file on a
 * Windows checkout. Comparing raw bytes therefore reports every file as drifted the moment anything
 * touches the tree. Measured the same day: a `git status` after a sync listed 36 changed files while
 * the commit held 9, the other 27 being line endings and nothing else.
 */
const norm = (text) => String(text).replace(/\r\n/g, "\n");

/**
 * Compare the mirror against the live memory.
 *
 * @param live    `Map<filename, contents>` — every `.md` in the session memory directory.
 * @param mirror  `Map<filename, contents>` — every `.md` in `.claude/cloud-context/memory-mirror/`.
 * @returns `{ compared, stale, missing, extra, drifted }` — `stale` are files present in both whose
 *          contents differ, `missing` are live memories the mirror lacks, `extra` are mirrored files
 *          with no live original (a memory deleted upstream and still shipping to cloud). Each is a
 *          sorted array of names; `drifted` is the total.
 */
export function cloudMirrorDrift({ live, mirror }) {
  const liveNames = [...(live?.keys() ?? [])].sort();
  const mirrorNames = [...(mirror?.keys() ?? [])].sort();

  const stale = [];
  const missing = [];
  for (const name of liveNames) {
    if (!mirror?.has(name)) {
      missing.push(name);
      continue;
    }
    if (norm(live.get(name)) !== norm(mirror.get(name))) stale.push(name);
  }
  const extra = mirrorNames.filter((name) => !live?.has(name));

  return {
    compared: liveNames.length,
    stale,
    missing,
    extra,
    drifted: stale.length + missing.length + extra.length,
  };
}

/**
 * The lines repo-doctor prints. Kept beside the arithmetic so a test reads the real words.
 *
 * 🔴 IT NAMES FILES, NOT JUST A COUNT. "5 files have drifted" is a number nobody can act on; the
 * names are what let a reader tell a stale ruling from a retired memory, and the Saginko case was
 * only obviously urgent once it had a name on it.
 */
export function cloudMirrorDriftReport(drift, { max = 10 } = {}) {
  if (drift.drifted === 0) {
    return [`  -> mirror is current: ${drift.compared} memory file(s), none drifted.`];
  }

  const lines = [
    `  -> ${drift.drifted} file(s) DRIFTED out of ${drift.compared}: ` +
      `${drift.stale.length} stale, ${drift.missing.length} missing from the mirror, ` +
      `${drift.extra.length} in the mirror with no live memory.`,
    "     A cloud session reads the mirror as of the last MERGED refresh — these are facts it has wrong.",
  ];
  for (const [label, names] of [["stale", drift.stale], ["missing", drift.missing], ["extra", drift.extra]]) {
    for (const name of names.slice(0, max)) lines.push(`     ${label.padEnd(7)} ${name}`);
    if (names.length > max) lines.push(`     ${"".padEnd(7)} … and ${names.length - max} more ${label}`);
  }
  lines.push("     Fix: node scripts/sync-cloud-context.mjs   (then commit the mirror through the normal PR flow)");
  return lines;
}
