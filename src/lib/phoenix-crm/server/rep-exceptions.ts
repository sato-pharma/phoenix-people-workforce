/**
 * Phoenix CRM — the Super Admin's Rep Exceptions page, server side: every rep, who has an exception, and the one
 * write. The rule, his words and what stays untouched are in `../rep-exception-rules.ts`.
 *
 * 🔴 THE PAGE SAYS WHAT THE DOOR WILL DO. `repStanding` reads only rows on the seats a rep holds now, because
 * `phoenix_crm_offplan_rep_exempt` matches the seat AND the rep, and the seats sent to the write are read here,
 * never taken from the page.
 */

import { forbiddenError, validationError } from "@/lib/http/api-errors";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, textOrNull } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import {
  parseRepExceptionAction,
  repExceptionDatesProblem,
  repStanding,
  suggestedRepExceptionWindow,
  type RepExceptionAction,
  type RepExceptionPick,
  type RepExceptionRow,
  type RepExceptionsAdminView,
  type StoredRepWindow,
} from "@/lib/phoenix-crm/rep-exception-rules";
import { personKey, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type StoredRow = {
  id: string;
  seat_id: string;
  rep_hr_id: string;
  valid_from: string;
  valid_until: string;
  ended_at: string | null;
  granted_by_hr_id: string | null;
  created_at: string | null;
};

/** The Super Admin, and never a test account. */
export function canManageRepExceptions(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin && viewer.canUpdate && !viewer.isTestPersona;
}

function assertManager(viewer: PhoenixCrmViewer): void {
  if (!canManageRepExceptions(viewer)) throw forbiddenError("Only the Super Admin manages rep exceptions.");
}

/** Everyone holding a rep seat, one entry per PERSON: both people on a shared seat, each person's every seat. */
function seatsByPerson(viewer: PhoenixCrmViewer): Map<string, OrgSeat[]> {
  const people = new Map<string, OrgSeat[]>();
  for (const seat of viewer.org.territoryHolders) {
    const key = personKey(seat.occupantHrId);
    if (!key) continue;
    const held = people.get(key) ?? [];
    held.push(seat);
    people.set(key, held);
  }
  return people;
}

async function loadStoredWindows(): Promise<Map<string, StoredRepWindow[]>> {
  const rows = await fetchAllRowsKeyset<StoredRow>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_offplan_exemptions")
        .select("id, seat_id, rep_hr_id, valid_from, valid_until, ended_at, granted_by_hr_id, created_at")
        .not("rep_hr_id", "is", null),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  const byPerson = new Map<string, StoredRepWindow[]>();
  for (const row of rows) {
    const key = personKey(row.rep_hr_id);
    if (!key) continue;
    const held = byPerson.get(key) ?? [];
    held.push({
      seatId: String(row.seat_id),
      from: String(row.valid_from),
      until: String(row.valid_until),
      endedAt: textOrNull(row.ended_at),
      grantedBy: textOrNull(row.granted_by_hr_id),
      createdAt: textOrNull(row.created_at),
    });
    byPerson.set(key, held);
  }
  return byPerson;
}

async function loadHireDates(): Promise<Map<string, string>> {
  const rows = await fetchAllRowsKeyset<{ hr_id: string; hire_date: string }>(
    () => getSupabaseAdmin().from("employees").select("hr_id, hire_date").not("hire_date", "is", null),
    { cursorColumn: "hr_id", cursorOf: (row) => String(row.hr_id) },
  );
  const dates = new Map<string, string>();
  for (const row of rows) {
    const key = personKey(row.hr_id);
    if (key) dates.set(key, String(row.hire_date).slice(0, 10));
  }
  return dates;
}

export async function loadRepExceptionsAdmin(viewer: PhoenixCrmViewer, rawRep: unknown): Promise<RepExceptionsAdminView> {
  assertManager(viewer);
  const today = viewer.cairoToday;
  const people = seatsByPerson(viewer);
  const [stored, hireDates] = await Promise.all([loadStoredWindows(), loadHireDates()]);

  const standings = new Map([...people].map(([key, seats]) => [key, repStanding(stored.get(key) ?? [], seats.map((seat) => seat.seatId), today)]));
  const names = await loadPeopleNames([...people.keys(), ...[...standings.values()].map((standing) => standing.live?.grantedBy ?? null)]);

  const joinDistinct = (values: Array<string | null | undefined>) => [...new Set(values.filter((value): value is string => Boolean(value)))].join(" · ");
  const reps: RepExceptionPick[] = [...people.entries()]
    .map(([hrId, held]) => ({
      hrId,
      name: nameOf(names, hrId),
      lineName: joinDistinct(held.map((seat) => seat.lineName)) || "No line",
      areaName: joinDistinct(held.map((seat) => seat.areaName)) || "No area",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const selected = reps.find((rep) => rep.hrId === personKey(textOrNull(rawRep))) ?? null;
  // A chosen rep alone; otherwise everyone who has ever had one, the live ones first.
  const shown = selected ? [selected] : reps.filter((rep) => stored.has(rep.hrId));
  const rows: RepExceptionRow[] = shown
    .map((rep) => {
      const standing = standings.get(rep.hrId);
      const live = standing?.live ?? null;
      const hireDate = hireDates.get(rep.hrId) ?? null;
      const window = live ? { from: live.from, until: live.until } : suggestedRepExceptionWindow(hireDate, today);
      return {
        ...rep,
        hireDate,
        on: Boolean(live),
        ...window,
        setByName: live?.grantedBy ? nameOf(names, live.grantedBy) : null,
        setAt: live?.createdAt ?? null,
      };
    })
    .sort((left, right) => Number(right.on) - Number(left.on) || left.name.localeCompare(right.name));

  const { offPlanDailyCap, offPlanWeeklyCap } = viewer.config.settings;
  return { today, offPlanDailyCap, offPlanWeeklyCap, reps, selected, rows };
}

/** One switch or one change of dates, for one rep. No message and no email goes to anybody. */
export async function setRepException(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ hrId: string; action: RepExceptionAction }> {
  assertManager(viewer);
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const hrId = personKey(textOrNull(body.hrId));
  if (!hrId) throw validationError("Choose a rep from the list.");
  const action = parseRepExceptionAction(body.action);
  if (!action) throw validationError("Reload the page and try again.");

  const seats = seatsByPerson(viewer).get(hrId) ?? [];
  if (seats.length === 0) throw validationError("This person holds no rep territory now. Reload the page.");

  if (action === "open") {
    const problem = repExceptionDatesProblem(body.from, body.until, viewer.cairoToday);
    if (problem) throw validationError(problem);
  }

  await callPhoenixCrm("phoenix_crm_rep_exception_set", {
    p_seats: seats.map((seat) => seat.seatId),
    p_rep: hrId,
    p_action: action,
    p_from: action === "open" ? String(body.from).trim() : null,
    p_until: action === "open" ? String(body.until).trim() : null,
    p_actor: viewer.hrId,
  });
  return { hrId, action };
}
