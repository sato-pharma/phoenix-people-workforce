import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadManagerPlanHubDetail } from "@/lib/phoenix-crm/server/manager-plan-hub";
import { loadManagerPlanBoard } from "@/lib/phoenix-crm/server/manager-plans";
import type { ManagerPlanBoardView } from "@/lib/phoenix-crm/view-types";
import { buildManagerWeekWorkbook, managerWeekWorkbookFileName } from "@/lib/phoenix-crm/server/manager-week-workbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * A manager's week as Excel (premium pass of Plan your week in Phoenix CRM, owner, 2026-11-09). The same door as the
 * board's own GET: `read`, then `loadManagerPlanBoard`, which narrows to the manager himself and the people who read
 * his week (`resolveManagerPlanReader`) — a rep is refused there, before any read. It reads, it never saves: the
 * board's GET writes nothing, and this route calls nothing else. Rate-limited, and every download is audited as
 * `crm_manager_week_export`, because the file names reps and customers.
 *
 * Two doors, one file. `?week=&manager=` is the board's: its reader rule as above. `?plan=<id>` is the Approvals Hub's:
 * `loadManagerPlanHubDetail`, the proof the hub's own page uses — a week's approvers, its manager, the Super Admin and
 * the Administrator — and "not found" for anyone else, never a hint the week exists. Neither door widens the other.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:phoenix-crm:manager-week" });
    const search = searchOf(request);
    const planId = search.get("plan");
    let board: ManagerPlanBoardView;
    if (planId) {
      const detail = await loadManagerPlanHubDetail(access, planId);
      if (detail.kind !== "plan") {
        return NextResponse.json({ error: "not_found", message: "This week could not be found.", success: false }, { status: 404 });
      }
      board = detail.board;
    } else {
      board = await loadManagerPlanBoard(viewer, {
        manager: search.get("manager"),
        scope: null,
        test: search.get("test"),
        week: search.get("week"),
      });
    }
    if (!board.manager) {
      return NextResponse.json({ error: "no_manager", message: "Choose whose week to download first.", success: false }, { status: 400 });
    }
    const buffer = await buildManagerWeekWorkbook(board, new Date().toISOString());

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityType: "crm_manager_week_export",
      entityId: board.plan?.planId ?? null,
      summary: `Exported the weekly plan of ${board.manager.name} (week of ${board.weekStart}${board.isTest ? ", test persona" : ""}${planId ? ", from the Approvals Hub" : ""})`,
    });

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": XLSX,
        "content-disposition": `attachment; filename="${managerWeekWorkbookFileName(board)}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return phoenixCrmFailure(error, "The weekly plan could not be exported.");
  }
}
