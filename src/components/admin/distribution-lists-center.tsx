"use client";

import { AlertTriangle, AtSign, Loader2, Users } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AdminSectionHeader } from "@/components/admin/admin-design-system";
import { MultiSelectFilter } from "@/components/ui/multi-select-filter";
import { Switch } from "@/components/ui/switch";
import { phoenixRoles, type PhoenixRole } from "@/lib/auth/permissions";
import { phxTextareaClassName } from "@/components/ui/form-tokens";

export type DistributionListView = {
  listKey: string;
  label: string;
  enabled: boolean;
  members: Array<{ hrId: string; displayName: string; email: string; via: "rule" | "included" }>;
  externalEmails: string[];
  emails: string[];
  skipped: Array<{ hrId: string; displayName: string; reason: "no_work_email" | "excluded" }>;
  refusedReason: string | null;
  warnings: string[];
};

export type DistributionSpecView = {
  listKey: string;
  description: string;
  roles: PhoenixRole[];
  lineIds: number[];
  areaIds: number[];
  departmentIds: number[];
  positionIds: number[];
  regionCodes: string[];
  includedHrIds: string[];
  excludedHrIds: string[];
  externalEmails: string[];
  allEmployees: boolean;
};

export type AliasView = {
  aliasAddress: string;
  label: string;
  purpose: string;
  distributionListKey: string | null;
  recordedMemberEmails: string[];
  recordedAt: string | null;
  recordedBy: string | null;
  recordedAgeDays: number | null;
  isActive: boolean;
  expectedEmails: string[] | null;
  drift: { toAdd: string[]; toRemove: Array<{ email: string; reason: "left_company" | "not_on_list" }>; inSync: boolean } | null;
};

const ROLE_OPTIONS = phoenixRoles.map((role) => ({ code: role, label: role }));

export function DistributionListsCenter({
  initialAliases,
  initialLists,
  initialSpecs,
}: {
  initialAliases: AliasView[];
  initialLists: DistributionListView[];
  initialSpecs: DistributionSpecView[];
}) {
  const [lists, setLists] = useState(initialLists);
  const [specs, setSpecs] = useState(initialSpecs);
  const [aliases, setAliases] = useState(initialAliases);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function patchSpec(listKey: string, patch: Partial<DistributionSpecView>) {
    setSpecs((current) => current.map((spec) => (spec.listKey === listKey ? { ...spec, ...patch } : spec)));
  }

  async function saveList(listKey: string, enabled: boolean) {
    const spec = specs.find((item) => item.listKey === listKey);
    if (!spec) return;
    setSavingKey(listKey);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/distribution-lists/${listKey}`, {
        body: JSON.stringify({ enabled, roles: spec.roles }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; resolved?: DistributionListView; message?: string }
        | null;
      if (!response.ok || !payload?.ok || !payload.resolved) {
        throw new Error(payload?.message ?? `Request failed (${response.status})`);
      }
      const resolved = payload.resolved;
      setLists((current) => current.map((list) => (list.listKey === listKey ? resolved : list)));
      // The saved membership is what the send would use, so report the count rather than "saved" —
      // a list that silently resolved to nobody is the failure this screen exists to make visible.
      setMessage(`${resolved.label} saved — it now reaches ${resolved.emails.length} address(es).`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save the distribution list.");
    } finally {
      setSavingKey(null);
    }
  }

  async function recordAlias(aliasAddress: string, rawEmails: string) {
    setSavingKey(aliasAddress);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/email-aliases", {
        body: JSON.stringify({
          action: "record",
          aliasAddress,
          memberEmails: rawEmails.split(/[\s,;]+/).map((email) => email.trim()).filter(Boolean),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      if (!response.ok || !payload?.ok) throw new Error(payload?.message ?? `Request failed (${response.status})`);
      setMessage(`Recorded what is on ${aliasAddress}. Reload to recompute the drift.`);
      setAliases((current) =>
        current.map((alias) => (alias.aliasAddress === aliasAddress ? { ...alias, recordedAgeDays: 0 } : alias)),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to record the alias membership.");
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="space-y-7">
      {message ? (
        <div className="rounded-xl border border-phx-line bg-phx-paper px-4 py-2.5 text-sm font-semibold text-phx-ink">{message}</div>
      ) : null}

      <div className="space-y-4">
        <AdminSectionHeader
          description="A named group Phoenix resolves fresh every time it sends, from the live employee directory — so it cannot go stale when somebody joins, moves line or leaves. Routing only: nothing here sends mail on its own."
          title="Distribution Lists"
        />
        <div className="grid gap-4">
          {lists.map((list) => (
            <ListCard
              key={list.listKey}
              list={list}
              onRolesChange={(roles) => patchSpec(list.listKey, { roles })}
              onSave={(enabled) => saveList(list.listKey, enabled)}
              saving={savingKey === list.listKey}
              spec={specs.find((spec) => spec.listKey === list.listKey)}
            />
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <AdminSectionHeader
          description="Company addresses that live on Turbify. Turbify has no API, so Phoenix can never read or change a real alias — this compares what somebody last recorded against what the list says, and gives you the changes to make by hand."
          title="Company Email Aliases"
        />
        <div className="grid gap-4">
          {aliases.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-phx-line bg-white p-5 text-sm text-phx-ink-soft">
              No aliases registered yet. Register one to start tracking who is on it.
            </p>
          ) : null}
          {aliases.map((alias) => (
            <AliasCard
              alias={alias}
              key={alias.aliasAddress}
              onRecord={(emails) => recordAlias(alias.aliasAddress, emails)}
              saving={savingKey === alias.aliasAddress}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warn" | "danger" }) {
  const tones = {
    danger: "border-rose-200 bg-rose-50 text-rose-700",
    neutral: "border-phx-line bg-phx-paper text-phx-ink-2",
    warn: "border-amber-200 bg-amber-50 text-amber-800",
  } as const;
  return <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${tones[tone]}`}>{children}</span>;
}

