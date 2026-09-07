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

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { getSupabaseAdmin } from "@/lib/supabase/server";

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
  ReturnCondition,
  ReturnDeviceInput,
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
  "id,device_id,employee_hr_id,employee_name,job_title,declaration_no,handover_place,issued_on,issued_by,agreed_value_egp,status,returned_on,returned_by,return_condition,shortfall_note,settlement_egp,reason,note";

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
    const { data } = await supabase
      .from("employees")
      .select("hr_id,full_name,nickname,job_title,employment_status,last_working_date")
      .ilike("hr_id", hrId)
      .limit(1);
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
  const { data, error } = await supabase
    .from("employees")
    .select("hr_id,full_name,nickname,job_title,employment_status")
    // Explicit order, because an unbounded select silently stops at 1000 rows with no marker.
    .order("full_name", { ascending: true })
    .limit(1000);
  if (error) throw new Error(deviceErrorMessage(error));

  return ((data ?? []) as Array<{
    hr_id: string;
    full_name: string;
    nickname: string | null;
    job_title: string | null;
    employment_status: string | null;
  }>)
    .filter((row) => !LEAVER_STATUSES.has(String(row.employment_status ?? "").trim().toLowerCase()))
    .map((row) => ({
      hrId: row.hr_id,
      name: resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id),
      jobTitle: row.job_title,
    }));
}

export async function getDeviceRegisterData(): Promise<DeviceRegisterData> {
  const supabase = getSupabaseAdmin();

  const { data: deviceData, error: deviceError } = await supabase
    .from("company_devices")
    .select(DEVICE_COLUMNS)
    .order("asset_tag", { ascending: true })
    .limit(2000);
  if (deviceError) throw new Error(deviceErrorMessage(deviceError));
  const deviceRows = (deviceData ?? []) as DeviceRow[];

  const { data: assignmentData, error: assignmentError } = await supabase
    .from("device_assignments")
    .select(ASSIGNMENT_COLUMNS)
    .eq("status", "outstanding")
    .order("issued_on", { ascending: false })
    .limit(2000);
  if (assignmentError) throw new Error(deviceErrorMessage(assignmentError));
  const outstanding = (assignmentData ?? []) as AssignmentRow[];

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
    const { data, error } = await supabase
      .from("device_assignments")
      .select(`id,employee_hr_id,agreed_value_egp,company_devices!inner(asset_tag,category,serial_number,imei)`)
      .eq("status", "outstanding")
      .limit(2000);
    if (error) return byPerson;

    for (const entry of (data ?? []) as unknown as Array<{
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
  };
}

// ---------------------------------------------------------------------------------------------
// Mutations. Each writes its audit row BEFORE the state changes, carrying the old values.
// ---------------------------------------------------------------------------------------------

function trimmed(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
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
  if (error) throw new Error(deviceErrorMessage(error));

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

export async function issueDevice(input: IssueDeviceInput, actor: string): Promise<string> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase.rpc("phx_device_issue", {
    p_device_id: input.deviceId,
    p_employee_hr_id: input.employeeHrId,
    p_actor: actor,
    p_declaration_no: trimmed(input.declarationNo),
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
      declarationNo: trimmed(input.declarationNo),
      handoverPlace: trimmed(input.handoverPlace),
    },
  });
  return assignmentId;
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

  const { data: before } = await supabase
    .from("company_devices")
    .select(DEVICE_COLUMNS)
    .eq("id", input.deviceId)
    .maybeSingle();

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
