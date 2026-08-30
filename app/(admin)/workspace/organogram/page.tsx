// RETIRED 2026-08-30, by the owner, in the conversation.
//
// The workspace shell's copy of the Organogram — the THIRD copy of one report.
//
// The organogram is served at /organogram in the admin shell (linked twice in the admin rail, and
// again as /hr/organogram through the HR namespace rewrite) and at /employee-portals/organogram in
// the portal rail. This was a third mounting of the same report, and the only string anywhere that
// linked to it was a card href inside src/components/marketing-requests/marketing-overview-dashboard.tsx
// — a component no route rendered. So this page had already stopped existing for every user; the
// navigation-page-findability ratchet was being satisfied by dead code, which is the more useful
// finding here: a literal in an unreachable file counts as a link to that guard.
//
// Redirecting rather than deleting keeps a bookmark working. It is safe for everyone who could open
// this page: both pages are admin-shell routes gated on the same `organogram` resource, so the
// audience of the workspace copy is a subset of /organogram's.
//
// The now-unused WorkspaceOrganogramPage export is left in
// src/components/workspace/admin-shell-employee-pages.tsx rather than cut out of a busy shared file
// in a subtraction-only pass.
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function WorkspaceOrganogramRoute() {
  redirect("/organogram");
}
