/**
 * Doctor Coverage — viewer scope resolution.
 *
 * Answers one question: for this signed-in viewer, WHICH reps' visits may they see?
 * The board itself (sfe-doctor-coverage.ts) is scope-blind and aggregates whatever rows it is
 * handed, so this module is the security boundary for the module's data.
 *
 * WHY THIS EXISTS. Until 2026-08-08 `getSfeDoctorCoverage({ month })` took no viewer argument at
 * all: every seat that could open the page received all 205 agents and 12,420 doctors, company-wide
 * (measured in production). The portal page's own header admitted it — "line-scoping this view is a
 * known follow-up, not built yet" — which meant a National Sales Manager, who owns exactly ONE
 * line, was reading every other line's reps and doctor panels. That is the hole this closes.
 *
 * It also widens the audience, which is the point: the board previously reached only Super Admin,
 * SFE Manager and NSM — analyst and executive seats. The District Manager who runs the coaching
 * conversation and the Medical Rep who actually walks into the clinic could not see it at all, so
 * the module produced no corrective action by construction. Owner decision 2026-08-08: DM sees own
 * reps, Medical Rep sees own panel, RM sees own region, PM/GPM see their line, MM stays company.
 *
 * Design constraints carried over verbatim from business-review/portal-scope.ts, because each
 * one of them was paid for with a real defect in this repo:
 *
 *  - Scope comes from the ORG TREE, never a region or line LABEL on the viewer's own row. PR #1479:
 *    six live areas sit in an operational region different from their geographic one, and
 *    region-label scoping hid 1,194 of one DM's own sales rows. The Regional Manager scope here is
 *    therefore a subtree walk, not a `regionName` string match.
 *  - A manager gets their WHOLE subtree, not one level. PR #1486: resolving a hierarchy scope with a
 *    one-level manager check made an RM see their DSMs but none of the reps beneath them, so a
 *    semester rolled up to "0.0%" and EGP 0 payout — wrong, and silent. `isWithinManagerHierarchy`
 *    climbs the full chain and is seat-continuity aware.
 *  - Scope is applied BEFORE any ranking or truncation. PR #1487: truncating company-wide first and
 *    filtering after silently emptied a scoped viewer's list. Here the agent list goes into the
 *    Postgres query, so nothing is ever ranked pre-scope.
 *  - Every failure path returns NO access, never a wider one. A missing hr id, an unknown role or a
 *    blank line resolves to `none`, never to `company`.
 *  - The role comes from the live AccessContext, never from client input.
 */

