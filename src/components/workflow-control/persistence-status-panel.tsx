"use client";

import {
  Archive,
  Check,
  CircleDot,
  ClipboardList,
  Database,
  History,
  Lock,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import {
  WORKFLOW_CONTROL_PERSISTENCE_ENABLED,
  WORKFLOW_CONTROL_PUBLISH_ENABLED,
  WORKFLOW_CONTROL_ROLLBACK_ENABLED,
} from "@/lib/workflow-control/feature-flags";

/**
 * Phase 3E Persistence Status Panel (CLIENT-ONLY, READ-ONLY).
 *
 * Surfaces the Phase 3 readiness state to admins inside the Draft Editor:
 *   - which capabilities are disabled (persistence / publish / rollback)
 *   - whether the Phase 3 migration is applied (it is not)
 *   - whether runtime workflow execution has changed (it has not)
 *   - a locked Version History placeholder
 *   - a governance checklist mirroring the Phase 3 plan
 *   - a clear safety note for publish
 *
 * No API calls, no fetch, no DB queries. Pure UI driven by the feature flags.
 */
export function PersistenceStatusPanel() {
  const persistenceEnabled = WORKFLOW_CONTROL_PERSISTENCE_ENABLED;
  const publishEnabled = WORKFLOW_CONTROL_PUBLISH_ENABLED;
  const rollbackEnabled = WORKFLOW_CONTROL_ROLLBACK_ENABLED;

  const statusRows: Array<{ icon: typeof Database; label: string; value: string; tone: "off" | "neutral" }> = [
    { icon: Database, label: "Persistence", value: persistenceEnabled ? "Enabled" : "Disabled", tone: persistenceEnabled ? "neutral" : "off" },
    { icon: ShieldCheck, label: "Publish", value: publishEnabled ? "Enabled" : "Disabled", tone: publishEnabled ? "neutral" : "off" },
    { icon: History, label: "Rollback", value: rollbackEnabled ? "Enabled" : "Disabled", tone: rollbackEnabled ? "neutral" : "off" },
    { icon: Archive, label: "Migration", value: "Not applied", tone: "off" },
    { icon: CircleDot, label: "Runtime workflow execution", value: "Static definitions only", tone: "neutral" },
    { icon: Lock, label: "Phase 3 storage", value: "Not active yet", tone: "off" },
  ];

  const governanceChecklist: Array<{ label: string; done: boolean }> = [
    { label: "Migration drafted", done: true },
    { label: "RLS planned", done: true },
    { label: "Service-role only", done: true },
    { label: "Feature flags disabled", done: true },
    { label: "Runtime adoption deferred to Phase 4", done: true },
    { label: "Audit log planned", done: true },
  ];

  return (
    <div className="mx-5 mt-4 space-y-3" data-testid="persistence-status-panel">
      {/* Persistence status grid */}
      <div className="rounded-xl border border-phx-line bg-phx-paper p-4">
        <p className="text-phx-xs font-black uppercase tracking-[0.10em] text-phx-ink-soft">Phase 3 persistence status</p>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {statusRows.map(({ icon: Icon, label, value, tone }) => (
            <div key={label} className="flex items-center gap-2 rounded-lg border border-phx-line bg-white px-3 py-2">
              <Icon className={`h-4 w-4 ${tone === "off" ? "text-phx-ink-faint" : "text-phx-ink-2"}`} />
              <div className="min-w-0 flex-1">
                <p className="text-phx-xs font-black uppercase tracking-[0.08em] text-phx-ink-faint">{label}</p>
                <p className={`mt-0.5 text-phx-sm font-bold ${tone === "off" ? "text-[#B91C1C]" : "text-phx-ink"}`}>{value}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Version History placeholder (locked) */}
      <div className="rounded-xl border border-phx-line bg-white p-4">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-phx-ink-faint" />
          <p className="text-phx-sm font-black uppercase tracking-[0.10em] text-phx-ink-soft">Version History</p>
          <span className="inline-flex items-center gap-1 rounded-full bg-phx-paper-2 px-2 py-0.5 text-phx-2xs font-bold text-phx-ink-2">
            <Lock className="h-3 w-3" /> Locked
          </span>
        </div>
        <p className="mt-1 text-phx-sm leading-5 text-phx-ink-soft">
          Version history will become available after Phase 3 persistence migration.
        </p>
        <div className="mt-2 rounded-lg border border-dashed border-phx-line bg-phx-paper px-3 py-3 text-center">
          <p className="text-phx-xs font-bold uppercase tracking-[0.10em] text-phx-ink-faint">Persisted Drafts</p>
          <p className="mt-0.5 text-phx-xs text-phx-ink-faint">Empty — Saved drafts unavailable until persistence is enabled.</p>
        </div>
      </div>

      {/* Publish safety note */}
      <div className="rounded-xl border border-[#FED7AA] bg-phx-accent-soft px-4 py-3">
        <p className="flex items-center gap-1.5 text-phx-xs font-black uppercase tracking-[0.10em] text-phx-accent-press">
          <ShieldCheck className="h-3.5 w-3.5" /> Publish safety
        </p>
        <p className="mt-1 text-phx-sm leading-5 text-[#9A3412]">
          Publishing will never change live workflows without validation, audit log, and explicit approval.
        </p>
      </div>

      {/* Governance checklist */}
      <div className="rounded-xl border border-phx-line bg-white p-4">
        <p className="flex items-center gap-1.5 text-phx-xs font-black uppercase tracking-[0.10em] text-phx-ink-soft">
          <ClipboardList className="h-3.5 w-3.5" /> Governance checklist
        </p>
        <ul className="mt-1.5 grid grid-cols-1 gap-1 sm:grid-cols-2">
          {governanceChecklist.map(({ label, done }) => (
            <li key={label} className="flex items-center gap-1.5">
              {done ? (
                <Check className="h-3.5 w-3.5 text-[#047857]" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-phx-ink-faint" />
              )}
              <span className="text-phx-sm text-phx-ink-2">{label}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
