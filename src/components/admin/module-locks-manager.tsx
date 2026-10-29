"use client";

import * as React from "react";
import { AlertCircle, CheckCircle2, Loader2, Lock, LockOpen, RefreshCw, Search } from "lucide-react";

import { AdminCallout, AdminSectionHeader } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { LockableAccount } from "@/lib/auth/module-lock-accounts";
import type { ModuleLock } from "@/lib/auth/module-locks";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { moduleLabel } from "@/lib/navigation/module-catalog";
import { phxSelectClassName } from "@/components/ui/form-tokens";

type Props = {
  initialAccounts: LockableAccount[];
  initialActive: ModuleLock[];
  initialError: string | null;
  initialHistory: ModuleLock[];
};

/**
 * How long the lock stands. Presets rather than a bare date picker, because the honest answer is
 * almost always "for a while" — and a picker asks someone at their desk to do date arithmetic to
 * express it. "Until I release it" is first because it is the common case.
 */
const DURATION_OPTIONS = [
  { hours: 0, label: "Until I release it" },
  { hours: 1, label: "1 hour" },
  { hours: 4, label: "4 hours" },
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
] as const;

/** The chosen duration in words, for the sentence under the picker. */
function durationLabel(hours: number): string {
  return DURATION_OPTIONS.find((option) => option.hours === hours)?.label ?? `${hours} hours`;
}

function accountName(account: LockableAccount): string {
  return account.displayName ?? account.fullName ?? account.loginId;
}

function lockedUntilLabel(lock: ModuleLock): string {
  return lock.unlockAt ? cairoDateTime(lock.unlockAt) : "Until released";
}

