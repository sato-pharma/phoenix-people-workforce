/**
 * /admin/needs-you — everything waiting on a decision only the owner makes, on one page.
 *
 * 🔴 A BOARD THAT UNDER-REPORTS IS WORSE THAN NO BOARD. This page exists so he stops walking a dozen
 * admin screens himself, which means a silent failure here costs him the decision more surely than no
 * board would. Every structural guarantee behind that lives in `src/lib/needs-you/` — read
 * `types.ts` before changing anything here.
 *
 * THE GATE IS THE SECURITY BOUNDARY, and the sidebar is not. `system-navigation.ts` hiding the row
 * from every other role is UX only; what actually keeps anyone else out is the redirect below, which
 * runs server-side before a byte of the board is read. `canAccessSystemAdministratorWorkspace` is
 * `scope === "system" || role === "Super Admin"`. The Talent Acquisition seat was
 * admitted on 2026-10-08 and refused again on 2026-10-16 at the owner's word ("remove needs you and
 * hide from ta account"): she is redirected here exactly like every other non-admin seat.
 *
 * NO NEW `PermissionResource`. Adding one would need 17 `permissionMatrix` rows and a `MODULE_LABELS`
 * entry, and — the reason that settles it — it would make this board LOCKABLE. A module lock on the
 * one page that answers "is anything waiting on you" is a silent board, which is the same failure as
 * an under-reporting one.
 *
 * `force-dynamic`, and a RELOAD is the refresh. No polling: a poll would need a route whose failure
 * mode is a `{count: 0}` fallback, and that shape is the one thing this page must never have.
 */
import { AlertCircle } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { NeedsYouBoardView } from "@/components/admin/needs-you-board";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import {
  canAccessSystemAdministratorWorkspace,
  resolveNavigationMode,
  type AccessContext,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getNeedsYouBoard } from "@/lib/needs-you/service";

export const dynamic = "force-dynamic";

// NO `metadata` export. The admin shell's layout names every tab through `generateMetadata` +
// `resolveModuleName`, which reads this route's own sidebar label — so the tab reads "Needs You"
// because the nav row says so. A page-level export here would be a second, drifting source for the
// one string `tests/module-tab-titles.test.ts` pins, and no other page in this shell has one.

export default async function NeedsYouPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  if (!canAccessSystemAdministratorWorkspace(access)) {
    redirect("/admin");
  }

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          description="Reading every approval queue, closing, payroll month and lifecycle signal."
          title="Loading Needs You"
        />
      }
    >
      <NeedsYouContent access={access} />
    </Suspense>
  );
}

async function NeedsYouContent({ access }: { access: AccessContext }) {
  // `getNeedsYouBoard` is built so that no source can reject it — every per-source failure becomes an
  // amber row. This catch is for the case that would otherwise be worse than a failed source: the
  // fan-out itself dying. It renders the error, NEVER an empty board — an empty board would read as
  // "nothing needs you", which is the one sentence that must never appear without proof.
  const result = await getNeedsYouBoard(access)
    .then((board) => ({ board, error: null as string | null }))
    .catch((error: unknown) => ({
      board: null,
      error: error instanceof Error ? error.message : "Unknown error",
    }));

  if (!result.board) {
    return (
      <div className="min-w-0 border border-rose-200 bg-rose-50 p-6">
        <div className="flex items-center gap-3 text-rose-700">
          <AlertCircle aria-hidden="true" className="h-5 w-5" />
          <h2 className="break-words text-base font-black">The board could not be assembled</h2>
        </div>
        <p className="mt-3 break-words text-sm text-rose-800">
          Nothing below this line was read, so treat nothing as clear. This is not &ldquo;nothing needs you&rdquo;.
        </p>
        <p className="mt-3 break-all border border-rose-200 bg-white/60 p-3 font-mono text-phx-xs text-rose-900">
          {result.error ?? "Unknown error"}
        </p>
      </div>
    );
  }

  return <NeedsYouBoardView board={result.board} />;
}