import { getEmployeeDirectoryRows, isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { isWithinManagerHierarchy, sameWorkforceLine } from "@/lib/workforce/hierarchy-resolver";
import {
  doctorCoverageScopeBasisForRole,
  type DoctorCoverageScope,
  type DoctorCoverageScopeBasis,
} from "@/lib/crm/doctor-coverage-roles";
import { getDoctorCoverageConfig, type DoctorCoverageLineOverrides } from "@/lib/crm/doctor-coverage-config";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import type { AccessContext } from "@/lib/auth/permissions";

/**
 * The scope SHAPE and the pure `isAgentInScope` check live in doctor-coverage-roles.ts, which is
 * kept free of server-only imports; this module RESOLVES a scope and is server-only itself.
 * Re-exported here so the many callers that already import the type from the resolver keep working,
 * and so "where is the scope type" has one obvious answer.
 */
export { isAgentInScope, type DoctorCoverageScope } from "@/lib/crm/doctor-coverage-roles";

/** Directory fields this module actually reads — keeps the pure core testable without a DB. */
export type DoctorCoverageScopeEmployee = {
  employmentStatus: string | null;
  hrId: string;
  /** Read ONLY by the downward rule below, to rank this seat against the viewer's own. */
  jobTitle: string | null;
  lineId: number | null;
  lineName: string | null;
  managerHrId: string | null;
  pendingManagerReplacementForHrId: string | null;
};

/**
 * THE DOWNWARD RULE - owner, 2026-09-04, stated plainly: "Never an employee sees his direct
 * manager. You see yourself and your scope down - downgrading, not upgrading." Asked whether the
 * cut should reach past his own manager, he answered: "remove dsms rsm and peer pms too."
 *
 * A `line` scope is line MEMBERSHIP, which is neither up nor down: it is everyone who happens to
 * carry that line id. Measured in production the day the rule was given, Product Manager B-155's
 * scope held 57 people - 41 medical reps, 10 District Sales Managers, 2 National Sales Managers, a
 * peer Product Manager, a Regional Sales Manager, and A-8, his own direct manager, who has 57 real
 * CRM visits of her own. Nothing rendered her, but only by accident: the Reps Plans board carries
 * an explicit medical-reps-only filter, and the KPIs board simply had no plan row to build for her.
 * Neither is a rule. So the stop belongs HERE, in the resolver that IS the security boundary, and
 * not in whichever downstream board remembers to filter.
 *
 * TWO INDEPENDENT CUTS, because they catch different things:
 *
 *   1. The viewer's own management chain - his manager, his manager's manager, all the way up.
 *      Identity-based and title-BLIND, so it still catches a manager whose job title is misspelt,
 *      missing, or absent from the ladder below.
 *   2. Anyone not ranked strictly BELOW the viewer's own seat, per the ladder.
 *
 * WHY A LADDER AND NOT A LIST OF BANNED TITLES. The `line` basis serves all three of
 * doctor-coverage-roles.ts's LINE_ROLES, and "District Sales Manager" is upward from a Product
 * Manager but DOWNWARD from a National Sales Manager. A flat blocklist of DSM/RSM/peer-PM would
 * therefore have deleted an NSM's own reports and handed him "no active employees are recorded on
 * your product line" - the module's own empty state, indistinguishable from a data fault. A ladder
 * is relative to the viewer, so one rule serves all three seats correctly.
 *
 * A title the ladder does not know is EXCLUDED from a line scope. That is deliberate, and it is the
 * safe direction: in production 12 head-office seats (the CEO, HR, Finance, QPPV, R&D, even
 * "Buffet") carry a line_id, so "unknown means field force, keep them" would put the CEO inside a
 * Product Manager's scope. It costs nothing today - lines 1, 2 and 3 are the field lines and every
 * title on them is ranked here, while line 4, which holds those office seats, has no line-scoped
 * viewer on it at all.
 *
 * THE VIEWER IS NEVER EXCLUDED FROM HIS OWN SCOPE. That guard is load-bearing rather than tidy: a
 * National Sales Manager is not strictly below himself, so without it the ladder would delete him
 * from his own board and produce exactly the empty state described above.
 *
 * The rank numbers are ORDER ONLY and carry no meaning of their own. Both spellings of each seat
 * are listed because this repo runs two vocabularies: an app ROLE ("Medical Rep", "District
 * Manager", "Regional Manager") and an employee JOB TITLE ("Medical Representative", "District
 * Sales Manager", "Regional Sales Manager"). A Product Manager is ranked alongside a District Sales
 * Manager on purpose - that is what makes a peer PM, and every DSM, fall outside his scope while
 * leaving the 41 medical reps inside it.
 */
const SEAT_RANK = new Map<string, number>([
  ["medical rep", 1],
  ["medical representative", 1],
  // A seniority grade on the rep title, ranked with the reps (B-7, 2026-09-29). The lookup is exact
  // and an unranked title is EXCLUDED from a line scope by design, so leaving it off would delete a
  // real rep's own coverage scope over an appreciation label.
  ["senior medical representative", 1],
  ["district manager", 2],
  ["district sales manager", 2],
  // A SENIORITY grade on the same district seat, not a rung between DM and RSM — ranking it 2
  // keeps his own reps inside his scope and keeps him inside his NSM's, exactly as before the
  // promotion (B-94, 2026-09-29). The lookup is exact, and an unranked title is EXCLUDED from a
  // line scope by design, so leaving it off would have deleted a real district from the boards.
  ["senior district manager", 2],
  ["product manager", 2],
  ["regional manager", 3],
  ["regional sales manager", 3],
  ["group product manager", 3],
  ["national sales manager", 4],
]);

/** `null` means this seat is not on the ladder at all. */
function seatRank(titleOrRole: string | null | undefined): number | null {
  const key = titleOrRole?.trim().toLowerCase();
  if (!key) return null;
  return SEAT_RANK.get(key) ?? null;
}

/**
 * Every ancestor of the viewer, canonicalised. Climbs `managerHrId` exactly as
 * `isWithinManagerHierarchy` does, and treats a pending seat replacement as an ancestor too — the
 * conservative direction, because being wrong here hides a row rather than exposing one.
 *
 * The `chain.has` break is not decoration: a self-referencing or mutually-referencing manager pair
 * exists in this directory often enough that the downward walk guards against it, and an unguarded
 * climb would spin forever inside a server render.
 */
function managementChainOf(
  viewerCanonicalHrId: string,
  byCanonicalHrId: ReadonlyMap<string, DownwardCutPerson>,
): ReadonlySet<string> {
  const chain = new Set<string>();
  let node = byCanonicalHrId.get(viewerCanonicalHrId);

  while (node) {
    const pending = normalizeHrIdForAccess(node.pendingManagerReplacementForHrId ?? "");
    if (pending) chain.add(pending);

    const managerKey = normalizeHrIdForAccess(node.managerHrId ?? "");
    if (!managerKey || chain.has(managerKey)) break;
    chain.add(managerKey);
    node = byCanonicalHrId.get(managerKey);
  }

  return chain;
}

/** Cut 1: true when this person is an ancestor of the viewer, so must not appear in his scope. */
function isAboveViewer(
  employee: Pick<DownwardCutPerson, "hrId">,
  viewerCanonicalHrId: string,
  chain: ReadonlySet<string>,
): boolean {
  const key = normalizeHrIdForAccess(employee.hrId);
  if (!key || key === viewerCanonicalHrId) return false; // you always see yourself
  return chain.has(key);
}

/**
 * The fields the downward rule reads — a narrow slice of a directory row, so any module holding
 * `EmployeeDirectoryRow`s (double-visit analytics, coaching) can hand them in unchanged.
 * `positionTitle` is optional because doctor coverage's own rows do not carry it.
 */
export type DownwardCutPerson = {
  hrId: string;
  jobTitle: string | null;
  managerHrId: string | null;
  pendingManagerReplacementForHrId: string | null;
  positionTitle?: string | null;
};

export type DownwardCut = {
  /** Canonical (normalizeHrIdForAccess) viewer key, or null when the session carries no id. */
  viewerKey: string | null;
  /** Canonical keys of every ancestor of the viewer. Never contains the viewer. */
  chain: ReadonlySet<string>;
  /** Cut 1 — identity-based, title-blind. False for the viewer himself. */
  isAboveViewer: (person: Pick<DownwardCutPerson, "hrId">) => boolean;
  /** Cut 2 — the seat-rank ladder. True for the viewer himself; false for an unranked title. */
  isStrictlyBelowViewer: (person: DownwardCutPerson) => boolean;
  /** Cut 2, unranked-tolerant — true only for a person whose title IS on the ladder at or above the
   * viewer's seat. An unranked title answers false. Owner decision 2026-09-13 (double-visit board):
   * a visitor with no sales rank — Training Manager, SFE Manager — stays visible. */
  isRankedAtOrAboveViewer: (person: DownwardCutPerson) => boolean;
};

/**
 * THE DOWNWARD RULE, exported for the OTHER surfaces that must obey it (double-visit analytics,
 * coaching). Built from the very same private helpers `resolveDoctorCoverageScope` uses —
 * `SEAT_RANK`, `seatRank`, `managementChainOf`, `isAboveViewer` — so there is ONE ladder and ONE
 * climb in the repo, not a copy that drifts. `resolveDoctorCoverageScope` itself does NOT call this
 * and its output is unchanged; this is an export, not a refactor.
 *
 * `employees` must be the FULL directory including inactive people, for the same reason as above:
 * a climb that stops at a manager who has left misses every ancestor above him, which fails in the
 * EXPOSING direction.
 *
 * ONE DELIBERATE DIFFERENCE FROM THE LOCKED RESOLVER, and it only ever narrows: a person is ranked by
 * the MORE SENIOR of `jobTitle` and `positionTitle` (Math.max). Doctor coverage reads `jobTitle`
 * alone because its rows carry nothing else. Ranking `positionTitle` FIRST was the regression that
 * sank an earlier attempt (it raised exposure); taking the higher of the two can only push a person
 * up the ladder and therefore OUT of a viewer's scope, never into it. The VIEWER is ranked exactly as
 * the resolver ranks him — role first, job title as the fallback.
 */
export function buildDownwardCut(input: {
  role: string;
  viewerHrId: string | null;
  employees: readonly DownwardCutPerson[];
}): DownwardCut {
  const viewerKey = normalizeHrIdForAccess(input.viewerHrId?.trim() ?? "") || null;
  const byCanonicalHrId = new Map<string, DownwardCutPerson>();
  for (const employee of input.employees) {
    const key = normalizeHrIdForAccess(employee.hrId);
    if (key) byCanonicalHrId.set(key, employee);
  }
  const chain = viewerKey ? managementChainOf(viewerKey, byCanonicalHrId) : new Set<string>();
  // A self-referencing record puts the viewer in his own chain; he is never above himself.
  if (viewerKey && chain.has(viewerKey)) {
    const withoutViewer = new Set(chain);
    withoutViewer.delete(viewerKey);
    return buildCut(withoutViewer);
  }
  return buildCut(chain);

  function buildCut(finalChain: ReadonlySet<string>): DownwardCut {
    const viewer = viewerKey ? byCanonicalHrId.get(viewerKey) ?? null : null;
    const viewerRank = seatRank(input.role) ?? seatRank(viewer?.jobTitle);
    const rankOf = (person: DownwardCutPerson) => {
      const byJob = seatRank(person.jobTitle);
      const byPosition = seatRank(person.positionTitle);
      if (byJob == null) return byPosition;
      if (byPosition == null) return byJob;
      return Math.max(byJob, byPosition);
    };
    return {
      viewerKey,
      chain: finalChain,
      isAboveViewer: (person) => (viewerKey ? isAboveViewer(person, viewerKey, finalChain) : false),
      isStrictlyBelowViewer: (person) => {
        if (viewerRank == null) return true;
        if (viewerKey && normalizeHrIdForAccess(person.hrId) === viewerKey) return true; // you always see yourself
        const rank = rankOf(person);
        return rank != null && rank < viewerRank;
      },
      isRankedAtOrAboveViewer: (person) => {
        if (viewerRank == null) return false;
        if (viewerKey && normalizeHrIdForAccess(person.hrId) === viewerKey) return false;
        const rank = rankOf(person);
        return rank != null && rank >= viewerRank;
      },
    };
  }
}

/**
 * Pure core — fixture-testable, no IO. `employees` must be the FULL directory including inactive
 * people (see the note on the hierarchy map below); this function does the active-only filtering
 * itself on the way out.
 */
export function resolveDoctorCoverageScope(input: {
  role: string;
  viewerHrId: string | null;
  employees: readonly DoctorCoverageScopeEmployee[];
  /** Canonical hr id → line ids, from doctor_coverage_config. Applies to LINE-scoped roles only:
   * it replaces which lines they cover and can never widen a team/self scope or grant access to a
   * role that has none, because the role check above runs first. */
  lineOverrides?: DoctorCoverageLineOverrides;
}): DoctorCoverageScope {
  const basis = doctorCoverageScopeBasisForRole(input.role);
  if (!basis) {
    return { kind: "none", reason: `Doctor coverage is not available to the ${input.role} role.` };
  }
  if (basis === "company") {
    return { kind: "company", basis: "company", label: `${input.role} · all lines` };
  }

  const viewerHrId = input.viewerHrId?.trim() ?? "";
  const viewerKey = normalizeHrIdForAccess(viewerHrId);
  if (!viewerKey) {
    return { kind: "none", reason: "No HR ID is attached to your session, so no territory can be resolved." };
  }

  if (basis === "self") {
    // Passed through in the session's own casing on purpose: the CRM reads door sprays every
    // casing/alias variant itself (expandHrIdFilterValues), and pre-normalizing here would strip
    // the hyphen out of an id like "B-124" that the mirror actually stores.
    return { kind: "agents", basis: "self", agentHrIds: [viewerHrId], label: `${input.role} · own panel` };
  }

  const viewer = input.employees.find((employee) => normalizeHrIdForAccess(employee.hrId) === viewerKey);
  if (!viewer) {
    return { kind: "none", reason: "Your employee record could not be found, so no territory can be resolved." };
  }

  // Built from EVERY employee, including inactive ones, and hoisted above both remaining bases —
  // the team walk needs it (see the note further down) and so does the upward rule, which has to
  // climb through a manager who may himself have left.
  const byCanonicalHrId = new Map<string, DoctorCoverageScopeEmployee>();
  for (const employee of input.employees) {
    const key = normalizeHrIdForAccess(employee.hrId);
    if (key) byCanonicalHrId.set(key, employee);
  }
  const chain = managementChainOf(viewerKey, byCanonicalHrId);
  const notInTheViewersChain = (employee: DoctorCoverageScopeEmployee) =>
    !isAboveViewer(employee, viewerKey, chain);

  if (basis === "line") {
    // Line identity comes off the viewer's own employee row here (not the org tree) because these
    // are staff seats with no reports to walk — a Product Manager owns brands, not people.
    //
    // An OVERRIDE wins when one exists. Some managers cover more than one line: Ahmed Sharaf
    // (B-155) is recorded on Pedia but owns brands on Anti Infective too (owner, 2026-08-09).
    // Overriding here rather than editing his employee record keeps that field honest for payroll
    // and org structure, and keeps the exception in one editable place.
    const override = input.lineOverrides?.[viewerKey];
    const lineIds = override && override.length > 0 ? override : viewer.lineId != null ? [viewer.lineId] : [];

    if (lineIds.length === 0 && !viewer.lineName?.trim()) {
      return { kind: "none", reason: "No product line is recorded on your employee record, so a whole-line scope cannot be granted." };
    }

    const onScopedLine = (employee: DoctorCoverageScopeEmployee) =>
      lineIds.length > 0
        ? employee.lineId != null && lineIds.includes(employee.lineId)
        : // No usable line id anywhere — fall back to the shared name-based comparison, which is
          // what a single-line viewer used before overrides existed.
          sameWorkforceLine(viewer, employee);

    // Cut 2 of the downward rule, and the reason it is applied on THIS basis only: a team scope
    // is already provably downward, because it is walked out of the org tree. The viewer's own
    // rank comes from his ROLE - the live AccessContext, never client input - and every LINE_ROLE
    // is on the ladder. The job-title fallback, and the `viewerRank == null` pass-through inside
    // the predicate, exist only so a line role added later without a ladder entry degrades to the
    // chain-only behaviour instead of to an empty board; runDoctorCoverageScopeTests asserts every
    // LINE_ROLE is ranked, because an unranked one would otherwise fail silently right here.
    const viewerRank = seatRank(input.role) ?? seatRank(viewer.jobTitle);
    const strictlyBelowTheViewer = (employee: DoctorCoverageScopeEmployee) => {
      if (viewerRank == null) return true;
      if (normalizeHrIdForAccess(employee.hrId) === viewerKey) return true; // you always see yourself
      const rank = seatRank(employee.jobTitle);
      return rank != null && rank < viewerRank;
    };

    const agentHrIds = input.employees
      .filter((employee) => isActiveLifecycleStatus(employee.employmentStatus))
      .filter(onScopedLine)
      .filter(notInTheViewersChain)
      .filter(strictlyBelowTheViewer)
      .map((employee) => employee.hrId);

    // Name every line the viewer actually covers — the owner's rule is that a viewer always sees
    // whose numbers these are, and "own line" says nothing when the answer is two lines.
    const lineNames = Array.from(
      new Set(
        lineIds
          .map((id) => input.employees.find((employee) => employee.lineId === id)?.lineName?.trim())
          .filter((name): name is string => Boolean(name)),
      ),
    );
    const scopeName = lineNames.length > 0 ? lineNames.join(" + ") : viewer.lineName?.trim() || "own";
    const suffix = lineNames.length > 1 ? "lines" : "line";
    return finalizeAgents(agentHrIds, "line", `${input.role} · ${scopeName} ${suffix}`);
  }

  // ── team scope (District Manager: own reps; Regional Manager: every rep under the region) ──
  // `byCanonicalHrId` is built above from EVERY employee, including inactive ones, while only
  // ACTIVE people are emitted below. That asymmetry is deliberate and load-bearing:
  // isWithinManagerHierarchy climbs `managerHrId` node by node, so if an intermediate manager (say
  // a DM who has just resigned) were missing from the map the climb would break at that node and
  // the RM above would lose every rep beneath them — the exact silent-empty failure PR #1486 was
  // about. Departed reps are still filtered out of the OUTPUT, and the CRM reads door drops their
  // visits independently.
  //
  // The chain cut is applied here too. On this basis it should be a no-op by construction — an
  // ancestor is never inside your own subtree — so it is defence in depth against a directory whose
  // manager links form a cycle, the exact shape the climb above already guards against. The RANK
  // ladder deliberately does NOT run here: this list is already downward-only, and ranking it would
  // drop a report whose job title happens to sit off the ladder (an Admin Assistant under a DM,
  // say) out of his own manager's board.
  const agentHrIds = input.employees
    .filter((employee) => isActiveLifecycleStatus(employee.employmentStatus))
    .filter((employee) =>
      isWithinManagerHierarchy({
        employee,
        byCanonicalHrId,
        viewerCanonicalHrId: viewerKey,
        canonicalize: normalizeHrIdForAccess,
      }),
    )
    .filter(notInTheViewersChain)
    .map((employee) => employee.hrId);
  const label = input.role === "Regional Manager" ? `${input.role} · own region` : `${input.role} · own team`;
  return finalizeAgents(agentHrIds, "team", label);
}

/**
 * An empty agent list must never reach the query. `queryVisits` treats `agentHrIds: []` as "no
 * rows", which would render an innocent-looking empty board — indistinguishable from a rep who
 * genuinely visited nobody. A viewer with no resolvable team gets an explicit explanation instead.
 */
function finalizeAgents(
  agentHrIds: readonly string[],
  basis: Exclude<DoctorCoverageScopeBasis, "company">,
  label: string,
): DoctorCoverageScope {
  const unique = Array.from(new Set(agentHrIds.filter((hrId) => hrId?.trim())));
  if (unique.length === 0) {
    return {
      kind: "none",
      reason:
        basis === "line"
          ? "No active employees are recorded on your product line, so there is no panel to show."
          : "No active reports are attached to your seat in the org tree, so no territory can be resolved.",
    };
  }
  return { kind: "agents", basis, agentHrIds: unique, label };
}

/**
 * IO wrapper: resolve the live directory, then the pure core.
 *
 * `access.role` must come from the live AccessContext, never from client input — the same rule the
 * Business Review portal scope enforces. A company-scoped role short-circuits before the directory
 * read, so the CEO command center does not pay for a directory fetch it will not filter on.
 */
export async function getDoctorCoverageScope(access: AccessContext): Promise<DoctorCoverageScope> {
  const basis = doctorCoverageScopeBasisForRole(access.role);
  if (!basis) {
    return { kind: "none", reason: `Doctor coverage is not available to the ${access.role} role.` };
  }
  if (basis === "company") {
    return { kind: "company", basis: "company", label: `${access.role} · all lines` };
  }
  // includeInactive: the hierarchy map needs every node to stay walkable — see the note above.
  // Line overrides come from the same cached config the norms do, so this costs no extra read on a
  // warm cache and degrades to "no overrides" (each viewer's own line) if the table is missing.
  const [employees, config] = await Promise.all([
    getEmployeeDirectoryRows({ includeInactive: true }),
    getDoctorCoverageConfig(),
  ]);
  return resolveDoctorCoverageScope({
    role: access.role,
    viewerHrId: access.hrId,
    employees,
    lineOverrides: config.lineOverrides,
  });
}

/** One person an override can meaningfully be set for, plus where they sit today. */
export type DoctorCoverageOverrideCandidate = {
  /** Canonical key — what the override map is stored under. */
  canonicalHrId: string;
  hrId: string;
  jobTitle: string;
  /** Line on their employee record, i.e. what they see WITHOUT an override. */
  lineId: number | null;
  lineName: string | null;
  name: string;
};

/**
 * Everything the override editor needs, derived from the employee directory rather than a new
 * query — the directory is already cached and already carries lineId + lineName.
 *
 * Candidates are limited to LINE-SCOPED roles on purpose. An override on anyone else is silently
 * inert: a District Manager is scoped by the org tree and a Medical Rep to themselves, so storing
 * lines against them would look like a setting that does nothing. Offering only the roles it can
 * actually affect is the difference between a control and a trap.
 *
 * Lines come from the people themselves, so a line with nobody on it never appears — an override
 * pointing at an empty line would produce a blank board and read as a bug.
 */
export async function getDoctorCoverageOverrideOptions(): Promise<{
  candidates: DoctorCoverageOverrideCandidate[];
  lines: Array<{ id: number; name: string }>;
}> {
  const employees = await getEmployeeDirectoryRows({ includeInactive: false });

  const lineMap = new Map<number, string>();
  for (const employee of employees) {
    if (employee.lineId != null && employee.lineName?.trim()) {
      lineMap.set(employee.lineId, employee.lineName.trim());
    }
  }

  const candidates = employees
    .filter((employee) => doctorCoverageScopeBasisForRole(employee.jobTitle?.trim() ?? "") === "line")
    .map((employee) => ({
      canonicalHrId: normalizeHrIdForAccess(employee.hrId) ?? "",
      hrId: employee.hrId,
      jobTitle: employee.jobTitle?.trim() ?? "",
      lineId: employee.lineId,
      lineName: employee.lineName?.trim() || null,
      name: employee.displayName || employee.fullName || employee.hrId,
    }))
    .filter((candidate) => candidate.canonicalHrId)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    candidates,
    lines: Array.from(lineMap, ([id, name]) => ({ id, name })).sort((a, b) => a.id - b.id),
  };
}
