"use client";

import * as React from "react";
import { AlertCircle, CheckCircle2, Copy, KeyRound, Loader2, Power, RefreshCw, UserPlus, Users } from "lucide-react";

import { AdminCallout, AdminSectionHeader } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { TestAccount, TestAccountPerson, TestAccountsView } from "@/lib/admin/test-accounts";
import { cairoDateTime } from "@/lib/format/cairo-datetime";

type Props = {
  initial: TestAccountsView;
  initialError: string | null;
};

type PasswordLink = { loginId: string; setupUrl: string; expiresAt: string | null };

const LABEL = "mb-1.5 block text-phx-xs font-bold uppercase tracking-wider text-slate-400";

function personLine(person: TestAccountPerson): string {
  const place = [person.area, person.region].filter(Boolean).join(", ");
  return [person.jobTitle ?? person.role, place].filter(Boolean).join(" · ");
}

function personOption(person: TestAccountPerson): string {
  return `${person.name} — ${personLine(person)}`;
}

async function send(url: string, method: "POST" | "PATCH", body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method,
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(json.message ?? json.error ?? `HTTP ${response.status}`));
  return json;
}

export function TestAccountsManager({ initial, initialError }: Props) {
  const [accounts, setAccounts] = React.useState(initial.accounts);
  const [people, setPeople] = React.useState(initial.people);
  const [error, setError] = React.useState<string | null>(initialError);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);

  const [newLogin, setNewLogin] = React.useState("TEST-");
  const [newPerson, setNewPerson] = React.useState("");
  const [link, setLink] = React.useState<PasswordLink | null>(null);
  const [editing, setEditing] = React.useState<{ loginId: string; hrId: string } | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/test-accounts");
      const json = (await response.json().catch(() => ({}))) as Partial<TestAccountsView> & { message?: string };
      if (!response.ok) throw new Error(json.message ?? `HTTP ${response.status}`);
      setAccounts(json.accounts ?? []);
      setPeople(json.people ?? []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function run(key: string, action: () => Promise<string | null>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const message = await action();
      if (message) setNotice(message);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function makeLink(loginId: string): Promise<string> {
    const json = await send("/api/admin/test-accounts/password-link", "POST", { loginId });
    setLink({ loginId, setupUrl: String(json.setupUrl ?? ""), expiresAt: json.expiresAt ? String(json.expiresAt) : null });
    return `Password link ready for ${loginId}. Open it in a private window and choose the password.`;
  }

  function create() {
    const person = people.find((row) => row.hrId === newPerson);
    void run("create", async () => {
      const json = await send("/api/admin/test-accounts", "POST", { loginId: newLogin, mirrorsHrId: newPerson });
      const loginId = String(json.loginId ?? newLogin);
      setNewLogin("TEST-");
      setNewPerson("");
      await makeLink(loginId);
      return `${loginId} is ready and works as ${person?.name ?? "the person you chose"}. Open the password link below in a private window to choose its password.`;
    });
  }

  function repoint(account: TestAccount, hrId: string) {
    const person = people.find((row) => row.hrId === hrId);
    void run(`repoint:${account.loginId}`, async () => {
      await send("/api/admin/test-accounts", "PATCH", { loginId: account.loginId, mirrorsHrId: hrId });
      setEditing(null);
      return `${account.loginId} now works as ${person?.name ?? "the person you chose"}. Its open sessions ended; sign in again.`;
    });
  }

  function toggle(account: TestAccount) {
    void run(`toggle:${account.loginId}`, async () => {
      await send("/api/admin/test-accounts", "PATCH", { loginId: account.loginId, isActive: !account.isActive });
      return account.isActive ? `${account.loginId} is switched off; it can no longer sign in.` : `${account.loginId} is switched on.`;
    });
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.setupUrl);
      setNotice("Password link copied.");
    } catch {
      setError("The browser would not copy the link. Select it and copy it by hand.");
    }
  }

  function personPicker(id: string, value: string, onChange: (hrId: string) => void) {
    return (
      // maxResults is the whole list plus the placeholder row: the default 100 hides people, and a fixed number only moves the cliff.
      <SearchableSelect className="w-full" id={id} maxResults={people.length + 1} onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">Choose a person…</option>
        {people.map((person) => (
          <option key={person.hrId} value={person.hrId}>
            {personOption(person)}
          </option>
        ))}
      </SearchableSelect>
    );
  }

  function worksAs(account: TestAccount) {
    if (!account.mirrors) return <p className="text-sm font-semibold text-red-700">Nobody — this account cannot sign in until you choose a person.</p>;
    return (
      <>
        <p className="font-semibold text-slate-900">{account.mirrors.name}</p>
        <p className="text-phx-xs text-slate-500">{personLine(account.mirrors)}</p>
      </>
    );
  }

  function actions(account: TestAccount, stacked: boolean) {
    const isEditing = editing?.loginId === account.loginId;
    if (isEditing && editing) {
      return (
        <div className="space-y-2">
          {personPicker(`test-account-repoint-${account.loginId}`, editing.hrId, (hrId) => setEditing({ loginId: account.loginId, hrId }))}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!editing.hrId || busy === `repoint:${account.loginId}`}
              onClick={() => repoint(account, editing.hrId)}
              size="sm"
              type="button"
            >
              {busy === `repoint:${account.loginId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save person
            </Button>
            <Button onClick={() => setEditing(null)} size="sm" type="button" variant="outline">
              Cancel
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className={stacked ? "grid gap-2" : "flex flex-wrap gap-2"}>
        <Button
          className="gap-1.5"
          disabled={!account.isActive || busy === `link:${account.loginId}`}
          onClick={() => void run(`link:${account.loginId}`, () => makeLink(account.loginId))}
          size="sm"
          type="button"
          variant="outline"
        >
          {busy === `link:${account.loginId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
          Password link
        </Button>
        <Button
          className="gap-1.5"
          onClick={() => setEditing({ loginId: account.loginId, hrId: account.mirrors?.hrId ?? "" })}
          size="sm"
          type="button"
          variant="outline"
        >
          <Users className="h-3.5 w-3.5" />
          Change person
        </Button>
        <Button
          className="gap-1.5"
          disabled={busy === `toggle:${account.loginId}`}
          onClick={() => toggle(account)}
          size="sm"
          type="button"
          variant="outline"
        >
          {busy === `toggle:${account.loginId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
          {account.isActive ? "Switch off" : "Switch on"}
        </Button>
      </div>
    );
  }

  function status(account: TestAccount) {
    if (!account.isActive) return "Switched off";
    return account.passwordSet ? "Ready" : "Waiting for its password";
  }

  return (
    <div className="space-y-6 p-6">
      <AdminSectionHeader
        action={
          <Button aria-label="Refresh" disabled={loading} onClick={refresh} size="sm" variant="outline">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        }
        description="A test account is your own login that lives inside a real person's employee portal: it opens exactly what they see, with their data. Nothing it does is saved as them. Phoenix CRM files its visits, plans, requests and decisions as test entries, which never reach a real report, and every other screen refuses to save. Make one for a rep and one for the rep's manager, and the two can work a plan through together."
        title="Test Accounts"
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

      {link ? (
        <Card className="p-5">
          <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">{`Password link for ${link.loginId}`}</h3>
          <p className="mt-2 text-sm text-slate-600">
            Open it in a private window — signing in here would replace your own session. It works once
            {link.expiresAt ? `, until ${cairoDateTime(link.expiresAt)}` : ""}. Then sign in with {link.loginId} and the password you chose.
          </p>
          <p className="mt-3 break-all border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-phx-xs text-slate-700">{link.setupUrl}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button className="gap-1.5" onClick={() => void copyLink()} size="sm" type="button" variant="outline">
              <Copy className="h-3.5 w-3.5" />
              Copy link
            </Button>
            <Button onClick={() => setLink(null)} size="sm" type="button" variant="outline">
              Done
            </Button>
          </div>
        </Card>
      ) : null}

      <Card className="p-5">
        <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Make a test account</h3>
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_auto] lg:items-end">
          <div>
            <label className={LABEL} htmlFor="test-account-login">
              Its login
            </label>
            <Input
              autoComplete="off"
              id="test-account-login"
              maxLength={35}
              onChange={(event) => setNewLogin(event.target.value.toUpperCase())}
              placeholder="TEST-AYA"
              value={newLogin}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="test-account-person">
              Works as
            </label>
            {personPicker("test-account-person", newPerson, setNewPerson)}
          </div>
          <Button className="gap-2" disabled={busy === "create" || !newPerson || newLogin.trim().length <= 5} onClick={create} type="button">
            {busy === "create" ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            Make test account
          </Button>
        </div>
        <p className="mt-2 text-phx-sm text-slate-400">
          Only people with an active employee-portal login can be chosen, so a test account always opens in the employee portal.
        </p>
      </Card>

      <Card className="p-5">
        <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">{`Test accounts (${accounts.length})`}</h3>

        {accounts.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No test account yet.</p>
        ) : (
          <>
            {/* Desktop: the full table, fitted to the width — never a horizontal scroll. */}
            <table className="mt-3 hidden w-full table-fixed text-sm lg:table">
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[30%]" />
                <col className="w-[16%]" />
                <col className="w-[32%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-100 text-left text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="pb-2 pr-4">Test account</th>
                  <th className="pb-2 pr-4">Works as</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {accounts.map((account) => (
                  <tr className="align-top" key={account.loginId}>
                    <td className="break-words py-3 pr-4">
                      <p className="font-semibold text-slate-900">{account.loginId}</p>
                      {account.updatedAt ? <p className="text-phx-xs text-slate-400">{`Changed ${cairoDateTime(account.updatedAt)}`}</p> : null}
                    </td>
                    <td className="break-words py-3 pr-4">{worksAs(account)}</td>
                    <td className="break-words py-3 pr-4 text-slate-700">{status(account)}</td>
                    <td className="py-3">{actions(account, false)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Mobile: cards, never a table — the admin shell's standing rule. */}
            <div className="mt-3 space-y-2 lg:hidden">
              {accounts.map((account) => (
                <div className="border border-slate-200 bg-white p-3" key={account.loginId}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="font-semibold text-slate-900">{account.loginId}</p>
                    <span className="text-phx-xs font-bold text-slate-600">{status(account)}</span>
                  </div>
                  <div className="mt-2">{worksAs(account)}</div>
                  <div className="mt-3">{actions(account, true)}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
