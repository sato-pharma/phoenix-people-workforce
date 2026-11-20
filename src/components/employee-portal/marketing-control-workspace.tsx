"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { RefreshCcw, Save } from "lucide-react";

import {
  LANDING_FOCUS,
  LANDING_INK,
  LandingMeta,
  LandingRailLine,
  LandingTitle,
  landingActionClassName,
} from "@/components/employee-portal/landing-kit";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
} from "@/components/employee-portal/portal-primitives";
import { phxButtonPrimaryClassName, phxLabelClassName, phxLabelTextClassName } from "@/components/ui/form-tokens";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";
import type {
  MarketingControlSetting,
  MarketingControlWorkspace,
  MarketingRequestType,
  MarketingWorkflowApprovalScope,
  MarketingWorkflowStep,
} from "@/lib/marketing-requests/types";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";


function emptyWorkspace(): MarketingControlWorkspace {
  return {
    canManageValidationRules: false,
    requestTypes: [],
    settings: [],
    workflowSteps: [],
  };
}

function Field({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <label className="block min-w-0">
      <span className={phxLabelClassName}>{label}</span>
      {children}
    </label>
  );
}

function SelectField({
  children,
  onChange,
  value,
}: {
  children: ReactNode;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <SearchableSelect
      className="w-full px-3"
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {children}
    </SearchableSelect>
  );
}

/** On/off switch: square, navy when on, slate when off — never an orange fill. */
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={checked}
      className={cn(
        "relative h-7 w-12 shrink-0 border transition-colors motion-reduce:transition-none",
        LANDING_FOCUS,
        checked ? "border-[#08111f] bg-[#08111f]" : "border-slate-300 bg-slate-200",
      )}
      onClick={() => onChange(!checked)}
      type="button"
    >
      <span
        aria-hidden="true"
        className={`absolute top-1 h-5 w-5 bg-white transition-[left] motion-reduce:transition-none ${
          checked ? "left-6" : "left-1"
        }`}
      />
    </button>
  );
}

/** The form kit's primary Save, sized for a table cell or a phone row. */
const SAVE_BUTTON_CLASS = cn(phxButtonPrimaryClassName, "justify-center px-3 motion-reduce:transition-none", LANDING_FOCUS);

/** A state in small coloured capitals — the kit's replacement for a filled pill. */
function ActiveState({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        "whitespace-nowrap text-phx-xs font-bold uppercase tracking-[0.08em]",
        active ? "text-emerald-700" : "text-slate-500",
      )}
    >
      {active ? "Active" : "Inactive"}
    </span>
  );
}

/** White small-capital column heads, as on every portal table. */
const TABLE_HEAD_CELL = "px-3 py-2.5 text-left text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500";

/** A table row: hairline, top-aligned, slate on hover. */
const TABLE_ROW = "align-top transition-colors hover:bg-slate-50 motion-reduce:transition-none";

function settingNumber(setting: MarketingControlSetting | undefined, key: string, fallback: number) {
  const value = setting?.value?.[key];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : String(fallback);
}

function settingBoolean(setting: MarketingControlSetting | undefined, key: string, fallback: boolean) {
  const value = setting?.value?.[key];
  return typeof value === "boolean" ? value : fallback;
}

function settingUpdatedLabel(setting: MarketingControlSetting | undefined) {
  if (!setting) return "Not configured";
  const updated = new Date(setting.updatedAt);
  if (Number.isNaN(updated.getTime())) return "Not configured";
  // Cairo time on a 24-hour clock, built by the stable formatter so the server and the browser
  // write the same bytes (the browser-locale call it replaced used the reader's own zone and a 12-hour clock).
  return formatStableEnGb(updated, {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    year: "numeric",
  });
}

/**
 * A section's header: the kit's orange tick and navy small-capital title, with the section's
 * small-capital meta on the right. No icon square and nothing under the title.
 */
function SectionHeader({
  badge,
  title,
}: {
  badge?: string;
  title: string;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-slate-200 px-3 py-2.5 sm:px-4">
      <LandingTitle>{title}</LandingTitle>
      <LandingMeta items={["Marketing Control", badge]} />
    </header>
  );
}

/** The small-capital label over a headline count. */
const FIGURE_LABEL = "break-words text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500";

/** A headline count: navy, tabular, 22px. */
const FIGURE_VALUE = `mt-1 break-words text-[22px] font-bold leading-none tracking-[-0.02em] tabular-nums ${LANDING_INK}`;

