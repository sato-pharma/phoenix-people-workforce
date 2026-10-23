/**
 * Company device register — domain types.
 *
 * These mirror `company_devices` and `device_assignments` (migration 20260907220000) one for one,
 * in camelCase, plus the derived flags the register is actually read for.
 *
 * The register answers two questions the custody paperwork never could: WHICH machine a person
 * signed for — a serial or an IMEI that a police report, an operator blocklist or an insurance
 * claim can use — and what the company still owns that it cannot currently see.
 */

/** Which of the two numbered custody forms a device prints on. */
export type DeviceCategory = "laptop" | "tablet" | "phone" | "other";

/**
 * `in_stock` — held by the company, issuable.
 * `assigned` — somebody has signed for it. Written only by `phx_device_issue`.
 * `repair`   — with IT or a vendor. Also where a damaged return lands, so a known fault is not
 *              handed to the next person under البند (1)'s «قبلتها بحالتها».
 * `lost` / `stolen` — gone. Kept apart because only `stolen` carries the محضر البند (5) requires,
 *              which is what supports an insurance claim and can excuse the holder under البند (11).
 * `retired`  — end of life. Terminal.
 */
export type DeviceStatus =
  | "in_stock"
  | "assigned"
  | "repair"
  | "lost"
  | "stolen"
  | "retired"
  /** Earmarked for a not-yet-hired holder. Not issuable to anyone else; owes nothing. */
  | "reserved";

/**
 * A status as a person reads it — the ONE list, shared by the Device custody page and the Rep Tablets
 * custody panel so one tablet never reads two ways on two pages. Client-safe: this module imports nothing.
 */
export const DEVICE_STATUS_LABEL: Readonly<Record<DeviceStatus, string>> = {
  in_stock: "In stock",
  reserved: "Reserved",
  assigned: "With staff",
  repair: "In repair",
  lost: "Lost",
  stolen: "Stolen",
  retired: "Retired",
};

/**
 * `outstanding` — he holds it. The only state that owes anything.
 * `returned`    — محضر رد العهدة completed. البند (8): nothing else proves a return.
 * `written_off` — closed without the device coming back, carrying a reason.
 */
export type AssignmentStatus =
  | "outstanding"
  | "returned"
  | "written_off"
  /** A pre-provision earmark for a not-yet-hired holder — no hr_id, no value, nobody has signed. */
  | "reserved"
  /** A reservation cancelled before anyone signed. A signed custody never reaches this state. */
  | "revoked";

/** الحالة عند الرد. `damaged` and `incomplete` are the two البند (10) prices. */
export type ReturnCondition = "good" | "damaged" | "incomplete";

/**
 * The statuses `phx_device_mark` accepts — `assigned` is what issuing MEANS and `reserved` is what
 * reserving MEANS; neither is ever typed by hand into a mark.
 */
export type MarkableDeviceStatus = Exclude<DeviceStatus, "assigned" | "reserved">;

/** The employment statuses that make a current holder a leaver. */
export type HolderEmploymentState = "active" | "left" | "unknown";

