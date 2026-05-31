"use client";

import { Check, ChevronLeft, ChevronRight, Eye, History, Mail, RotateCcw, Save, Send } from "lucide-react";
import type { DragEvent, ReactNode } from "react";
import { useMemo, useState, useTransition } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  adminPanelClassName,
  adminSoftPanelClassName,
} from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { EmailTemplateRecipientRole, EmailTemplateRow } from "@/lib/email-templates/service";
import { cn } from "@/lib/utils";

type RoutingOptions = {
  lines: string[];
  recipientRoles: Array<{ label: string; value: EmailTemplateRecipientRole }>;
  titles: string[];
};

type DesignerVariable = {
  allowedTemplateTypes: string[];
  category: string;
  label: string;
  sampleValue: string;
  token: string;
};

type DesignerPreset = {
  description: string;
  key: string;
  label: string;
  role: EmailTemplateRecipientRole;
};

type ValidationIssue = {
  field: string;
  message: string;
  severity: "error" | "warning";
  token?: string;
};

type SimulationRecipient = {
  email: string;
  name?: string | null;
};

type ValidationState = {
  duplicateRecipientsRemoved: number;
  issues: ValidationIssue[];
  isReadyToPublish: boolean;
  preview: PreviewState;
  simulation: {
    bcc: SimulationRecipient[];
    cc: SimulationRecipient[];
    diagnostics: {
      duplicateRecipientsRemoved: number;
      finalRecipientCount: number;
      rawRecipientCount: number;
    };
    to: SimulationRecipient[];
    warnings: string[];
  };
};

type PreviewState = {
  html: string;
  previewText: string;
  subject: string;
  text: string;
};

type HistoryEntry = {
  action: string;
  changedAt: string;
  changedBy: string | null;
  reason: string | null;
  versionNumber: number;
};

type Props = {
  initialPlaceholderHints: string[];
  initialRoutingOptions: RoutingOptions;
  initialTemplates: EmailTemplateRow[];
  templateReadiness: {
    activeTemplates: number;
    missingBody: number;
    missingRecipients: number;
    missingSubject: number;
    readinessRate: number;
    readyTemplates: number;
    totalTemplates: number;
  };
};

const steps = ["Choose Email", "Edit Content", "Choose Recipients", "Review & Publish"] as const;
const presetRoles: Record<string, EmailTemplateRecipientRole> = {
  candidate: "candidate",
  direct_manager: "direct_manager",
  employee: "employee",
  finance_team: "finance",
  hr_team: "hr",
  manager_chain: "manager_chain",
};

const fallbackVariables: DesignerVariable[] = [
  { allowedTemplateTypes: [], category: "Employee", label: "Employee Name", sampleValue: "Mariam Adel", token: "employeeName" },
  { allowedTemplateTypes: [], category: "Employee", label: "Employee HR ID", sampleValue: "PHX-1024", token: "employeeHrId" },
  { allowedTemplateTypes: [], category: "Manager", label: "Manager Name", sampleValue: "Omar Nabil", token: "managerName" },
  { allowedTemplateTypes: [], category: "Candidate", label: "Candidate Name", sampleValue: "Ahmed Hassan", token: "candidateName" },
  { allowedTemplateTypes: [], category: "Company", label: "Summary", sampleValue: "A workflow update needs review.", token: "summary" },
  { allowedTemplateTypes: [], category: "Company", label: "Status", sampleValue: "Pending", token: "status" },
];

function cloneTemplate(template: EmailTemplateRow): EmailTemplateRow {
  return {
    ...template,
    rules: {
      bccRoles: [...template.rules.bccRoles],
      bccStaticEmails: [...template.rules.bccStaticEmails],
      ccRoles: [...template.rules.ccRoles],
      ccStaticEmails: [...template.rules.ccStaticEmails],
      targetLines: [...template.rules.targetLines],
      targetTitles: [...template.rules.targetTitles],
      toRoles: [...template.rules.toRoles],
      toStaticEmails: [...template.rules.toStaticEmails],
    },
  };
}

