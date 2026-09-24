import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { MilestoneSpecError, parseMilestoneSpec, parsePlainDate, todayInCairo } from "@/lib/milestones/periods";
import { listMilestonesDue } from "@/lib/milestones/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who is due a service milestone inside a window.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHO MAY CALL IT. `milestones:read`, which the matrix grants to the Super Admin alone.
 * THE GATE IS HERE, not in the sidebar: `system-navigation.ts` hiding a link is UX. This route
 * reads every active employee's hire date with no scope narrowing, which is exactly why it is not
 * a team-scoped surface.
 *
 * `from` and `to` are calendar dates (`YYYY-MM-DD`), defaulting to today in Cairo and 30 days on.
 * `period` narrows the sweep to one milestone — `1m`, `1y`, `100d`.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "milestones", "read");

    const url = new URL(request.url);
    const from = parsePlainDate(url.searchParams.get("from")) ?? todayInCairo();
    const to = parsePlainDate(url.searchParams.get("to")) ?? undefined;
    const period = url.searchParams.get("period");
    const specs = period ? [parseMilestoneSpec(period)] : undefined;

    const entries = await listMilestonesDue({ from, to, specs });
    return Response.json({ from, to: to ?? null, entries }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json(
        { error: "Milestones are available to the system administrator only." },
        { status: 403 },
      );
    }
    if (error instanceof MilestoneSpecError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json(
      { error: clientSafeErrorMessage(error, "The milestone list could not be read.") },
      { status: 500 },
    );
  }
}
