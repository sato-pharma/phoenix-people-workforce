import { redirect } from "next/navigation";
import { Suspense } from "react";

import { RoleWorkspace } from "@/components/recruitment/workspace/role-workspace";
import type { ManagerShelfView } from "@/components/recruitment/workspace/folders-view";
import { listFilters } from "@/components/recruitment/workspace/workspace-format";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import { resolveActivityModule } from "@/lib/activity/modules";
import { canAccess, type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { logAppError } from "@/lib/error-monitor/service";
import { isUuid } from "@/lib/http/uuid";
import { getApplication } from "@/lib/recruitment/applications";
import { loadCvFolderCabinet } from "@/lib/recruitment/cv-folder-tree-db";
import { loadAllDistrictBoards } from "@/lib/recruitment/district-manager-folders-db";
import { listHiringManagerOptions } from "@/lib/recruitment/hiring-manager-notify";
import { fenceCandidateIds, fenceDistrictBoards } from "@/lib/recruitment/workspace/fence";
import { cairoToday, parseWorkspaceFilters, type WorkspaceFilters } from "@/lib/recruitment/workspace/filters";
import { loadWorkspacePlaces } from "@/lib/recruitment/workspace/places";
import {
  allowedTabsForViewer,
  FOLDERS_TAB,
  isWorkspaceRoleTab,
  NEEDS_PLACING,
  tabsWithRegions,
  workspaceViewer,
  type WorkspaceTabKey,
  type WorkspaceViewer,
} from "@/lib/recruitment/workspace/role-tabs";
import { loadAnswerFilters, loadWorkspaceCounts, loadWorkspacePage } from "@/lib/recruitment/workspace/rows-db";
import type { WorkspaceRow } from "@/lib/recruitment/workspace/types";

// The Recruitment workspace (owner, 19–20 Oct 2026: rebuilt from scratch, one tab per role the
// applicant chose). The screen is `src/components/recruitment/workspace/role-workspace.tsx`; this page
// only decides who may open it, which tab and CV a link lands on, and reads the first view.
//
// THE GATE IS THE WORKSPACE'S OWN NAMED RULE (`workspaceViewer`), not `candidates: read`: the CEO reads
// this screen and must never hold the pool's grant (`tests/ceo-account-contract.test.ts`). The rows,
// counts and meta routes apply the same rule, and every write route still asks its own permission.
//
// OLD LINKS STILL LAND. `?candidate=` opens that CV in the tab it sits in; `?application=` opens the
// application's candidate; and the one link only the old screen can finish — Employee Master's
// "back to recruitment" after a hire (`?application=&hiredHrId=`) — goes on to the previous workspace,
// where that hand-back lives, with its query intact.
//
// EACH READ SETTLES ON ITS OWN. A read that fails leaves its part empty and is NAMED on screen, and
// one row goes to the error log for the whole load — never a blank page, never a silent zero.

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** How long an optional read may hold the page before it draws without it. */
const OPTIONAL_DEADLINE_MS = 8_000;

function toParams(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) params.set(key, value[0]);
  }
  return params;
}

export default async function RecruitmentPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAccessContextFromPage();
  const viewer = workspaceViewer(access);
  if (!viewer.canRead) redirect("/employee-portals");

  const params = toParams(await searchParams);
  if (params.get("application") && params.get("hiredHrId")) {
    redirect(`/recruitment/previous?${params.toString()}`);
  }

  return (
    <Suspense
      fallback={
        <AppRouteLoadingState
          title="Loading Recruitment"
          description="Preparing every role's CVs, their answers and the counts."
        />
      }
    >
      <WorkspaceContent access={access} params={params} viewer={viewer} />
    </Suspense>
  );
}

type Settled<T> = { ok: true; value: T } | { ok: false; label: string; error: unknown };

