export type EmployeeNodeType =
  | "active_employee"
  | "historical_record"
  | "vacancy_node"
  | "system_placeholder"
  | "others_unassigned_node"
  | "non_login_aggregation_node";

export type EmployeeNodeClassification = {
  node_type: EmployeeNodeType;
  eligible_for_login: boolean;
  eligible_for_headcount: boolean;
  eligible_for_payroll_portal: boolean;
  eligible_for_sales_personal_dashboard: boolean;
  eligible_for_sales_aggregation: boolean;
  eligible_for_organogram: boolean;
  eligible_for_vacancy_dashboard: boolean;
  reason: string;
};

export type EmployeeNodeInput = Record<string, unknown> & {
  areaId?: number | null;
  areaName?: string | null;
  crmId?: string | null;
  crmUsername?: string | null;
  employmentStatus?: string | null;
  fullName?: string | null;
  hrId?: string | null;
  jobTitle?: string | null;
  lineId?: number | null;
  lineName?: string | null;
  managerHrId?: string | null;
  positionTitle?: string | null;
  workEmail?: string | null;
};

export type SalesOwnershipClassification =
  | "assigned_employee_sales"
  | "vacant_territory_sales"
  | "non_assignable_territory_sales"
  | "line_level_sales"
  | "others_unassigned_sales"
  | "unresolved_sales_exception";

export type SalesOwnershipRecord = Record<string, unknown> & {
  areaId?: number | null;
  areaName?: string | null;
  employeeCrmId?: string | null;
  employeeHrId?: string | null;
  employeeLookupKey?: string | null;
  employeeName?: string | null;
  line?: string | null;
  lineId?: number | null;
  managerHrId?: string | null;
  territory?: string | null;
};

export type SalesOwnershipVacancySignal = Record<string, unknown> & {
  areaId?: number | null;
  areaName?: string | null;
  lineId?: number | null;
  lineName?: string | null;
  managerHrId?: string | null;
  status?: string | null;
  vacancyCode?: string | null;
  vacancyId?: number | string | null;
};

export type SalesOwnershipContext = {
  areaIdByName?: ReadonlyMap<string, number>;
  employeeByCrmId?: ReadonlyMap<string, EmployeeNodeInput>;
  employeeByHrId?: ReadonlyMap<string, EmployeeNodeInput>;
  employeeByLookupKey?: ReadonlyMap<string, EmployeeNodeInput>;
  employeeByName?: ReadonlyMap<string, EmployeeNodeInput>;
  employees?: EmployeeNodeInput[];
  lineIdByAreaId?: ReadonlyMap<number, number>;
  lineIdByName?: ReadonlyMap<string, number>;
  vacancies?: SalesOwnershipVacancySignal[];
};

export type SalesOwnershipResult = {
  classification: SalesOwnershipClassification;
  owner_employee_hr_id: string | null;
  owner_manager_hr_id: string | null;
  owner_line_id: number | null;
  owner_area_id: number | null;
  owner_nsm_hr_id: string | null;
  derived_team_key: string | null;
  is_exception: boolean;
  include_in_employee_total: boolean;
  include_in_manager_total: boolean;
  include_in_line_total: boolean;
  include_in_company_total: boolean;
  include_in_vacancy_dashboard: boolean;
  reason: string;
};

type IndexedSalesOwnershipContext = SalesOwnershipContext & {
  employeeByCrmId: ReadonlyMap<string, EmployeeNodeInput>;
  employeeByHrId: ReadonlyMap<string, EmployeeNodeInput>;
  employeeByLookupKey: ReadonlyMap<string, EmployeeNodeInput>;
  employeeByName: ReadonlyMap<string, EmployeeNodeInput>;
};

function compact(value: unknown) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function normalize(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeKey(value: unknown) {
  return normalize(value).replace(/\s+/g, " ");
}

function getText(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = compact(source[key]);
    if (value) return value;
  }
  return null;
}

