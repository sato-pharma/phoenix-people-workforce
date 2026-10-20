import { NextResponse } from "next/server";

import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { forbiddenError, unauthorizedError } from "@/lib/http/api-errors";
import { loadWorkspacePlaces } from "@/lib/recruitment/workspace/places";
import { loadAnswerFilters } from "@/lib/recruitment/workspace/rows-db";
import {
  allowedTabsForViewer,
  FOLDERS_TAB,
  isWorkspaceTabKey,
  NEEDS_PLACING,
  workspaceViewer,
  type WorkspaceTabKey,
} from "@/lib/recruitment/workspace/role-tabs";
import { recruitmentApiError, recruitmentProblem } from "@/app/api/recruitment/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What one tab is split by and filtered on: its regions and areas with their vacant seats, the answer
 * filters of the questions its people are asked, and what this viewer may do here.
 *
 * A tab outside the viewer's own is a 403, never an empty list that would pass for "no regions": the
 * tabs a viewer sees are decided from the session (`workspaceViewer`), and the Talent Acquisition seat
 * asking for an HR tab is refused here exactly as the rows filter refuses it.
 *
 * `canHire` is `employees: update` — completing a hire means saving the new employee in Employee
 * Master, which the Talent Acquisition seat does not hold, so the screen greys the button for her.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) throw unauthorizedError();
    const viewer = workspaceViewer(access);
    if (!viewer.canRead) throw forbiddenError("Forbidden: the recruitment workspace is not open to this account.");

    const raw = new URL(request.url).searchParams.get("tab");
    const allowed = allowedTabsForViewer(viewer);
    let tab: WorkspaceTabKey;
    if (raw === null || raw === "") {
      tab = (allowed[0] as WorkspaceTabKey | undefined) ?? NEEDS_PLACING;
    } else if (!isWorkspaceTabKey(raw)) {
      return recruitmentProblem("That is not a recruitment tab.", 400);
    } else {
      tab = raw;
    }
    if (tab !== FOLDERS_TAB && !allowed.includes(tab)) {
      return recruitmentProblem("This tab is not open to your account.", 403);
    }

    const [places, answerFilters, canHire] = await Promise.all([
      loadWorkspacePlaces(tab),
      loadAnswerFilters(tab, viewer),
      canAccess(access, "employees", "update"),
    ]);
    return NextResponse.json({
      answerFilters,
      places,
      success: true,
      tab,
      viewer: {
        canHire,
        canWork: viewer.canWork,
        roleTabs: viewer.roleTabs,
        seesNeedsPlacing: viewer.seesNeedsPlacing,
      },
    });
  } catch (error) {
    return recruitmentApiError(error, "Could not load this tab.");
  }
}
