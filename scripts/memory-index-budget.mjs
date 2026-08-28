// THE MEMORY INDEX HAS A HARD CLIFF AND A SOFT BUDGET, AND THE GAP BETWEEN THEM IS THE POINT.
//
// The cliff belongs to the loader. `MEMORY.md` is the only memory file that auto-loads, and it is
// truncated at 24,400 bytes SILENTLY — no error, no marker, no ellipsis. The tail simply stops
// existing, so a hook can be present in the file and absent from every session that reads it. That
// is not a tidiness problem; it is a correctness one, and it has already eaten real hooks twice.
//
// `repo-doctor.mjs` used to warn only ONCE OVER that line. That is too late by construction: by the
// time it fires, sessions have been loading a partial index for however long it took someone to
// run the doctor. An alarm that can only tell you about damage already done is not a gate.
//
// WHY A BUDGET AND NOT JUST A CEILING. The index is append-only in practice — every session adds a
// hook, almost none retires one. Measured 2026-08-28: two parallel sessions added 567 bytes in the
// 40 minutes between one trim finishing and the next check, which is why "sitting just under the
// ceiling" is not a state you get to hold. A trim that lands on 335 bytes of headroom is undone by
// the next append, and the two lines that landed that day were 330 and 235 bytes — each one on its
// own larger than the headroom that had just been bought.
//
// WHY 22,000. The gap is 2,400 bytes, which is about ten hooks at the file's own average — ~230
// bytes across 101 hook lines, stable across every measurement so far. Ten hooks is enough slack
// that several parallel sessions can append before anyone has to act, which is the difference
// between a budget and a fire alarm. It also sits well clear of the structural floor — roughly
// 13,000 bytes of hooks that genuinely have to exist — so the budget constrains growth without
// asking anyone to gut the index chasing a smaller number.
//
// THE ARITHMETIC IS DELIBERATELY ONE-WAY. An unreadable or missing file reports `unknown`, never
// `ok`. A size check that answers "fine" when it could not measure is how the cliff gets crossed
// while the doctor prints a clean bill.
export const MEMORY_INDEX_READ_CEILING = 24_400;
export const MEMORY_INDEX_BUDGET = 22_000;

/**
 * Grade the memory index against its budget and the loader's read ceiling.
 *
 * @param {number} bytes size of MEMORY.md on disk, in bytes
 * @returns {{
 *   status: "unknown" | "ok" | "over_budget" | "over_ceiling",
 *   bytes: number, budget: number, ceiling: number,
 *   headroomToBudget: number, headroomToCeiling: number, mustFree: number,
 * }}
 */
export function assessMemoryIndexSize(bytes) {
  const base = {
    bytes: Number.isFinite(bytes) ? bytes : 0,
    budget: MEMORY_INDEX_BUDGET,
    ceiling: MEMORY_INDEX_READ_CEILING,
  };

  // Not a measurement. `fs.statSync` throwing, a missing file, or a nonsense value all land here,
  // and none of them are evidence the index is healthy.
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { ...base, status: "unknown", headroomToBudget: 0, headroomToCeiling: 0, mustFree: 0 };
  }

  const headroomToBudget = MEMORY_INDEX_BUDGET - bytes;
  const headroomToCeiling = MEMORY_INDEX_READ_CEILING - bytes;
  // What it would take to get back inside the budget. Zero when already inside, so a caller can
  // print it unconditionally without special-casing the healthy path.
  const mustFree = Math.max(0, bytes - MEMORY_INDEX_BUDGET);

  const status =
    bytes > MEMORY_INDEX_READ_CEILING ? "over_ceiling" : bytes > MEMORY_INDEX_BUDGET ? "over_budget" : "ok";

  return { ...base, status, headroomToBudget, headroomToCeiling, mustFree };
}

/**
 * The lines repo-doctor prints for the index size. Kept here with the arithmetic so the number and
 * the sentence describing it cannot drift apart — a report that says "healthy" beside a figure over
 * the cliff is worse than no report.
 *
 * @param {ReturnType<typeof assessMemoryIndexSize>} verdict
 * @returns {string[]}
 */
export function memoryIndexBudgetLines(verdict) {
  const kb = (n) => (n / 1024).toFixed(1) + "KB";

  if (verdict.status === "unknown") {
    return ["  MEMORY.md could not be measured — treat the index as UNKNOWN, not as healthy."];
  }

  const scale = `MEMORY.md ${kb(verdict.bytes)} — budget ${kb(verdict.budget)}, loader cliff ${kb(verdict.ceiling)}`;

  if (verdict.status === "over_ceiling") {
    return [
      "  " + scale,
      `  OVER THE CLIFF — the last ${verdict.bytes - verdict.ceiling} bytes are already invisible to every`,
      "  session. Hooks are being dropped silently right now. Free bytes before trusting the index.",
    ];
  }

  if (verdict.status === "over_budget") {
    return [
      "  " + scale,
      `  OVER BUDGET — free ${verdict.mustFree} bytes. Only ${verdict.headroomToCeiling} left before the loader`,
      "  starts dropping the tail silently. Retire a resolved hook or relocate one to AGENTS.md;",
      "  do not add a new line until this is back inside budget (AGENTS.md 2.2).",
    ];
  }

  return ["  " + scale + ` — ${verdict.headroomToBudget} bytes of budget left`];
}
