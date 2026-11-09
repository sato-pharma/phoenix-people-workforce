/**
 * Company device register — domain service.
 *
 * Four rules shape everything here, and three of them are the same rules
 * `src/lib/mailbox-offboarding/service.ts` follows, for the same reasons.
 *
 * 1. **The custody rules live in the database, not in this file.** `phx_device_issue`,
 *    `phx_device_return`, `phx_device_mark` and `phx_device_write_off` hold them: one live holder
 *    per device, a settlement capped at the value the holder saw when he signed (البند 10), a lost
 *    device that does NOT release its holder, and a damaged return that lands in `repair` rather
 *    than back in stock. This service calls them and reports what they return. A rule in a page is
 *    bypassed by the next page — and two of these decide how much comes out of somebody's wages.
 *
 * 2. **Reads are scoped by permission, not by RLS.** Both tables have RLS on with no
 *    `authenticated` grant, and every query here runs on the service-role client behind an
 *    `assertPermission` call in the route handler.
 *
 * 3. **hr_id is matched lowered on both sides, always.** It is mixed case in this database; a
 *    plain `.eq` silently under-returns, which is the failure that once hid 28% of reps' own
 *    orders and every occupancy join.
 *
 * 4. **The register never asserts a device is safe — only what somebody recorded.** A row saying
 *    `in_stock` means a named person recorded a return, not that anybody has since seen the
 *    machine. Every state change carries an actor for that reason.
 */

import { writeAuditLog, writeRequiredAuditLog } from "@/lib/admin/audit";
import {
  DeviceIdentityCorrectionError,
  describeIdentityChange,
  findRegistrationClash,
  planIdentityCorrection,
  type IdentityEntry,
} from "@/lib/devices/device-identity";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { DEVICE_STATUS_LABEL } from "./types";
import type {
  AssignableEmployee,
  AssignmentStatus,
  CompanyDevice,
  CreateDeviceInput,
  CustodyDeviceFacts,
  DeviceAssignment,
  DeviceCategory,
  DeviceRegisterData,
  DeviceRegisterStats,
  DeviceStatus,
  HolderEmploymentState,
  IssueDeviceInput,
  LeaverHoldingDevices,
  MarkDeviceInput,
  MarkableDeviceStatus,
  ReassignPlaceholderInput,
  ReconcileDeviceInput,
  ReserveDeviceInput,
  ReturnCondition,
  ReturnDeviceInput,
  RevokeReservationInput,
  SetAssignmentItemValuesInput,
  WriteOffDeviceInput,
} from "./types";

/** The employment statuses that make a current holder a leaver. Mirrors the mailbox register's. */
const LEAVER_STATUSES = new Set(["resigned", "terminated"]);

type DeviceRow = {
  id: string;
  asset_tag: string;
  category: DeviceCategory;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  imei: string | null;
  device_name: string | null;
  processor: string | null;
  installed_ram: string | null;
  system_type: string | null;
  windows_device_id: string | null;
  windows_product_id: string | null;
  sim_number: string | null;
  line_number: string | null;
  estimated_value_egp: number | string | null;
  purchased_on: string | null;
  status: DeviceStatus;
  status_reason: string | null;
  status_changed_at: string | null;
  note: string | null;
};

type AssignmentRow = {
  id: string;
  device_id: string;
  employee_hr_id: string;
  employee_name: string;
  job_title: string | null;
  declaration_no: string | null;
  handover_place: string | null;
  issued_on: string;
  issued_by: string | null;
  agreed_value_egp: number | string | null;
  item_values_egp: Record<string, number | string> | null;
  status: AssignmentStatus;
  returned_on: string | null;
  returned_by: string | null;
  return_condition: ReturnCondition | null;
  shortfall_note: string | null;
  settlement_egp: number | string | null;
  reason: string | null;
  note: string | null;
};

const DEVICE_COLUMNS =
  "id,asset_tag,category,manufacturer,model,serial_number,imei,device_name,processor,installed_ram,system_type,windows_device_id,windows_product_id,sim_number,line_number,estimated_value_egp,purchased_on,status,status_reason,status_changed_at,note";

const ASSIGNMENT_COLUMNS =
  "id,device_id,employee_hr_id,employee_name,job_title,declaration_no,handover_place,issued_on,issued_by,agreed_value_egp,item_values_egp,status,returned_on,returned_by,return_condition,shortfall_note,settlement_egp,reason,note";

/**
 * True when the register has not reached this environment.
 *
 * Distinguished from a real failure so a preview branch renders an honest "not ready yet" instead
 * of an empty register — which would read as "the company owns no devices", the misleading zero
 * AGENTS.md §7 names.
 */
export function isDeviceRegisterSchemaMissing(error: unknown): boolean {
  const message = deviceErrorMessage(error).toLowerCase();
  return (
    (message.includes("company_devices") ||
      message.includes("device_assignments") ||
      message.includes("phx_device_")) &&
    (message.includes("does not exist") ||
      message.includes("could not find") ||
      message.includes("schema cache") ||
      message.includes("relation") ||
      message.includes("function"))
  );
}

export function deviceErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "Device register request failed.");
  }
  return "Device register request failed.";
}

/** A whole read, page by page, with a failed page raised as the register's own error. */
export async function readAllRegisterRows<T>(
  buildQuery: Parameters<typeof fetchAllRows>[0],
  tiebreakColumn: string,
): Promise<T[]> {
  try {
    return await fetchAllRows<T>(buildQuery, tiebreakColumn);
  } catch (error) {
    throw new Error(deviceErrorMessage(error));
  }
}

/**
 * Postgres `numeric` arrives from PostgREST as a STRING, not a number.
 *
 * Left as-is it reaches the page and `toLocaleString` renders it fine, so the defect hides until
 * something adds two of them and gets "1200.00450.00". Every money field in this module goes
 * through here.
 */
function toAmount(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A stored per-item value map, read back.
 *
 * Numeric jsonb comes back as a number, but a value written as a string by any other route would
 * come back as one, so both are coerced through `toAmount` and anything unreadable is DROPPED
 * rather than rendered. A garbled amount on a custody receipt is worse than a blank: the blank says
 * "write it here" and a wrong number says "you agreed to this".
 */
export function readItemValues(
  raw: Record<string, number | string> | null | undefined,
): Record<string, number> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const amount = toAmount(value as number | string | null);
    if (amount === null || amount < 0) continue;
    out[key] = amount;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The readable version of `device_assignments_item_values_shape`.
 *
 * The CHECK constraint is the real guard; this exists so somebody who typed a letter into a price
 * box gets a sentence instead of a constraint-violation string — the same split the register
 * already uses for `company_devices_identifiable`.
 *
 * AN ABSENT KEY AND A ZERO ARE DIFFERENT THINGS, and this is where that distinction is kept. The
 * form's own note strikes the row of any item not actually handed over and excludes it from the
 * total, so "not handed over" is expressed by leaving the key out. A zero asserts the item WAS
 * handed over and is worth nothing, which is a statement somebody signs. Blank input therefore
 * drops the key; an explicit 0 is kept.
 */
export function normalizeItemValues(
  input: Record<string, unknown> | null | undefined,
): Record<string, number> | null {
  if (!input || typeof input !== "object") return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined || String(value).trim() === "") continue;
    if (!/^[1-9][0-9]?$/.test(key)) {
      throw new Error(`"${key}" is not a custody item number.`);
    }
    const amount = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isFinite(amount)) {
      throw new Error(`The value for item ${key} is not a number.`);
    }
    if (amount < 0) {
      throw new Error(`The value for item ${key} cannot be negative.`);
    }
    out[key] = amount;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The total of what was priced.
 *
 * Sums only the keys PRESENT, which is the form's rule — «ولا تُحتسب قيمته ضمن الإجمالي» for any
 * item not handed over. Returns null when nothing is priced, so the total cell prints a blank
 * rather than a zero.
 */
