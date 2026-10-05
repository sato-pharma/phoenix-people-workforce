// Phoenix Ranks — the shared board every medical rep of every line sees (owner, 2026-10-05).
//
// The admin twin at /admin/ranks renders the same board for the CEO, the SFE Manager and the Super
// Admin, with the raw counts behind each score. THIS page never receives those counts: the read
// leaves the `metrics` column out for the portal audience (src/lib/rep-ranks/server/read.ts).
//
// Who may open it: the Early Birds audience — field-force recognition, the same family of board —
// enforced here with `canAccess(access, "early_birds", "read")`, not by the menu.
//
// URL: ?window=day|week|month|quarter|semester, ?key= a computed window, ?line= a line name,
// ?rep= the rep whose profile is open. Every value is matched against what was actually computed;
// an unknown one falls back to the newest window, or opens no profile, and the page says nothing it
// cannot back.

import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { RepRanksBoard, rankHref, type RankLinkContext } from "@/components/rep-ranks/rep-ranks-board";
import { RepRanksProfile } from "@/components/rep-ranks/rep-ranks-profile";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { canAccess } from "@/lib/auth/permissions";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import { loadRankBoard, loadRankProfile } from "@/lib/rep-ranks/server/read";
import { RANK_WINDOW_KINDS, type RankWindowKind } from "@/lib/rep-ranks/windows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE_PATH = "/employee-portals/ranks";

type PageProps = { searchParams?: Promise<{ window?: string; key?: string; line?: string; rep?: string }> };

export default async function PortalRepRanksPage({ searchParams }: PageProps) {
  const access = await resolveAuthenticatedPageAccess();
  const params = (await searchParams) ?? {};

  const shell = (children: React.ReactNode) => (
    <EmployeePortalPageShell
      badge="Phoenix Ranks"
      description="Every medical rep of every line, scored on the same twelve measures plus an AM start bonus. Top of the day, week, month, quarter and semester."
      title="Phoenix Ranks"
    >
      {children}
    </EmployeePortalPageShell>
  );

  if (!(await canAccess(access, "early_birds", "read"))) {
    return shell(
      <EmployeePortalEmptyState message="Phoenix Ranks is open to the field force and their managers." title="Not available for your role" />,
    );
  }

  const kind: RankWindowKind = RANK_WINDOW_KINDS.includes(params.window as RankWindowKind) ? (params.window as RankWindowKind) : "month";
  let board;
  try {
    board = await loadRankBoard({ kind, windowKey: params.key ?? null, audience: "portal" });
  } catch {
    return shell(
      <EmployeePortalEmptyState
        message="The ranking could not be read right now. This is a temporary problem on our side, not a change to anyone's standing. Please refresh in a minute."
        title="The ranking could not be loaded"
      />,
    );
  }

  const line = params.line && board.lines.includes(params.line) ? params.line : null;
  const context: RankLinkContext = { basePath: BASE_PATH, kind, windowKey: board.window?.key ?? null, line };
  const viewerKey = normalizeHrIdForAccess(access.hrId);
  const requestedRep = normalizeHrIdForAccess(params.rep ?? null);
  const profile = requestedRep ? await loadRankProfile(requestedRep).catch(() => null) : null;

  return shell(
    <RepRanksBoard
      board={board}
      context={context}
      openRepKey={profile?.hrIdKey ?? null}
      profile={profile ? <RepRanksProfile closeHref={rankHref(context, {})} profile={profile} /> : null}
      viewerKey={viewerKey}
    />,
  );
}