export type CompanyDevice = {
  id: string;
  /** The human handle — owner rule: never show a raw code where a name will do. */
  assetTag: string;
  category: DeviceCategory;
  manufacturer: string | null;
  model: string | null;

  /** At least one of these two is always present — `company_devices_identifiable` refuses a row without. */
  serialNumber: string | null;
  imei: string | null;

  deviceName: string | null;
  processor: string | null;
  installedRam: string | null;
  systemType: string | null;
  windowsDeviceId: string | null;
  windowsProductId: string | null;

  simNumber: string | null;
  lineNumber: string | null;

  estimatedValueEgp: number | null;
  purchasedOn: string | null;

  status: DeviceStatus;
  statusReason: string | null;
  statusChangedAt: string | null;
  note: string | null;

  /** The live custody record, when one is outstanding. Null for anything in stock or gone. */
  assignmentId: string | null;
  holderHrId: string | null;
  holderName: string | null;
  holderJobTitle: string | null;
  issuedOn: string | null;
  /** Frozen at issue — البند (9). Not the device's current value. */
  agreedValueEgp: number | null;
  /**
   * The breakdown behind `agreedValueEgp`, keyed by the custody template's item number.
   *
   * Not a replacement for it: البند (10) caps recovery at the signed total, and nothing recomputes
   * that total from these parts. An absent key means the item was not handed over.
   */
  itemValuesEgp: Record<string, number> | null;
  declarationNo: string | null;

  /**
   * Whether the person holding this device still works here.
   *
   * THE FLAG THE REGISTER EXISTS TO RAISE. A device signed out to somebody whose last working day
   * has passed is the exact case the custody receipt's البند (7) addresses — return «قبل استلام
   * مستحقاتي النهائية» — and the one nothing in Phoenix could see before this table. `unknown`
   * means the holder's hr_id no longer matches any directory row, which is itself worth surfacing
   * rather than quietly treating as fine.
   */
  holderState: HolderEmploymentState;
  holderLastWorkingDate: string | null;
  /** Days since the holder's last working day, 0 when it has not passed or is unknown. */
  daysSinceHolderLeft: number;
  /** Outstanding, and the holder has left. The register's headline number. */
  isHeldByLeaver: boolean;
};

/** One closed or open custody event, for the device's own history. */
export type DeviceAssignment = {
  id: string;
  deviceId: string;
  employeeHrId: string;
  employeeName: string;
  jobTitle: string | null;
  declarationNo: string | null;
  handoverPlace: string | null;
  issuedOn: string;
  issuedBy: string | null;
  issuedByName: string | null;
  /** Per-item values as signed for at THIS handover, keyed by template item number. */
  itemValuesEgp: Record<string, number> | null;
  agreedValueEgp: number | null;
  status: AssignmentStatus;
  returnedOn: string | null;
  returnedBy: string | null;
  returnedByName: string | null;
  returnCondition: ReturnCondition | null;
  shortfallNote: string | null;
  settlementEgp: number | null;
  reason: string | null;
  note: string | null;
};

export type DeviceRegisterStats = {
  total: number;
  inStock: number;
  assigned: number;
  repair: number;
  /** `lost` and `stolen` together — both are "the company cannot see it". */
  missing: number;
  retired: number;
  /** Outstanding devices whose holder has left. Leads the page. */
  heldByLeavers: number;
  /** The agreed value of those, in EGP — what البند (10) would let the company recover. */
  valueHeldByLeaversEgp: number;
  /** Devices carrying no estimated value, so البند (10) can recover nothing against them. */
  withoutValue: number;
};

/**
 * One leaver and everything he still holds — the clearance view of the same data.
 *
 * Grouped by PERSON rather than by device because that is the question asked at an exit: not
 * "where is PHX-LAP-0007" but "what does this person still have, and what is it worth". The
 * custody receipt's return protocol says final dues may not be paid before it is completed, so
 * this list is what somebody has to be able to see on the day a settlement is prepared.
 */
export type LeaverHoldingDevices = {
  employeeHrId: string;
  employeeName: string;
  jobTitle: string | null;
  lastWorkingDate: string | null;
  employmentStatus: string | null;
  daysSinceLastDay: number;
  devices: Array<{
    assignmentId: string;
    deviceId: string;
    assetTag: string;
    category: DeviceCategory;
    /** Serial or IMEI, whichever the device carries — what a police report needs. */
    identifier: string;
    agreedValueEgp: number | null;
    issuedOn: string;
  }>;
  totalValueEgp: number;
};

/** A person the register may issue a device to. Active employees only. */
export type AssignableEmployee = {
  hrId: string;
  name: string;
  jobTitle: string | null;
};

export type DeviceRegisterData = {
  devices: CompanyDevice[];
  leaversHolding: LeaverHoldingDevices[];
  assignable: AssignableEmployee[];
  stats: DeviceRegisterStats;
};