export function totalItemValues(values: Record<string, number> | null | undefined): number | null {
  if (!values) return null;
  const amounts = Object.values(values).filter((amount) => Number.isFinite(amount));
  if (amounts.length === 0) return null;
  return amounts.reduce((sum, amount) => sum + amount, 0);
}

/** Whole days between an ISO date and today in Cairo. Negative and unknown both collapse to 0. */
function daysSince(dateIso: string | null, todayIso: string): number {
  if (!dateIso) return 0;
  const then = Date.parse(`${dateIso.slice(0, 10)}T00:00:00Z`);
  const now = Date.parse(`${todayIso}T00:00:00Z`);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor((now - then) / 86400000));
}

/** Serial or IMEI — whichever the device carries. What a police report actually asks for. */
export function deviceIdentifier(device: {
  serialNumber: string | null;
  imei: string | null;
}): string {
  return (device.serialNumber ?? device.imei ?? "").trim();
}

/**
 * One employee's directory facts, as the register needs them.
 *
 * `employment_status` is read lowered because it is stored in mixed case across the table's
 * history — `Resigned` and `resigned` are both present in production.
 */
type HolderFacts = {
  state: HolderEmploymentState;
  lastWorkingDate: string | null;
  employmentStatus: string | null;
  name: string | null;
  jobTitle: string | null;
};

async function resolveHolders(hrIds: string[]): Promise<Map<string, HolderFacts>> {
  const wanted = Array.from(
    new Set(hrIds.map((id) => String(id ?? "").trim().toLowerCase()).filter(Boolean)),
  );
  const holders = new Map<string, HolderFacts>();
  if (wanted.length === 0) return holders;

  const supabase = getSupabaseAdmin();
  // Chunked at 50: a PostgREST `.in()` carrying several hundred ids returns zero rows and no error.
  for (let index = 0; index < wanted.length; index += 50) {
    const chunk = wanted.slice(index, index + 50);
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id,full_name,nickname,job_title,employment_status,last_working_date")
      .in("hr_id", chunk);
    if (error) throw new Error(deviceErrorMessage(error));
    for (const row of (data ?? []) as Array<{
      hr_id: string;
      full_name: string;
      nickname: string | null;
      job_title: string | null;
      employment_status: string | null;
      last_working_date: string | null;
    }>) {
      const status = String(row.employment_status ?? "").trim().toLowerCase();
      holders.set(String(row.hr_id).toLowerCase(), {
        state: LEAVER_STATUSES.has(status) ? "left" : "active",
        lastWorkingDate: row.last_working_date,
        employmentStatus: row.employment_status,
        name: resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id),
        jobTitle: row.job_title,
      });
    }
  }

  /**
   * A chunked `.in()` on a mixed-case column can miss a row whose stored casing differs from the
   * lowered id we asked for. PostgREST has no case-insensitive `in`, so the fallback is a second
   * pass with `ilike` for whatever the first pass did not answer — small by construction, because
   * it only runs for ids the bulk read missed.
   */
  const missed = wanted.filter((id) => !holders.has(id));
  for (const hrId of missed) {
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id,full_name,nickname,job_title,employment_status,last_working_date")
      .ilike("hr_id", hrId)
      .limit(1);
    // RAISED, never skipped. A holder this pass fails to read is left with no directory row, and a
    // holder with no row counts as a LEAVER (`computeDeviceHolderFlags`) — so a failed read used to
    // put a current employee on the leavers list, value and all, on the one screen built to find them.
    if (error) throw new Error(deviceErrorMessage(error));
    const row = (data ?? [])[0] as
      | {
          hr_id: string;
          full_name: string;
          nickname: string | null;
          job_title: string | null;
          employment_status: string | null;
          last_working_date: string | null;
        }
      | undefined;
    if (!row) continue;
    const status = String(row.employment_status ?? "").trim().toLowerCase();
    holders.set(hrId, {
      state: LEAVER_STATUSES.has(status) ? "left" : "active",
      lastWorkingDate: row.last_working_date,
      employmentStatus: row.employment_status,
      name: resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id),
      jobTitle: row.job_title,
    });
  }

  return holders;
}

/**
 * The derived flags, as a pure function.
 *
 * Extracted so a test can reach them without a database. `isHeldByLeaver` is the single most
 * consequential line in this module — it is the whole reason the register is worth building — and
 * it is computed rather than stored so it can never drift from the employment record beneath it.
 * That only helps if the computation itself is pinned.
 */
export function computeDeviceHolderFlags(
  input: {
    assignmentOutstanding: boolean;
    holderState: HolderEmploymentState;
    holderLastWorkingDate: string | null;
  },
  todayIso: string,
): { daysSinceHolderLeft: number; isHeldByLeaver: boolean } {
  if (!input.assignmentOutstanding) {
    return { daysSinceHolderLeft: 0, isHeldByLeaver: false };
  }
  return {
    daysSinceHolderLeft: daysSince(input.holderLastWorkingDate, todayIso),
    /**
     * `unknown` counts as a leaver, deliberately. A device signed out to an hr_id that matches no
     * directory row is not evidence that everything is fine — it is a holder nobody can contact,
     * which is strictly worse than a recorded leaver. Treating it as active would hide it on the
     * one screen built to find it.
     */
    isHeldByLeaver: input.holderState !== "active",
  };
}

function mapDevice(
  row: DeviceRow,
  assignment: AssignmentRow | undefined,
  holders: Map<string, HolderFacts>,
  todayIso: string,
): CompanyDevice {
  const holder = assignment ? holders.get(assignment.employee_hr_id.toLowerCase()) : undefined;
  const holderState: HolderEmploymentState = assignment
    ? (holder?.state ?? "unknown")
    : "active";
  const flags = computeDeviceHolderFlags(
    {
      assignmentOutstanding: Boolean(assignment),
      holderState,
      holderLastWorkingDate: holder?.lastWorkingDate ?? null,
    },
    todayIso,
  );

  return {
    id: row.id,
    assetTag: row.asset_tag,
    category: row.category,
    manufacturer: row.manufacturer,
    model: row.model,
    serialNumber: row.serial_number,
    imei: row.imei,
    deviceName: row.device_name,
    processor: row.processor,
    installedRam: row.installed_ram,
    systemType: row.system_type,
    windowsDeviceId: row.windows_device_id,
    windowsProductId: row.windows_product_id,
    simNumber: row.sim_number,
    lineNumber: row.line_number,
    estimatedValueEgp: toAmount(row.estimated_value_egp),
    purchasedOn: row.purchased_on,
    status: row.status,
    statusReason: row.status_reason,
    statusChangedAt: row.status_changed_at,
    note: row.note,

    assignmentId: assignment?.id ?? null,
    holderHrId: assignment?.employee_hr_id ?? null,
    // The SNAPSHOT is what the receipt was signed with; the directory name is only a fallback for
    // a row written before the snapshot existed.
    holderName: assignment ? (assignment.employee_name || holder?.name || assignment.employee_hr_id) : null,
    holderJobTitle: assignment?.job_title ?? holder?.jobTitle ?? null,
    issuedOn: assignment?.issued_on ?? null,
    agreedValueEgp: assignment ? toAmount(assignment.agreed_value_egp) : null,
    itemValuesEgp: assignment ? readItemValues(assignment.item_values_egp) : null,
    declarationNo: assignment?.declaration_no ?? null,

    holderState: assignment ? holderState : "active",
    holderLastWorkingDate: holder?.lastWorkingDate ?? null,
    ...flags,
  };
}

