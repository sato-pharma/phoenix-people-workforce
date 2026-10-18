import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import type { CvFolderCabinetData } from "@/components/recruitment/cv-folder-cabinet";
import type { CandidateFolderAreaOption } from "@/lib/recruitment/candidate-folder-options";
import type { RecruitmentDashboard } from "@/lib/recruitment/dashboard";
import type { HiringManagerOption } from "@/lib/recruitment/hiring-manager-notify";
import type { Candidate, PositionCatalogueOption } from "@/lib/recruitment/types";
import type { VacancyReportRow } from "@/lib/reports/vacancies";

/**
 * The Recruitment page's eight reads, settled ONE BY ONE.
 *
 * Both page files (`app/(admin)/recruitment/page.tsx` and its employee-portal mirror) used to run the
 * seven reads in a single `Promise.all` inside a single `try`. Any one rejection blanked the whole page,
 * wrote nothing to the log, and the workspace then told the reader to "apply the recruitment migrations
 * on staging" -- advice for a fresh environment, shown on a production page that was only waiting on a
 * slow database. On 18 Oct 2026 the Talent Acquisition seat met that wall while production timed out
 * between 10:30 and 11:55 Cairo; five of the seven reads were optional extras (a vacancy list, a position
 * list, a manager list, the employee directory, the area list) that the page can draw without.
 *
 * Two reads decide whether the page means anything -- the requisitions and pipeline, and the candidate
 * pool. Every other read degrades: its slot stays empty, the page says in words which part is missing,
 * and the rest keeps working. An optional read also carries a deadline, so one slow extra cannot hold
 * the page for the full fifteen-second request timeout.
 *
 * Nothing here throws. A failed read is data (`RecruitmentReadFailure`), never an exception, which is
 * what lets the pages stay a single straight line.
 */

export type RecruitmentReadSource =
  | "dashboard"
  | "pool"
  | "vacancies"
  | "positionCatalogue"
  | "hiringManagers"
  | "employeeDirectory"
  | "areaOptions"
  | "cvFolders";

/** What the page tells the reader is missing, in the words a recruiter uses. */
export const RECRUITMENT_READ_LABELS: Record<RecruitmentReadSource, string> = {
  dashboard: "requisitions and the hiring pipeline",
  pool: "the candidate list",
  vacancies: "the open vacancies for new requisitions",
  positionCatalogue: "the position list for new requisitions",
  hiringManagers: "the hiring-manager list",
  employeeDirectory: "the manager list for requisitions",
  areaOptions: "the area list for folders",
  cvFolders: "the CV folders",
};

/**
 * How long an OPTIONAL read may take before the page draws without it. The request timeout underneath
 * is fifteen seconds; an extra list is not worth that wait.
 */
export const OPTIONAL_READ_DEADLINE_MS = 8_000;

export class RecruitmentReadTimeoutError extends Error {
  constructor(source: RecruitmentReadSource, deadlineMs: number) {
    super(`The ${source} read did not answer within ${deadlineMs} ms.`);
    this.name = "RecruitmentReadTimeoutError";
  }
}

export type RecruitmentReadFailure = {
  source: RecruitmentReadSource;
  label: string;
  error: unknown;
  timedOut: boolean;
};

export type SettledRead<T> = { ok: true; value: T } | { ok: false; failure: RecruitmentReadFailure };

/**
 * Starts `read` at once and settles it. Never rejects: a throw, a rejection and a missed deadline all
 * come back as `{ ok: false, failure }`.
 */
