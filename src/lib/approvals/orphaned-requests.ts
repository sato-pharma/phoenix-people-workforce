// ─────────────────────────────────────────────────────────────────────────────
// Orphaned approval requests — a request that can no longer move because the one
// person who must act on it next has left the company.
//
// WHY THIS EXISTS. Every chain-shaped workflow in Phoenix (marketing, direct
// orders, vacation) has the same hole: a request handed back to its requester to
// edit, or sitting on a named approver's rung, goes nowhere once that person
// resigns. Login is blocked for a resigned employee, so a `returned` request they
// own can never be resubmitted, and an approval rung assigned to them by name can
// never be decided. Nothing in the product surfaces it — it is not in anyone's
// "waiting on me" queue and it is not terminal, so it simply ages out of sight.
// On 2026-10-04 five direct orders (two resigned reps, 48–52 days) were stranded
// exactly this way and only a hand sweep of the database found them.
//
// WHAT "ORPHANED" MEANS HERE, precisely: a NON-TERMINAL request whose single
// required next actor is a person the employee master reports as NOT active.
//
//   * A request handed back to its requester (`returned`) → the actor is the
//     REQUESTER. If they have left, nobody can resubmit it.
//   * A request awaiting a decision → the actor is the approver on the ACTIVE
//     rung (marketing's `current` step; the earliest still-`pending` step on the
//     other two). If that rung names a person who has left, it cannot advance.
//
// A rung with no named person (a direct-order role rung resolves its approver by
// ROLE at decision time, `approver_hr_id` null) is NEVER orphaned by one
// departure, so it is not a candidate. A deliberate pause (`held`, `finance_hold`)
// has no next actor by design and is not a candidate either. An actor we cannot
// find in the employee master at all is left ALONE — this flags a known
// resignation, not every odd id, because a false "stuck" accuses a cleanup that
// is not needed.
//
// This module is PURE above the one reader. `selectOrphanedRequests` and
// `summarizeOrphans` take rows and an employee map and decide; `findOrphanedRequests`
// is the only part that touches Supabase, and it THROWS on a read failure rather
// than returning an empty list — an unread chain must surface as "could not be
// read", never as "nothing is stuck" (the Needs You board's governing rule).
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

import { isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Which workflow the stranded request belongs to. */
export type OrphanedRequestModule = "direct-order" | "marketing" | "vacation";

/** Whether the person who can no longer act is the one who raised it or the one who must decide it. */
export type OrphanedActorRole = "requester" | "approver";

/** A human label for each module, as a person would say it — never a table name. */
export const orphanedRequestModuleLabels: Record<OrphanedRequestModule, string> = {
  "direct-order": "direct order",
  marketing: "marketing request",
  vacation: "vacation request",
};

/**
 * Where each module's stranded request is cleared up. The board links here; it never acts.
 *
 * 🔴 `requesterRemedy` IS THE VERB THAT SCREEN CAN ACTUALLY PERFORM, and it lives here as a field
 * rather than as a word in the copy because getting it wrong is a real defect this file shipped.
 * Until 2026-10-08 the direct-order note read "reassign or close them on the Direct Orders screen"
 * and **neither control existed anywhere in Phoenix** — Stuck Approvals reassigned weekly plans and
 * excuses only, and cancelling a direct order took `held` only. So five stranded orders were found
 * correctly by this module, shown correctly on the board, and then cleared by hand-written SQL
 * against production, because the remedy the board named could not be clicked. Naming a verb here
 * without building the control is that bug again.
 *
 * 🔴 `requesterRemedy: null` MEANS NO CONTROL EXISTS, and the board then says so in plain words
 * instead of printing a verb. No module is null today. `vacation` WAS: a returned vacation is handed
 * back to the employee (`manager_return` → `returned`) and only that employee may resubmit it, and
 * until 2026-10-15 nothing could clear one for a resigned employee (`admin_delete` would destroy it
 * and the `v2_vacation_requests` status check had no `cancelled`). `closeOrphanedVacationRequest`
 * now does, on Stuck Approvals. If a module ever loses its control, set the verb back to null rather
 * than leave the board naming a button nobody can click.
 *
 * `requesterHref` / `requesterScreen` are optional: a module whose APPROVER-case screen differs from
 * its REQUESTER-case screen names the second one here. Vacation's approver case is solved on Leave
 * Approvals (reassign the rung), its requester case on Stuck Approvals (close the request).
 */
export const orphanedRequestModuleScreens: Record<
  OrphanedRequestModule,
  {
    href: `/${string}`;
    screen: string;
    requesterRemedy: string | null;
    requesterHref?: `/${string}`;
    requesterScreen?: string;
  }
> = {
  // CLOSED, never reassigned: a resubmit reprices the basket on today's basis and resumes at the
  // rung that returned it, so re-addressing one hands a live manager a money edit rather than an
  // administrative tidy. `closeOrphanedDirectOrder` — Super Admin only, and it refuses outright
  // while the requester can still log in.
  "direct-order": { href: "/admin/approvals/stuck", requesterRemedy: "close", screen: "Stuck Approvals" },
  // `cancelMarketingRequest` accepts `returned`, Super Admin only, from the request's own Case File
  // — which is reached from the inbox.
  marketing: { href: "/admin/marketing-requests/inbox", requesterRemedy: "cancel", screen: "Marketing Inbox" },
  // CLOSED, never reassigned and never deleted: `closeOrphanedVacationRequest` — Super Admin only,
  // takes `returned` only, and refuses while the employee can still log in. The approver case still
  // links to Leave Approvals, where the rung is reassigned.
  vacation: {
    href: "/admin/approvals/vacation",
    requesterHref: "/admin/approvals/stuck",
    requesterRemedy: "close",
    requesterScreen: "Stuck Approvals",
    screen: "Leave Approvals",
  },
};

/**
 * One request's next actor, already resolved — the grain the pure core decides over. `actorHrId`
 * null means the active rung names no specific person (a role rung), which can never be orphaned by
 * one departure, so such a row is simply dropped before deciding.
 */
export type OrphanedRequestCandidate = {
  module: OrphanedRequestModule;
  /** The request's own code or id, for the item key and for de-duplication. */
  requestKey: string;
  status: string;
  actorRole: OrphanedActorRole;
  actorHrId: string | null;
  /** The request's own `updated_at`, so the board can age it. */
  oldestAt: string | null;
};

/** What the employee master says about one person — the only facts the decision needs. */
export type OrphanedActorRecord = {
  name: string;
  employmentStatus: string | null;
};

/** A confirmed orphan: a candidate whose actor the master reports as not active. */
export type OrphanedRequest = {
  module: OrphanedRequestModule;
  requestKey: string;
  status: string;
  actorRole: OrphanedActorRole;
  actorHrId: string;
  actorName: string;
  employmentStatus: string | null;
  oldestAt: string | null;
};

/** One (module, reason) group, the shape the Needs You adapter turns into a single row. */
export type OrphanedRequestGroup = {
  module: OrphanedRequestModule;
  actorRole: OrphanedActorRole;
  count: number;
  /** Distinct actor names, for the row's people cell. Names, never ids. */
  people: string[];
  /** The oldest `updated_at` in the group, or null when none carried one. */
  oldestAt: string | null;
};

/**
 * Upper-cased so a lookup never misses on casing — `assigned_hr_id` keeps the master's own casing,
 * and the master itself is not uniformly upper-case (one live HR_ID is stored lower-case).
 */
function hrKey(hrId: string | null | undefined): string {
  return String(hrId ?? "").trim().toUpperCase();
}

/**
 * The decision, pure. A candidate is an orphan when its actor is named AND the master both knows
 * that person and reports them as not active. A missing actor, or an actor the master does not
 * hold, is NOT flagged — see the header: this detects a known departure, never guesses one.
 */
export function selectOrphanedRequests(
  candidates: readonly OrphanedRequestCandidate[],
  actorsByHrId: ReadonlyMap<string, OrphanedActorRecord>,
): OrphanedRequest[] {
  const out: OrphanedRequest[] = [];
  for (const candidate of candidates) {
    if (!candidate.actorHrId) continue;
    const actor = actorsByHrId.get(hrKey(candidate.actorHrId));
    if (!actor) continue;
    if (isActiveLifecycleStatus(actor.employmentStatus)) continue;
    out.push({
      module: candidate.module,
      requestKey: candidate.requestKey,
      status: candidate.status,
      actorRole: candidate.actorRole,
      actorHrId: candidate.actorHrId,
      actorName: actor.name,
      employmentStatus: actor.employmentStatus,
      oldestAt: candidate.oldestAt,
    });
  }
  return out;
}

/**
 * Group confirmed orphans by (module, reason) so the board shows one row per kind rather than one
 * per request — "2 direct orders are stuck on a rep who has resigned" reads better than two rows.
 * Oldest-first inside each group by way of the min `oldestAt`.
 */
export function summarizeOrphans(orphans: readonly OrphanedRequest[]): OrphanedRequestGroup[] {
  const groups = new Map<string, OrphanedRequestGroup>();
  for (const orphan of orphans) {
    const key = `${orphan.module}:${orphan.actorRole}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (!existing.people.includes(orphan.actorName)) existing.people.push(orphan.actorName);
      if (orphan.oldestAt && (!existing.oldestAt || orphan.oldestAt < existing.oldestAt)) {
        existing.oldestAt = orphan.oldestAt;
      }
    } else {
      groups.set(key, {
        module: orphan.module,
        actorRole: orphan.actorRole,
        count: 1,
        people: [orphan.actorName],
        oldestAt: orphan.oldestAt,
      });
    }
  }
  return [...groups.values()];
}

// ── The reader — the one part that touches the database ───────────────────────────────────────────

/**
 * Statuses that mean "handed back to the requester to edit", per module. The actor is the requester.
 *
 * Vacation's `returned` belongs here: a manager's "Return for Edit" (`manager_return`) hands it to the
 * EMPLOYEE, the approval screen disables every button with "Waiting for the employee to resubmit", and
 * only `resubmitVacationRequest` moves it on. Until 2026-10-08 this list was empty for vacation, so a
 * returned vacation fell into the approver branch, found no pending rung and was silently dropped.
 */
const BACK_WITH_REQUESTER: Record<OrphanedRequestModule, readonly string[]> = {
  marketing: ["returned"],
  "direct-order": ["returned"],
  vacation: ["returned"],
};

/**
 * Statuses that are finished OR deliberately paused — neither awaits an actor, so they are never
 * candidates. Everything else on a module is treated as awaiting its active-rung approver.
 *
 * 🔴 Every TERMINAL status must be listed, not only the common ones: a finished request's approval
 * steps are NOT cleaned up (read live 2026-10-08: 59 still-`pending` direct-order steps sat on
 * rejected orders, 39 on returned ones and 15 on cancelled ones), so a terminal status left off
 * this list reads as "awaiting its approver" and a resigned name on that leftover rung is reported
 * as stuck.
 *
 * Direct orders, against the live CHECK (draft, pending_approval, approved, rejected, returned,
 * reversed, held, expired, cancelled): `reversed` and `expired` are terminal (the order page shows
 * them as stopped, with no owner). `draft` is "not submitted yet — only you can see it": it sits with
 * its author, is in no approver's queue and waits on nobody, so it is not a stranded request either
 * — the same reading marketing already gives its own `draft`.
 */
const NO_ACTOR_EXPECTED: Record<OrphanedRequestModule, readonly string[]> = {
  marketing: ["draft", "approved", "active", "roi_tracking", "closed", "finance_hold", "archived", "cancelled", "rejected"],
  "direct-order": ["draft", "approved", "rejected", "reversed", "expired", "cancelled", "held"],
  vacation: ["approved", "rejected", "cancelled"],
};

/** Page size for the employee-master read. Supabase caps a response at 1,000 rows. */
const EMPLOYEE_PAGE_SIZE = 1000;

/** PostgREST folds every `.in()` value into the request URL; past a few hundred ids it answers EMPTY with no error. */
const REQUEST_ID_BATCH = 100;

/** The approval-step rows of many requests: ids in batches, every batch read to its end. A failed page throws. */
async function stepsInBatches<T>(
  requestIds: readonly string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildQuery: (batch: string[]) => any,
): Promise<T[]> {
  const rows: T[] = [];
  for (let index = 0; index < requestIds.length; index += REQUEST_ID_BATCH) {
    const batch = requestIds.slice(index, index + REQUEST_ID_BATCH);
    rows.push(...(await fetchAllRows<T>(() => buildQuery(batch), "id")));
  }
  return rows;
}

type ParentRow = { id: string; status: string | null; actorHrId: string | null; updatedAt: string | null };

/** The earliest still-pending rung's named approver for each request id, or null for a role rung. */
function earliestPendingApprover(
  steps: ReadonlyArray<{ request_id: string; step_order: number | null; approver_hr_id: string | null; status: string | null }>,
): Map<string, string | null> {
  const best = new Map<string, { order: number; hrId: string | null }>();
  for (const step of steps) {
    if (String(step.status ?? "").trim().toLowerCase() !== "pending") continue;
    const order = Number(step.step_order ?? Number.MAX_SAFE_INTEGER);
    const current = best.get(step.request_id);
    if (!current || order < current.order) {
      best.set(step.request_id, { order, hrId: step.approver_hr_id ?? null });
    }
  }
  const out = new Map<string, string | null>();
  for (const [requestId, value] of best) out.set(requestId, value.hrId);
  return out;
}

/**
 * Build the candidate list for one module: its non-terminal parents resolved to a next actor.
 * `resolveApprover(requestId)` returns the named approver of the active rung, or null for a role rung.
 */
function candidatesForModule(
  module: OrphanedRequestModule,
  parents: readonly ParentRow[],
  resolveApprover: (requestId: string) => string | null,
): OrphanedRequestCandidate[] {
  const backWith = new Set(BACK_WITH_REQUESTER[module]);
  const finished = new Set(NO_ACTOR_EXPECTED[module]);
  const candidates: OrphanedRequestCandidate[] = [];
  for (const parent of parents) {
    const status = String(parent.status ?? "").trim().toLowerCase();
    if (finished.has(status)) continue;
    if (backWith.has(status)) {
      candidates.push({
        module,
        requestKey: parent.id,
        status,
        actorRole: "requester",
        actorHrId: parent.actorHrId,
        oldestAt: parent.updatedAt,
      });
      continue;
    }
    candidates.push({
      module,
      requestKey: parent.id,
      status,
      actorRole: "approver",
      actorHrId: resolveApprover(parent.id),
      oldestAt: parent.updatedAt,
    });
  }
  return candidates;
}

/**
 * Read all three chains and return the requests stranded on someone who has left. Throws on any read
 * failure — the caller (the Needs You adapter) turns a throw into an amber "could not be read" row,
 * which is the only safe direction for a board whose one job is never to under-report.
 */
export async function findOrphanedRequests(
  supabase: SupabaseClient = getSupabaseAdmin(),
): Promise<OrphanedRequest[]> {
  // ── Marketing ──
  // Every read below is paged (a page error throws, as before): this board's one job is never to
  // under-report, so a response cut at a row ceiling must not be able to hide a stranded request.
  const marketingParentsQuery = () =>
    supabase
      .from("marketing_requests")
      .select("id, status, requester_hr_id, updated_at")
      .not("status", "in", `(${NO_ACTOR_EXPECTED.marketing.join(",")})`);
  const marketingRows = await fetchAllRows<{ id: string; status: string | null; requester_hr_id: string | null; updated_at: string | null }>(marketingParentsQuery, "id");
  const marketingAwaiting = marketingRows
    .filter((row) => !new Set(BACK_WITH_REQUESTER.marketing).has(String(row.status ?? "").trim().toLowerCase()))
    .map((row) => row.id);
  const marketingCurrent = await stepsInBatches<{ request_id: string; assigned_hr_id: string | null }>(marketingAwaiting, (batch) =>
    supabase
      .from("marketing_request_approval_steps")
      .select("request_id, assigned_hr_id")
      .eq("status", "current")
      .eq("is_cc", false)
      .in("request_id", batch),
  );
  const marketingApproverByRequest = new Map<string, string | null>();
  for (const step of marketingCurrent) {
    marketingApproverByRequest.set(step.request_id, step.assigned_hr_id ?? null);
  }
  const marketingCandidates = candidatesForModule(
    "marketing",
    marketingRows.map((row) => ({ id: row.id, status: row.status, actorHrId: row.requester_hr_id, updatedAt: row.updated_at })),
    (id) => marketingApproverByRequest.get(id) ?? null,
  );

  // ── Direct orders ──
  const directParentsQuery = () =>
    supabase
      .from("direct_order_requests")
      .select("id, status, requester_hr_id, updated_at")
      .not("status", "in", `(${NO_ACTOR_EXPECTED["direct-order"].join(",")})`);
  const directRows = await fetchAllRows<{ id: string; status: string | null; requester_hr_id: string | null; updated_at: string | null }>(directParentsQuery, "id");
  const directAwaiting = directRows
    .filter((row) => !new Set(BACK_WITH_REQUESTER["direct-order"]).has(String(row.status ?? "").trim().toLowerCase()))
    .map((row) => row.id);
  const directSteps = await stepsInBatches<{ request_id: string; step_order: number | null; approver_hr_id: string | null; status: string | null }>(
    directAwaiting,
    (batch) =>
      supabase
        .from("direct_order_approval_steps")
        .select("request_id, step_order, approver_hr_id, status")
        .in("request_id", batch),
  );
  const directApproverByRequest = earliestPendingApprover(directSteps);
  const directCandidates = candidatesForModule(
    "direct-order",
    directRows.map((row) => ({ id: row.id, status: row.status, actorHrId: row.requester_hr_id, updatedAt: row.updated_at })),
    (id) => directApproverByRequest.get(id) ?? null,
  );

  // ── Vacation ──
  const vacationParentsQuery = () =>
    supabase
      .from("v2_vacation_requests")
      .select("id, status, employee_hr_id, updated_at")
      .not("status", "in", `(${NO_ACTOR_EXPECTED.vacation.join(",")})`);
  const vacationRows = await fetchAllRows<{ id: string; status: string | null; employee_hr_id: string | null; updated_at: string | null }>(vacationParentsQuery, "id");
  const vacationAwaiting = vacationRows
    .filter((row) => !new Set(BACK_WITH_REQUESTER.vacation).has(String(row.status ?? "").trim().toLowerCase()))
    .map((row) => row.id);
  const vacationSteps = await stepsInBatches<{ request_id: string; step_order: number | null; approver_hr_id: string | null; status: string | null }>(
    vacationAwaiting,
    (batch) =>
      supabase
        .from("v2_vacation_approval_steps")
        .select("request_id, step_order, approver_hr_id, status")
        .in("request_id", batch),
  );
  const vacationApproverByRequest = earliestPendingApprover(vacationSteps);
  const vacationCandidates = candidatesForModule(
    "vacation",
    vacationRows.map((row) => ({ id: row.id, status: row.status, actorHrId: row.employee_hr_id, updatedAt: row.updated_at })),
    (id) => vacationApproverByRequest.get(id) ?? null,
  );

  // ── Resolve the actors and decide ──
  //
  // 🔴 THE WHOLE MASTER IS READ AND KEYED IN CODE, never filtered with `.in("hr_id", ids)`. Postgres
  // equality is case-sensitive, so an `.in` over the request rows' raw ids misses any actor whose
  // casing drifted from the master's — and a missing master row is exactly what `selectOrphanedRequests`
  // reads as "unknown, leave alone", so the orphan vanished without a trace. The master is a few
  // hundred rows; reading it whole and keying it through `hrKey` is the only form casing cannot beat.
  // Paged, because Supabase silently caps one response at 1,000 rows.
  const candidates = [...marketingCandidates, ...directCandidates, ...vacationCandidates];
  const wanted = new Set(candidates.map((candidate) => hrKey(candidate.actorHrId)).filter(Boolean));
  const actorsByHrId = new Map<string, OrphanedActorRecord>();
  if (wanted.size > 0) {
    for (let from = 0; ; from += EMPLOYEE_PAGE_SIZE) {
      const employees = await supabase
        .from("employees")
        .select("hr_id, full_name, employment_status")
        .order("hr_id", { ascending: true })
        .range(from, from + EMPLOYEE_PAGE_SIZE - 1);
      if (employees.error) throw employees.error;
      const page = (employees.data ?? []) as Array<{ hr_id: string; full_name: string | null; employment_status: string | null }>;
      for (const employee of page) {
        const key = hrKey(employee.hr_id);
        if (!wanted.has(key)) continue;
        actorsByHrId.set(key, {
          name: String(employee.full_name ?? "").trim() || employee.hr_id,
          employmentStatus: employee.employment_status ?? null,
        });
      }
      if (page.length < EMPLOYEE_PAGE_SIZE) break;
    }
  }

  return selectOrphanedRequests(candidates, actorsByHrId);
}