export function buildDeviceStats(devices: CompanyDevice[]): DeviceRegisterStats {
  const heldByLeavers = devices.filter((device) => device.isHeldByLeaver);
  return {
    total: devices.length,
    inStock: devices.filter((device) => device.status === "in_stock").length,
    assigned: devices.filter((device) => device.status === "assigned").length,
    repair: devices.filter((device) => device.status === "repair").length,
    missing: devices.filter((device) => device.status === "lost" || device.status === "stolen").length,
    retired: devices.filter((device) => device.status === "retired").length,
    heldByLeavers: heldByLeavers.length,
    valueHeldByLeaversEgp: heldByLeavers.reduce((sum, device) => sum + (device.agreedValueEgp ?? 0), 0),
    /**
     * Counted, and shown. A device with no estimated value is one البند (10) can recover NOTHING
     * against — the clause caps a deduction at the figure on the receipt, so a blank there is a
     * device the company has no financial claim over. That is invisible until somebody counts it.
     */
    withoutValue: devices.filter((device) => device.estimatedValueEgp === null).length,
  };
}

/**
 * Everything a leaver still holds, grouped by person.
 *
 * This is the clearance view: the custody receipt's return protocol states that final dues may not
 * be paid before it is completed («ولا يجوز صرف المستحقات النهائية قبل استيفائه»), so somebody
 * preparing a settlement needs to see this list, per person, with the values on it.
 */
export function buildLeaversHolding(devices: CompanyDevice[], todayIso: string): LeaverHoldingDevices[] {
  const byPerson = new Map<string, LeaverHoldingDevices>();

  for (const device of devices) {
    if (!device.isHeldByLeaver || !device.holderHrId || !device.assignmentId) continue;
    const key = device.holderHrId.toLowerCase();
    const existing = byPerson.get(key);
    const entry = existing ?? {
      employeeHrId: device.holderHrId,
      employeeName: device.holderName ?? device.holderHrId,
      jobTitle: device.holderJobTitle,
      lastWorkingDate: device.holderLastWorkingDate,
      employmentStatus: device.holderState === "unknown" ? null : "left",
      daysSinceLastDay: daysSince(device.holderLastWorkingDate, todayIso),
      devices: [],
      totalValueEgp: 0,
    };
    entry.devices.push({
      assignmentId: device.assignmentId,
      deviceId: device.id,
      assetTag: device.assetTag,
      category: device.category,
      identifier: deviceIdentifier(device),
      agreedValueEgp: device.agreedValueEgp,
      issuedOn: device.issuedOn ?? "",
    });
    entry.totalValueEgp += device.agreedValueEgp ?? 0;
    if (!existing) byPerson.set(key, entry);
  }

  return [...byPerson.values()].sort((left, right) => {
    if (right.daysSinceLastDay !== left.daysSinceLastDay) {
      return right.daysSinceLastDay - left.daysSinceLastDay;
    }
    return right.totalValueEgp - left.totalValueEgp;
  });
}

/**
 * Employees a device may be issued to.
 *
 * `employment_status` IS THE ONLY AUTHORITY HERE, and that is a correction rather than a
 * simplification. This selected `is_active` as a second guard until 2026-09-07, when applying the
 * migration to staging and querying `information_schema` showed the column does not exist on
 * `public.employees` — on staging OR production. PostgREST answers an unknown column with an error,
 * so the register's whole read would have thrown, and the page would have rendered its error state
 * instead of a person picker. A source-level test could not have seen it; only asking the database
 * could. The mailbox register's equivalent query reads `employment_status` alone for the same
 * reason.
 */
async function loadAssignableEmployees(): Promise<AssignableEmployee[]> {
  const supabase = getSupabaseAdmin();
  // Paged, because one select silently stops at a fixed row count with no marker.
  const data = await readAllRegisterRows<{
    hr_id: string;
    full_name: string;
    nickname: string | null;
    job_title: string | null;
    employment_status: string | null;
  }>(
    () =>
      supabase
        .from("employees")
        .select("hr_id,full_name,nickname,job_title,employment_status")
        .order("full_name", { ascending: true }),
    "hr_id",
  );

  return data
    .filter((row) => !LEAVER_STATUSES.has(String(row.employment_status ?? "").trim().toLowerCase()))
    .map((row) => ({
      hrId: row.hr_id,
      name: resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id),
      jobTitle: row.job_title,
    }));
}

/**
 * The live RESERVATIONS, by device — the reserved assignments getDeviceRegisterData does not surface
 * because it maps only outstanding custody. The Rep Tablets fleet uses this to show a reserved tablet's
 * held-for name and to target reconcile/revoke/reassign at the right assignment.
 */
export async function loadReservedAssignments(): Promise<
  Array<{ deviceId: string; assignmentId: string; placeholderName: string | null }>
> {
  const supabase = getSupabaseAdmin();
  const data = await readAllRegisterRows<{ id: string; device_id: string; placeholder_name: string | null }>(
    () => supabase.from("device_assignments").select("id, device_id, placeholder_name").eq("status", "reserved"),
    "id",
  );
  return data.map((row) => ({
    assignmentId: row.id,
    deviceId: row.device_id,
    placeholderName: row.placeholder_name ?? null,
  }));
}

export async function getDeviceRegisterData(): Promise<DeviceRegisterData> {
  const supabase = getSupabaseAdmin();

  const deviceRows = await readAllRegisterRows<DeviceRow>(
    () => supabase.from("company_devices").select(DEVICE_COLUMNS).order("asset_tag", { ascending: true }),
    "id",
  );

  const outstanding = await readAllRegisterRows<AssignmentRow>(
    () =>
      supabase
        .from("device_assignments")
        .select(ASSIGNMENT_COLUMNS)
        .eq("status", "outstanding")
        .order("issued_on", { ascending: false }),
    "id",
  );

  const byDevice = new Map(outstanding.map((row) => [row.device_id, row]));
  const holders = await resolveHolders(outstanding.map((row) => row.employee_hr_id));
  const todayIso = currentCairoDateOnlyIso();

  const devices = deviceRows.map((row) => mapDevice(row, byDevice.get(row.id), holders, todayIso));

  return {
    devices,
    leaversHolding: buildLeaversHolding(devices, todayIso),
    assignable: await loadAssignableEmployees(),
    stats: buildDeviceStats(devices),
  };
}

/**
 * Every custody event against one device, newest first — the device's own history.
 *
 * Separate from the register read because it is per-device detail nobody needs until they open a
 * row, and loading it for 2,000 devices to render 40 would be a page-sized query for a panel.
 */
export async function getDeviceHistory(deviceId: string): Promise<DeviceAssignment[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("device_assignments")
    .select(ASSIGNMENT_COLUMNS)
    .eq("device_id", deviceId)
    .order("issued_on", { ascending: false })
    .limit(200);
  if (error) throw new Error(deviceErrorMessage(error));

  const rows = (data ?? []) as AssignmentRow[];
  const actors = await resolveHolders(rows.flatMap((row) => [row.issued_by, row.returned_by].filter(Boolean) as string[]));

  return rows.map((row) => ({
    id: row.id,
    deviceId: row.device_id,
    employeeHrId: row.employee_hr_id,
    employeeName: row.employee_name,
    jobTitle: row.job_title,
    declarationNo: row.declaration_no,
    handoverPlace: row.handover_place,
    issuedOn: row.issued_on,
    issuedBy: row.issued_by,
    issuedByName: actors.get(String(row.issued_by ?? "").toLowerCase())?.name ?? null,
    agreedValueEgp: toAmount(row.agreed_value_egp),
    itemValuesEgp: readItemValues(row.item_values_egp),
    status: row.status,
    returnedOn: row.returned_on,
    returnedBy: row.returned_by,
    returnedByName: actors.get(String(row.returned_by ?? "").toLowerCase())?.name ?? null,
    returnCondition: row.return_condition,
    shortfallNote: row.shortfall_note,
    settlementEgp: toAmount(row.settlement_egp),
    reason: row.reason,
    note: row.note,
  }));
}

