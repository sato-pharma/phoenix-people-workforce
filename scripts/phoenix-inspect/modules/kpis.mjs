/**
 * The KPIs board ("KPI reports") as the explorer sees it: personas, states, the clicks it may make,
 * what it must never touch, and the source files whose literals are kept unmasked.
 *
 * Every route, tab and parameter here is read from source (route inventory, src/lib/crm/kpis-tabs.ts,
 * kpis-filters.ts KPI_FILTER_PARAMS, kpis-trend-options.ts KPI_TREND_PARAMS); none is invented.
 * August 2026 is staging's last full month of visits, November 2026 its real empty state
 * (CONNECTION_DIAGNOSTICS.md §3).
 */

export const FULL_MONTH = "2026-08";
export const EMPTY_MONTH = "2026-11";

/**
 * Who the explorer signs in as. Logins exist on STAGING only (INSPECTION_PERSONAS.md); their passwords
 * live on the machine that runs the explorer, never in Git. `matrix` says how much of the state list
 * the persona walks: "full" = every state at every viewport; "landing" = the module's landing state at
 * desktop and mobile; "denied" = the persona must NOT reach the board.
 */
export const PERSONAS = Object.freeze([
  { id: "ceo", login: "INSPECT-CEO", role: "CEO", shell: "admin", matrix: "full" },
  { id: "sfe", login: "INSPECT-SFE", role: "SFE Manager", shell: "admin", matrix: "landing" },
  { id: "hrr", login: "INSPECT-HRR", role: "HR Resourcing", shell: "hr", matrix: "landing" },
  { id: "nsm", login: "TEST-INSPECT-NSM", role: "National Sales Manager", shell: "portal", matrix: "landing" },
  { id: "dm", login: "TEST-INSPECT-DM", role: "District Manager", shell: "portal", matrix: "full" },
  { id: "rep", login: "TEST-INSPECT-REP", role: "Medical Rep", shell: "portal", matrix: "landing" },
  { id: "emp", login: "TEST-INSPECT-EMP", role: "Employee", shell: "portal", matrix: "denied" },
]);

const ADMIN_BASE = "/admin/kpis";
const HR_BASE = "/hr/admin/kpis";
const PORTAL_BASE = "/employee-portals/kpis";

/** Where a persona's board lives. */
export function basePathFor(persona) {
  if (persona.shell === "admin") return ADMIN_BASE;
  if (persona.shell === "hr") return HR_BASE;
  return PORTAL_BASE;
}

/**
 * The states. `shells` says which boards have the state (the portal splits Call Rate, Coverage and
 * Frequency onto their own pages; the admin board holds them as ?tab=). `path` is relative to the
 * persona's base. `query` never carries a person: `rep=` drill-downs take the FIRST rep link the page
 * itself offers (`followFirst`), so no id is written here or in the manifest.
 */
const month = { month: FULL_MONTH };
export const STATES = Object.freeze([
  // The landing state of each board.
  { id: "summary", label: "Summary, August 2026", shells: ["admin", "hr", "portal"], path: "", query: month, landing: true },
  // Admin tabs.
  ...["call-rate", "coverage", "frequency", "am-pm", "pharmacies", "weekly"].map((tab) => ({
    id: `tab-${tab}`,
    label: `${tab} tab, August 2026`,
    shells: tab === "am-pm" || tab === "pharmacies" || tab === "weekly" ? ["admin", "hr", "portal"] : ["admin", "hr"],
    path: "",
    query: { ...month, tab },
  })),
  // Portal report pages (the admin board's call-rate / coverage / frequency tabs).
  ...["call-rate", "coverage", "frequency"].map((report) => ({
    id: `report-${report}`,
    label: `${report} report page, August 2026`,
    shells: ["portal"],
    path: `/${report}`,
    query: month,
  })),
  { id: "call-rate-am", label: "Call Rate, AM view", shells: ["admin", "hr"], path: "", query: { ...month, tab: "call-rate", view: "am" } },
  { id: "call-rate-pm", label: "Call Rate, PM view", shells: ["admin", "hr"], path: "", query: { ...month, tab: "call-rate", view: "pm" } },
  { id: "report-call-rate-am", label: "Call Rate report, AM view", shells: ["portal"], path: "/call-rate", query: { ...month, view: "am" } },
  { id: "weekly-quarter", label: "Weekly tab by quarter, coverage", shells: ["admin", "hr", "portal"], path: "", query: { ...month, tab: "weekly", trend: "quarter", measure: "coverage" } },
  { id: "period-week-1", label: "Summary, first week of August", shells: ["admin", "hr", "portal"], path: "", query: { ...month, period: "w1" } },
  { id: "sorted-coverage-desc", label: "Summary sorted by coverage, highest first", shells: ["admin", "hr", "portal"], path: "", query: { ...month, sort: "coverage", dir: "desc" } },
  { id: "filter-band-behind", label: "Summary filtered to the 'behind' coverage band", shells: ["admin", "hr", "portal"], path: "", query: { ...month, cov: "behind" } },
  { id: "search-no-match", label: "Summary searched for a name that matches nobody", shells: ["admin", "hr", "portal"], path: "", query: { ...month, q: "zzqx" } },
  { id: "empty-month", label: "Summary, November 2026 (no visits on staging)", shells: ["admin", "hr", "portal"], path: "", query: { month: EMPTY_MONTH } },
  // Drill-downs: the page's own first rep link, never a typed id.
  { id: "coverage-rep-open", label: "Coverage tab with one rep's doctor list open", shells: ["admin", "hr"], path: "", query: { ...month, tab: "coverage" }, followFirst: 'a[href*="rep="]' },
  { id: "call-rate-rep", label: "One rep's call-rate page", shells: ["admin", "hr"], path: "", query: { ...month, tab: "call-rate" }, followFirst: 'a[href*="/kpis/call-rate/"]' },
  { id: "report-call-rate-rep", label: "One rep's call-rate page (portal)", shells: ["portal"], path: "/call-rate", query: month, followFirst: 'a[href*="/kpis/call-rate/"]' },
  // Clicks (each target passes classifyControl before it is clicked).
  { id: "advanced-filters-open", label: "Advanced filters panel open", shells: ["admin", "hr", "portal"], path: "", query: month, click: { selector: 'button[aria-expanded="false"]', nameIncludes: "Advanced filters" } },
  { id: "row-detail-open", label: "A table row's detail panel open (Coverage)", shells: ["admin", "hr"], path: "", query: { ...month, tab: "coverage" }, click: { selector: 'tbody [aria-controls][aria-expanded="false"]' } },
  { id: "keyboard-focus", label: "Keyboard focus after eight Tab presses", shells: ["admin", "hr", "portal"], path: "", query: month, keyboard: { presses: 8 } },
  // Mocked states (labelled mock in the manifest; the server is never asked to fail).
  { id: "mock-loading", label: "Loading state (the page's own loading.tsx, response held)", shells: ["portal"], path: "", query: month, mock: "loading" },
  { id: "mock-error", label: "Server error on navigation (response replaced with a 500)", shells: ["admin", "hr", "portal"], path: "", query: month, mock: "error" },
]);