export type CreateDeviceInput = {
  assetTag: string;
  category: DeviceCategory;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  imei?: string | null;
  deviceName?: string | null;
  processor?: string | null;
  installedRam?: string | null;
  systemType?: string | null;
  windowsDeviceId?: string | null;
  windowsProductId?: string | null;
  simNumber?: string | null;
  lineNumber?: string | null;
  estimatedValueEgp?: number | null;
  purchasedOn?: string | null;
  note?: string | null;
};

export type IssueDeviceInput = {
  deviceId: string;
  employeeHrId: string;
  declarationNo?: string | null;
  handoverPlace?: string | null;
  issuedOn?: string | null;
  /**
   * Keyed by the custody template's item number. An absent key means the item was not handed over.
   *
   * Values are `unknown` because this crosses the wire: the browser sends what was typed into a box,
   * and `normalizeItemValues` is the thing that decides whether it is a price. Narrowing here would
   * only move the lie earlier.
   */
  itemValuesEgp?: Record<string, unknown> | null;
};

/** Re-pricing an outstanding handover, for the case where the figures arrive after the press. */
export type SetAssignmentItemValuesInput = {
  assignmentId: string;
  /** Raw, as typed. `normalizeItemValues` validates it — see `IssueDeviceInput.itemValuesEgp`. */
  itemValuesEgp: Record<string, unknown> | null;
};

export type ReturnDeviceInput = {
  assignmentId: string;
  condition: ReturnCondition;
  shortfallNote?: string | null;
  settlementEgp?: number | null;
  returnedOn?: string | null;
  note?: string | null;
};

export type MarkDeviceInput = {
  deviceId: string;
  status: MarkableDeviceStatus;
  reason?: string | null;
};

export type WriteOffDeviceInput = {
  assignmentId: string;
  reason: string;
  settlementEgp?: number | null;
};

/** Earmark an in-stock device for a not-yet-hired holder, by a typed name. Freezes no value. */
export type ReserveDeviceInput = {
  deviceId: string;
  placeholderName: string;
  declarationNo?: string | null;
  handoverPlace?: string | null;
  note?: string | null;
};

/** Move a reservation to a different typed name — still nobody has signed. */
export type ReassignPlaceholderInput = {
  assignmentId: string;
  newName: string;
};

/** Cancel a reservation before anyone signs. Never for a signed custody. */
export type RevokeReservationInput = {
  assignmentId: string;
  reason?: string | null;
};

/**
 * Day one: bind a reservation to the hired employee, which creates the real signed custody and
 * freezes the device's value onto it (البند 9).
 */
export type ReconcileDeviceInput = {
  assignmentId: string;
  employeeHrId: string;
  declarationNo?: string | null;
  handoverPlace?: string | null;
  issuedOn?: string | null;
};

/**
 * The device half of a custody receipt, resolved for one handover.
 *
 * Carried on `HiringPackData` beside `exit` and `renewal`, and NULL whenever no device has been
 * chosen — which is most of the time, because the form is often printed before the machine is in
 * anybody's hand. Null prints the ruled blanks the form has always printed; a device fills them.
 */
export type CustodyDeviceFacts = {
  assetTag: string;
  category: DeviceCategory;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  imei: string | null;
  deviceName: string | null;
  processor: string | null;
  installedRam: string | null;
  systemType: string | null;
  windowsDeviceId: string | null;
  windowsProductId: string | null;
  simNumber: string | null;
  lineNumber: string | null;
  /**
   * The per-item values from the OUTSTANDING assignment, or null when nobody holds this device.
   *
   * Read from the assignment rather than the device because البند (9) prices what was agreed at
   * THIS handover. Reprinting last year's receipt must show last year's figures, and a device
   * reissued to somebody else at a different value must not rewrite the paper the first holder
   * signed.
   */
  itemValuesEgp: Record<string, number> | null;
};