/**
 * What one person still holds. The gate a settlement is prepared against.
 *
 * Returns outstanding assignments only. Used by the exit surface and by the custody form, and it
 * is the query the return protocol's «لا يجوز صرف المستحقات النهائية قبل استيفائه» needs answered.
 */
export async function getOutstandingDevicesFor(employeeHrId: string): Promise<
  Array<{
    assignmentId: string;
    deviceId: string;
    assetTag: string;
    category: DeviceCategory;
    identifier: string;
    agreedValueEgp: number | null;
    issuedOn: string;
  }>
> {
  const key = String(employeeHrId ?? "").trim();
  if (!key) return [];

  const supabase = getSupabaseAdmin();
  // `ilike` with no wildcard is an exact, case-insensitive match — the hr_id rule.
  const { data, error } = await supabase
    .from("device_assignments")
    .select(`${ASSIGNMENT_COLUMNS},company_devices!inner(id,asset_tag,category,serial_number,imei)`)
    .eq("status", "outstanding")
    .ilike("employee_hr_id", key)
    .order("issued_on", { ascending: false });
  if (error) throw new Error(deviceErrorMessage(error));

  type EmbeddedDevice = {
    id: string;
    asset_tag: string;
    category: DeviceCategory;
    serial_number: string | null;
    imei: string | null;
  };

  /**
   * PostgREST returns an embedded resource as an ARRAY unless it can infer a to-one relationship,
   * and whether it does depends on how it read the foreign key — so the same query can hand back
   * an object in one deployment and a one-element array in another. Normalising here rather than
   * asserting one shape: the assertion is what would break, silently, on the environment that
   * disagreed, and it would break by returning "this person holds nothing".
   */
  const first = (embedded: EmbeddedDevice | EmbeddedDevice[] | null): EmbeddedDevice | null => {
    if (!embedded) return null;
    return Array.isArray(embedded) ? (embedded[0] ?? null) : embedded;
  };

  const rows = (data ?? []) as unknown as Array<
    AssignmentRow & { company_devices: EmbeddedDevice | EmbeddedDevice[] | null }
  >;

  const out: Array<{
    assignmentId: string;
    deviceId: string;
    assetTag: string;
    category: DeviceCategory;
    identifier: string;
    agreedValueEgp: number | null;
    issuedOn: string;
  }> = [];

  for (const row of rows) {
    const device = first(row.company_devices);
    // `!inner` should make this unreachable; kept because a row whose device vanished is a broken
    // custody record, and skipping it is right where crashing the page is not.
    if (!device) continue;
    out.push({
      assignmentId: row.id,
      deviceId: device.id,
      assetTag: device.asset_tag,
      category: device.category,
      identifier: deviceIdentifier({ serialNumber: device.serial_number, imei: device.imei }),
      agreedValueEgp: toAmount(row.agreed_value_egp),
      issuedOn: row.issued_on,
    });
  }
  return out;
}

/**
 * What each of MANY people still holds, keyed on the LOWERED hr_id.
 *
 * The bulk form of `getOutstandingDevicesFor`, for the exit surface — which renders one row per
 * leaver and would otherwise make one round trip per row. Returns a Map so a caller can ask about
 * somebody who holds nothing and get an empty array rather than a missing key.
 *
 * IT NEVER THROWS. This decorates a screen that must render without it: the resignations page is
 * how somebody finds out that a person left at all, and taking it down because an asset register
 * query failed would trade a missing warning for a missing page. An empty map degrades to "no
 * devices flagged", which is what the page showed before this existed.
 */
export async function getOutstandingDevicesByEmployee(
  employeeHrIds: readonly string[],
): Promise<Map<string, Array<{ assignmentId: string; assetTag: string; category: DeviceCategory; identifier: string; agreedValueEgp: number | null }>>> {
  const byPerson = new Map<
    string,
    Array<{ assignmentId: string; assetTag: string; category: DeviceCategory; identifier: string; agreedValueEgp: number | null }>
  >();

  const wanted = Array.from(
    new Set(employeeHrIds.map((id) => String(id ?? "").trim().toLowerCase()).filter(Boolean)),
  );
  if (wanted.length === 0) return byPerson;

  try {
    const supabase = getSupabaseAdmin();
    // A failed page throws into the catch below, which returns the empty map as before.
    const data = await fetchAllRows(
      () =>
        supabase
          .from("device_assignments")
          .select(`id,employee_hr_id,agreed_value_egp,company_devices!inner(asset_tag,category,serial_number,imei)`)
          .eq("status", "outstanding"),
      "id",
    );

    for (const entry of data as unknown as Array<{
      id: string;
      employee_hr_id: string;
      agreed_value_egp: number | string | null;
      company_devices:
        | { asset_tag: string; category: DeviceCategory; serial_number: string | null; imei: string | null }
        | Array<{ asset_tag: string; category: DeviceCategory; serial_number: string | null; imei: string | null }>
        | null;
    }>) {
      const key = String(entry.employee_hr_id ?? "").trim().toLowerCase();
      // Filtered here rather than in the query: PostgREST has no case-insensitive `in`, and an
      // `.in()` on a MIXED-CASE column is the exact shape that silently under-returns. Reading the
      // outstanding set whole and matching lowered in memory cannot miss a row — and the whole set
      // is bounded by the size of the fleet, not by the number of leavers on screen.
      if (!key || !wanted.includes(key)) continue;
      const embedded = entry.company_devices;
      const device = Array.isArray(embedded) ? embedded[0] : embedded;
      if (!device) continue;

      const list = byPerson.get(key) ?? [];
      list.push({
        assignmentId: entry.id,
        assetTag: device.asset_tag,
        category: device.category,
        identifier: deviceIdentifier({ serialNumber: device.serial_number, imei: device.imei }),
        agreedValueEgp: toAmount(entry.agreed_value_egp),
      });
      byPerson.set(key, list);
    }
  } catch {
    return byPerson;
  }

  return byPerson;
}

/**
 * The device half of a custody receipt, for one device.
 *
 * Returns null for an id that names nothing, rather than throwing: the custody form must always
 * print, and a form printed with ruled blanks is exactly what it printed before this register
 * existed. Refusing to render a signed instrument because a lookup missed would be the worse
 * failure.
 */
export async function getCustodyDeviceFacts(deviceId: string | null | undefined): Promise<CustodyDeviceFacts | null> {
  if (!deviceId) return null;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("company_devices")
    .select(DEVICE_COLUMNS)
    .eq("id", deviceId)
    .maybeSingle();
  if (error || !data) return null;

  const row = data as DeviceRow;

  const { data: liveRow } = await supabase
    .from("device_assignments")
    .select("item_values_egp,status")
    .eq("device_id", deviceId)
    .eq("status", "outstanding")
    .maybeSingle();
  const live = (liveRow as Pick<AssignmentRow, "item_values_egp"> | null) ?? null;

  return {
    assetTag: row.asset_tag,
    category: row.category,
    manufacturer: row.manufacturer,
    model: row.model,
    serialNumber: row.serial_number,
    imei: row.imei,
    deviceName: row.device_name,
    processor: row.processor,
    installedRam: row.installed_ram,
    systemType: row.system_type,
    windowsDeviceId: row.windows_device_id,
    windowsProductId: row.windows_product_id,
    simNumber: row.sim_number,
    lineNumber: row.line_number,
    // From the OUTSTANDING assignment, never from the device. البند (9) prices what was agreed at
    // THIS handover, so a device reissued later at different figures must not rewrite the paper the
    // previous holder signed. Null when nobody holds it, which prints the blanks it always printed.
    itemValuesEgp: readItemValues(live?.item_values_egp ?? null),
  };
}

