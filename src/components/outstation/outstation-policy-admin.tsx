"use client";

import { Save, Settings2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { OutstationPolicyRule } from "@/lib/outstation/types";

type EditableRule = OutstationPolicyRule;

const MANAGED_ROLE_ORDER = ["District Manager", "National Sales Manager"] as const;

function roleKey(roleName: string) {
  return roleName.trim().toLowerCase();
}

function defaultRuleForRole(roleName: (typeof MANAGED_ROLE_ORDER)[number]): EditableRule {
  const isNsm = roleKey(roleName) === "national sales manager";
  const now = new Date().toISOString();

  return {
    active: true,
    createdAt: now,
    fuelRatePerKm: 1.8,
    gpsAccuracyThresholdMeters: 100,
    id: Number.NaN,
    maxOfflineSyncDelayHours: 8,
    minimumDistanceKm: 60,
    overnightAllowance: isNsm ? 500 : 500,
    requiresTicketAttachment: true,
    returnDayAllowance: isNsm ? 300 : 300,
    roleName,
    sameDayAllowance: isNsm ? 300 : 300,
    updatedAt: now,
  };
}

function buildManagedRules(initialPolicies: OutstationPolicyRule[]) {
  const existing = new Map(initialPolicies.map((policy) => [roleKey(policy.roleName), policy]));

  return MANAGED_ROLE_ORDER.map((roleName) => existing.get(roleKey(roleName)) ?? defaultRuleForRole(roleName));
}

function policyDescription(roleName: string) {
  if (roleName.toLowerCase() === "district manager") {
    return "DSM outstation allowance and ticket enforcement policy.";
  }
  if (roleName.toLowerCase() === "national sales manager") {
    return "NSM outstation allowance, distance validation, and ticket enforcement policy.";
  }
  return "Role-based outstation policy rule.";
}

export function OutstationPolicyAdmin({
  initialPolicies,
}: {
  initialPolicies: OutstationPolicyRule[];
}) {
  const [rules, setRules] = useState<EditableRule[]>(() => buildManagedRules(initialPolicies));
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const activeCount = useMemo(
    () => rules.filter((rule) => rule.active).length,
    [rules],
  );

  const policyRuleCount = rules.length;

  const hasRules = rules.length > 0;

  function updateRule(index: number, patch: Partial<EditableRule>) {
    setRules((current) =>
      current.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, ...patch } : rule)),
    );
  }

  async function savePolicies() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/outstation/policy", {
        body: JSON.stringify({
          rules: rules.map((rule) => ({
            active: rule.active,
            fuelRatePerKm: rule.fuelRatePerKm,
            gpsAccuracyThresholdMeters: rule.gpsAccuracyThresholdMeters,
            maxOfflineSyncDelayHours: rule.maxOfflineSyncDelayHours,
            minimumDistanceKm: rule.minimumDistanceKm,
            overnightAllowance: rule.overnightAllowance,
            requiresTicketAttachment: rule.requiresTicketAttachment,
            returnDayAllowance: rule.returnDayAllowance,
            roleName: rule.roleName,
            sameDayAllowance: rule.sameDayAllowance,
          })),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.message ?? payload.error ?? "Unable to save outstation policy.");
        return;
      }

      setRules(buildManagedRules(Array.isArray(payload.policies) ? payload.policies : []));
      setMessage("Outstation policy updated successfully.");
    } catch {
      setMessage("Unable to save outstation policy.");
    } finally {
      setSaving(false);
    }
  }

  if (!hasRules) {
    return (
      <div className="space-y-5">
        <AdminPageHero
          description="No policy rows are available yet."
          eyebrow="Outstation policy"
          icon={<Settings2 className="h-3.5 w-3.5" />}
          title="Configure outstation policy rules"
        />
        <AdminCallout tone="neutral">
          <Settings2 className="mt-0.5 h-5 w-5 text-[#EA580C]" />
          <p className="font-semibold text-[#334155]">No policy rows were loaded from the data source.</p>
        </AdminCallout>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AdminPageHero
        description="Tune minimum distance, allowance amounts, validation thresholds, and ticket requirements by role. Changes are applied across outstation calculation and review."
        eyebrow="Policy engine"
        icon={<Settings2 className="h-3.5 w-3.5" />}
        title="Residence and allowance policy"
        badges={(
          <div className="flex flex-wrap gap-2 text-xs">
            <AdminInsightChip tone="slate">Rules: {policyRuleCount}</AdminInsightChip>
            <AdminInsightChip tone="slate">Active: {activeCount}</AdminInsightChip>
          </div>
        )}
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricBlock
          label="Policy Rules"
          value={String(policyRuleCount)}
          description="Configured role rows"
        />
        <MetricBlock
          label="Active Rules"
          value={String(activeCount)}
          description="Currently enabled in calculations"
        />
        <MetricBlock
          label="Min Distance"
          value={`${Math.min(...rules.map((rule) => rule.minimumDistanceKm)).toFixed(0)} KM`}
          description="Lowest gate in scope"
        />
        <MetricBlock
          label="Max Offline Delay"
          value={`${Math.max(...rules.map((rule) => rule.maxOfflineSyncDelayHours))} hrs`}
          description="Longest tolerance"
        />
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        {rules.map((rule, index) => (
          <Card className={`${adminPanelClassName} overflow-hidden`} key={rule.roleName}>
            <div className="border-b border-[#E2E8F0] px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl bg-[#FFF7ED] text-[#EA580C]">
                    <Settings2 className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="truncate text-lg font-black tracking-[-0.02em] text-[#0F172A]">
                      {rule.roleName}
                    </h2>
                    <p className="mt-1 text-sm leading-6 text-[#64748B]">{policyDescription(rule.roleName)}</p>
                  </div>
                </div>
                <AdminInsightChip tone={rule.active ? "orange" : "neutral"}>{rule.active ? "Active" : "Inactive"}</AdminInsightChip>
              </div>
            </div>

            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Field label="Minimum Distance (KM)">
                <Input
                  className="rounded-[12px] border-[#DDE6F1] bg-white text-[#0F172A] focus:border-[#FDBA74] focus-visible:outline-none"
                  onChange={(event) => updateRule(index, { minimumDistanceKm: Number(event.target.value) })}
                  type="number"
                  value={rule.minimumDistanceKm}
                />
              </Field>

              <Field label="Fuel Rate Per KM">
                <Input
                  className="rounded-[12px] border-[#DDE6F1] bg-white text-[#0F172A] focus:border-[#FDBA74] focus-visible:outline-none"
                  onChange={(event) => updateRule(index, { fuelRatePerKm: Number(event.target.value) })}
                  step="0.1"
                  type="number"
                  value={rule.fuelRatePerKm}
                />
              </Field>

              <Field label="Same Day Allowance">
                <Input
                  className="rounded-[12px] border-[#DDE6F1] bg-white text-[#0F172A] focus:border-[#FDBA74] focus-visible:outline-none"
                  onChange={(event) => updateRule(index, { sameDayAllowance: Number(event.target.value) })}
                  type="number"
                  value={rule.sameDayAllowance}
                />
              </Field>

              <Field label="Overnight Allowance">
                <Input
                  className="rounded-[12px] border-[#DDE6F1] bg-white text-[#0F172A] focus:border-[#FDBA74] focus-visible:outline-none"
                  onChange={(event) => updateRule(index, { overnightAllowance: Number(event.target.value) })}
                  type="number"
                  value={rule.overnightAllowance}
                />
              </Field>

              <Field label="Return Day Allowance">
                <Input
                  className="rounded-[12px] border-[#DDE6F1] bg-white text-[#0F172A] focus:border-[#FDBA74] focus-visible:outline-none"
                  onChange={(event) => updateRule(index, { returnDayAllowance: Number(event.target.value) })}
                  type="number"
                  value={rule.returnDayAllowance}
                />
              </Field>

              <Field label="GPS Accuracy Threshold (m)">
                <Input
                  className="rounded-[12px] border-[#DDE6F1] bg-white text-[#0F172A] focus:border-[#FDBA74] focus-visible:outline-none"
                  onChange={(event) =>
                    updateRule(index, { gpsAccuracyThresholdMeters: Number(event.target.value) })
                  }
                  type="number"
                  value={rule.gpsAccuracyThresholdMeters}
                />
              </Field>

              <Field label="Max Offline Delay (hours)">
                <Input
                  className="rounded-[12px] border-[#DDE6F1] bg-white text-[#0F172A] focus:border-[#FDBA74] focus-visible:outline-none"
                  onChange={(event) => updateRule(index, { maxOfflineSyncDelayHours: Number(event.target.value) })}
                  type="number"
                  value={rule.maxOfflineSyncDelayHours}
                />
              </Field>

              <Field label="Ticket attachment">
                <label className="flex h-10 items-center gap-3 rounded-[12px] border border-[#DDE6F1] bg-[#F8FAFC] px-3 text-sm">
                  <input
                    checked={rule.requiresTicketAttachment}
                    className="h-4 w-4"
                    onChange={(event) => updateRule(index, { requiresTicketAttachment: event.target.checked })}
                    type="checkbox"
                  />
                  <span className="font-semibold text-[#0F172A]">Require ticket attachment</span>
                </label>
              </Field>

              <Field label="Rule status">
                <label className="flex h-10 items-center gap-3 rounded-[12px] border border-[#DDE6F1] bg-[#F8FAFC] px-3 text-sm">
                  <input
                    checked={rule.active}
                    className="h-4 w-4"
                    onChange={(event) => updateRule(index, { active: event.target.checked })}
                    type="checkbox"
                  />
                  <span className="font-semibold text-[#0F172A]">Apply this rule</span>
                </label>
              </Field>
            </div>
          </Card>
        ))}
      </div>

      <section className="grid">
        <Card className={`${adminPanelClassName} p-5`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-[#EA580C]">Save policy</p>
              <h3 className="mt-1 text-lg font-black tracking-[-0.03em] text-[#0F172A]">Publish updates</h3>
              <p className="mt-1 text-sm text-[#64748B]">Persist edits so new rules are used for eligibility and allowance calculations.</p>
            </div>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <Button
                className="rounded-[10px] bg-[#F97316] px-4 py-2.5 font-semibold text-white hover:bg-[#EA580C]"
                disabled={saving}
                onClick={savePolicies}
                type="button"
              >
                <Save className="h-4 w-4" />
                {saving ? "Saving..." : "Save Policy"}
              </Button>
              {message ? <span className="text-sm font-semibold text-[#334155]">{message}</span> : null}
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}

function MetricBlock({
  description,
  label,
  value,
}: {
  description: string;
  label: string;
  value: string;
}) {
  return (
    <Card className={`${adminPanelClassName} p-4`}>
      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">{label}</p>
      <p className="mt-2 truncate text-2xl font-black text-[#0F172A]">{value}</p>
      <p className="mt-2 text-xs text-[#64748B]">{description}</p>
    </Card>
  );
}

function Field({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">{label}</span>
      {children}
    </label>
  );
}