function getNumber(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getBoolean(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = normalize(value);
      if (["true", "yes", "1", "y"].includes(normalized)) return true;
      if (["false", "no", "0", "n"].includes(normalized)) return false;
    }
  }
  return null;
}

function setIfPresent(map: Map<string, EmployeeNodeInput>, value: unknown, employee: EmployeeNodeInput) {
  const key = normalizeKey(value);
  if (key && !map.has(key)) map.set(key, employee);
}

export function buildSalesOwnershipContext(context: SalesOwnershipContext = {}): IndexedSalesOwnershipContext {
  const employeeByHrId = new Map<string, EmployeeNodeInput>();
  const employeeByCrmId = new Map<string, EmployeeNodeInput>();
  const employeeByLookupKey = new Map<string, EmployeeNodeInput>();
  const employeeByName = new Map<string, EmployeeNodeInput>();

  for (const [key, value] of context.employeeByHrId ?? []) employeeByHrId.set(normalizeKey(key), value);
  for (const [key, value] of context.employeeByCrmId ?? []) employeeByCrmId.set(normalizeKey(key), value);
  for (const [key, value] of context.employeeByLookupKey ?? []) employeeByLookupKey.set(normalizeKey(key), value);
  for (const [key, value] of context.employeeByName ?? []) employeeByName.set(normalizeKey(key), value);

  for (const employee of context.employees ?? []) {
    setIfPresent(employeeByHrId, getText(employee, ["hrId", "hr_id"]), employee);
    setIfPresent(employeeByCrmId, getText(employee, ["crmId", "crm_id"]), employee);
    setIfPresent(employeeByLookupKey, getText(employee, ["crmUsername", "crm_username", "employeeLookupKey", "employee_lookup_key"]), employee);
    setIfPresent(employeeByName, getText(employee, ["fullName", "full_name", "employeeName", "employee_name", "name"]), employee);
  }

  return {
    ...context,
    employeeByCrmId,
    employeeByHrId,
    employeeByLookupKey,
    employeeByName,
  };
}

function lookupEmployee(map: ReadonlyMap<string, EmployeeNodeInput>, value: unknown) {
  const key = normalizeKey(value);
  return key ? map.get(key) ?? null : null;
}