// ---------------------------------------------------------------------------------------------
// Mutations. Each writes its audit row BEFORE the state changes, carrying the old values.
// ---------------------------------------------------------------------------------------------

function trimmed(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

/**
 * Whether a NEW custody may name this person — the refusal sentence, or null when it may.
 *
 * `phx_device_issue` checks only that the hr_id exists, and the register's person picker leaves
 * leavers out, so the page could not choose one — but the route takes any hr_id it is sent, and
 * `phx_device_reconcile` took a leaver too. A new signed receipt for somebody who has already left
 * is a handover that cannot have happened. The ONE door that may name a leaver is the bulk import,
 * which records custody that already exists (a device still out with somebody who has gone — the
 * exposure the register is built to show), so it passes `allowLeaver`. A person with no directory row
 * is left to the database, which refuses them with its own "No employee matches" sentence.
 */
export function holderRefusal(
  holder: Pick<HolderFacts, "state" | "name" | "employmentStatus"> | undefined,
  action: "issue" | "reconcile",
): string | null {
  if (!holder || holder.state !== "left") return null;
  const who = holder.name ?? "This employee";
  const status = String(holder.employmentStatus ?? "left").trim().toLowerCase() || "left";
  return action === "issue"
    ? `Issuing a device to ${who} is refused: they have left the company (${status}). A new handover goes to a current employee. A device a leaver still holds is recorded through the bulk import, which flags it at once.`
    : `Reconciling a reservation to ${who} is refused: they have left the company (${status}). Revoke the reservation, or reconcile it to the person who actually started.`;
}

/**
 * Why a device may not be marked from its current state — or null when it may.
 *
 * A RESERVED device carries a live reservation row (`device_assignments.status = 'reserved'`), and
 * `phx_device_mark` never looked at it: "Back in stock" left the reservation live on an in-stock
 * device, which then could be neither issued (the one-live-claim index refuses it) nor revoked
 * (`phx_device_revoke` only resets a device still `reserved`); "Lost" or "In repair" left a reservation
 * that `phx_device_reconcile` would later turn into a signed custody for a machine nobody could hand
 * over. A reservation is ended first — revoked, or reconciled — and only then is the device's state
 * changed.
 */
export function markRefusal(device: { status: DeviceStatus; assetTag: string }): string | null {
  if (device.status !== "reserved") return null;
  return `Marking ${device.assetTag} is refused while it is reserved for somebody. Revoke the reservation (or reconcile it on day one) from the tablet's custody panel first, then change its state.`;
}

/**
 * Why a reservation may not be reconciled into a signed custody — or null when it may.
 *
 * `phx_device_reconcile` moved the device to `assigned` whatever state it was in. A reserved tablet
 * marked lost, stolen, retired or in repair in the meantime would come out of reconcile as a signed
 * custody, with its value frozen under البند (9), for a machine that was never handed over.
 */
export function reconcileRefusal(device: { status: DeviceStatus; assetTag: string } | null): string | null {
  if (!device) return "Reconciling this reservation is refused: its device is no longer in the custody register.";
  if (device.status === "reserved") return null;
  return `Reconciling ${device.assetTag} is refused: the device is ${DEVICE_STATUS_LABEL[device.status].toLowerCase()} now, not reserved, so it cannot be handed over. Revoke the reservation and deal with the device first.`;
}

/**
 * The HTTP status a register error answers with: 400 when it is a custody rule refusing the caller,
 * 500 otherwise.
 *
 * Every custody rule raises rather than returns — one holder per device, a settlement capped at
 * البند (10)'s agreed value, a damaged return that must say what was damaged — and each sentence is
 * written for the person who pressed the button. "That custody record is closed" (pricing a closed
 * handover) and "That custody record no longer exists" were missing here, so a caller's own mistake
 * answered 500 and read as the server failing.
 */
export function deviceRegisterErrorStatus(message: string): 400 | 500 {
  return /^(Device|No employee|A device|A return|A write-off|This custody|That custody record|Unknown device|Issuing|Marking|A settlement|Reserving|A reservation|Only a reservation|Revoking|Reconciling)\b/.test(
    message,
  )
    ? 400
    : 500;
}

/**
 * The year a declaration number is counted in: the HANDOVER's year when the handover carries a date,
 * otherwise this year in Cairo.
 *
 * The test was once written `/^d{4}/` — a literal "dddd" — so it never matched a date, and a handover
 * recorded on 30 December and saved on 2 January was numbered in the new year's series. A signed
 * receipt then carried a number from a year it was not signed in.
 */
export function declarationYear(issuedOn: string | null | undefined, now: Date = new Date()): string {
  return /^\d{4}-\d{2}-\d{2}/.test(String(issuedOn ?? "").trim())
    ? String(issuedOn).trim().slice(0, 4)
    : new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric" }).format(now);
}

/**
 * The next declaration number (رقم الإقرار) when the handover form leaves it blank — owner, 2026-10-11:
 * "automate adding the declaration number, I have none". Format `DEC-<year>-<4 digits>`, counting up
 * per year from the highest one already issued. A number typed by hand is always kept as typed.
 */
async function nextDeclarationNo(issuedOn: string | null | undefined): Promise<string> {
  const year = declarationYear(issuedOn);
  const prefix = `DEC-${year}-`;
  const { data, error } = await getSupabaseAdmin()
    .from("device_assignments")
    .select("declaration_no")
    .like("declaration_no", `${prefix}%`);
  if (error) throw new Error(deviceErrorMessage(error));
  let highest = 0;
  for (const row of (data ?? []) as Array<{ declaration_no: string | null }>) {
    const n = Number(String(row.declaration_no ?? "").slice(prefix.length));
    if (Number.isInteger(n) && n > highest) highest = n;
  }
  return `${prefix}${String(highest + 1).padStart(4, "0")}`;
}

export async function createDevice(input: CreateDeviceInput, actor: string): Promise<string> {
  const supabase = getSupabaseAdmin();

  const serial = trimmed(input.serialNumber);
  const imei = trimmed(input.imei);
  // The same rule `company_devices_identifiable` enforces, checked here so the caller gets a
  // sentence rather than a constraint-violation string. The constraint is still the real guard.
  if (!serial && !imei) {
    throw new Error(
      "A device needs a serial number or an IMEI. Without one it cannot be identified to the police, to an operator or to an insurer — which is what this register is for.",
    );
  }

  // Compared on letters and digits, not on the text the unique indexes see — see
  // `findRegistrationClash`. Read whole, page by page, every time: a first page would miss a repeat.
  const clash = findRegistrationClash(
    { assetTag: input.assetTag, serialNumber: serial, imei },
    await readRegisterIdentities(),
  );
  if (clash) throw new Error(clash);

  const { data, error } = await supabase
    .from("company_devices")
    .insert({
      asset_tag: String(input.assetTag ?? "").trim(),
      category: input.category,
      manufacturer: trimmed(input.manufacturer),
      model: trimmed(input.model),
      serial_number: serial,
      imei,
      device_name: trimmed(input.deviceName),
      processor: trimmed(input.processor),
      installed_ram: trimmed(input.installedRam),
      system_type: trimmed(input.systemType),
      windows_device_id: trimmed(input.windowsDeviceId),
      windows_product_id: trimmed(input.windowsProductId),
      sim_number: trimmed(input.simNumber),
      line_number: trimmed(input.lineNumber),
      estimated_value_egp: input.estimatedValueEgp ?? null,
      purchased_on: input.purchasedOn || null,
      note: trimmed(input.note),
      created_by: actor,
    })
    .select("id")
    .single();
  if (error) {
    // Another writer saved the same tag, serial or IMEI between the check above and this insert.
    // Said as a sentence (and answered 400), never as the constraint's own name.
    if ((error as { code?: string }).code === "23505") {
      throw new Error(
        "A device with this asset tag, serial number or IMEI was added to the register a moment ago by somebody else. Reload the register and check before adding it again.",
      );
    }
    throw new Error(deviceErrorMessage(error));
  }

  const deviceId = String((data as { id: string }).id);
  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "company_device",
    entityId: deviceId,
    summary: `Registered device ${input.assetTag} (${input.category})`,
    newValues: { assetTag: input.assetTag, category: input.category, serialNumber: serial, imei },
  });
  return deviceId;
}

