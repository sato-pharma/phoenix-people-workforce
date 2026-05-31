/**
 * Strategic Risk Register — pure assembly of a categorized, severity-ranked,
 * owner-annotated register from EXISTING real signals only. No DB access here;
 * inputs are passed in by the page from already-authorized aggregate services.
 *
 * Ownership is a documented domain -> FUNCTION routing convention (never a
 * fabricated individual). Lifecycle risk severity reuses the lifecycle windows.
 */
export type RiskSeverity = "critical" | "warning" | "watch";

export type RiskCategory =
  | "Workforce"
  | "Payroll"
  | "Compliance"
  | "Recruitment"
  | "Data Integrity"
  | "System";

export type RiskRow = {
  id: string;
  title: string;
  category: RiskCategory;
  severity: RiskSeverity;
  entity: string | null;
  dueDate: string | null;
  days: number | null;
  impact: string;
  owner: string;
  source: string;
};

export type RiskRegister = {
  rows: RiskRow[];
  unavailableSources: string[];
};

export type LifecycleRiskAlertInput = {
  type: "contract" | "probation";
  name: string;
  date: string;
  days: number;
};

export type RiskRegisterInput = {
  alerts?: LifecycleRiskAlertInput[] | null;
  alertsAvailable: boolean;
  payrollFlags?: number;
  pendingLeave?: number;
  pendingOffers?: number;
  dataUnavailable?: string[];
  failureCount24h?: number;
  staleSources?: string[];
};

const SEVERITY_RANK: Record<RiskSeverity, number> = { critical: 0, warning: 1, watch: 2 };

/** Documented routing: a FUNCTION owns the follow-up, never a guessed person. */
export function resolveRiskOwner(category: RiskCategory): string {
  switch (category) {
    case "Workforce":
    case "Compliance":
      return "HR / People Ops";
    case "Payroll":
      return "Finance / Payroll";
    case "Recruitment":
      return "Talent Acquisition";
    case "Data Integrity":
    case "System":
      return "Platform / Data Ops";
    default:
      return "Unassigned";
  }
}

function contractSeverity(days: number): RiskSeverity {
  if (days <= 7) return "critical";
  if (days <= 30) return "warning";
  return "watch";
}

function probationSeverity(days: number): RiskSeverity {
  if (days <= 7) return "critical";
  if (days <= 15) return "warning";
  return "watch";
}

/** Pure comparator: Critical -> Warning -> Watch, then nearest due / oldest age, then title. */
export function compareRisk(a: RiskRow, b: RiskRow): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  const aDays = typeof a.days === "number" ? a.days : Number.POSITIVE_INFINITY;
  const bDays = typeof b.days === "number" ? b.days : Number.POSITIVE_INFINITY;
  if (aDays !== bDays) return aDays - bDays;
  return a.title.localeCompare(b.title);
}

export function buildStrategicRiskRegister(input: RiskRegisterInput): RiskRegister {
  const rows: RiskRow[] = [];
  const unavailableSources: string[] = [];

  if (input.alertsAvailable && Array.isArray(input.alerts)) {
    for (const alert of input.alerts) {
      const category: RiskCategory = alert.type === "contract" ? "Compliance" : "Workforce";
      const severity = alert.type === "contract" ? contractSeverity(alert.days) : probationSeverity(alert.days);
      rows.push({
        id: `${alert.type}:${alert.name}:${alert.date}`,
        title: alert.type === "contract" ? "Contract renewal due" : "Probation period ending",
        category,
        severity,
        entity: alert.name,
        dueDate: alert.date,
        days: alert.days,
        impact:
          alert.type === "contract"
            ? "Retention / continuity risk if renewal lapses"
            : "Confirmation decision required before probation ends",
        owner: resolveRiskOwner(category),
        source: "Lifecycle risk",
      });
    }
  } else {
    unavailableSources.push("Lifecycle risk alerts");
  }

  if ((input.payrollFlags ?? 0) > 0) {
    rows.push({
      id: "payroll-flags",
      title: `${input.payrollFlags} payroll flag(s) open`,
      category: "Payroll",
      severity: "warning",
      entity: null,
      dueDate: null,
      days: null,
      impact: "Pay-accuracy / compliance exposure in the latest batch",
      owner: resolveRiskOwner("Payroll"),
      source: "Payroll summary",
    });
  }

  if ((input.pendingLeave ?? 0) > 0) {
    rows.push({
      id: "pending-leave",
      title: `${input.pendingLeave} leave request(s) pending decision`,
      category: "Compliance",
      severity: "watch",
      entity: null,
      dueDate: null,
      days: null,
      impact: "Coverage planning / decision-SLA risk",
      owner: resolveRiskOwner("Compliance"),
      source: "Leave",
    });
  }

  if ((input.pendingOffers ?? 0) > 0) {
    rows.push({
      id: "pending-offers",
      title: `${input.pendingOffers} offer(s) awaiting response`,
      category: "Recruitment",
      severity: "watch",
      entity: null,
      dueDate: null,
      days: null,
      impact: "Hiring pipeline / time-to-fill risk",
      owner: resolveRiskOwner("Recruitment"),
      source: "Recruitment",
    });
  }

  for (const message of input.dataUnavailable ?? []) {
    if (!message) continue;
    rows.push({
      id: `data:${message}`,
      title: message,
      category: "Data Integrity",
      severity: "warning",
      entity: null,
      dueDate: null,
      days: null,
      impact: "An executive metric may be incomplete until this feed is restored",
      owner: resolveRiskOwner("Data Integrity"),
      source: "Platform",
    });
  }

  if ((input.failureCount24h ?? 0) > 0) {
    rows.push({
      id: "ops-failures",
      title: `${input.failureCount24h} operational failure(s) in 24h`,
      category: "System",
      severity: "warning",
      entity: null,
      dueDate: null,
      days: null,
      impact: "Process-reliability risk across automated workflows",
      owner: resolveRiskOwner("System"),
      source: "Operations",
    });
  }

  for (const stale of input.staleSources ?? []) {
    if (!stale) continue;
    rows.push({
      id: `stale:${stale}`,
      title: `Stale data source: ${stale}`,
      category: "System",
      severity: "watch",
      entity: null,
      dueDate: null,
      days: null,
      impact: "Freshness risk on a dependent metric",
      owner: resolveRiskOwner("System"),
      source: "Operations",
    });
  }

  rows.sort(compareRisk);
  return { rows, unavailableSources };
}