function ListCard({
  list,
  spec,
  saving,
  onRolesChange,
  onSave,
}: {
  list: DistributionListView;
  spec: DistributionSpecView | undefined;
  saving: boolean;
  onRolesChange: (roles: PhoenixRole[]) => void;
  onSave: (enabled: boolean) => void;
}) {
  const [enabled, setEnabled] = useState(list.enabled);
  const [showAll, setShowAll] = useState(false);

  // Every rule dimension other than roles is read-only on this screen. Shown as plain text, never
  // as a disabled-looking control, so it cannot read as an editor that silently does nothing.
  const otherRules = spec
    ? [
        spec.lineIds.length ? `lines ${spec.lineIds.join(", ")}` : null,
        spec.areaIds.length ? `areas ${spec.areaIds.join(", ")}` : null,
        spec.departmentIds.length ? `departments ${spec.departmentIds.join(", ")}` : null,
        spec.positionIds.length ? `positions ${spec.positionIds.join(", ")}` : null,
        spec.regionCodes.length ? `regions ${spec.regionCodes.join(", ")}` : null,
      ].filter(Boolean)
    : [];

  const shown = showAll ? list.members : list.members.slice(0, 12);
  // 🔴 The one list that reaches the whole company must SAY SO on its own card. Without this it
  // renders like any other: an editable Roles picker reading "No role filter" whose every choice is
  // silently inert (the matcher returns true before the roles check), no "Also filtered by" line
  // because every array is empty, and the words "Nobody. Check the rule above" — because a disabled
  // list resolves to nobody. Toggle and Save, and that card becomes a live company-wide audience.
  const reachesEveryone = spec?.allEmployees === true;

  return (
    <div className="rounded-2xl border border-phx-line bg-white p-5 shadow-[0_10px_28px_rgba(15,23,42,0.06)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-base font-black text-phx-ink">
            <Users className="h-4 w-4 text-phx-accent" />
            {list.label}
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-phx-ink-soft">{spec?.description}</p>
        </div>
        <div className="flex items-center gap-3 rounded-full border border-phx-line bg-phx-paper px-3 py-2">
          <span className="text-xs font-bold text-phx-ink-2">{enabled ? "Enabled" : "Disabled"}</span>
          <Switch checked={enabled} label={`${list.label} enabled`} onChange={setEnabled} />
        </div>
      </div>

      {list.refusedReason ? (
        <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs font-semibold text-rose-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{list.refusedReason}</span>
        </div>
      ) : null}

      {reachesEveryone ? (
        <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs font-black text-amber-900">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            This list reaches EVERY employee in the company. Switching it on makes one send a
            company-wide email, which cannot be recalled.
          </span>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        {reachesEveryone ? (
          // No role picker on an all-company list: every choice in it is inert, because the matcher
          // answers true before it reads roles. An editable control that does nothing is worse than
          // no control.
          <p className="text-xs font-semibold text-phx-ink-2">Rule: everyone — no filter applies.</p>
        ) : (
          <MultiSelectFilter
            allLabel="No role filter"
            label="Roles"
            mode="include"
            onModeChange={() => {
              /* A recipient list is always an "include" — exclude mode has no meaning here. */
            }}
            onSelectedChange={(next) => onRolesChange(next as PhoenixRole[])}
            options={ROLE_OPTIONS}
            selected={spec?.roles ?? []}
          />
        )}
        <button
          className="inline-flex h-[42px] items-center gap-1.5 rounded-lg bg-[#0B0B0B] px-4 text-phx-xs font-black text-white transition hover:bg-[#1E293B] disabled:opacity-50"
          disabled={saving}
          onClick={() => onSave(enabled)}
          type="button"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save
        </button>
      </div>

      {otherRules.length > 0 ? (
        <p className="mt-2.5 text-xs font-semibold text-phx-ink-faint">
          Also filtered by {otherRules.join(" · ")} — edit those through the API for now.
        </p>
      ) : null}

      <div className="mt-4 border-t border-phx-line pt-3">
        <p className="text-xs font-black uppercase tracking-wide text-phx-ink-2">
          Reaches {list.emails.length} address{list.emails.length === 1 ? "" : "es"} right now
        </p>
        {list.members.length === 0 && list.externalEmails.length === 0 ? (
          <p className="mt-2 text-sm text-phx-ink-soft">Nobody. Check the rule above before anything is pointed at this list.</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {shown.map((member) => (
              <Chip key={member.hrId}>
                {member.displayName}
                {member.via === "included" ? " (added by hand)" : ""}
              </Chip>
            ))}
            {list.members.length > shown.length ? (
              <button
                className="rounded-full border border-phx-line px-2.5 py-1 text-xs font-bold text-phx-ink-2 underline"
                onClick={() => setShowAll(true)}
                type="button"
              >
                +{list.members.length - shown.length} more
              </button>
            ) : null}
            {list.externalEmails.map((email) => (
              <Chip key={email}>{email} (external)</Chip>
            ))}
          </div>
        )}

        {list.skipped.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-bold text-phx-ink-faint">Not reached:</span>
            {list.skipped.map((entry) => (
              <Chip key={entry.hrId} tone="warn">
                {entry.displayName} — {entry.reason === "no_work_email" ? "no work email" : "excluded"}
              </Chip>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AliasCard({
  alias,
  saving,
  onRecord,
}: {
  alias: AliasView;
  saving: boolean;
  onRecord: (emails: string) => void;
}) {
  const [draft, setDraft] = useState(alias.recordedMemberEmails.join("\n"));
  const leavers = alias.drift?.toRemove.filter((entry) => entry.reason === "left_company") ?? [];

  return (
    <div className="rounded-2xl border border-phx-line bg-white p-5 shadow-[0_10px_28px_rgba(15,23,42,0.06)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-base font-black text-phx-ink">
            <AtSign className="h-4 w-4 text-phx-accent" />
            {alias.aliasAddress}
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-phx-ink-soft">
            {alias.label}
            {alias.purpose ? ` — ${alias.purpose}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {alias.distributionListKey ? (
            <Chip>driven by {alias.distributionListKey}</Chip>
          ) : (
            <Chip tone="warn">no list drives this yet</Chip>
          )}
        </div>
      </div>

      {leavers.length > 0 ? (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-2.5">
          <p className="flex items-center gap-1.5 text-xs font-black text-rose-700">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {leavers.length} address{leavers.length === 1 ? "" : "es"} on this alias belong to nobody still employed
          </p>
          <p className="mt-1 text-xs text-rose-700">
            Remove {leavers.map((entry) => entry.email).join(", ")} in the Turbify control panel. A password reset does not
            close this — the app passwords survive it.
          </p>
        </div>
      ) : null}

      {alias.drift ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div>
            <p className="text-xs font-black uppercase tracking-wide text-phx-ink-2">Add by hand</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {alias.drift.toAdd.length === 0 ? (
                <span className="text-xs text-phx-ink-soft">Nothing to add.</span>
              ) : (
                alias.drift.toAdd.map((email) => <Chip key={email}>{email}</Chip>)
              )}
            </div>
          </div>
          <div>
            <p className="text-xs font-black uppercase tracking-wide text-phx-ink-2">Remove by hand</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {alias.drift.toRemove.length === 0 ? (
                <span className="text-xs text-phx-ink-soft">Nothing to remove.</span>
              ) : (
                alias.drift.toRemove.map((entry) => (
                  <Chip key={entry.email} tone={entry.reason === "left_company" ? "danger" : "neutral"}>
                    {entry.email}
                  </Chip>
                ))
              )}
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-phx-ink-soft">
          Point this alias at a distribution list to see what needs changing on it.
        </p>
      )}

      <div className="mt-4 border-t border-phx-line pt-3">
        <label className="text-xs font-black uppercase tracking-wide text-phx-ink-2" htmlFor={`record-${alias.aliasAddress}`}>
          What is actually on it
        </label>
        <p className="mt-1 text-xs text-phx-ink-faint">
          {alias.recordedAgeDays === null
            ? "Never recorded. Open the Turbify control panel, read the members, and paste them here."
            : `Last recorded ${alias.recordedAgeDays} day(s) ago${alias.recordedBy ? ` by ${alias.recordedBy}` : ""}. Nothing can verify this from here — it is what somebody said they saw.`}
        </p>
        <textarea
          className={`${phxTextareaClassName} mt-2`}
          id={`record-${alias.aliasAddress}`}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="one address per line"
          rows={3}
          value={draft}
        />
        <button
          className="mt-2 inline-flex h-[42px] items-center gap-1.5 rounded-lg bg-[#0B0B0B] px-4 text-phx-xs font-black text-white transition hover:bg-[#1E293B] disabled:opacity-50"
          disabled={saving}
          onClick={() => onRecord(draft)}
          type="button"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Record what I saw
        </button>
      </div>
    </div>
  );
}