/**
 * `allowLeaver` is for the bulk import ALONE, which records custody that already exists — see
 * `holderRefusal`. Every other caller issues to a current employee or is refused before anything is
 * written.
 */
export async function issueDevice(
  input: IssueDeviceInput,
  actor: string,
  options: { allowLeaver?: boolean } = {},
): Promise<string> {
  const supabase = getSupabaseAdmin();
  if (!options.allowLeaver) {
    const key = String(input.employeeHrId ?? "").trim().toLowerCase();
    const refusal = holderRefusal((await resolveHolders([key])).get(key), "issue");
    if (refusal) throw new Error(refusal);
  }
  const declarationNo = trimmed(input.declarationNo) ?? (await nextDeclarationNo(input.issuedOn));

  const { data, error } = await supabase.rpc("phx_device_issue", {
    p_device_id: input.deviceId,
    p_employee_hr_id: input.employeeHrId,
    p_actor: actor,
    p_declaration_no: declarationNo,
    p_handover_place: trimmed(input.handoverPlace),
    p_issued_on: input.issuedOn || null,
  });
  if (error) throw new Error(deviceErrorMessage(error));

  const assignmentId = typeof data === "string" ? data : String(data ?? "");
  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "device_assignment",
    entityId: assignmentId,
    summary: `Issued device ${input.deviceId} to ${input.employeeHrId}`,
    newValues: {
      deviceId: input.deviceId,
      employeeHrId: input.employeeHrId,
      declarationNo,
      handoverPlace: trimmed(input.handoverPlace),
    },
  });

  // Priced in a SECOND statement rather than through `phx_device_issue`, deliberately. Widening
  // that function's signature would mean replacing a production RPC to carry a field the handover
  // itself does not depend on, and the failure this leaves is the benign one: an assignment with
  // no prices, which is exactly what every assignment written before this column existed looks
  // like, and what the form prints as ruled blanks. It is visible on the page and fixable by
  // pricing again. The opposite arrangement fails by refusing a handover over a price.
  const values = normalizeItemValues(input.itemValuesEgp ?? null);
  if (values) await setAssignmentItemValues({ assignmentId, itemValuesEgp: values }, actor);

  return assignmentId;
}

/**
 * Price the items on an OUTSTANDING handover.
 *
 * REFUSED ONCE THE ASSIGNMENT IS CLOSED, and that is where البند (9)'s freeze actually bites. A
 * returned or written-off custody record has been settled: البند (10) priced any shortfall against
 * the figures on the signed paper, so re-pricing it afterwards would change what somebody already
 * answered for, in the direction of owing more. While it is outstanding the paper may not even be
 * printed yet, and correcting a price there is the ordinary case, not a rewrite of history.
 */
export async function setAssignmentItemValues(
  input: SetAssignmentItemValuesInput,
  actor: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const values = normalizeItemValues(input.itemValuesEgp ?? null);

  const { data: before, error: readError } = await supabase
    .from("device_assignments")
    .select(ASSIGNMENT_COLUMNS)
    .eq("id", input.assignmentId)
    .maybeSingle();
  if (readError) throw new Error(deviceErrorMessage(readError));
  if (!before) throw new Error("That custody record no longer exists.");

  const row = before as AssignmentRow;
  if (row.status !== "outstanding") {
    throw new Error(
      "That custody record is closed, so its values cannot be changed. البند (9) fixes the figures " +
        "somebody signed for, and البند (10) has already priced any shortfall against them.",
    );
  }

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "device_assignment",
    entityId: input.assignmentId,
    summary: `Priced the custody items for ${row.employee_name}`,
    oldValues: { itemValuesEgp: readItemValues(row.item_values_egp) },
    newValues: { itemValuesEgp: values, totalEgp: totalItemValues(values) },
  });

  const { error } = await supabase
    .from("device_assignments")
    .update({ item_values_egp: values, updated_at: new Date().toISOString() })
    .eq("id", input.assignmentId);
  if (error) throw new Error(deviceErrorMessage(error));
}

export async function returnDevice(input: ReturnDeviceInput, actor: string): Promise<string> {
  const supabase = getSupabaseAdmin();

  const { data: before } = await supabase
    .from("device_assignments")
    .select(ASSIGNMENT_COLUMNS)
    .eq("id", input.assignmentId)
    .maybeSingle();

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "device_assignment",
    entityId: input.assignmentId,
    summary: `Recorded a device return (${input.condition}) for ${(before as AssignmentRow | null)?.employee_name ?? input.assignmentId}`,
    oldValues: (before as Record<string, unknown> | null) ?? null,
    newValues: {
      condition: input.condition,
      shortfallNote: trimmed(input.shortfallNote),
      settlementEgp: input.settlementEgp ?? null,
      returnedOn: input.returnedOn || null,
    },
  });

  const { data, error } = await supabase.rpc("phx_device_return", {
    p_assignment_id: input.assignmentId,
    p_actor: actor,
    p_condition: input.condition,
    p_shortfall_note: trimmed(input.shortfallNote),
    p_settlement_egp: input.settlementEgp ?? null,
    p_returned_on: input.returnedOn || null,
    p_note: trimmed(input.note),
  });
  if (error) throw new Error(deviceErrorMessage(error));
  return typeof data === "string" ? data : String(data ?? "returned");
}

export async function markDevice(input: MarkDeviceInput, actor: string): Promise<string> {
  const supabase = getSupabaseAdmin();

  const { data: before, error: readError } = await supabase
    .from("company_devices")
    .select(DEVICE_COLUMNS)
    .eq("id", input.deviceId)
    .maybeSingle();
  // Read first and refused on failure: the refusal below needs the device's real state, and an
  // unreadable one must not be waved through as "not reserved".
  if (readError) throw new Error(deviceErrorMessage(readError));
  if (before) {
    const row = before as DeviceRow;
    const refusal = markRefusal({ status: row.status, assetTag: row.asset_tag });
    if (refusal) throw new Error(refusal);
  }

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "company_device",
    entityId: input.deviceId,
    summary: `Marked device ${(before as DeviceRow | null)?.asset_tag ?? input.deviceId} as ${input.status}`,
    oldValues: (before as Record<string, unknown> | null) ?? null,
    newValues: { status: input.status, reason: trimmed(input.reason) },
  });

  const { data, error } = await supabase.rpc("phx_device_mark", {
    p_device_id: input.deviceId,
    p_status: input.status,
    p_actor: actor,
    p_reason: trimmed(input.reason),
  });
  if (error) throw new Error(deviceErrorMessage(error));
  return typeof data === "string" ? data : String(data ?? input.status);
}

/**
 * Reserve an in-stock device for a not-yet-hired holder, by a typed name.
 *
 * A reservation is NOT a signed custody (the owner's decision, 2026-09-28): it freezes no value and
 * owes nothing, because nobody has signed. `phx_device_reserve` earmarks the device (`reserved`) so it
 * cannot be issued to anyone else. The real signed custody is created later, by `reconcileDevice`.
 */