export async function settleRead<T>(
  source: RecruitmentReadSource,
  read: () => PromiseLike<T>,
  options: { deadlineMs?: number } = {},
): Promise<SettledRead<T>> {
  const fail = (error: unknown, timedOut: boolean): SettledRead<T> => ({
    ok: false,
    failure: { source, label: RECRUITMENT_READ_LABELS[source], error, timedOut },
  });

  let pending: Promise<T>;
  try {
    pending = Promise.resolve(read());
  } catch (error) {
    return fail(error, false);
  }

  const { deadlineMs } = options;
  if (deadlineMs === undefined) {
    try {
      return { ok: true, value: await pending };
    } catch (error) {
      return fail(error, false);
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deadlineMs);
  });
  // The read keeps running after its deadline. Its eventual rejection must not become an unhandled one.
  pending.catch(() => undefined);

  try {
    const winner = await Promise.race([pending, deadline]);
    if (winner === "deadline") return fail(new RecruitmentReadTimeoutError(source, deadlineMs), true);
    return { ok: true, value: winner as T };
  } catch (error) {
    return fail(error, false);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type RecruitmentManagerOption = { hrId: string; fullName: string };

export type RecruitmentPageReads = {
  dashboard: () => PromiseLike<RecruitmentDashboard>;
  pool: () => PromiseLike<Candidate[]>;
  vacancies: () => PromiseLike<VacancyReportRow[]>;
  positionCatalogue: () => PromiseLike<PositionCatalogueOption[]>;
  hiringManagers: () => PromiseLike<HiringManagerOption[]>;
  employeeDirectory: () => PromiseLike<Array<{ hrId: string; displayName: string }>>;
  areaOptions: () => PromiseLike<CandidateFolderAreaOption[]>;
  cvFolders: () => PromiseLike<{ members: Map<string, string[]>; rows: CvFolderCabinetData["rows"] }>;
};

export type RecruitmentPageData = {
  dashboard: RecruitmentDashboard | null;
  candidates: Candidate[];
  openVacancies: VacancyReportRow[];
  positionCatalogue: PositionCatalogueOption[];
  hiringManagers: HiringManagerOption[];
  managers: RecruitmentManagerOption[];
  areaOptions: CandidateFolderAreaOption[];
  cvFolderCabinet: CvFolderCabinetData;
  /** Every read that did not land, in the order the page asks for them. */
  failures: RecruitmentReadFailure[];
};

/**
 * Runs all eight reads at once and returns what loaded plus what did not.
 *
 * Missing data keeps its EMPTY shape here (an empty array, no dashboard, an empty cabinet) because the
 * client components need a value. The empty shape must never be read as an answer: the page passes the
 * failed sources down beside it, and the workspace shows "unavailable" in place of a zero. An empty
 * cabinet is the one empty shape that is also correct on its own -- it shows every CV in the pool, where
 * a half-read one would hide people.
 */
export async function settleRecruitmentPage(
  reads: RecruitmentPageReads,
  options: { optionalDeadlineMs?: number } = {},
): Promise<RecruitmentPageData> {
  const optional = { deadlineMs: options.optionalDeadlineMs ?? OPTIONAL_READ_DEADLINE_MS };
  const [dashboard, pool, vacancies, catalogue, hiringManagers, employees, areas, cabinet] = await Promise.all([
    settleRead("dashboard", reads.dashboard),
    settleRead("pool", reads.pool),
    settleRead("vacancies", reads.vacancies, optional),
    settleRead("positionCatalogue", reads.positionCatalogue, optional),
    settleRead("hiringManagers", reads.hiringManagers, optional),
    settleRead("employeeDirectory", reads.employeeDirectory, optional),
    settleRead("areaOptions", reads.areaOptions, optional),
    settleRead("cvFolders", reads.cvFolders, optional),
  ]);

  const failures = [dashboard, pool, vacancies, catalogue, hiringManagers, employees, areas, cabinet].flatMap(
    (settled) => (settled.ok ? [] : [settled.failure]),
  );

  return {
    dashboard: dashboard.ok ? dashboard.value : null,
    candidates: pool.ok ? pool.value : [],
    openVacancies: vacancies.ok ? vacancies.value : [],
    positionCatalogue: catalogue.ok ? catalogue.value : [],
    hiringManagers: hiringManagers.ok ? hiringManagers.value : [],
    managers: employees.ok
      ? employees.value
          .map((row) => ({ hrId: row.hrId, fullName: row.displayName }))
          .sort((a, b) => a.fullName.localeCompare(b.fullName))
      : [],
    areaOptions: areas.ok ? areas.value : [],
    // A plain object, not the Map the loader returns: this crosses into a client component, and a
    // Map that survives today's React serializer is a dependency on that serializer rather than on
    // anything this module states.
    cvFolderCabinet: cabinet.ok
      ? { members: Object.fromEntries(cabinet.value.members), rows: cabinet.value.rows }
      : { members: {}, rows: [] },
    failures,
  };
}

/** The sources that did not load, for the client component. Plain strings -- they cross the server boundary. */
export function unavailableSources(failures: ReadonlyArray<RecruitmentReadFailure>): RecruitmentReadSource[] {
  return failures.map((failure) => failure.source);
}

/** "the candidate list and the CV folders" -- the sentence the workspace shows. Order follows the input. */
export function describeUnavailable(sources: ReadonlyArray<RecruitmentReadSource>): string {
  const labels = Array.from(new Set(sources.map((source) => RECRUITMENT_READ_LABELS[source])));
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * One line for the error log: which sources failed and what each one actually said. The reader sees
 * the plain notice; this is for whoever has to find out why.
 */
export function describeReadFailures(failures: ReadonlyArray<RecruitmentReadFailure>): string {
  const parts = failures.map(
    (failure) => `${failure.source}${failure.timedOut ? " (timed out)" : ""}: ${describeThrown(failure.error)}`,
  );
  return `Recruitment page loaded without ${failures.length} read${failures.length === 1 ? "" : "s"} -- ${parts.join(" | ")}`;
}
