// Early Birds — a started Phoenix CRM team's clock (owner, 2026-10-02: "First Phoenix visit").
//
// For a rep of a team counted from Phoenix CRM (src/lib/crm/phoenix-team-starts.ts), within the team's
// start, his start of the day is the time of his FIRST COUNTABLE Phoenix visit that day — `captured_at`,
// the moment it was saved at the customer's door, read as Cairo wall clock exactly as the read door
// carries it in `crm_save_date`. It replaces his iReports360 GPS check-in in BOTH components that read a
// clock — the start (`gpsStartByRepDay`) and the "#1 days" daily board — so the module stays on one
// clock. Since 2026-10-16 ("Phoenix wins the day") the clock is decided PER DAY, not per start window: a
// day with a Phoenix visit takes that visit's time, and a day with none keeps the rep's iReports360
// check-in, exactly as the read door now keeps his iReports360 rows on a day Phoenix does not hold.
//
// The day's start itself is `phoenixFirstVisitStarts` (src/lib/crm/sfe-field-analytics.ts), the ONE
// helper the SFE start-time table reads too.
//
// WHICH REP-DAYS A START COVERS IS NOT EARLY BIRDS' RULE ANY MORE. It began here because Early Birds was
// the first reader to need it, and it is re-exported from here so this module's own doc and its pinned
// test keep their path — but it now lives in the feature's canon (`src/lib/crm/phoenix-team-starts.ts`),
// beside `isPhoenixNativeVisitRow`, because a second reader outside Early Birds needs the same answer:
// `rep-day.ts`, which asks the LIVE vendor API and so has no `source` column to judge a row by. The
// windows are read through `loadStartedRepWindows` in `src/lib/crm/phoenix-started-reps.ts`, the one
// read of that RPC; collect.ts no longer needs them.

export { startedWindowCovers, type StartedRepWindow } from "@/lib/crm/phoenix-team-starts";