export async function reserveDevice(input: ReserveDeviceInput, actor: string): Promise<string> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase.rpc("phx_device_reserve", {
    p_device_id: input.deviceId,
    p_placeholder_name: input.placeholderName,
    p_actor: actor,
    p_declaration_no: trimmed(input.declarationNo),
    p_handover_place: trimmed(input.handoverPlace),
    p_note: trimmed(input.note),
  });
  if (error) throw new Error(deviceErrorMessage(error));

  const assignmentId = typeof data === "string" ? data : String(data ?? "");
  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "device_assignment",
    entityId: assignmentId,
    summary: `Reserved device ${input.deviceId} for ${input.placeholderName.trim()}`,
    newValues: {
      deviceId: input.deviceId,
      placeholderName: input.placeholderName.trim(),
      declarationNo: trimmed(input.declarationNo),
      handoverPlace: trimmed(input.handoverPlace),
    },
  });
  return assignmentId;
}

/** Move a reservation to a different typed name — still nobody has signed. */
export async function reassignPlaceholder(
  input: ReassignPlaceholderInput,
  actor: string,
): Promise<string> {
  const supabase = getSupabaseAdmin();

  const { data: before } = await supabase
    .from("device_assignments")
    .select(ASSIGNMENT_COLUMNS)
    .eq("id", input.assignmentId)
    .maybeSingle();

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "device_assignment",
    entityId: input.assignmentId,
    summary: `Reassigned a device reservation to ${input.newName.trim()}`,
    oldValues: (before as Record<string, unknown> | null) ?? null,
    newValues: { placeholderName: input.newName.trim() },
  });

  const { data, error } = await supabase.rpc("phx_device_reassign_placeholder", {
    p_assignment_id: input.assignmentId,
    p_new_name: input.newName,
    p_actor: actor,
  });
  if (error) throw new Error(deviceErrorMessage(error));
  return typeof data === "string" ? data : String(data ?? input.assignmentId);
}

/** Cancel a reservation before anyone signs. A signed custody is returned or written off, never revoked. */
export async function revokeReservation(
  input: RevokeReservationInput,
  actor: string,
): Promise<string> {
  const supabase = getSupabaseAdmin();

  const { data: before } = await supabase
    .from("device_assignments")
    .select(ASSIGNMENT_COLUMNS)
    .eq("id", input.assignmentId)
    .maybeSingle();

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "device_assignment",
    entityId: input.assignmentId,
    summary: `Revoked a device reservation${trimmed(input.reason) ? ` (${trimmed(input.reason)})` : ""}`,
    oldValues: (before as Record<string, unknown> | null) ?? null,
    newValues: { status: "revoked", reason: trimmed(input.reason) },
  });

  const { data, error } = await supabase.rpc("phx_device_revoke", {
    p_assignment_id: input.assignmentId,
    p_actor: actor,
    p_reason: trimmed(input.reason),
  });
  if (error) throw new Error(deviceErrorMessage(error));
  return typeof data === "string" ? data : String(data ?? "revoked");
}

/**
 * Day one: bind a reservation to the hired employee. THIS is the signed issue — البند (9)'s value is
 * frozen onto the row here, from the device, and the device moves to `assigned`.
 */
export async function reconcileDevice(input: ReconcileDeviceInput, actor: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data: before, error: readError } = await supabase
    .from("device_assignments")
    .select(ASSIGNMENT_COLUMNS)
    .eq("id", input.assignmentId)
    .maybeSingle();
  if (readError) throw new Error(deviceErrorMessage(readError));

  // The device must still be RESERVED, and the person must not have left — both refused before
  // anything is written (`reconcileRefusal`, `holderRefusal`). The database refuses both as well
  // (20261109030915_device_custody_state_guards.sql); this is the readable half. The device read is
  // only for a live reservation — anything else is refused by the database's own "Only a reservation".
  if (before && (before as AssignmentRow).status === "reserved") {
    const { data: deviceRow, error: deviceError } = await supabase
      .from("company_devices")
      .select("asset_tag,status")
      .eq("id", (before as AssignmentRow).device_id)
      .maybeSingle();
    if (deviceError) throw new Error(deviceErrorMessage(deviceError));
    const device = deviceRow as { asset_tag: string; status: DeviceStatus } | null;
    const deviceRefusal = reconcileRefusal(device ? { status: device.status, assetTag: device.asset_tag } : null);
    if (deviceRefusal) throw new Error(deviceRefusal);
  }
  const holderKey = String(input.employeeHrId ?? "").trim().toLowerCase();
  const leaverRefusal = holderRefusal((await resolveHolders([holderKey])).get(holderKey), "reconcile");
  if (leaverRefusal) throw new Error(leaverRefusal);

  const declarationNo = trimmed(input.declarationNo) ?? (await nextDeclarationNo(input.issuedOn));

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "device_assignment",
    entityId: input.assignmentId,
    summary: `Reconciled a device reservation to ${input.employeeHrId} (day-one custody)`,
    oldValues: (before as Record<string, unknown> | null) ?? null,
    newValues: {
      employeeHrId: input.employeeHrId,
      declarationNo,
      handoverPlace: trimmed(input.handoverPlace),
      issuedOn: input.issuedOn || null,
    },
  });

  const { data, error } = await supabase.rpc("phx_device_reconcile", {
    p_assignment_id: input.assignmentId,
    p_employee_hr_id: input.employeeHrId,
    p_actor: actor,
    p_declaration_no: declarationNo,
    p_handover_place: trimmed(input.handoverPlace),
    p_issued_on: input.issuedOn || null,
  });
  if (error) throw new Error(deviceErrorMessage(error));
  return typeof data === "string" ? data : String(data ?? input.assignmentId);
}

/** Which console reported the IMEI — it decides the audit row's wording, nothing else. */
export type ReportedImeiSource = "android_management" | "headwind";

const REPORTED_IMEI_SOURCE_NAMES: Readonly<Record<ReportedImeiSource, string>> = {
  android_management: "Google",
  headwind: "Headwind",
};

/**
 * Record the IMEI a managed tablet reports to its MDM on its register entry — ONLY where the entry
 * holds none.
 *
 * THE AUDIT ROW NAMES THE CONSOLE THAT REPORTED IT, and the default stays Google so the Android
 * Management path is unchanged to the byte. A row reading "reports to Google" about a number
 * Headwind read would be a false record of where a value came from, which is the one thing an
 * audit row exists to get right.
 *
 * The one register write whose value no person typed: Rep Tablets calls it with what the tablet
 * itself reported, so the IMEI a police report or an operator asks for is on the entry without
 * anybody dialling *#06#. It never overwrites. An IMEI somebody typed stays even when the tablet
 * reports a different one — the Rep Tablets page shows the two side by side and a person decides
 * which is wrong. The update is conditional on the entry still holding exactly what was read, so a
 * value typed in between is not replaced either; the answer is then false and nothing is written.
 *
 * The same IMEI on a second entry is refused twice over: Rep Tablets never asks for one (it compares
 * on digits, so a typed "35-123456-789012-3" counts), and `uq_company_devices_imei` refuses the
 * same text at the database, whatever called this.
 */
export async function recordReportedImei(
  input: { deviceId: string; imei: string; source?: ReportedImeiSource },
  actor: string,
): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const imei = trimmed(input.imei);
  if (!imei) throw new Error("There is no IMEI to record.");
  const source = input.source ?? "android_management";

  const { data: before, error: readError } = await supabase
    .from("company_devices")
    .select(DEVICE_COLUMNS)
    .eq("id", input.deviceId)
    .maybeSingle();
  if (readError) throw new Error(deviceErrorMessage(readError));
  if (!before) throw new Error("That tablet is no longer in the custody register.");
  const row = before as DeviceRow;
  if (trimmed(row.imei)) return false;

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "company_device",
    entityId: input.deviceId,
    summary: `Recorded the IMEI ${row.asset_tag} reports to ${REPORTED_IMEI_SOURCE_NAMES[source]} in the custody register`,
    oldValues: { imei: row.imei },
    newValues: { imei, source },
  });

  const update = supabase
    .from("company_devices")
    .update({ imei, updated_at: new Date().toISOString() })
    .eq("id", input.deviceId);
  const { data, error } = await (row.imei === null ? update.is("imei", null) : update.eq("imei", row.imei)).select("id");
  if (error) throw new Error(deviceErrorMessage(error));
  return Array.isArray(data) && data.length > 0;
}

