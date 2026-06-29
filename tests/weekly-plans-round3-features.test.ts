import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

export function runWeeklyPlansRound3FeaturesTests() {
  const serviceSource = readFileSync("src/lib/weekly-planning/service.ts", "utf8");
  const workspaceSource = readFileSync("src/components/employee-portal/plans-workspace.tsx", "utf8");
  const privateCalExportSource = readFileSync("src/lib/private-calendar/export.ts", "utf8");
  const dialogA11ySource = readFileSync("src/components/ui/use-dialog-a11y.ts", "utf8");
  const batchRouteSource = readFileSync("app/api/weekly-plans/decisions/batch/route.ts", "utf8");
  const calExportRouteSource = readFileSync("app/api/private-calendar/export/route.ts", "utf8");
  const accessRegistrySource = readFileSync("src/lib/security/access-registry.ts", "utf8");

  // ── F1: Manager bulk approve ──────────────────────────────────────────────

  assert.match(
    serviceSource,
    /export async function bulkDecideEmployeePlans/,
    "service must export bulkDecideEmployeePlans",
  );
  assert.match(
    serviceSource,
    /action: "manager_approve"/,
    "bulkDecideEmployeePlans must only accept manager_approve",
  );
  assert.match(
    serviceSource,
    /results\.push\(\{ ok: true, planId \}\)/,
    "bulkDecideEmployeePlans must push ok:true result per plan",
  );
  assert.match(
    serviceSource,
    /ok: false/,
    "bulkDecideEmployeePlans must return ok:false on per-plan failure",
  );
  assert.match(
    batchRouteSource,
    /bulkDecideEmployeePlans/,
    "batch route must call bulkDecideEmployeePlans",
  );
  assert.match(
    batchRouteSource,
    /action.*!==.*"manager_approve"/,
    "batch route must reject actions other than manager_approve",
  );
  assert.match(
    accessRegistrySource,
    /\/api\/weekly-plans\/decisions\/batch/,
    "batch route must be registered in access-registry",
  );
  assert.match(
    workspaceSource,
    /doBulkApprove|bulkApprove/i,
    "plans workspace must expose a bulk approve action",
  );
  assert.match(
    workspaceSource,
    /selectedIds/,
    "plans workspace must track selected plan IDs for bulk action",
  );

  // ── F2: Private calendar export ───────────────────────────────────────────

  assert.match(
    privateCalExportSource,
    /export.*async function buildPrivateCalendarWorkbook/,
    "export module must export buildPrivateCalendarWorkbook",
  );
  assert.match(
    privateCalExportSource,
    /export.*async function buildPrivateCalendarPdf/,
    "export module must export buildPrivateCalendarPdf",
  );
  assert.match(
    privateCalExportSource,
    /Calendar/,
    "XLSX workbook must include a Calendar sheet",
  );
  assert.match(
    privateCalExportSource,
    /Exceptions/,
    "XLSX workbook must include an Exceptions sheet",
  );
  assert.match(
    privateCalExportSource,
    /Summary/,
    "XLSX workbook must include a Summary sheet",
  );
  assert.match(
    privateCalExportSource,
    /pdf-lib/,
    "PDF builder must use pdf-lib",
  );
  assert.match(
    calExportRouteSource,
    /buildPrivateCalendarWorkbook/,
    "export route must call buildPrivateCalendarWorkbook",
  );
  assert.match(
    calExportRouteSource,
    /buildPrivateCalendarPdf/,
    "export route must call buildPrivateCalendarPdf",
  );
  assert.match(
    calExportRouteSource,
    /application\/vnd\.openxmlformats/,
    "export route must set XLSX content-type",
  );
  assert.match(
    calExportRouteSource,
    /application\/pdf/,
    "export route must set PDF content-type",
  );
  assert.match(
    accessRegistrySource,
    /\/api\/private-calendar\/export/,
    "private-calendar export route must be registered in access-registry",
  );

  // ── F5: Decision-history timeline ─────────────────────────────────────────

  assert.match(
    serviceSource,
    /employee_plan_decisions/,
    "planSelect must include employee_plan_decisions",
  );
  assert.match(
    serviceSource,
    /decisions.*EmployeePlanDecision\[\]|EmployeePlanDecision\[\].*decisions/,
    "EmployeePlan type must carry a decisions array",
  );
  assert.match(
    serviceSource,
    /\.sort\(.*a.*b.*createdAt|createdAt.*localeCompare/,
    "decisions must be sorted ascending by createdAt",
  );
  assert.match(
    serviceSource,
    /export.*type EmployeePlanDecision/,
    "service must export the EmployeePlanDecision type",
  );
  assert.match(
    workspaceSource,
    /PlanDecisionTimeline/,
    "plans workspace must render PlanDecisionTimeline",
  );
  assert.match(
    workspaceSource,
    /\.decisions/,
    "plans workspace must read .decisions from the plan object",
  );

  // ── F4: Draft autosave ────────────────────────────────────────────────────

  assert.match(
    workspaceSource,
    /phoenix:plan-draft/,
    "draft autosave must use the phoenix:plan-draft localStorage key prefix",
  );
  assert.match(
    workspaceSource,
    /DRAFT_VERSION/,
    "draft key must include a version constant so old keys can be ignored on schema changes",
  );
  assert.match(
    workspaceSource,
    /localStorage\.setItem/,
    "draft autosave must persist to localStorage",
  );
  assert.match(
    workspaceSource,
    /localStorage\.getItem/,
    "draft autosave must restore from localStorage",
  );
  assert.match(
    workspaceSource,
    /localStorage\.removeItem/,
    "draft autosave must clear localStorage on save/submit",
  );
  assert.match(
    workspaceSource,
    /discardDraft/,
    "plans workspace must define a discardDraft function",
  );
  assert.match(
    workspaceSource,
    /Discard draft/i,
    "plans workspace must render a Discard draft button",
  );
  assert.match(
    workspaceSource,
    /draftSavedAt/,
    "plans workspace must track draft saved timestamp",
  );

  // ── F6: Notification gaps (acknowledge → employee, cancel → manager) ──────

  assert.match(
    serviceSource,
    /async function notifyEmployeeAcknowledged/,
    "service must define notifyEmployeeAcknowledged helper",
  );
  assert.match(
    serviceSource,
    /notifyEmployeeAcknowledged\(/,
    "acknowledgeEmployeePlan must call notifyEmployeeAcknowledged",
  );
  assert.match(
    serviceSource,
    /hr_acknowledge/,
    "acknowledge notification must use hr_acknowledge event type",
  );
  assert.match(
    serviceSource,
    /cancelEmployeePlan[\s\S]{0,800}notifyManager|notifyManager[\s\S]{0,400}cancelEmployeePlan/,
    "cancelEmployeePlan must wire manager notification",
  );

  // ── F7: Accessibility — useDialogA11y ─────────────────────────────────────

  assert.match(
    dialogA11ySource,
    /export function useDialogA11y/,
    "use-dialog-a11y must export useDialogA11y",
  );
  assert.match(
    dialogA11ySource,
    /event\.key === "Escape"/,
    "useDialogA11y must handle ESC key",
  );
  assert.match(
    dialogA11ySource,
    /event\.key === "Tab"/,
    "useDialogA11y must implement Tab focus trap",
  );
  assert.match(
    dialogA11ySource,
    /returnFocusRef/,
    "useDialogA11y must capture return-focus target",
  );
  assert.match(
    dialogA11ySource,
    /document\.body\.style\.overflow\s*=\s*"hidden"/,
    "useDialogA11y must lock body scroll when open",
  );
  assert.match(
    dialogA11ySource,
    /document\.body\.style\.overflow\s*=\s*previousOverflow/,
    "useDialogA11y must restore body scroll on cleanup",
  );
  assert.match(
    workspaceSource,
    /role="dialog"/,
    "plans workspace dialogs must have role=dialog",
  );
  assert.match(
    workspaceSource,
    /aria-modal="true"/,
    "plans workspace dialogs must have aria-modal",
  );
  assert.match(
    workspaceSource,
    /aria-label="Close"/,
    "icon-only close buttons must have aria-label=Close",
  );

  // ── F8: List virtualization ────────────────────────────────────────────────

  assert.match(
    workspaceSource,
    /useVirtualizer/,
    "plans workspace must use useVirtualizer from @tanstack/react-virtual",
  );
  assert.match(
    workspaceSource,
    /threshold.*40|40.*threshold/,
    "VirtualList must activate only above the 40-item threshold",
  );
  assert.match(
    workspaceSource,
    /overscan.*5|5.*overscan/,
    "VirtualList must use overscan of 5 for smooth scroll",
  );
  assert.match(
    workspaceSource,
    /VirtualList/,
    "plans workspace must define or import a VirtualList helper",
  );
}
