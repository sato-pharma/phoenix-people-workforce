// Master Map — how many organogram rows a single read is allowed to return.
//
// Its own module because both the loader and the fingerprint read the same two views, and a cap
// that disagreed between them would let the stamp call the org unchanged while the workbook was
// built from a truncated copy of it.

/**
 * A ceiling far above the organogram's real size, asked for explicitly.
 *
 * NOT fixing a live truncation. Measured against production 2026-08-18: `db-max-rows` is unset, so
 * an unbounded PostgREST read returns everything — 52,614 rows came back from a `select` with no
 * limit at all. The organogram reads were never being cut short.
 *
 * What this guards is the day that changes. `db-max-rows` is Supabase-side configuration, invisible
 * from this repository, and PostgREST enforces it by returning a SHORT PAGE WITH NO ERROR. If it
 * were ever set below the organogram's size, the workbook would quietly rebuild from half an org
 * chart: the areas past the cut would render "Not in the organogram", which reads as a mapping the
 * owner has to go and fix rather than as a read that came back short. Asking for a bound makes that
 * detectable — a response AT the bound is treated as truncated and sent down the same fail-soft
 * path as a failed read, so the sheet holds its last good managers and the reason goes to the log.
 *
 * The cost is a ceiling this code imposes on itself where none existed. That is deliberate: at
 * 5,000 it is ~34x the real size (147 area rows and 133 seats on 2026-08-17), no ordinary growth
 * reaches it, and failing loudly at 5,000 is better than succeeding wrongly at any number.
 */
export const ORGANOGRAM_ROW_CAP = 5000;