async function settle<T>(label: string, read: () => PromiseLike<T>, deadlineMs?: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = Promise.resolve(read());
    if (deadlineMs === undefined) return { ok: true, value: await pending };
    pending.catch(() => undefined);
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), deadlineMs);
    });
    const winner = await Promise.race([pending, deadline]);
    if (winner === "deadline") return { error: new Error(`did not answer within ${deadlineMs} ms`), label, ok: false };
    return { ok: true, value: winner as T };
  } catch (error) {
    return { error, label, ok: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

/** One row in the error log for the whole load, naming every read that failed. Never awaited. */
function logFailures(access: AccessContext, failures: ReadonlyArray<{ label: string; error: unknown }>): void {
  if (failures.length === 0) return;
  const activityModule = resolveActivityModule("/recruitment");
  void logAppError({
    hrId: access.hrId ?? null,
    loginId: access.loginId ?? null,
    message: `Recruitment workspace loaded without ${failures.length} read${failures.length === 1 ? "" : "s"} -- ${failures
      .map((failure) => `${failure.label}: ${describe(failure.error)}`)
      .join(" | ")}`,
    moduleKey: activityModule.key,
    moduleLabel: activityModule.label,
    role: access.role ?? null,
    route: "/recruitment",
    routeType: "page",
    source: "server",
  }).catch(() => undefined);
}

/** The one CV a link names, behind the viewer's tabs and the Talent Acquisition fence. */
async function readOneRow(filters: WorkspaceFilters, viewer: WorkspaceViewer, id: string): Promise<WorkspaceRow | null> {
  const page = await loadWorkspacePage(filters, viewer, { ids: [id] });
  return page.rows[0] ?? null;
}

/** The tab a linked CV is opened in: the first of its tabs this viewer sees, else Needs placing. */
function tabForRow(row: WorkspaceRow, allowed: readonly string[]): WorkspaceTabKey {
  const placed = row.placements.find((placement) => allowed.includes(placement.tab));
  return placed ? placed.tab : NEEDS_PLACING;
}

async function WorkspaceContent({
  access,
  params,
  viewer,
}: {
  access: AccessContext;
  params: URLSearchParams;
  viewer: WorkspaceViewer;
}) {
  const filters = parseWorkspaceFilters(params);
  const allowed = allowedTabsForViewer(viewer);
  const notices: string[] = [];

  // A tab outside the viewer's own is dropped, never shown empty as though it held nobody.
  if (filters.tab && filters.tab !== FOLDERS_TAB && !allowed.includes(filters.tab)) filters.tab = null;
  const namedTab = filters.tab;

  // `?application=` → that application's candidate (the requisition's scope check runs inside).
  const applicationId = params.get("application");
  if (!filters.candidate && applicationId && isUuid(applicationId)) {
    const application = await getApplication(access, applicationId).catch(() => null);
    if (application?.candidateId) filters.candidate = application.candidateId;
    else notices.push("That application is no longer in Recruitment, or it is not open to you.");
  }

  // The linked CV, fenced. Read first without a tab to learn where it sits, then in that tab so its
  // chips follow that tab's questions.
  let openedRow: WorkspaceRow | null = null;
  if (filters.candidate) {
    const first = await readOneRow({ ...filters, tab: namedTab }, viewer, filters.candidate).catch(() => null);
    if (!first) {
      notices.push("That CV is not open to you, or it is no longer in Recruitment.");
      filters.candidate = null;
    } else if (namedTab) {
      openedRow = first;
    } else {
      const tab = tabForRow(first, allowed);
      filters.tab = tab;
      openedRow = (await readOneRow({ ...filters, tab }, viewer, first.id).catch(() => null)) ?? first;
    }
  }

  const tab: WorkspaceTabKey = filters.tab ?? (allowed[0] as WorkspaceTabKey | undefined) ?? NEEDS_PLACING;
  filters.tab = tab;
  const listed = listFilters(filters);
  const regions = isWorkspaceRoleTab(tab) && tabsWithRegions.includes(tab);

  const [page, counts, places, answerFilters, managers, cabinet, shelves, canHire, canExport, viewerName] = await Promise.all([
    settle("the CVs", () => loadWorkspacePage(listed, viewer)),
    settle("the counts", () => loadWorkspaceCounts(listed, viewer)),
    regions ? settle("the regions and areas", () => loadWorkspacePlaces(tab), OPTIONAL_DEADLINE_MS) : Promise.resolve(null),
    tab === FOLDERS_TAB ? Promise.resolve(null) : settle("the answer filters", () => loadAnswerFilters(tab, viewer), OPTIONAL_DEADLINE_MS),
    viewer.canWork ? settle("the manager list", () => listHiringManagerOptions(), OPTIONAL_DEADLINE_MS) : Promise.resolve(null),
    settle(
      "the CV folders",
      async () => {
        const read = await loadCvFolderCabinet({ withNames: true });
        // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant is neither listed nor counted.
        const visible = await fenceCandidateIds(access, [...read.members.values()].flat());
        const members: Record<string, string[]> = {};
        for (const [folderId, ids] of read.members) members[folderId] = ids.filter((id) => visible.has(id));
        return { members, rows: read.rows };
      },
      OPTIONAL_DEADLINE_MS,
    ),
    tab === FOLDERS_TAB
      ? settle(
          "the managers' folders",
          async (): Promise<ManagerShelfView[]> => {
            const { boards } = await loadAllDistrictBoards();
            const fenced = await fenceDistrictBoards(access, boards);
            const names = await namesByHrId(fenced.map((board) => board.managerHrId));
            return fenced
              .filter((board) => board.candidateCount > 0)
              .map((board) => ({
                candidateCount: board.candidateCount,
                folders: board.folders
                  .filter((folder) => folder.candidates.length > 0)
                  .map((folder) => ({
                    areaName: folder.areaName,
                    candidates: folder.candidates.map((candidate) => ({ id: candidate.id, name: candidate.fullName })),
                  })),
                lineName: board.lineName,
                managerName: names.get(board.managerHrId),
                regionName: board.regionName,
                seatId: board.seatId,
                seatLabel: board.seatLabel,
              }));
          },
          OPTIONAL_DEADLINE_MS,
        )
      : Promise.resolve(null),
    canAccess(access, "employees", "update").catch(() => false),
    // The export route asks `recruitment: export`; the CEO reads the workspace without it, so the
    // button is drawn only for a reader the route will answer.
    canAccess(access, "recruitment", "export").catch(() => false),
    access.hrId ? namesByHrId([access.hrId]).then((names) => names.get(access.hrId), () => null) : Promise.resolve(null),
  ]);

  const failures = [page, counts, places, answerFilters, managers, cabinet, shelves].flatMap((read) =>
    read && !read.ok ? [{ error: read.error, label: read.label }] : [],
  );
  logFailures(access, failures);
  // The CVs and the counts have their own notice inside the screen; name the rest here.
  const unavailable = failures.filter((failure) => failure.label !== "the CVs").map((failure) => failure.label);

  return (
    <RoleWorkspace
      folderMembers={cabinet.ok ? cabinet.value.members : {}}
      folderRows={cabinet.ok ? cabinet.value.rows : []}
      initialAnswerFilters={answerFilters?.ok ? answerFilters.value : null}
      initialCounts={counts.ok ? counts.value : null}
      initialFilters={filters}
      initialOpenedRow={openedRow}
      initialPage={page.ok ? page.value : null}
      initialPageError={page.ok ? null : "The CVs could not be loaded just now. Reload the page, or change a filter to try again."}
      initialPlaces={places?.ok ? places.value : null}
      managerShelves={shelves ? (shelves.ok ? shelves.value : []) : null}
      managers={managers?.ok ? managers.value : []}
      notices={notices}
      today={cairoToday()}
      unavailable={unavailable}
      viewer={{
        canDelete: access.role === "Super Admin" || access.scope === "system",
        canExport,
        canHire: viewer.canWork && canHire,
        canWork: viewer.canWork,
        name: viewerName,
        roleTabs: viewer.roleTabs,
        seesNeedsPlacing: viewer.seesNeedsPlacing,
      }}
    />
  );
}
