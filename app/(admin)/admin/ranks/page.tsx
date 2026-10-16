// Phoenix Ranks — admin twin of /employee-portals/ranks, for the CEO, the SFE Manager and the Super
// Admin (the board's audience that resolves to the admin shell). Same board component; the one
// difference is the audience: this page reads the `metrics` column and prints the raw counts behind
// every score — owner, 2026-10-05: "the metrics keep in your back end or show it to the admin
// account. But for the reps, only accuracy score."

import { redirect } from "next/navigation";
import { Award } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { RepRanksBoard, rankHref, type RankLinkContext } from "@/components/rep-ranks/rep-ranks-board";
import { RepRanksProfile } from "@/components/rep-ranks/rep-ranks-profile";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import { RANK_ADMIN_ROLES } from "@/lib/rep-ranks/admin-audience";
import { loadRankBoard, loadRankProfile } from "@/lib/rep-ranks/server/read";
import { RANK_WINDOW_KINDS, type RankWindowKind } from "@/lib/rep-ranks/windows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE_PATH = "/admin/ranks";

type PageProps = { searchParams?: Promise<{ window?: string; key?: string; line?: string; rep?: string }> };

export default async function AdminRepRanksPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (access.scope !== "system" && !RANK_ADMIN_ROLES.has(access.role)) redirect("/admin");
  if (!(await canAccess(access, "early_birds", "read"))) redirect("/admin");

  const params = (await searchParams) ?? {};
  const kind: RankWindowKind = RANK_WINDOW_KINDS.includes(params.window as RankWindowKind) ? (params.window as RankWindowKind) : "month";

  const hero = (
    <AdminPageHero
      description="Every medical rep of every line on one board, scored on twelve equal Phoenix CRM measures plus an AM start bonus. Reps see the scores; this page also shows the counts behind them."
      eyebrow="Field Discipline"
      icon={<Award className="h-5 w-5" />}
      title="Phoenix Ranks"
    />
  );

  let board;
  try {
    board = await loadRankBoard({ kind, windowKey: params.key ?? null, audience: "admin" });
  } catch {
    return (
      <div className="space-y-5">
        {hero}
        <div className="border border-amber-200 bg-amber-50 px-5 py-4">
          <p className="text-sm font-bold text-amber-900">The ranking could not be read.</p>
          <p className="mt-1 text-sm text-amber-800">This is a data-read problem, not a result. Refresh in a minute.</p>
        </div>
      </div>
    );
  }

  const line = params.line && board.lines.includes(params.line) ? params.line : null;
  const context: RankLinkContext = { basePath: BASE_PATH, kind, windowKey: board.window?.key ?? null, line };
  const requestedRep = normalizeHrIdForAccess(params.rep ?? null);
  const profile = requestedRep ? await loadRankProfile(requestedRep).catch(() => null) : null;

  return (
    <div className="space-y-5">
      {hero}
      <RepRanksBoard
        board={board}
        certificatesForAll
        context={context}
        openRepKey={profile?.hrIdKey ?? null}
        profile={profile ? <RepRanksProfile closeHref={rankHref(context, {})} profile={profile} /> : null}
        viewerKey={null}
      />
    </div>
  );
}