type SaveState = {
  key: string;
  message: string;
};

export function MarketingControlWorkspace() {
  const [workspace, setWorkspace] = useState<MarketingControlWorkspace>(emptyWorkspace);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState | null>(null);
  const [requestTypeDrafts, setRequestTypeDrafts] = useState<Record<number, MarketingRequestType>>({});
  const [workflowDrafts, setWorkflowDrafts] = useState<Record<number, MarketingWorkflowStep>>({});
  const [roiMultiplier, setRoiMultiplier] = useState("10");
  const [financeInvoiceDays, setFinanceInvoiceDays] = useState("7");
  const [validationDrafts, setValidationDrafts] = useState<Record<string, boolean>>({});

  async function loadWorkspace() {
    setIsLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/marketing-requests/control", {
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok) {
        setWorkspace(emptyWorkspace());
        setMessage(payload.message ?? "Unable to load marketing controls.");
        return;
      }
      const nextWorkspace: MarketingControlWorkspace = {
        canManageValidationRules: Boolean(payload.canManageValidationRules),
        requestTypes: payload.requestTypes ?? [],
        settings: payload.settings ?? [],
        workflowSteps: payload.workflowSteps ?? [],
      };
      setWorkspace(nextWorkspace);
      setRequestTypeDrafts(Object.fromEntries(nextWorkspace.requestTypes.map((type) => [type.id, type])));
      setWorkflowDrafts(Object.fromEntries(nextWorkspace.workflowSteps.map((step) => [step.id, step])));
      const roiSetting = nextWorkspace.settings.find((setting) => setting.key === "roi_multiplier");
      const financeSetting = nextWorkspace.settings.find((setting) => setting.key === "finance_invoice_deadline_days");
      setRoiMultiplier(settingNumber(roiSetting, "multiplier", 10));
      setFinanceInvoiceDays(settingNumber(financeSetting, "days", 7));
      setValidationDrafts(Object.fromEntries(
        nextWorkspace.settings
          .filter((setting) => setting.group === "validation")
          .map((setting) => [setting.key, settingBoolean(setting, "required", true)]),
      ));
    } catch {
      setWorkspace(emptyWorkspace());
      setMessage("Unable to load marketing controls.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadWorkspace();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const groupedSettings = useMemo(() => {
    return {
      finance: workspace.settings.filter((setting) => setting.group === "finance"),
      roi: workspace.settings.filter((setting) => setting.group === "roi"),
      validation: workspace.settings.filter((setting) => setting.group === "validation"),
    };
  }, [workspace.settings]);

  async function patchControl(body: Record<string, unknown>, successMessage: string) {
    setSaveState({ key: JSON.stringify(body), message: "Saving" });
    setMessage(null);
    try {
      const response = await fetch("/api/marketing-requests/control", {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.message ?? "Unable to save marketing control.");
        return;
      }
      setMessage(successMessage);
      await loadWorkspace();
    } catch {
      setMessage("Unable to save marketing control.");
    } finally {
      setSaveState(null);
    }
  }

  const saving = Boolean(saveState);

  return (
    <div className="@container space-y-6">
      {/* ------ The three counts and Refresh — white tiles on the page, never tiles on a card ------ */}
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <div className={`min-w-0 border border-slate-200 bg-white px-4 py-3 ${adminSoftDepthClassName}`}>
          <p className={FIGURE_LABEL}>Request Types</p>
          <p className={FIGURE_VALUE}>{workspace.requestTypes.length}</p>
        </div>
        <div className={`min-w-0 border border-slate-200 bg-white px-4 py-3 ${adminSoftDepthClassName}`}>
          <p className={FIGURE_LABEL}>Workflow Steps</p>
          <p className={FIGURE_VALUE}>{workspace.workflowSteps.length}</p>
        </div>
        <div className={`min-w-0 border border-slate-200 bg-white px-4 py-3 ${adminSoftDepthClassName}`}>
          <p className={FIGURE_LABEL}>Validation Settings</p>
          <p className={FIGURE_VALUE}>
            {workspace.canManageValidationRules ? groupedSettings.validation.length : "Admin"}
          </p>
        </div>
        <button
          className={landingActionClassName("outline", "h-full min-h-[78px] bg-white sm:min-h-[78px]")}
          onClick={() => void loadWorkspace()}
          type="button"
        >
          {isLoading ? <LoadingSpinner className="h-4 w-4 text-current" /> : <RefreshCcw aria-hidden="true" className="h-4 w-4" />}
          Refresh
        </button>
      </div>

      {message ? (
        <div className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`} role="status">
          <LandingRailLine rail="bg-amber-400">{message}</LandingRailLine>
        </div>
      ) : null}

      <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        <SectionHeader badge={`${workspace.requestTypes.length} types`} title="Request Types" />
        {workspace.requestTypes.length === 0 ? (
          <PortalEmptyState
            message="No request type has been configured yet. Add one to start accepting marketing requests."
            title="No request types"
          />
        ) : null}
        <div className="divide-y divide-slate-200 md:hidden">
          {workspace.requestTypes.map((type) => {
            const draft = requestTypeDrafts[type.id] ?? type;
            return (
              <PortalRecordCard
                accent={draft.active ? "emerald" : "slate"}
                key={`${type.id}-mobile`}
                meta={<span className="font-mono">{type.code}</span>}
                status={<ActiveState active={draft.active} />}
                title={draft.name}
              >
                <div className="grid gap-3">
                  <Field label="Name">
                    <Input
                      onChange={(event) => setRequestTypeDrafts((current) => ({
                        ...current,
                        [type.id]: { ...draft, name: event.target.value },
                      }))}
                      value={draft.name}
                    />
                  </Field>
                  <Field label="Description">
                    <Input
                      onChange={(event) => setRequestTypeDrafts((current) => ({
                        ...current,
                        [type.id]: { ...draft, description: event.target.value },
                      }))}
                      value={draft.description ?? ""}
                    />
                  </Field>
                  <Field label="Sort order">
                    <Input
                      min={0}
                      onChange={(event) => setRequestTypeDrafts((current) => ({
                        ...current,
                        [type.id]: { ...draft, sortOrder: Number(event.target.value || 0) },
                      }))}
                      type="number"
                      value={draft.sortOrder}
                    />
                  </Field>
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                    <label className={`inline-flex items-center gap-2 ${phxLabelTextClassName}`}>
                      Other description
                      <Toggle
                        checked={draft.requiresDescription}
                        label={`Require description for ${draft.name}`}
                        onChange={(checked) => setRequestTypeDrafts((current) => ({
                          ...current,
                          [type.id]: { ...draft, requiresDescription: checked },
                        }))}
                      />
                    </label>
                    <label className={`inline-flex items-center gap-2 ${phxLabelTextClassName}`}>
                      Active
                      <Toggle
                        checked={draft.active}
                        label={`Active status for ${draft.name}`}
                        onChange={(checked) => setRequestTypeDrafts((current) => ({
                          ...current,
                          [type.id]: { ...draft, active: checked },
                        }))}
                      />
                    </label>
                  </div>
                  <button
                    className={cn(SAVE_BUTTON_CLASS, "w-full")}
                    disabled={saving}
                    onClick={() => void patchControl({
                      entity: "request_type",
                      id: type.id,
                      patch: {
                        active: draft.active,
                        description: draft.description,
                        name: draft.name,
                        requiresDescription: draft.requiresDescription,
                        sortOrder: draft.sortOrder,
                      },
                    }, "Request type saved.")}
                    type="button"
                  >
                    <Save aria-hidden="true" className="h-4 w-4" />
                    Save
                  </button>
                </div>
              </PortalRecordCard>
            );
          })}
        </div>
        <PortalDesktopTable
          cols={
            <colgroup>
              <col className="w-[10%]" />
              <col className="w-[20%]" />
              <col className="w-[24%]" />
              <col className="w-[8%]" />
              <col className="w-[14%]" />
              <col className="w-[10%]" />
              <col className="w-[14%]" />
            </colgroup>
          }
        >
            <thead>
              <tr className="border-b border-slate-200">
                <th className={TABLE_HEAD_CELL} scope="col">Code</th>
                <th className={TABLE_HEAD_CELL} scope="col">Name</th>
                <th className={TABLE_HEAD_CELL} scope="col">Description</th>
                <th className={TABLE_HEAD_CELL} scope="col">Sort</th>
                <th className={TABLE_HEAD_CELL} scope="col">Other Description</th>
                <th className={TABLE_HEAD_CELL} scope="col">Active</th>
                <th className={TABLE_HEAD_CELL} scope="col">Save</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              {workspace.requestTypes.map((type) => {
                const draft = requestTypeDrafts[type.id] ?? type;
                return (
                  <tr className={TABLE_ROW} key={type.id}>
                    <td className="min-w-0 break-words px-3 py-3 font-mono text-phx-xs font-bold text-slate-600">{type.code}</td>
                    <td className="px-3 py-3">
                      <Input
                        onChange={(event) => setRequestTypeDrafts((current) => ({
                          ...current,
                          [type.id]: { ...draft, name: event.target.value },
                        }))}
                        value={draft.name}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Input
                        onChange={(event) => setRequestTypeDrafts((current) => ({
                          ...current,
                          [type.id]: { ...draft, description: event.target.value },
                        }))}
                        value={draft.description ?? ""}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Input
                        className="min-w-0"
                        min={0}
                        onChange={(event) => setRequestTypeDrafts((current) => ({
                          ...current,
                          [type.id]: { ...draft, sortOrder: Number(event.target.value || 0) },
                        }))}
                        type="number"
                        value={draft.sortOrder}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Toggle
                        checked={draft.requiresDescription}
                        label={`Require description for ${type.name}`}
                        onChange={(checked) => setRequestTypeDrafts((current) => ({
                          ...current,
                          [type.id]: { ...draft, requiresDescription: checked },
                        }))}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Toggle
                        checked={draft.active}
                        label={`Active status for ${type.name}`}
                        onChange={(checked) => setRequestTypeDrafts((current) => ({
                          ...current,
                          [type.id]: { ...draft, active: checked },
                        }))}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <button
                        className={SAVE_BUTTON_CLASS}
                        disabled={saving}
                        onClick={() => void patchControl({
                          entity: "request_type",
                          id: type.id,
                          patch: {
                            active: draft.active,
                            description: draft.description,
                            name: draft.name,
                            requiresDescription: draft.requiresDescription,
                            sortOrder: draft.sortOrder,
                          },
                        }, "Request type saved.")}
                        type="button"
                      >
                        <Save aria-hidden="true" className="h-4 w-4" />
                        Save
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
        </PortalDesktopTable>
      </section>

      <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        <SectionHeader badge={`${workspace.workflowSteps.length} steps`} title="Approval Workflow" />
        {workspace.workflowSteps.length === 0 ? (
          <PortalEmptyState
            message="No approval step has been configured yet, so a submitted request has nobody to go to."
            title="No workflow steps"
          />
        ) : null}
        <div className="divide-y divide-slate-200 md:hidden">
          {workspace.workflowSteps.map((step) => {
            const draft = workflowDrafts[step.id] ?? step;
            return (
              <PortalRecordCard
                accent={draft.active ? "orange" : "slate"}
                key={`${step.id}-mobile`}
                meta={`Sequence ${draft.sequence}`}
                status={<ActiveState active={draft.active} />}
                title={draft.stepName}
              >
                <div className="grid gap-3">
                  <Field label="Step">
                    <Input
                      onChange={(event) => setWorkflowDrafts((current) => ({
                        ...current,
                        [step.id]: { ...draft, stepName: event.target.value },
                      }))}
                      value={draft.stepName}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Sequence">
                      <Input
                        min={1}
                        onChange={(event) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, sequence: Number(event.target.value || 1) },
                        }))}
                        type="number"
                        value={draft.sequence}
                      />
                    </Field>
                    <Field label="SLA Days">
                      <Input
                        min={0}
                        onChange={(event) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: {
                            ...draft,
                            defaultSlaDays: event.target.value ? Number(event.target.value) : null,
                          },
                        }))}
                        type="number"
                        value={draft.defaultSlaDays ?? ""}
                      />
                    </Field>
                  </div>
                  <Field label="Scope">
                    <SelectField
                      onChange={(value) => setWorkflowDrafts((current) => ({
                        ...current,
                        [step.id]: { ...draft, approvalScope: value as MarketingWorkflowApprovalScope },
                      }))}
                      value={draft.approvalScope}
                    >
                      <option value="direct_manager">Direct manager</option>
                      <option value="role">Role</option>
                      <option value="finance">Finance</option>
                      <option value="final">Final</option>
                    </SelectField>
                  </Field>
                  <Field label="Assigned Role">
                    <Input
                      onChange={(event) => setWorkflowDrafts((current) => ({
                        ...current,
                        [step.id]: { ...draft, assignedRole: event.target.value },
                      }))}
                      value={draft.assignedRole}
                    />
                  </Field>
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                    <label className={`inline-flex items-center gap-2 ${phxLabelTextClassName}`}>
                      Required
                      <Toggle
                        checked={draft.required}
                        label={`Required for ${draft.stepName}`}
                        onChange={(checked) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, required: checked },
                        }))}
                      />
                    </label>
                    <label className={`inline-flex items-center gap-2 ${phxLabelTextClassName}`}>
                      Active
                      <Toggle
                        checked={draft.active}
                        label={`Active status for ${draft.stepName}`}
                        onChange={(checked) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, active: checked },
                        }))}
                      />
                    </label>
                  </div>
                  <button
                    className={cn(SAVE_BUTTON_CLASS, "w-full")}
                    disabled={saving}
                    onClick={() => void patchControl({
                      entity: "workflow_step",
                      id: step.id,
                      patch: {
                        active: draft.active,
                        approvalScope: draft.approvalScope,
                        assignedRole: draft.assignedRole,
                        defaultSlaDays: draft.defaultSlaDays,
                        required: draft.required,
                        sequence: draft.sequence,
                        stepName: draft.stepName,
                      },
                    }, "Workflow step saved.")}
                    type="button"
                  >
                    <Save aria-hidden="true" className="h-4 w-4" />
                    Save
                  </button>
                </div>
              </PortalRecordCard>
            );
          })}
        </div>
        <PortalDesktopTable
          cols={
            <colgroup>
              <col className="w-[8%]" />
              <col className="w-[20%]" />
              <col className="w-[15%]" />
              <col className="w-[17%]" />
              <col className="w-[10%]" />
              <col className="w-[10%]" />
              <col className="w-[8%]" />
              <col className="w-[12%]" />
            </colgroup>
          }
        >
            <thead>
              <tr className="border-b border-slate-200">
                <th className={TABLE_HEAD_CELL} scope="col">Seq</th>
                <th className={TABLE_HEAD_CELL} scope="col">Step</th>
                <th className={TABLE_HEAD_CELL} scope="col">Scope</th>
                <th className={TABLE_HEAD_CELL} scope="col">Assigned Role</th>
                <th className={TABLE_HEAD_CELL} scope="col">SLA Days</th>
                <th className={TABLE_HEAD_CELL} scope="col">Required</th>
                <th className={TABLE_HEAD_CELL} scope="col">Active</th>
                <th className={TABLE_HEAD_CELL} scope="col">Save</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              {workspace.workflowSteps.map((step) => {
                const draft = workflowDrafts[step.id] ?? step;
                return (
                  <tr className={TABLE_ROW} key={step.id}>
                    <td className="px-3 py-3">
                      <Input
                        className="min-w-0"
                        min={1}
                        onChange={(event) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, sequence: Number(event.target.value || 1) },
                        }))}
                        type="number"
                        value={draft.sequence}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Input
                        onChange={(event) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, stepName: event.target.value },
                        }))}
                        value={draft.stepName}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <SelectField
                        onChange={(value) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, approvalScope: value as MarketingWorkflowApprovalScope },
                        }))}
                        value={draft.approvalScope}
                      >
                        <option value="direct_manager">Direct manager</option>
                        <option value="role">Role</option>
                        <option value="finance">Finance</option>
                        <option value="final">Final</option>
                      </SelectField>
                    </td>
                    <td className="px-3 py-3">
                      <Input
                        onChange={(event) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, assignedRole: event.target.value },
                        }))}
                        value={draft.assignedRole}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Input
                        className="min-w-0"
                        min={0}
                        onChange={(event) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: {
                            ...draft,
                            defaultSlaDays: event.target.value ? Number(event.target.value) : null,
                          },
                        }))}
                        type="number"
                        value={draft.defaultSlaDays ?? ""}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Toggle
                        checked={draft.required}
                        label={`Required for ${step.stepName}`}
                        onChange={(checked) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, required: checked },
                        }))}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Toggle
                        checked={draft.active}
                        label={`Active status for ${step.stepName}`}
                        onChange={(checked) => setWorkflowDrafts((current) => ({
                          ...current,
                          [step.id]: { ...draft, active: checked },
                        }))}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <button
                        className={SAVE_BUTTON_CLASS}
                        disabled={saving}
                        onClick={() => void patchControl({
                          entity: "workflow_step",
                          id: step.id,
                          patch: {
                            active: draft.active,
                            approvalScope: draft.approvalScope,
                            assignedRole: draft.assignedRole,
                            defaultSlaDays: draft.defaultSlaDays,
                            required: draft.required,
                            sequence: draft.sequence,
                            stepName: draft.stepName,
                          },
                        }, "Workflow step saved.")}
                        type="button"
                      >
                        <Save aria-hidden="true" className="h-4 w-4" />
                        Save
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
        </PortalDesktopTable>
      </section>

      <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        <SectionHeader title="ROI And Finance Rules" />
        {/* Two rules side by side on a hairline — never two tinted boxes inside the panel. */}
        <div className="grid divide-y divide-slate-200 @3xl:grid-cols-2 @3xl:divide-x @3xl:divide-y-0">
          <div className="min-w-0 px-3 py-4 sm:px-4">
            <Field label="ROI multiplier">
              <Input
                className="text-base"
                min={1}
                onChange={(event) => setRoiMultiplier(event.target.value)}
                type="number"
                value={roiMultiplier}
              />
            </Field>
            <p className="mt-3 break-words text-phx-xs font-semibold tabular-nums text-slate-500">
              Updated: {settingUpdatedLabel(groupedSettings.roi.find((setting) => setting.key === "roi_multiplier"))}
            </p>
            <button
              className={cn(SAVE_BUTTON_CLASS, "mt-4")}
              disabled={saving}
              onClick={() => void patchControl({
                entity: "setting",
                settingKey: "roi_multiplier",
                value: { multiplier: Number(roiMultiplier || 0) },
              }, "ROI rule saved.")}
              type="button"
            >
              <Save aria-hidden="true" className="h-4 w-4" />
              Save ROI
            </button>
          </div>

          <div className="min-w-0 px-3 py-4 sm:px-4">
            <Field label="Invoice deadline days">
              <Input
                className="text-base"
                min={1}
                onChange={(event) => setFinanceInvoiceDays(event.target.value)}
                type="number"
                value={financeInvoiceDays}
              />
            </Field>
            <p className="mt-3 break-words text-phx-xs font-semibold tabular-nums text-slate-500">
              Updated: {settingUpdatedLabel(groupedSettings.finance.find((setting) => setting.key === "finance_invoice_deadline_days"))}
            </p>
            <button
              className={cn(SAVE_BUTTON_CLASS, "mt-4")}
              disabled={saving}
              onClick={() => void patchControl({
                entity: "setting",
                settingKey: "finance_invoice_deadline_days",
                value: { days: Number(financeInvoiceDays || 0) },
              }, "Finance rule saved.")}
              type="button"
            >
              <Save aria-hidden="true" className="h-4 w-4" />
              Save Finance
            </button>
          </div>
        </div>
      </section>

      <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        <SectionHeader
          badge={workspace.canManageValidationRules ? `${groupedSettings.validation.length} rules` : "Admin only"}
          title="Validation Settings"
        />
        {workspace.canManageValidationRules ? (
          <div className="divide-y divide-slate-200">
            {groupedSettings.validation.map((setting) => (
              <div
                className="grid items-center gap-3 px-3 py-3 sm:px-4 @2xl:grid-cols-[minmax(0,1fr)_auto_auto] @2xl:gap-4"
                key={setting.key}
              >
                <div className="min-w-0">
                  <p className={`break-words text-phx-sm font-bold ${LANDING_INK}`}>{setting.label}</p>
                  <p className="mt-1 break-words text-phx-xs font-semibold tabular-nums text-slate-500">Updated: {settingUpdatedLabel(setting)}</p>
                </div>
                <Toggle
                  checked={validationDrafts[setting.key] ?? settingBoolean(setting, "required", true)}
                  label={setting.label}
                  onChange={(checked) => setValidationDrafts((current) => ({
                    ...current,
                    [setting.key]: checked,
                  }))}
                />
                <button
                  className={SAVE_BUTTON_CLASS}
                  disabled={saving}
                  onClick={() => void patchControl({
                    entity: "setting",
                    settingKey: setting.key,
                    value: { required: validationDrafts[setting.key] ?? settingBoolean(setting, "required", true) },
                  }, "Validation setting saved.")}
                  type="button"
                >
                  <Save aria-hidden="true" className="h-4 w-4" />
                  Save
                </button>
              </div>
            ))}
          </div>
        ) : (
          <LandingRailLine rail="bg-slate-300">Validation settings are available to Super Admin only.</LandingRailLine>
        )}
      </section>
    </div>
  );
}
