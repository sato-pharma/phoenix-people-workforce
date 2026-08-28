"use client";

import { useMemo, useState, useTransition } from "react";

import { Card } from "@/components/ui/card";
import type { AccountActivationRow } from "@/lib/recruitment/account-activation";

type AccountActivationWorkspaceProps = {
  initialUsers: AccountActivationRow[];
};

export function AccountActivationWorkspace({ initialUsers }: AccountActivationWorkspaceProps) {
  const [users, setUsers] = useState(initialUsers);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingLoginId, setPendingLoginId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return users;
    return users.filter(
      (user) =>
        user.loginId.toLowerCase().includes(needle) ||
        user.name.toLowerCase().includes(needle) ||
        user.role.toLowerCase().includes(needle),
    );
  }, [search, users]);

  function toggle(user: AccountActivationRow) {
    setError(null);
    setPendingLoginId(user.loginId);
    startTransition(async () => {
      try {
        const response = await fetch("/api/employee-portal/account-activation", {
          body: JSON.stringify({ isActive: !user.isActive, loginId: user.loginId }),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.message || "Failed to update account status.");
        }
        setUsers(payload.users as AccountActivationRow[]);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Failed to update account status.");
      } finally {
        setPendingLoginId(null);
      }
    });
  }

  return (
    <div className="space-y-4">
      <Card className="rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
        <label className="mb-2 block text-phx-xs font-semibold uppercase tracking-wider text-slate-400" htmlFor="account-activation-search">
          Search
        </label>
        <input
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-orange-300 focus:shadow-[0_0_0_3px_rgba(249,115,22,0.08)]"
          id="account-activation-search"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by login, name, or role..."
          type="text"
          value={search}
        />
      </Card>

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
          {error}
        </div>
      ) : null}

      <Card className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
        <div className="border-b border-gray-100 px-4 py-4 sm:px-6">
          <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">Accounts</p>
          <h2 className="mt-1 text-base font-semibold text-slate-900">{filtered.length} matching</h2>
          <p className="mt-0.5 text-phx-xs font-medium text-slate-400">
            Super Admin, CEO, and Talent Acquisition accounts are never listed here.
          </p>
        </div>
        <div className="divide-y divide-gray-100">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate-500 sm:px-6">No matching accounts.</p>
          ) : (
            filtered.map((user) => (
              <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6" key={user.loginId}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">{user.name}</p>
                  <p className="truncate text-xs text-slate-500">
                    {user.loginId} · {user.role}
                  </p>
                </div>
                <button
                  className={`shrink-0 rounded-md border px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
                    user.isActive
                      ? "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                      : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                  }`}
                  disabled={isPending && pendingLoginId === user.loginId}
                  onClick={() => toggle(user)}
                  type="button"
                >
                  {isPending && pendingLoginId === user.loginId ? "Working..." : user.isActive ? "Deactivate" : "Activate"}
                </button>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