function canonicalSalesLine(value: unknown) {
  return normalize(value)
    .replace(/\bline\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function otherBucketForLine(line: unknown) {
  const normalizedLine = canonicalSalesLine(line);
  if (normalizedLine === "cns") return "o-3";
  if (normalizedLine.includes("anti") && normalizedLine.includes("infective")) return "o-2";
  if (normalizedLine.includes("pedia")) return "o-1";
  return null;
}

function isOthersText(value: unknown) {
  const text = normalize(value);
  return text === "others" || text === "other" || text === "unassigned" || text === "others / unassigned";
}

export function isApprovedOthersSalesBucket(source: {
  employeeHrId?: string | null;
  employeeLookupKey?: string | null;
  employeeName?: string | null;
  line?: string | null;
}) {
  const expectedHrId = otherBucketForLine(source.line);
  const hrId = normalize(source.employeeHrId);

  return Boolean(
    (expectedHrId && hrId === expectedHrId) ||
      isOthersText(source.employeeLookupKey) ||
      isOthersText(source.employeeName)
  );
}

function textContainsAny(value: unknown, tokens: string[]) {
  const text = normalize(value);
  return Boolean(text && tokens.some((token) => text.includes(token)));
}

function explicitNodeType(employee: EmployeeNodeInput): EmployeeNodeType | null {
  const raw = [
    getText(employee, ["nodeType", "node_type"]),
    getText(employee, ["recordType", "record_type"]),
    getText(employee, ["businessType", "business_type"]),
    getText(employee, ["employeeType", "employee_type"]),
  ].filter(Boolean).join(" ");
  const value = normalize(raw);
  if (!value) return null;
  if (value.includes("others") || value.includes("unassigned")) return "others_unassigned_node";
  if (value.includes("non_login") || value.includes("non-login") || value.includes("aggregation")) return "non_login_aggregation_node";
  if (value.includes("vacancy") || value.includes("vacant")) return "vacancy_node";
  if (value.includes("system") || value.includes("placeholder")) return "system_placeholder";
  if (value.includes("historical") || value.includes("payroll_record")) return "historical_record";
  if (value.includes("active")) return "active_employee";
  return null;
}

function hasSalesRole(employee: EmployeeNodeInput) {
  const title = `${getText(employee, ["jobTitle", "job_title"]) ?? ""} ${getText(employee, ["positionTitle", "position_title"]) ?? ""}`;
  const normalized = normalize(title);
  return Boolean(
    normalized &&
      (normalized.includes("sales") ||
        normalized.includes("medical rep") ||
        normalized.includes("representative") ||
        /\b(mr|dsm|nsm)\b/.test(normalized))
  );
}

function approvedForAggregation(employee: EmployeeNodeInput) {
  return getBoolean(employee, ["approvedForAggregation", "approved_for_aggregation", "eligible_for_sales_aggregation"]) === true;
}

export function classifyEmployeeNode(employee: EmployeeNodeInput): EmployeeNodeClassification {
  const hrId = getText(employee, ["hrId", "hr_id"]);
  const fullName = getText(employee, ["fullName", "full_name", "name"]);
  const status = getText(employee, ["employmentStatus", "employment_status", "status"]);
  const title = `${getText(employee, ["jobTitle", "job_title"]) ?? ""} ${getText(employee, ["positionTitle", "position_title"]) ?? ""}`;
  const combined = [hrId, fullName, status, title].filter(Boolean).join(" ");
  const explicit = explicitNodeType(employee);
  const payrollEligible = getBoolean(employee, ["payrollEligible", "payroll_eligible"]);
  const organogramVisible = getBoolean(employee, ["organogramVisible", "organogram_visible"]);

  let nodeType: EmployeeNodeType = explicit ?? "active_employee";
  if (!explicit) {
    if (isApprovedOthersSalesBucket({ employeeHrId: hrId, employeeName: fullName, line: getText(employee, ["lineName", "line_name", "line"]) })) {
      nodeType = "others_unassigned_node";
    } else if (textContainsAny(combined, ["non_login", "non-login", "aggregation node", "aggregate bucket"])) {
      nodeType = "non_login_aggregation_node";
    } else if (textContainsAny(combined, ["vacancy", "vacant"])) {
      nodeType = "vacancy_node";
    } else if (textContainsAny(combined, ["system placeholder", "placeholder", "system node"])) {
      nodeType = "system_placeholder";
    } else if (
      textContainsAny(status, ["historical", "historical_payroll_record", "payroll record"]) ||
      ["inactive", "resigned", "terminated", "left", "suspended"].some((token) => normalize(status).includes(token))
    ) {
      nodeType = "historical_record";
    }
  }

  if (nodeType === "active_employee") {
    return {
      node_type: nodeType,
      eligible_for_login: true,
      eligible_for_headcount: true,
      eligible_for_payroll_portal: payrollEligible ?? true,
      eligible_for_sales_personal_dashboard: hasSalesRole(employee),
      eligible_for_sales_aggregation: true,
      eligible_for_organogram: organogramVisible ?? true,
      eligible_for_vacancy_dashboard: false,
      reason: "Active employee node.",
    };
  }

  if (nodeType === "historical_record") {
    return {
      node_type: nodeType,
      eligible_for_login: false,
      eligible_for_headcount: false,
      eligible_for_payroll_portal: false,
      eligible_for_sales_personal_dashboard: false,
      eligible_for_sales_aggregation: approvedForAggregation(employee),
      eligible_for_organogram: organogramVisible ?? false,
      eligible_for_vacancy_dashboard: false,
      reason: "Historical or inactive payroll/person record; do not create login access.",
    };
  }

  if (nodeType === "vacancy_node") {
    return {
      node_type: nodeType,
      eligible_for_login: false,
      eligible_for_headcount: false,
      eligible_for_payroll_portal: false,
      eligible_for_sales_personal_dashboard: false,
      eligible_for_sales_aggregation: getBoolean(employee, ["linkedToTerritorySales", "linked_to_territory_sales"]) ?? true,
      eligible_for_organogram: organogramVisible ?? true,
      eligible_for_vacancy_dashboard: true,
      reason: "Explicit vacancy node; it can represent coverage but never login access.",
    };
  }

  if (nodeType === "system_placeholder") {
    return {
      node_type: nodeType,
      eligible_for_login: false,
      eligible_for_headcount: false,
      eligible_for_payroll_portal: false,
      eligible_for_sales_personal_dashboard: false,
      eligible_for_sales_aggregation: approvedForAggregation(employee),
      eligible_for_organogram: organogramVisible ?? false,
      eligible_for_vacancy_dashboard: false,
      reason: "System placeholder node; not a real active employee.",
    };
  }

  if (nodeType === "others_unassigned_node") {
    return {
      node_type: nodeType,
      eligible_for_login: false,
      eligible_for_headcount: false,
      eligible_for_payroll_portal: false,
      eligible_for_sales_personal_dashboard: false,
      eligible_for_sales_aggregation: true,
      eligible_for_organogram: organogramVisible ?? false,
      eligible_for_vacancy_dashboard: false,
      reason: "Approved Others/Unassigned aggregation node.",
    };
  }

  return {
    node_type: nodeType,
    eligible_for_login: false,
    eligible_for_headcount: false,
    eligible_for_payroll_portal: false,
    eligible_for_sales_personal_dashboard: false,
    eligible_for_sales_aggregation: true,
    eligible_for_organogram: organogramVisible ?? false,
    eligible_for_vacancy_dashboard: false,
    reason: "Non-login aggregation node.",
  };
}

function employeeHrId(employee: EmployeeNodeInput | null | undefined) {
  return getText(employee ?? {}, ["hrId", "hr_id"]);
}

function employeeLineId(employee: EmployeeNodeInput | null | undefined) {
  return getNumber(employee ?? {}, ["lineId", "line_id"]);
}

function employeeAreaId(employee: EmployeeNodeInput | null | undefined) {
  return getNumber(employee ?? {}, ["areaId", "area_id"]);
}

function employeeLineName(employee: EmployeeNodeInput | null | undefined) {
  return getText(employee ?? {}, ["lineName", "line_name", "line"]);
}

function employeeManagerHrId(employee: EmployeeNodeInput | null | undefined) {
  return getText(employee ?? {}, ["managerHrId", "manager_hr_id"]);
}

function isNsmEmployee(employee: EmployeeNodeInput | null | undefined) {
  const title = `${getText(employee ?? {}, ["jobTitle", "job_title"]) ?? ""} ${getText(employee ?? {}, ["positionTitle", "position_title"]) ?? ""}`;
  return textContainsAny(title, ["national sales manager", " nsm", "nsm "]) || /\bnsm\b/.test(normalize(title));
}

function isOpenVacancy(signal: SalesOwnershipVacancySignal) {
  const status = normalize(getText(signal, ["status"]));
  return !status || status === "open" || status === "active" || status === "approved";
}

function valuesMatch(left: unknown, right: unknown) {
  const leftText = normalizeKey(left);
  const rightText = normalizeKey(right);
  return Boolean(leftText && rightText && leftText === rightText);
}

function vacancyMatchesRecord(signal: SalesOwnershipVacancySignal, record: SalesOwnershipRecord) {
  if (!isOpenVacancy(signal)) return false;

  const recordVacancyCode = getText(record, ["vacancyCode", "vacancy_code"]);
  const signalVacancyCode = getText(signal, ["vacancyCode", "vacancy_code"]);
  if (recordVacancyCode && signalVacancyCode && valuesMatch(recordVacancyCode, signalVacancyCode)) return true;

  const recordManager = getText(record, ["managerHrId", "manager_hr_id"]);
  const signalManager = getText(signal, ["managerHrId", "manager_hr_id"]);
  const managerMatches = !recordManager || !signalManager || valuesMatch(recordManager, signalManager);
  if (!managerMatches) return false;

  const recordAreaId = getNumber(record, ["areaId", "area_id"]);
  const signalAreaId = getNumber(signal, ["areaId", "area_id"]);
  if (recordAreaId !== null && signalAreaId !== null) return recordAreaId === signalAreaId;

  const recordTerritory = getText(record, ["territory", "areaName", "area_name"]);
  const signalAreaName = getText(signal, ["areaName", "area_name", "territory"]);
  if (recordTerritory && signalAreaName) return valuesMatch(recordTerritory, signalAreaName);

  return false;
}

function hasExplicitVacancySignal(record: SalesOwnershipRecord, context: SalesOwnershipContext) {
  const explicit = getBoolean(record, ["explicitVacancySignal", "explicit_vacancy_signal", "isVacancy", "is_vacancy"]);
  if (explicit === true) return true;

  if (getText(record, ["vacancyId", "vacancy_id", "vacancyCode", "vacancy_code"])) return true;

  const vacancyText = [
    getText(record, ["employeeLookupKey", "employee_lookup_key"]),
    getText(record, ["employeeName", "employee_name"]),
    getText(record, ["territoryStatus", "territory_status"]),
  ].filter(Boolean).join(" ");
  if (textContainsAny(vacancyText, ["vacant", "vacancy"])) return true;

  return Boolean((context.vacancies ?? []).some((signal) => vacancyMatchesRecord(signal, record)));
}

function inferLineId(record: SalesOwnershipRecord, context: SalesOwnershipContext, employees: Array<EmployeeNodeInput | null | undefined>) {
  const direct = getNumber(record, ["lineId", "line_id"]);
  if (direct !== null) return direct;

  for (const employee of employees) {
    const lineId = employeeLineId(employee);
    if (lineId !== null) return lineId;
  }

  const lineName = getText(record, ["line", "lineName", "line_name"]);
  if (lineName && context.lineIdByName) {
    const fromLineName = context.lineIdByName.get(normalizeKey(lineName)) ?? context.lineIdByName.get(lineName);
    if (typeof fromLineName === "number") return fromLineName;
  }

  const areaId = getNumber(record, ["areaId", "area_id"]);
  if (areaId !== null && context.lineIdByAreaId) {
    const fromArea = context.lineIdByAreaId.get(areaId);
    if (typeof fromArea === "number") return fromArea;
  }

  return null;
}

function inferAreaId(record: SalesOwnershipRecord, context: SalesOwnershipContext, employees: Array<EmployeeNodeInput | null | undefined>) {
  const direct = getNumber(record, ["areaId", "area_id"]);
  if (direct !== null) return direct;

  for (const employee of employees) {
    const areaId = employeeAreaId(employee);
    if (areaId !== null) return areaId;
  }

  const areaName = getText(record, ["areaName", "area_name", "territory"]);
  if (areaName && context.areaIdByName) {
    const fromAreaName = context.areaIdByName.get(normalizeKey(areaName)) ?? context.areaIdByName.get(areaName);
    if (typeof fromAreaName === "number") return fromAreaName;
  }

  return null;
}

function inferLineKey(record: SalesOwnershipRecord, employees: Array<EmployeeNodeInput | null | undefined>) {
  return (
    getText(record, ["line", "lineName", "line_name"]) ??
    employees.map(employeeLineName).find(Boolean) ??
    null
  );
}

function inferNsmHrId(manager: EmployeeNodeInput | null | undefined) {
  if (!manager) return null;
  if (isNsmEmployee(manager)) return employeeHrId(manager);
  return employeeManagerHrId(manager);
}

export function deriveTeamKey(input: {
  classification?: SalesOwnershipClassification | null;
  lineId?: number | string | null;
  lineKey?: string | null;
  managerHrId?: string | null;
}) {
  if (input.classification === "unresolved_sales_exception") return null;

  const managerHrId = compact(input.managerHrId);
  const lineSegment =
    input.lineId !== null && input.lineId !== undefined && String(input.lineId).trim() !== ""
      ? String(input.lineId).trim()
      : input.lineKey
        ? `line:${canonicalSalesLine(input.lineKey) || normalizeKey(input.lineKey)}`
        : null;

  if (!lineSegment) return null;

  if (managerHrId) return `team:${lineSegment}:${managerHrId}`;
  if (input.classification === "others_unassigned_sales") return `team:${lineSegment}:others_unassigned`;
  return `team:${lineSegment}:line_level`;
}

function result(input: Omit<SalesOwnershipResult, "derived_team_key" | "is_exception"> & { lineKey?: string | null }): SalesOwnershipResult {
  const derivedTeamKey = deriveTeamKey({
    classification: input.classification,
    lineId: input.owner_line_id,
    lineKey: input.lineKey ?? null,
    managerHrId: input.owner_manager_hr_id,
  });

  return {
    classification: input.classification,
    owner_employee_hr_id: input.owner_employee_hr_id,
    owner_manager_hr_id: input.owner_manager_hr_id,
    owner_line_id: input.owner_line_id,
    owner_area_id: input.owner_area_id,
    owner_nsm_hr_id: input.owner_nsm_hr_id,
    derived_team_key: derivedTeamKey,
    is_exception: input.classification === "unresolved_sales_exception",
    include_in_employee_total: input.include_in_employee_total,
    include_in_manager_total: input.include_in_manager_total,
    include_in_line_total: input.include_in_line_total,
    include_in_company_total: input.include_in_company_total,
    include_in_vacancy_dashboard: input.include_in_vacancy_dashboard,
    reason: input.reason,
  };
}

function classifyResolvedEmployeeSales(
  record: SalesOwnershipRecord,
  context: IndexedSalesOwnershipContext,
  owner: EmployeeNodeInput,
  source: "direct" | "resolved",
) {
  const node = classifyEmployeeNode(owner);
  const ownerEmployeeHrId = employeeHrId(owner);
  const recordManager = getText(record, ["managerHrId", "manager_hr_id"]);
  const ownerManagerHrId = recordManager ?? employeeManagerHrId(owner);
  const manager = ownerManagerHrId ? lookupEmployee(context.employeeByHrId, ownerManagerHrId) : null;
  const ownerLineId = inferLineId(record, context, [owner, manager]);
  const ownerAreaId = inferAreaId(record, context, [owner]);
  const lineKey = inferLineKey(record, [owner, manager]);
  const ownerNsmHrId = inferNsmHrId(manager);

  if (node.node_type === "vacancy_node") {
    return result({
      classification: "vacant_territory_sales",
      include_in_company_total: true,
      include_in_employee_total: false,
      include_in_line_total: ownerLineId !== null || Boolean(lineKey),
      include_in_manager_total: Boolean(ownerManagerHrId),
      include_in_vacancy_dashboard: true,
      lineKey,
      owner_area_id: ownerAreaId,
      owner_employee_hr_id: null,
      owner_line_id: ownerLineId,
      owner_manager_hr_id: ownerManagerHrId,
      owner_nsm_hr_id: ownerNsmHrId,
      reason: "Sales record resolves to an explicit vacancy node.",
    });
  }

  if (
    node.node_type === "others_unassigned_node" ||
    node.node_type === "non_login_aggregation_node" ||
    (node.node_type === "system_placeholder" && node.eligible_for_sales_aggregation)
  ) {
    return result({
      classification: "others_unassigned_sales",
      include_in_company_total: true,
      include_in_employee_total: false,
      include_in_line_total: ownerLineId !== null || Boolean(lineKey),
      include_in_manager_total: false,
      include_in_vacancy_dashboard: false,
      lineKey,
      owner_area_id: ownerAreaId,
      owner_employee_hr_id: null,
      owner_line_id: ownerLineId,
      owner_manager_hr_id: null,
      owner_nsm_hr_id: ownerNsmHrId,
      reason: "Sales record resolves to an approved non-login aggregate bucket.",
    });
  }

  if (node.node_type === "system_placeholder") {
    return result({
      classification: "unresolved_sales_exception",
      include_in_company_total: false,
      include_in_employee_total: false,
      include_in_line_total: false,
      include_in_manager_total: false,
      include_in_vacancy_dashboard: false,
      lineKey,
      owner_area_id: ownerAreaId,
      owner_employee_hr_id: null,
      owner_line_id: ownerLineId,
      owner_manager_hr_id: ownerManagerHrId,
      owner_nsm_hr_id: ownerNsmHrId,
      reason: "Employee HR ID resolves to a system placeholder that is not approved for sales aggregation.",
    });
  }

  return result({
    classification: "assigned_employee_sales",
    include_in_company_total: true,
    include_in_employee_total: true,
    include_in_line_total: true,
    include_in_manager_total: Boolean(ownerManagerHrId),
    include_in_vacancy_dashboard: false,
    lineKey,
    owner_area_id: ownerAreaId,
    owner_employee_hr_id: ownerEmployeeHrId,
    owner_line_id: ownerLineId,
    owner_manager_hr_id: ownerManagerHrId,
    owner_nsm_hr_id: ownerNsmHrId,
    reason: source === "direct" ? "Employee HR ID matched a known employee." : "Employee ownership was resolved from alternate employee keys.",
  });
}

function resolveEmployeeFromAlternateKeys(record: SalesOwnershipRecord, context: IndexedSalesOwnershipContext) {
  return (
    lookupEmployee(context.employeeByCrmId, getText(record, ["employeeCrmId", "employee_crm_id", "crmId", "crm_id"])) ??
    lookupEmployee(context.employeeByLookupKey, getText(record, ["employeeLookupKey", "employee_lookup_key", "crmUsername", "crm_username"])) ??
    lookupEmployee(context.employeeByName, getText(record, ["employeeName", "employee_name", "fullName", "full_name"]))
  );
}

export function classifySalesOwnership(
  record: SalesOwnershipRecord,
  context: SalesOwnershipContext = {},
): SalesOwnershipResult {
  const indexed = buildSalesOwnershipContext(context);
  const employeeHrId = getText(record, ["employeeHrId", "employee_hr_id"]);
  const managerHrId = getText(record, ["managerHrId", "manager_hr_id"]);
  const recordLineId = inferLineId(record, indexed, []);
  const recordAreaId = inferAreaId(record, indexed, []);
  const lineKey = inferLineKey(record, []);

  if (employeeHrId) {
    const employee = lookupEmployee(indexed.employeeByHrId, employeeHrId);
    if (employee) return classifyResolvedEmployeeSales(record, indexed, employee, "direct");

    const resolved = resolveEmployeeFromAlternateKeys(record, indexed);
    if (resolved) return classifyResolvedEmployeeSales(record, indexed, resolved, "resolved");

    return result({
      classification: "unresolved_sales_exception",
      include_in_company_total: false,
      include_in_employee_total: false,
      include_in_line_total: false,
      include_in_manager_total: false,
      include_in_vacancy_dashboard: false,
      lineKey,
      owner_area_id: recordAreaId,
      owner_employee_hr_id: null,
      owner_line_id: recordLineId,
      owner_manager_hr_id: managerHrId,
      owner_nsm_hr_id: null,
      reason: "Employee HR ID was provided but could not be resolved from HR ID, CRM ID, lookup key, or name.",
    });
  }

  if (isApprovedOthersSalesBucket({
    employeeHrId: employeeHrId,
    employeeLookupKey: getText(record, ["employeeLookupKey", "employee_lookup_key"]),
    employeeName: getText(record, ["employeeName", "employee_name"]),
    line: lineKey,
  })) {
    return result({
      classification: "others_unassigned_sales",
      include_in_company_total: true,
      include_in_employee_total: false,
      include_in_line_total: recordLineId !== null || Boolean(lineKey),
      include_in_manager_total: false,
      include_in_vacancy_dashboard: false,
      lineKey,
      owner_area_id: recordAreaId,
      owner_employee_hr_id: null,
      owner_line_id: recordLineId,
      owner_manager_hr_id: null,
      owner_nsm_hr_id: null,
      reason: "Sales row belongs to an approved Others/Unassigned aggregate bucket.",
    });
  }

  if (managerHrId) {
    const manager = lookupEmployee(indexed.employeeByHrId, managerHrId);
    const ownerLineId = inferLineId(record, indexed, [manager]);
    const ownerAreaId = inferAreaId(record, indexed, [manager]);
    const ownerNsmHrId = inferNsmHrId(manager);
    const ownerLineKey = inferLineKey(record, [manager]);
    const explicitVacancy = hasExplicitVacancySignal(record, indexed);

    return result({
      classification: explicitVacancy ? "vacant_territory_sales" : "non_assignable_territory_sales",
      include_in_company_total: true,
      include_in_employee_total: false,
      include_in_line_total: ownerLineId !== null || Boolean(ownerLineKey),
      include_in_manager_total: true,
      include_in_vacancy_dashboard: explicitVacancy,
      lineKey: ownerLineKey,
      owner_area_id: ownerAreaId,
      owner_employee_hr_id: null,
      owner_line_id: ownerLineId,
      owner_manager_hr_id: managerHrId,
      owner_nsm_hr_id: ownerNsmHrId,
      reason: explicitVacancy
        ? "Missing employee HR ID has an explicit vacancy signal."
        : "Missing employee HR ID has manager/line ownership and no explicit vacancy signal; treated as non-assignable territory sales.",
    });
  }

  if (recordLineId !== null || lineKey) {
    return result({
      classification: "line_level_sales",
      include_in_company_total: true,
      include_in_employee_total: false,
      include_in_line_total: true,
      include_in_manager_total: false,
      include_in_vacancy_dashboard: false,
      lineKey,
      owner_area_id: recordAreaId,
      owner_employee_hr_id: null,
      owner_line_id: recordLineId,
      owner_manager_hr_id: null,
      owner_nsm_hr_id: null,
      reason: "Sales row has line ownership but no employee or manager owner.",
    });
  }

  return result({
    classification: "unresolved_sales_exception",
    include_in_company_total: false,
    include_in_employee_total: false,
    include_in_line_total: false,
    include_in_manager_total: false,
    include_in_vacancy_dashboard: false,
    lineKey: null,
    owner_area_id: recordAreaId,
    owner_employee_hr_id: null,
    owner_line_id: null,
    owner_manager_hr_id: null,
    owner_nsm_hr_id: null,
    reason: "Sales row has no resolvable employee, manager, line, vacancy, or approved aggregate owner.",
  });
}

export function salesOwnershipLabel(classification: SalesOwnershipClassification) {
  const labels: Record<SalesOwnershipClassification, string> = {
    assigned_employee_sales: "Assigned Employee",
    vacant_territory_sales: "Vacant Territory",
    non_assignable_territory_sales: "Non-Assignable Territory",
    line_level_sales: "Line-Level Sales",
    others_unassigned_sales: "Others / Unassigned",
    unresolved_sales_exception: "Unresolved Exception",
  };
  return labels[classification];
}

export function shouldFlagMissingAccessForEmployeeNode(
  employee: EmployeeNodeInput,
  access: { hasAccessProfile?: boolean; hasAuthUser?: boolean },
) {
  const node = classifyEmployeeNode(employee);
  return node.eligible_for_login && (!access.hasAuthUser || !access.hasAccessProfile);
}