/** Other entries read per page when looking for a duplicate serial or IMEI. PostgREST's own cap. */
const IDENTITY_PAGE_SIZE = 1000;

/** Every entry's id, tag, serial and IMEI — the whole register, page by page, never a first page. */
async function readRegisterIdentities(): Promise<IdentityEntry[]> {
  const supabase = getSupabaseAdmin();
  const entries: IdentityEntry[] = [];
  for (let from = 0; ; from += IDENTITY_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("company_devices")
      .select("id,asset_tag,serial_number,imei")
      .order("id", { ascending: true })
      .range(from, from + IDENTITY_PAGE_SIZE - 1);
    if (error) throw new Error(deviceErrorMessage(error));
    const rows = (data ?? []) as Array<Pick<DeviceRow, "id" | "asset_tag" | "serial_number" | "imei">>;
    for (const row of rows) {
      entries.push({ id: row.id, assetTag: row.asset_tag, serialNumber: row.serial_number, imei: row.imei });
    }
    if (rows.length < IDENTITY_PAGE_SIZE) return entries;
  }
}

/**
 * Correct the serial number and IMEI of an entry that already exists — Super Admin only
 * (`company_devices:approve`, owner decision 2026-09-18), with a written reason.
 *
 * The one path that REPLACES an identity somebody recorded. `createDevice` writes the pair once and
 * the bulk import refuses entries that exist, so before this a wrong IMEI stayed wrong for good —
 * and Rep Tablets' "the register has a different IMEI" warning could never be cleared.
 *
 * Allowed in every status, assigned included: the commonest case is a rep's tablet, in the rep's
 * hands, whose IMEI was typed wrong when it was registered.
 *
 * In order: the plan refuses anything wrong before a write (`planIdentityCorrection`), including a
 * form opened on values the entry no longer holds; the audit row, with the old values, the new
 * values and the reason, is written BEFORE the change and is required — no audit row, no change;
 * and the update is conditional on the entry still holding exactly what was read, so a value
 * somebody else saves between that read and this write is never overwritten unseen either.
 *
 * A correction that fails AFTER its audit row leaves a second row saying so, because the first one
 * already reads "Corrected" — in a register kept for the police and insurers, the log must not
 * disagree with the entry. That second row is best-effort: it never hides the failure it records.
 */
export async function correctDeviceIdentity(
  input: {
    deviceId: string;
    serialNumber: string | null;
    imei: string | null;
    reason: string;
    shownSerialNumber: string | null;
    shownImei: string | null;
  },
  actor: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();

  const { data: before, error: readError } = await supabase
    .from("company_devices")
    .select(DEVICE_COLUMNS)
    .eq("id", input.deviceId)
    .maybeSingle();
  if (readError) throw new Error(deviceErrorMessage(readError));
  if (!before) throw new DeviceIdentityCorrectionError("That device is no longer in the custody register.");
  const row = before as DeviceRow;

  const plan = planIdentityCorrection(
    { id: row.id, assetTag: row.asset_tag, serialNumber: row.serial_number, imei: row.imei },
    input,
    await readRegisterIdentities(),
  );

  const target = `${describeIdentityChange(plan)} of ${row.asset_tag}`;
  // Set as the update leaves for the database. Before it, the entry cannot have changed.
  let updateSent = false;
  try {
    await writeRequiredAuditLog({
      actorLoginId: actor,
      entityType: "company_device",
      entityId: row.id,
      summary: `Corrected ${target} in the custody register`,
      oldValues: { serialNumber: row.serial_number, imei: row.imei },
      newValues: { serialNumber: plan.serialNumber, imei: plan.imei, reason: plan.reason },
    });

    let update = supabase
      .from("company_devices")
      .update({ serial_number: plan.serialNumber, imei: plan.imei, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    update = row.serial_number === null ? update.is("serial_number", null) : update.eq("serial_number", row.serial_number);
    update = row.imei === null ? update.is("imei", null) : update.eq("imei", row.imei);
    updateSent = true;
    const { data, error } = await update.select("id");
    if (error) {
      // `uq_company_devices_serial` / `uq_company_devices_imei`: another entry saved the same text
      // between the duplicate check and this update.
      if ((error as { code?: string }).code === "23505") {
        throw new DeviceIdentityCorrectionError(
          "Another entry in the register now holds that serial number or IMEI. Reload the register and check which device it belongs to.",
        );
      }
      throw new Error(deviceErrorMessage(error));
    }
    if (!Array.isArray(data) || data.length === 0) {
      throw new DeviceIdentityCorrectionError(
        `${row.asset_tag}'s serial number or IMEI was changed by somebody else while you were correcting it, so nothing was saved. Reload the register and correct it again.`,
      );
    }
  } catch (failure) {
    // A refusal from the database is certain the entry did not change; a request that failed on
    // the way back is not — that row says so rather than claim either.
    const unchanged = !updateSent || failure instanceof DeviceIdentityCorrectionError;
    await writeAuditLog({
      actorLoginId: actor,
      entityType: "company_device",
      entityId: row.id,
      summary: unchanged
        ? `The correction of ${target} was not applied — the entry still holds its old serial number and IMEI`
        : `The correction of ${target} failed and may not have been applied — read the entry before relying on the row above`,
      oldValues: { serialNumber: row.serial_number, imei: row.imei },
      newValues: {
        serialNumber: plan.serialNumber,
        imei: plan.imei,
        reason: plan.reason,
        failure: failure instanceof Error ? failure.message : String(failure),
      },
    });
    throw failure;
  }
}

export async function writeOffDevice(input: WriteOffDeviceInput, actor: string): Promise<string> {
  const supabase = getSupabaseAdmin();

  const { data: before } = await supabase
    .from("device_assignments")
    .select(ASSIGNMENT_COLUMNS)
    .eq("id", input.assignmentId)
    .maybeSingle();

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "device_assignment",
    entityId: input.assignmentId,
    summary: `Wrote off the custody of ${(before as AssignmentRow | null)?.employee_name ?? input.assignmentId}`,
    oldValues: (before as Record<string, unknown> | null) ?? null,
    newValues: { reason: input.reason, settlementEgp: input.settlementEgp ?? null },
  });

  const { data, error } = await supabase.rpc("phx_device_write_off", {
    p_assignment_id: input.assignmentId,
    p_actor: actor,
    p_reason: input.reason,
    p_settlement_egp: input.settlementEgp ?? null,
  });
  if (error) throw new Error(deviceErrorMessage(error));
  return typeof data === "string" ? data : String(data ?? "written_off");
}

// ---------------------------------------------------------------------------------------------
// Boundary guards. The API takes arbitrary JSON; these keep an unknown string out of the database.
// ---------------------------------------------------------------------------------------------

export function isDeviceCategory(value: unknown): value is DeviceCategory {
  return value === "laptop" || value === "tablet" || value === "phone" || value === "other";
}

export function isReturnCondition(value: unknown): value is ReturnCondition {
  return value === "good" || value === "damaged" || value === "incomplete";
}

/** `assigned` is deliberately absent — issuing a device is what makes it assigned. */
export function isMarkableDeviceStatus(value: unknown): value is MarkableDeviceStatus {
  return (
    value === "in_stock" ||
    value === "repair" ||
    value === "lost" ||
    value === "stolen" ||
    value === "retired"
  );
}

/**
 * A money field arriving from JSON.
 *
 * Refuses a negative and anything non-finite. Returns null for absent, which is a legitimate value
 * everywhere money appears here — a device may genuinely have no agreed value.
 */
export function parseAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}