function parseLines(value: string) {
  return Array.from(new Set(value.split(/[\n,;]/).map((item) => item.trim()).filter(Boolean)));
}

function emailText(values: string[]) {
  return values.join("\n");
}

function templatePayload(template: EmailTemplateRow) {
  return {
    bodyHtml: template.bodyHtml,
    bodyText: template.bodyText,
    closingText: template.closingText,
    description: template.description,
    greeting: template.greeting,
    isActive: template.isActive,
    previewText: template.previewText,
    rules: template.rules,
    subject: template.subject,
    templateName: template.templateName,
  };
}

function applyFormat(value: string, format: "bold" | "button" | "divider" | "italic" | "link" | "list" | "paragraph") {
  if (format === "bold") return `${value}<strong>Important text</strong>`;
  if (format === "italic") return `${value}<em>Helpful note</em>`;
  if (format === "list") return `${value}<ul><li>First point</li><li>Second point</li></ul>`;
  if (format === "link") return `${value}<a href="https://phoenix.example.com">Link text</a>`;
  if (format === "button") return `${value}<p><a href="{{ctaUrl}}">{{ctaLabel}}</a></p>`;
  if (format === "divider") return `${value}<hr />`;
  return `${value}<p>New paragraph</p>`;
}

export function EmailTemplateManager({
  initialRoutingOptions,
  initialTemplates,
  templateReadiness,
}: Props) {
  const firstTemplate = initialTemplates[0];
  const [templates, setTemplates] = useState(initialTemplates);
  const [draft, setDraft] = useState<EmailTemplateRow | null>(() => firstTemplate ? cloneTemplate(firstTemplate) : null);
  const [step, setStep] = useState(0);
  const [activeField, setActiveField] = useState<"bodyHtml" | "bodyText" | "closingText" | "greeting" | "previewText" | "subject">("bodyHtml");
  const [variables, setVariables] = useState<DesignerVariable[]>(fallbackVariables);
  const [presets, setPresets] = useState<DesignerPreset[]>([]);
  const [metadataLoaded, setMetadataLoaded] = useState(false);
  const [validation, setValidation] = useState<ValidationState | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [changeReason, setChangeReason] = useState("");
  const [restoreReason, setRestoreReason] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [sampleEmployeeHrId, setSampleEmployeeHrId] = useState("");
  const [sampleCandidateEmail, setSampleCandidateEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const templateVariables = useMemo(() => {
    if (!draft) return variables;
    return variables.filter((variable) => variable.allowedTemplateTypes.length === 0 || variable.allowedTemplateTypes.includes(draft.templateKey));
  }, [draft, variables]);
  const issues = validation?.issues ?? [];
  const canPublish = Boolean(validation?.isReadyToPublish && changeReason.trim().length >= 10);

  function loadDesignerMetadata() {
    if (metadataLoaded) return;
    startTransition(async () => {
      const response = await fetch("/api/admin/email-templates/designer-metadata");
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "Email designer metadata failed to load.");
        return;
      }
      setVariables(payload.variables ?? fallbackVariables);
      setPresets(payload.recipientPresets ?? []);
      setMetadataLoaded(true);
    });
  }

  function selectTemplate(template: EmailTemplateRow) {
    setDraft(cloneTemplate(template));
    setStep(1);
    setValidation(null);
    setHistory([]);
    setMessage(null);
    setError(null);
    setChangeReason("");
    setRestoreReason("");
    loadDesignerMetadata();
  }

  function updateDraft<K extends keyof EmailTemplateRow>(key: K, value: EmailTemplateRow[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setValidation(null);
  }

  function updateRules<K extends keyof EmailTemplateRow["rules"]>(key: K, value: EmailTemplateRow["rules"][K]) {
    setDraft((current) => current ? { ...current, rules: { ...current.rules, [key]: value } } : current);
    setValidation(null);
  }

  function insertVariable(token: string) {
    if (!draft) return;
    const value = String(draft[activeField] ?? "");
    updateDraft(activeField, `${value}{{${token}}}` as EmailTemplateRow[typeof activeField]);
  }

  function dropVariable(event: DragEvent<HTMLTextAreaElement | HTMLInputElement>, field: typeof activeField) {
    event.preventDefault();
    const token = event.dataTransfer.getData("text/plain");
    if (!token || !draft) return;
    const value = String(draft[field] ?? "");
    updateDraft(field, `${value}{{${token}}}` as EmailTemplateRow[typeof field]);
    setActiveField(field);
  }

  function togglePreset(channel: "bccRoles" | "ccRoles" | "toRoles", presetKey: string) {
    const role = presetRoles[presetKey];
    if (!draft || !role) return;
    const current = draft.rules[channel];
    updateRules(channel, current.includes(role) ? current.filter((value) => value !== role) : [...current, role]);
  }

  function presetChecked(channel: "bccRoles" | "ccRoles" | "toRoles", presetKey: string) {
    const role = presetRoles[presetKey];
    return Boolean(draft && role && draft.rules[channel].includes(role));
  }

  function validateDraft() {
    if (!draft) return;
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const response = await fetch("/api/admin/email-templates/validate-draft", {
        body: JSON.stringify({
          candidateEmail: sampleCandidateEmail,
          employeeHrId: sampleEmployeeHrId,
          template: templatePayload(draft),
          templateKey: draft.templateKey,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "Backend validation failed.");
        return;
      }
      setValidation(payload.validation as ValidationState);
      setMessage("Backend validation and preview are ready.");
    });
  }

  function saveTemplate(mode: "draft" | "publish") {
    if (!draft) return;
    setError(null);
    setMessage(null);
    if (mode === "publish" && !canPublish) {
      setError("Run backend validation and add a publish reason of at least 10 characters.");
      return;
    }
    startTransition(async () => {
      const nextDraft = { ...draft, isActive: mode === "publish" };
      const response = await fetch(`/api/admin/email-templates/${encodeURIComponent(draft.templateKey)}`, {
        body: JSON.stringify({
          ...templatePayload(nextDraft),
          action: mode === "publish" ? "publish" : "draft",
          changeReason: changeReason.trim(),
        }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? payload?.issues?.[0]?.message ?? "Email template save failed.");
        return;
      }
      const saved = payload.template as EmailTemplateRow;
      setTemplates((current) => current.map((template) => template.templateKey === saved.templateKey ? saved : template));
      setDraft(cloneTemplate(saved));
      setChangeReason("");
      setValidation(null);
      setMessage(mode === "publish" ? "Template published with backend validation." : "Draft saved safely.");
    });
  }

  function sendTestEmail() {
    if (!draft) return;
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const response = await fetch("/api/admin/email-templates/test", {
        body: JSON.stringify({ template: templatePayload(draft), templateKey: draft.templateKey, to: testEmail }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? payload?.issues?.[0]?.message ?? "Test email failed.");
        return;
      }
      setMessage(payload.result?.skipped ? `Test email skipped: ${payload.result.reason}` : `Test email sent to ${testEmail}.`);
    });
  }

  function loadHistory() {
    if (!draft) return;
    startTransition(async () => {
      const response = await fetch(`/api/admin/email-templates/${encodeURIComponent(draft.templateKey)}/history`);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "History failed to load.");
        return;
      }
      setHistory(payload.history ?? []);
    });
  }

  function restoreTemplate(versionNumber: number) {
    if (!draft) return;
    if (restoreReason.trim().length < 10) {
      setError("Add a restore reason of at least 10 characters.");
      return;
    }
    startTransition(async () => {
      const response = await fetch(`/api/admin/email-templates/${encodeURIComponent(draft.templateKey)}/rollback`, {
        body: JSON.stringify({ changeReason: restoreReason.trim(), versionNumber }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? payload?.issues?.[0]?.message ?? "Restore failed.");
        return;
      }
      const saved = payload.template as EmailTemplateRow;
      setTemplates((current) => current.map((template) => template.templateKey === saved.templateKey ? saved : template));
      setDraft(cloneTemplate(saved));
      setRestoreReason("");
      setValidation(null);
      setMessage(`Template restored to version ${versionNumber}.`);
      loadHistory();
    });
  }

  if (!draft) {
    return (
      <main className="min-h-screen bg-[#F3F6FA] p-6">
        <AdminCallout tone="warning">Email templates are not available. Run the email template migration and refresh.</AdminCallout>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#F3F6FA] px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1500px] space-y-5">
        <AdminPageHero
          actions={
            <>
              <Button className="gap-2 rounded-xl border border-[#CBD5E1] bg-white px-4 py-2.5 font-black text-[#0F172A]" onClick={validateDraft} type="button" variant="secondary">
                <Eye className="h-4 w-4" />
                Backend Preview
              </Button>
              <Button className="gap-2 rounded-xl bg-[#F97316] px-4 py-2.5 font-black text-white" disabled={isPending || !canPublish} onClick={() => saveTemplate("publish")} type="button">
                <Save className="h-4 w-4" />
                Publish
              </Button>
            </>
          }
          badges={
            <div className="flex flex-wrap gap-2">
              <AdminInsightChip>{templateReadiness.readyTemplates}/{templateReadiness.totalTemplates} ready</AdminInsightChip>
              <AdminInsightChip tone="slate">{templateReadiness.activeTemplates} active</AdminInsightChip>
              <AdminInsightChip tone={templateReadiness.missingRecipients > 0 ? "orange" : "slate"}>{templateReadiness.missingRecipients} routing gaps</AdminInsightChip>
            </div>
          }
          description="A guided editor for system emails. The backend still validates variables, recipients, preview, publishing, restore, and sending behavior."
          eyebrow="Admin Communication"
          icon={<Mail className="h-3.5 w-3.5" />}
          title="Email Templates"
        />

        {message ? <AdminCallout tone="success"><Check className="mt-0.5 h-4 w-4" />{message}</AdminCallout> : null}
        {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}

        <Card className={cn(adminPanelClassName, "p-4")}>
          <div className="grid gap-2 md:grid-cols-4">
            {steps.map((label, index) => (
              <button
                className={cn(
                  "rounded-lg border px-3 py-3 text-left text-sm font-black",
                  step === index ? "border-[#F97316] bg-[#FFF7ED] text-[#9A3412]" : "border-[#E2E8F0] bg-white text-[#334155]",
                )}
                key={label}
                onClick={() => {
                  setStep(index);
                  if (index > 0) loadDesignerMetadata();
                }}
                type="button"
              >
                {index + 1}. {label}
              </button>
            ))}
          </div>
        </Card>

        {step === 0 ? (
          <div className="grid gap-4 lg:grid-cols-3">
            {templates.map((template) => {
              const healthy = template.subject.trim() && template.bodyHtml.trim() && template.rules.toRoles.length + template.rules.toStaticEmails.length > 0;
              return (
                <Card className={cn(adminPanelClassName, "p-5")} key={template.templateKey}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-black text-[#0F172A]">{template.templateName}</h2>
                      <p className="mt-2 text-sm leading-6 text-[#64748B]">{template.description}</p>
                    </div>
                    <span className={cn("rounded-full px-2.5 py-1 text-xs font-black", healthy ? "bg-[#DCFCE7] text-[#166534]" : "bg-[#FFF7ED] text-[#9A3412]")}>
                      {healthy ? "Healthy" : "Needs review"}
                    </span>
                  </div>
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <span className="text-xs font-bold text-[#64748B]">{template.isActive ? "Published" : "Draft"} - {new Date(template.updatedAt).toLocaleDateString()}</span>
                    <Button className="rounded-xl bg-[#0F172A] text-white" onClick={() => selectTemplate(template)} type="button">
                      Edit
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        ) : null}

        {step === 1 ? (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <Card className={cn(adminPanelClassName, "space-y-4 p-5")}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]">Edit Content</p>
                  <h2 className="mt-1 text-xl font-black text-[#0F172A]">{draft.templateName}</h2>
                </div>
                <div className="flex items-center gap-3 rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2">
                  <span className="text-xs font-bold text-[#475569]">{draft.isActive ? "Active" : "Inactive"}</span>
                  <Switch checked={draft.isActive} label="Template active status" onChange={(checked) => updateDraft("isActive", checked)} />
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Friendly email name"><Input value={draft.templateName} onChange={(event) => updateDraft("templateName", event.target.value)} /></Field>
                <Field label="Subject"><Input onDrop={(event) => dropVariable(event, "subject")} onDragOver={(event) => event.preventDefault()} onFocus={() => setActiveField("subject")} value={draft.subject} onChange={(event) => updateDraft("subject", event.target.value)} /></Field>
              </div>
              <Field label="Preview text"><Input onDrop={(event) => dropVariable(event, "previewText")} onDragOver={(event) => event.preventDefault()} onFocus={() => setActiveField("previewText")} value={draft.previewText} onChange={(event) => updateDraft("previewText", event.target.value)} /></Field>
              <Field label="Greeting"><Input onDrop={(event) => dropVariable(event, "greeting")} onDragOver={(event) => event.preventDefault()} onFocus={() => setActiveField("greeting")} value={draft.greeting} onChange={(event) => updateDraft("greeting", event.target.value)} /></Field>
              <div className="flex flex-wrap gap-2">
                {(["paragraph", "bold", "italic", "list", "link", "button", "divider"] as const).map((format) => (
                  <Button key={format} className="h-9 rounded-lg border border-[#CBD5E1] bg-white px-3 text-xs font-black text-[#0F172A]" onClick={() => updateDraft("bodyHtml", applyFormat(draft.bodyHtml, format))} type="button" variant="secondary">
                    {format}
                  </Button>
                ))}
              </div>
              <Field label="Body">
                <textarea className="min-h-[230px] w-full rounded-xl border border-[#CBD5E1] bg-white px-3 py-3 text-sm leading-6 text-[#0F172A] outline-none focus:border-[#F97316] focus:ring-2 focus:ring-[#F97316]/20" onDrop={(event) => dropVariable(event, "bodyHtml")} onDragOver={(event) => event.preventDefault()} onFocus={() => setActiveField("bodyHtml")} value={draft.bodyHtml} onChange={(event) => updateDraft("bodyHtml", event.target.value)} />
              </Field>
              <Field label="Plain text fallback">
                <textarea className="min-h-[110px] w-full rounded-xl border border-[#CBD5E1] bg-white px-3 py-3 text-sm leading-6 text-[#0F172A] outline-none focus:border-[#F97316] focus:ring-2 focus:ring-[#F97316]/20" onDrop={(event) => dropVariable(event, "bodyText")} onDragOver={(event) => event.preventDefault()} onFocus={() => setActiveField("bodyText")} value={draft.bodyText} onChange={(event) => updateDraft("bodyText", event.target.value)} />
              </Field>
              <Field label="Closing"><Input onDrop={(event) => dropVariable(event, "closingText")} onDragOver={(event) => event.preventDefault()} onFocus={() => setActiveField("closingText")} value={draft.closingText} onChange={(event) => updateDraft("closingText", event.target.value)} /></Field>
            </Card>
            <VariablePanel activeField={activeField} onInsert={insertVariable} variables={templateVariables} />
          </div>
        ) : null}

        {step === 2 ? (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
            <Card className={cn(adminPanelClassName, "space-y-5 p-5")}>
              <div>
                <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]">Choose Recipients</p>
                <h2 className="mt-1 text-xl font-black text-[#0F172A]">Simple recipient presets</h2>
              </div>
              <div className="grid gap-4 lg:grid-cols-3">
                {(["toRoles", "ccRoles", "bccRoles"] as const).map((channel) => (
                  <div className={cn(adminSoftPanelClassName, "p-4")} key={channel}>
                    <p className="text-sm font-black text-[#0F172A]">{channel === "toRoles" ? "TO" : channel === "ccRoles" ? "CC" : "BCC"}</p>
                    <div className="mt-3 space-y-2">
                      {(presets.length > 0 ? presets : Object.keys(presetRoles).map((key) => ({ description: key, key, label: key.replace(/_/g, " "), role: presetRoles[key] }))).map((preset) => (
                        <label className="flex items-start gap-2 rounded-lg px-2 py-2 text-sm text-[#334155] hover:bg-[#FFF7ED]" key={`${channel}-${preset.key}`}>
                          <input checked={presetChecked(channel, preset.key)} className="mt-1 h-4 w-4 accent-[#F97316]" onChange={() => togglePreset(channel, preset.key)} type="checkbox" />
                          <span>
                            <span className="block font-black">{preset.label}</span>
                            <span className="text-xs leading-5 text-[#64748B]">{preset.description}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <details className={cn(adminSoftPanelClassName, "p-4")}>
                <summary className="cursor-pointer text-sm font-black text-[#0F172A]">Advanced settings for Super Admins</summary>
                <div className="mt-4 grid gap-3 lg:grid-cols-3">
                  <Field label="Static TO emails"><textarea className="min-h-[88px] w-full rounded-xl border border-[#CBD5E1] px-3 py-2 text-sm" value={emailText(draft.rules.toStaticEmails)} onChange={(event) => updateRules("toStaticEmails", parseLines(event.target.value))} /></Field>
                  <Field label="Static CC emails"><textarea className="min-h-[88px] w-full rounded-xl border border-[#CBD5E1] px-3 py-2 text-sm" value={emailText(draft.rules.ccStaticEmails)} onChange={(event) => updateRules("ccStaticEmails", parseLines(event.target.value))} /></Field>
                  <Field label="Static BCC emails"><textarea className="min-h-[88px] w-full rounded-xl border border-[#CBD5E1] px-3 py-2 text-sm" value={emailText(draft.rules.bccStaticEmails)} onChange={(event) => updateRules("bccStaticEmails", parseLines(event.target.value))} /></Field>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <Field label="Target lines"><select className="min-h-[112px] w-full rounded-xl border border-[#CBD5E1] bg-white px-3 py-2 text-sm" multiple value={draft.rules.targetLines} onChange={(event) => updateRules("targetLines", Array.from(event.currentTarget.selectedOptions).map((option) => option.value))}>{initialRoutingOptions.lines.map((line) => <option key={line} value={line}>{line}</option>)}</select></Field>
                  <Field label="Target titles"><select className="min-h-[112px] w-full rounded-xl border border-[#CBD5E1] bg-white px-3 py-2 text-sm" multiple value={draft.rules.targetTitles} onChange={(event) => updateRules("targetTitles", Array.from(event.currentTarget.selectedOptions).map((option) => option.value))}>{initialRoutingOptions.titles.map((title) => <option key={title} value={title}>{title}</option>)}</select></Field>
                </div>
              </details>
            </Card>
            <Card className={cn(adminPanelClassName, "space-y-4 p-5")}>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]">Visual recipient preview</p>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Sample employee HR ID"><Input value={sampleEmployeeHrId} onChange={(event) => setSampleEmployeeHrId(event.target.value)} placeholder="PHX-1024" /></Field>
                <Field label="Candidate email"><Input value={sampleCandidateEmail} onChange={(event) => setSampleCandidateEmail(event.target.value)} placeholder="candidate@example.com" /></Field>
              </div>
              <Button className="w-full rounded-xl bg-[#0F172A] text-white" onClick={validateDraft} type="button">Resolve with backend</Button>
              {validation ? <RecipientPreview validation={validation} /> : <p className="text-sm leading-6 text-[#64748B]">Run backend resolution to see the exact TO, CC, and BCC recipients.</p>}
            </Card>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
            <Card className={cn(adminPanelClassName, "space-y-4 p-5")}>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]">Review & Publish</p>
                  <h2 className="mt-1 text-xl font-black text-[#0F172A]">{validation?.preview.subject ?? draft.subject}</h2>
                </div>
                <Button className="rounded-xl bg-[#0F172A] text-white" onClick={validateDraft} type="button">Run backend review</Button>
              </div>
              {issues.length > 0 ? (
                <div className="space-y-2">
                  {issues.map((issue) => (
                    <div className={cn("rounded-xl border px-3 py-2 text-sm font-semibold", issue.severity === "error" ? "border-[#FCA5A5] bg-[#FEF2F2] text-[#B91C1C]" : "border-[#FED7AA] bg-[#FFF7ED] text-[#9A3412]")} key={`${issue.field}-${issue.message}`}>
                      {issue.message}
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="overflow-hidden rounded-xl border border-[#CBD5E1] bg-white">
                {validation?.preview.html ? <iframe className="h-[620px] w-full bg-white" sandbox="" srcDoc={validation.preview.html} title="Backend email preview" /> : <div className="flex h-[620px] items-center justify-center px-6 text-center text-sm text-[#64748B]">Run backend review to render the final email.</div>}
              </div>
            </Card>
            <aside className="space-y-5">
              <Card className={cn(adminPanelClassName, "space-y-4 p-5")}>
                <Field label="Publish reason"><textarea className="min-h-[96px] w-full rounded-xl border border-[#CBD5E1] px-3 py-3 text-sm" value={changeReason} onChange={(event) => setChangeReason(event.target.value)} placeholder="Example: Simplified leave approval wording for HR audit clarity." /></Field>
                <div className="grid gap-2">
                  <Button className="rounded-xl border border-[#CBD5E1] bg-white text-[#0F172A]" onClick={() => saveTemplate("draft")} type="button" variant="secondary"><Save className="mr-2 h-4 w-4" />Save Draft</Button>
                  <Button className="rounded-xl bg-[#F97316] text-white" disabled={!canPublish || isPending} onClick={() => saveTemplate("publish")} type="button"><Send className="mr-2 h-4 w-4" />Publish</Button>
                </div>
                <div className="grid gap-2">
                  <Field label="Send test to"><Input type="email" value={testEmail} onChange={(event) => setTestEmail(event.target.value)} placeholder="admin@satopharma.com" /></Field>
                  <Button className="rounded-xl border border-[#CBD5E1] bg-white text-[#0F172A]" onClick={sendTestEmail} type="button" variant="secondary">Send Test</Button>
                </div>
              </Card>
              <Card className={cn(adminPanelClassName, "space-y-4 p-5")}>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]">Restore</p>
                  <Button className="rounded-xl border border-[#CBD5E1] bg-white text-[#0F172A]" onClick={loadHistory} type="button" variant="secondary"><History className="mr-2 h-4 w-4" />Load</Button>
                </div>
                <Field label="Restore reason"><Input value={restoreReason} onChange={(event) => setRestoreReason(event.target.value)} placeholder="Reason required before restore" /></Field>
                <div className="max-h-[320px] space-y-2 overflow-auto">
                  {history.length > 0 ? history.map((entry) => (
                    <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3" key={entry.versionNumber}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-black text-[#0F172A]">Version {entry.versionNumber} - {entry.action}</p>
                          <p className="mt-1 text-xs font-semibold text-[#64748B]">{new Date(entry.changedAt).toLocaleString()}</p>
                          {entry.reason ? <p className="mt-2 text-xs leading-5 text-[#475569]">{entry.reason}</p> : null}
                        </div>
                        <Button className="h-9 rounded-xl border border-[#CBD5E1] bg-white text-[#0F172A]" onClick={() => restoreTemplate(entry.versionNumber)} type="button" variant="secondary"><RotateCcw className="h-4 w-4" /></Button>
                      </div>
                    </div>
                  )) : <p className="text-sm leading-6 text-[#64748B]">Load history to restore an older backend snapshot.</p>}
                </div>
              </Card>
            </aside>
          </div>
        ) : null}

        <div className="flex justify-between">
          <Button className="rounded-xl border border-[#CBD5E1] bg-white text-[#0F172A]" disabled={step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))} type="button" variant="secondary"><ChevronLeft className="mr-2 h-4 w-4" />Back</Button>
          <Button className="rounded-xl bg-[#0F172A] text-white" disabled={step === steps.length - 1} onClick={() => {
            loadDesignerMetadata();
            setStep((current) => Math.min(steps.length - 1, current + 1));
          }} type="button">Next<ChevronRight className="ml-2 h-4 w-4" /></Button>
        </div>
      </div>
    </main>
  );
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">{label}</span>
      {children}
    </label>
  );
}

function VariablePanel({
  activeField,
  onInsert,
  variables,
}: {
  activeField: string;
  onInsert: (token: string) => void;
  variables: DesignerVariable[];
}) {
  const grouped = variables.reduce<Record<string, DesignerVariable[]>>((acc, variable) => {
    acc[variable.category] = [...(acc[variable.category] ?? []), variable];
    return acc;
  }, {});

  return (
    <Card className={cn(adminPanelClassName, "space-y-4 p-5")}>
      <div>
        <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C2410C]">Variables</p>
        <p className="mt-1 text-sm leading-6 text-[#64748B]">Click or drag a chip into the active field. Backend stores the token.</p>
        <p className="mt-1 text-xs font-bold text-[#64748B]">Active field: {activeField}</p>
      </div>
      <div className="max-h-[640px] space-y-4 overflow-auto pr-1">
        {Object.entries(grouped).map(([category, items]) => (
          <div key={category}>
            <p className="mb-2 text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">{category}</p>
            <div className="flex flex-wrap gap-2">
              {items.map((variable) => (
                <button
                  className="rounded-full border border-[#FED7AA] bg-[#FFF7ED] px-3 py-1.5 text-xs font-black text-[#C2410C]"
                  draggable
                  key={variable.token}
                  onClick={() => onInsert(variable.token)}
                  onDragStart={(event) => event.dataTransfer.setData("text/plain", variable.token)}
                  title={`Stores {{${variable.token}}}. Example: ${variable.sampleValue}`}
                  type="button"
                >
                  {variable.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function RecipientPreview({ validation }: { validation: ValidationState }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3">
        <RecipientList label="TO" recipients={validation.simulation.to} />
        <RecipientList label="CC" recipients={validation.simulation.cc} />
        <RecipientList label="BCC" recipients={validation.simulation.bcc} />
      </div>
      <p className="text-xs font-bold text-[#64748B]">
        {validation.simulation.diagnostics.finalRecipientCount} final recipient(s). {validation.duplicateRecipientsRemoved} duplicate(s) removed by backend.
      </p>
    </div>
  );
}

function RecipientList({ label, recipients }: { label: string; recipients: SimulationRecipient[] }) {
  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white p-3">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">{label} ({recipients.length})</p>
      <div className="mt-2 space-y-2">
        {recipients.length > 0 ? recipients.map((recipient) => (
          <div className="min-w-0 rounded-lg bg-[#F8FAFC] px-2.5 py-2" key={`${label}-${recipient.email}`}>
            <p className="truncate text-sm font-bold text-[#0F172A]">{recipient.email}</p>
            {recipient.name ? <p className="truncate text-xs font-semibold text-[#64748B]">{recipient.name}</p> : null}
          </div>
        )) : <p className="text-sm font-semibold text-[#94A3B8]">No recipients resolved.</p>}
      </div>
    </div>
  );
}