/** Controls the explorer must never click, whatever a state says. Checked before every click. */
export const NEVER_TOUCH = Object.freeze([
  { selector: 'a[href*="/api/crm/kpis-export"]', reason: "Export XLSX: writes an audit row, spends rate-limit budget and downloads real data" },
  { selector: "a[download]", reason: "any download" },
  { selector: 'button[type="submit"], input[type="submit"]', reason: "form submit (Apply ranges, the doctor filter's Send)" },
]);

/** Source files whose string literals are kept unmasked, and whose literals map shots to files. */
export const SOURCE_FILES = Object.freeze([
  "app/(admin)/admin/kpis/page.tsx",
  "app/(admin)/admin/kpis/call-rate/[rep]/page.tsx",
  "app/employee-portals/kpis/page.tsx",
  "app/employee-portals/kpis/loading.tsx",
  "app/employee-portals/kpis/call-rate/page.tsx",
  "app/employee-portals/kpis/call-rate/[rep]/page.tsx",
  "app/employee-portals/kpis/coverage/page.tsx",
  "app/employee-portals/kpis/frequency/page.tsx",
  "src/components/crm/kpis-board-view.tsx",
  "src/components/crm/kpis-chrome.tsx",
  "src/components/crm/kpis-filter-bar.tsx",
  "src/components/crm/kpis-period-picker.tsx",
  "src/components/crm/kpis-doctor-filter-bar.tsx",
  "src/components/crm/kpis-trend-view.tsx",
  "src/components/crm/kpi-reports-tables.tsx",
  "src/components/crm/kpi-coverage-panels.tsx",
  "src/components/crm/kpi-coverage-rep-panels.tsx",
  "src/components/crm/kpi-frequency-panels.tsx",
  "src/components/crm/kpi-frequency-rep-panels.tsx",
  "src/components/crm/portal-kpi-report-page.tsx",
  "src/components/ui/table-row-detail.tsx",
  "src/lib/crm/kpis-tabs.ts",
  "src/lib/crm/kpis-filters.ts",
  "src/lib/crm/kpis-trend-options.ts",
  "src/config/system-navigation.ts",
  "src/components/employee-portal/employee-portal-layout.tsx",
  "src/components/layout/app-shell.tsx",
]);

export const KPIS_MODULE = Object.freeze({
  id: "kpi-reports",
  title: "KPIs board (the KPI reports: Summary, Call Rate, Coverage, Frequency, AM · PM, Pharmacies, Weekly)",
  personas: PERSONAS,
  states: STATES,
  neverTouch: NEVER_TOUCH,
  sourceFiles: SOURCE_FILES,
  basePathFor,
});

/** The states a persona walks, by its matrix. */
export function statesFor(persona) {
  const shell = persona.shell;
  const mine = STATES.filter((state) => state.shells.includes(shell));
  if (persona.matrix === "full") return mine;
  if (persona.matrix === "denied") return mine.filter((state) => state.landing);
  return mine.filter((state) => state.landing);
}

/** Viewports a persona's state is captured at. */
export function viewportsFor(persona, state) {
  if (persona.matrix === "full") {
    if (state.mock || state.keyboard || state.click) return ["desktop", "mobile"];
    return ["desktop", "tablet", "mobile"];
  }
  return ["desktop", "mobile"];
}

/** The address of a state for a persona, query in the source's own parameter names. */
export function addressFor(persona, state) {
  const query = new URLSearchParams(state.query ?? {}).toString();
  return `${basePathFor(persona)}${state.path ?? ""}${query ? `?${query}` : ""}`;
}