export function ModuleLocksManager({
  initialAccounts,
  initialActive,
  initialError,
  initialHistory,
}: Props) {
  const [accounts, setAccounts] = React.useState(initialAccounts);
  const [active, setActive] = React.useState(initialActive);
  const [history, setHistory] = React.useState(initialHistory);
  const [error, setError] = React.useState<string | null>(initialError);
  const [notice, setNotice] = React.useState<string | null>(null);

  const [loginId, setLoginId] = React.useState("");
  const [picked, setPicked] = React.useState<string[]>([]);
  const [durationHours, setDurationHours] = React.useState(0);
  const [note, setNote] = React.useState("");
  const [moduleSearch, setModuleSearch] = React.useState("");

  const [saving, setSaving] = React.useState(false);
  const [releasing, setReleasing] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const account = accounts.find((row) => row.loginId === loginId) ?? null;

  // Modules already locked on the chosen account, so the list can say so instead of offering a
  // lock that would silently overwrite the standing one.
  const lockedKeysForAccount = React.useMemo(() => {
    const target = loginId.toLowerCase();
    return new Set(
      active.filter((lock) => lock.loginId.toLowerCase() === target).map((lock) => lock.moduleKey),
    );
  }, [active, loginId]);

  const visibleModules = React.useMemo(() => {
    if (!account) return [];
    const query = moduleSearch.trim().toLowerCase();
    if (!query) return account.modules;
    return account.modules.filter((module) => module.label.toLowerCase().includes(query));
  }, [account, moduleSearch]);

  function selectAccount(nextLoginId: string) {
    setLoginId(nextLoginId);
    setPicked([]);
    setModuleSearch("");
    setNotice(null);
    setError(null);
  }

  function toggleModule(key: string) {
    setPicked((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));
  }

  async function refresh() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/module-locks");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = (await response.json()) as {
        accounts: LockableAccount[];
        active: ModuleLock[];
        history: ModuleLock[];
      };
      setAccounts(json.accounts ?? []);
      setActive(json.active ?? []);
      setHistory(json.history ?? []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function applyLocks() {
    if (!account || picked.length === 0) return;
    setSaving(true);
    setError(null);
    setNotice(null);

    const unlockAt =
      durationHours > 0 ? new Date(Date.now() + durationHours * 3600_000).toISOString() : null;

    try {
      // One request per module rather than one carrying a list: a refusal then names the module it
      // refused, and a module that goes through is not undone by a later one that does not.
      for (const moduleKey of picked) {
        const response = await fetch("/api/admin/module-locks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Deliberately does NOT send the target's role or anything else the guard depends on.
          // The server reads the account's role from the database — a client that states its own
          // target's role is a guard the client can switch off by omitting a field.
          body: JSON.stringify({
            loginId: account.loginId,
            moduleKey,
            note: note.trim() || null,
            unlockAt,
          }),
        });
        if (!response.ok) {
          const json = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
          throw new Error(json.error ?? json.message ?? `HTTP ${response.status}`);
        }
      }

      const count = picked.length;
      setNotice(
        `${count === 1 ? moduleLabel(picked[0]) : `${count} modules`} locked for ${accountName(account)}.`,
      );
      setPicked([]);
      setNote("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function release(lock: ModuleLock) {
    setReleasing(lock.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/module-locks?id=${encodeURIComponent(lock.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const json = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(json.error ?? json.message ?? `HTTP ${response.status}`);
      }
      setNotice(`${moduleLabel(lock.moduleKey)} released for ${lock.loginId}.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setReleasing(null);
    }
  }

  const nameByLoginId = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const row of accounts) map.set(row.loginId.toLowerCase(), accountName(row));
    return map;
  }, [accounts]);

  function personLabel(lock: ModuleLock): string {
    return nameByLoginId.get(lock.loginId.toLowerCase()) ?? lock.loginId;
  }

  return (
    <div className="space-y-6 p-6">
      <AdminSectionHeader
        action={
          <Button aria-label="Refresh" disabled={loading} onClick={refresh} size="sm" variant="outline">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        }
        description="Temporarily close a module on one account. The person keeps the tab in their sidebar — it carries a padlock — and any page in that module tells them it is locked by the system administrator. Nothing about their permissions changes, so releasing the lock puts everything back exactly as it was."
        title="Temporary Module Locks"
      />

      {error ? (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </AdminCallout>
      ) : null}

      {notice ? (
        <AdminCallout tone="success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </AdminCallout>
      ) : null}

      <Card className="p-5">
        <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Lock a module</h3>

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <label className="mb-1.5 block text-phx-xs font-bold uppercase tracking-wider text-slate-400" htmlFor="module-lock-account">
              Account
            </label>
            {/* maxResults defaults to 100 and this company has more logins than that — an account
                past the hundredth would simply not be in the list until you typed. */}
            <SearchableSelect
              className="w-full"
              id="module-lock-account"
              maxResults={1000}
              onChange={(event) => selectAccount(event.target.value)}
              value={loginId}
            >
              <option value="">Choose a person…</option>
              {accounts.map((row) => (
                <option key={row.loginId} value={row.loginId}>
                  {`${accountName(row)} — ${row.role ?? "No role"} (${row.loginId})`}
                </option>
              ))}
            </SearchableSelect>
          </div>

          <div>
            <label className="mb-1.5 block text-phx-xs font-bold uppercase tracking-wider text-slate-400" htmlFor="module-lock-duration">
              How long
            </label>
            <select
              className={phxSelectClassName}
              id="module-lock-duration"
              onChange={(event) => setDurationHours(Number(event.target.value))}
              value={durationHours}
            >
              {DURATION_OPTIONS.map((option) => (
                <option key={option.hours} value={option.hours}>
                  {option.label}
                </option>
              ))}
            </select>
            {/*
              Worded RELATIVE to the moment the lock is applied, not as an absolute instant. The
              unlock time is computed when Lock is pressed, so a clock shown while the form sits
              open would drift away from the time actually stored — and reading Date.now() during
              render is impure besides (react-hooks/purity). "4 hours after you lock it" is exactly
              what happens, however long this form has been sitting here.
            */}
            <p className="mt-1.5 text-phx-2xs text-slate-400">
              {durationHours > 0
                ? `Reopens on its own ${durationLabel(durationHours)} after you lock it.`
                : "Stays locked until you release it here."}
            </p>
          </div>
        </div>

        {account ? (
          <div className="mt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-phx-xs font-bold uppercase tracking-wider text-slate-400">
                {`Modules ${accountName(account)} normally opens`}
              </p>
              <div className="relative w-full sm:w-64">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  aria-label="Search modules"
                  className="h-8 pl-9"
                  onChange={(event) => setModuleSearch(event.target.value)}
                  placeholder="Search modules…"
                  value={moduleSearch}
                />
              </div>
            </div>

            {account.modules.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                This account&apos;s role opens no lockable module.
              </p>
            ) : (
              <div className="mt-3 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {visibleModules.map((module) => {
                  const alreadyLocked = lockedKeysForAccount.has(module.key);
                  return (
                    <label
                      className={`flex cursor-pointer items-center gap-2.5 rounded border px-3 py-2 text-sm transition ${
                        picked.includes(module.key)
                          ? "border-amber-300 bg-amber-50 text-amber-900"
                          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                      }`}
                      key={module.key}
                    >
                      <input
                        checked={picked.includes(module.key)}
                        className="h-3.5 w-3.5 shrink-0 accent-amber-500"
                        onChange={() => toggleModule(module.key)}
                        type="checkbox"
                      />
                      <span className="whitespace-nowrap font-semibold">{module.label}</span>
                      {alreadyLocked ? (
                        <span className="ml-auto whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-phx-2xs font-bold uppercase tracking-wider text-amber-700">
                          Locked
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            )}

            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <div>
                <label className="mb-1.5 block text-phx-xs font-bold uppercase tracking-wider text-slate-400" htmlFor="module-lock-note">
                  Note shown to them (optional)
                </label>
                <Input
                  id="module-lock-note"
                  maxLength={180}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="e.g. Closed while the August payroll is being finalised."
                  value={note}
                />
              </div>
              <Button
                className="gap-2"
                disabled={saving || picked.length === 0}
                onClick={applyLocks}
                type="button"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
                {picked.length > 1 ? `Lock ${picked.length} modules` : "Lock module"}
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-4 text-sm text-slate-500">Choose a person to see the modules they normally open.</p>
        )}
      </Card>

      <Card className="p-5">
        <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">
          {`Locked right now (${active.length})`}
        </h3>

        {active.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No module is locked on any account.</p>
        ) : (
          <>
            {/* Desktop: the full table. */}
            <div className="mt-3 hidden lg:block">
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col className="w-[20%]" />
                  <col className="w-[18%]" />
                  <col className="w-[24%]" />
                  <col className="w-[28%]" />
                  <col className="w-[10%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-slate-100 text-left text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
                    <th className="pb-2 pr-4">Person</th>
                    <th className="pb-2 pr-4">Module</th>
                    <th className="pb-2 pr-4">Locked · until</th>
                    <th className="pb-2 pr-4">By · note</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {active.map((lock) => (
                    <tr className="align-top" key={lock.id}>
                      <td className="break-words py-3 pr-4 font-medium text-slate-900">{personLabel(lock)}</td>
                      <td className="break-words py-3 pr-4 font-semibold text-amber-700">
                        {moduleLabel(lock.moduleKey)}
                      </td>
                      <td className="break-words py-3 pr-4 text-slate-600">
                        <p>{cairoDateTime(lock.lockedAt)}</p>
                        <p className="text-phx-xs text-slate-500">{lockedUntilLabel(lock)}</p>
                      </td>
                      <td className="break-words py-3 pr-4 text-slate-600">
                        <p>{lock.lockedByName ?? "—"}</p>
                        {lock.note ? <p className="text-phx-xs text-slate-500">{lock.note}</p> : null}
                      </td>
                      <td className="py-3">
                        <Button
                          className="gap-1.5"
                          disabled={releasing === lock.id}
                          onClick={() => release(lock)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {releasing === lock.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <LockOpen className="h-3.5 w-3.5" />
                          )}
                          Release
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile: cards, never a table — the admin shell's standing rule. */}
            <div className="mt-3 space-y-2 lg:hidden">
              {active.map((lock) => (
                <div className="rounded-xl border border-slate-200 bg-white p-3" key={lock.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900">{personLabel(lock)}</p>
                    </div>
                    <span className="whitespace-nowrap rounded bg-amber-50 px-2 py-0.5 text-phx-xs font-bold text-amber-700">
                      {moduleLabel(lock.moduleKey)}
                    </span>
                  </div>
                  <p className="mt-2 text-phx-xs text-slate-500">
                    {`Locked ${cairoDateTime(lock.lockedAt)} · ${lockedUntilLabel(lock)}${lock.lockedByName ? ` · by ${lock.lockedByName}` : ""}`}
                  </p>
                  {lock.note ? <p className="mt-1 text-phx-xs text-slate-600">{lock.note}</p> : null}
                  <Button
                    className="mt-3 w-full gap-1.5"
                    disabled={releasing === lock.id}
                    onClick={() => release(lock)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {releasing === lock.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <LockOpen className="h-3.5 w-3.5" />
                    )}
                    Release
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      {history.length > 0 ? (
        <Card className="p-5">
          <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Released recently</h3>
          <div className="mt-3 space-y-1.5">
            {history.slice(0, 15).map((lock) => (
              <p className="break-words text-phx-xs text-slate-500" key={lock.id}>
                {`${moduleLabel(lock.moduleKey)} · ${personLabel(lock)} · locked ${cairoDateTime(lock.lockedAt)}${
                  lock.releasedAt ? ` · released ${cairoDateTime(lock.releasedAt)}` : " · expired on its own"
                }${lock.releasedByName ? ` by ${lock.releasedByName}` : ""}`}
              </p>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
