// Client-safe constants for the My Visits / Team Visits workspace.
//
// These live apart from my-crm-visits.ts because that module is server-only: it reaches
// crm/reads.ts -> employees/employee-directory.ts -> employees/employee-photo.ts -> node:crypto.
// The workspace is a "use client" component, so importing any VALUE from my-crm-visits.ts pulls
// that whole chain into the browser bundle and webpack dev fails the build outright with
// `UnhandledSchemeError: Reading from "node:crypto"` — which then poisons the dev compilation for
// every route requested afterwards, not just this one. (A type-only import is erased and is fine;
// it was the switch from `import type` to a value import that broke it.)

/** Newest-first cap on a manager's team feed — see the rationale in fetchTeamVisits. */
export const TEAM_VISIT_ROW_CAP = 500;
