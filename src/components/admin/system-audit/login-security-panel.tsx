"use client";

import { Globe, KeyRound, Loader2, Lock, Search, ShieldAlert, UsersRound } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import { AdminInsightChip, AdminStatCard, AdminTableShell } from "@/components/admin/admin-design-system";
import { FormField } from "@/components/ui/form-kit";
import {
  phxButtonDangerDenseClassName,
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxFieldClassName,
} from "@/components/ui/form-tokens";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import type { LoginSecurityOverview } from "@/lib/security/login-security";
import { cn } from "@/lib/utils";

/**
 * Login security on the System Audit page — what the retired Monitoring and System Issues pages
 * showed about sign-in, moved here on 23 Oct 2026 without their silent failures:
 *
 * - a figure that could not be read says "Unavailable", never 0 (the old tiles turned a failed
 *   read into a zero, and a security list into "all clear");
 * - every count is exact — the old failed sign-in count stopped at 1,000 rows;
 * - every name is a person's name, never a login or HR id.
 *
 * Data comes in as props (loaded on the server by `loadLoginSecurityOverview`); the search box, the
 * pager and the Block / Unblock buttons talk to /api/admin/system-audit/security and
 * /api/admin/system-audit/block-ip.
 *
 * A suspicious address also says how many people signed in SUCCESSFULLY from it. Three accounts
 * failing from one address is what an office or a mobile network looks like on an ordinary morning,
 * so when two or more people got in from it, Block asks a second time, here in the panel, before
 * anything is sent — and the server refuses the block (409) without that second press anyway
 * (deep audit, 17 Nov 2026).
 */

/** How long a block from this screen lasts. Sent explicitly so the button text and the block agree. */
const BLOCK_DAYS = 30;

const UNAVAILABLE = "Unavailable";

function countValue(value: number | null) {
  return value === null ? UNAVAILABLE : value.toLocaleString("en-US");
}

function personName(name: string | null) {
  return name ?? "Account not in the directory";
}

function LensUnavailable({ what }: { what: string }) {
  return (
    <p className="px-4 py-4 text-sm font-semibold text-rose-700">
      Unavailable — {what} could not be read, so this list is not known to be empty.
    </p>
  );
}

function LensEmpty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-4 text-sm text-slate-500">{children}</p>;
}

function Flag({ children, tone }: { children: ReactNode; tone: "rose" | "slate" }) {
  return (
    <span
      className={cn(
        "ml-2 inline-block border px-1.5 py-0.5 align-middle text-phx-xs font-bold uppercase tracking-[0.08em]",
        tone === "rose" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-slate-300 bg-slate-50 text-slate-600",
      )}
    >
      {children}
    </span>
  );
}

/** "no one signed in successfully" / "1 person signed in successfully" / "3 people …", from it. */
function successfulSignInsLine(count: number) {
  if (count === 0) return "no one signed in successfully from it";
  return `${count.toLocaleString("en-US")} ${count === 1 ? "person" : "people"} signed in successfully from it`;
}

/** The address waiting on the second press, and the count that made it wait. */
type SharedBlock = { ip: string; people: number; reason: string | undefined };

function DenseButton({
  children,
  disabled,
  onClick,
  tone,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  tone: "danger" | "ghost";
}) {
  return (
    <button
      className={cn(
        "inline-flex h-8 items-center gap-1.5 border px-3 text-xs font-bold transition disabled:opacity-50",
        tone === "danger" ? phxButtonDangerDenseClassName : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100",
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

export function LoginSecurityPanel({ overview: initialOverview }: { overview: LoginSecurityOverview }) {
  const [overview, setOverview] = useState<LoginSecurityOverview>(initialOverview);
  const [searchDraft, setSearchDraft] = useState(initialOverview.recentActivity?.search ?? "");
  const [loading, setLoading] = useState(false);
  const [busyIp, setBusyIp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sharedBlock, setSharedBlock] = useState<SharedBlock | null>(null);

  const signals = overview.signals;
  const activity = overview.recentActivity;
  const signalsDown = new Set(signals.unavailable);
  const attemptsDown = signals.unavailable.some((label) => label.startsWith("Sign-in attempts"));
  const locationsDown = attemptsDown || signalsDown.has("Known sign-in locations");
  const lockedDown = signalsDown.has("Locked accounts");
  const blockedDown = signalsDown.has("Blocked IP list");

  async function refresh(page: number, search: string) {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (search.trim()) params.set("search", search.trim());
      const response = await fetch(`/api/admin/system-audit/security?${params.toString()}`, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { overview?: LoginSecurityOverview; message?: string } | null;
      if (!response.ok || !body?.overview) {
        throw new Error(body?.message ?? "Login security could not be refreshed.");
      }
      setOverview(body.overview);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Login security could not be refreshed.");
    } finally {
      setLoading(false);
    }
  }

  /**
   * The first press on Block. A shared address (2+ people got in from it) never sends from here: it
   * opens the in-panel question, and only "Block anyway" sends, with confirmShared.
   */
  function requestBlock(ip: string, reason: string, successfulAccounts: number, sharedNetwork: boolean) {
    const confirmed = window.confirm(
      `Block ${ip} from signing in for ${BLOCK_DAYS} days? Anyone signing in from this address will be refused. It can be unblocked here at any time.`,
    );
    if (!confirmed) return;
    if (sharedNetwork) {
      setError(null);
      setNotice(null);
      setSharedBlock({ ip, people: successfulAccounts, reason });
      return;
    }
    void manageIp(ip, "block", reason);
  }

  async function manageIp(ip: string, action: "block" | "unblock", reason?: string, confirmShared = false) {
    setBusyIp(ip);
    setError(null);
    setNotice(null);
    try {
      const blockBody = { action, days: BLOCK_DAYS, ip, reason };
      const response = await fetch("/api/admin/system-audit/block-ip", {
        body: JSON.stringify(action === "block" ? (confirmShared ? { ...blockBody, confirmShared: true } : blockBody) : { action, ip }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string; message?: string; successfulAccounts?: number }
          | null;
        // The server counted 2+ people since this screen was read: ask the same second question.
        if (response.status === 409 && body?.error === "shared_address" && typeof body.successfulAccounts === "number") {
          setSharedBlock({ ip, people: body.successfulAccounts, reason });
          return;
        }
        throw new Error(body?.message ?? "The block list could not be updated.");
      }
      setSharedBlock(null);
      setNotice(action === "block" ? `${ip} is blocked for ${BLOCK_DAYS} days.` : `${ip} is unblocked.`);
      await refresh(activity?.page ?? 1, activity?.search ?? "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The block list could not be updated.");
    } finally {
      setBusyIp(null);
    }
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void refresh(1, searchDraft);
  }

  const lensSignalCount =
    signals.lockedAccounts.length + signals.hammeredAccounts.length + signals.bruteForceIps.length + signals.newLocationLogins.length;

  return (
    <section className="@container space-y-5" id="login-security">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="mt-1 h-9 w-1.5 shrink-0 bg-gradient-to-b from-orange-500 to-amber-400" />
          <div>
            <p className="text-phx-xs font-bold uppercase tracking-[0.22em] text-orange-600">Sign-in protection</p>
            <h2 className="mt-1 text-xl font-bold tracking-[-0.025em] text-slate-950">Login security</h2>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AdminInsightChip tone="slate">Read {cairoDateTime(overview.generatedAt)}</AdminInsightChip>
          <button
            className={phxButtonGhostClassName}
            disabled={loading}
            onClick={() => void refresh(activity?.page ?? 1, activity?.search ?? "")}
            type="button"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Refresh
          </button>
        </div>
      </div>

      {error ? (
        <p className="border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-800" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800" role="status">
          {notice}
        </p>
      ) : null}
      {overview.unavailable.length > 0 ? (
        <div className="border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">
          <p className="font-bold">Some sources could not be read. Their figures say “Unavailable”, never zero:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {overview.unavailable.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-2 @min-[960px]:grid-cols-4">
        <AdminStatCard
          description="Accounts locked out right now after repeated failed sign-ins."
          icon={<Lock className="h-4 w-4" />}
          label="Locked accounts"
          size="compact"
          tone="rose"
          value={countValue(overview.lockedAccounts)}
        />
        <AdminStatCard
          description="Accounts that must set a new password at their next sign-in."
          icon={<KeyRound className="h-4 w-4" />}
          label="Forced password resets"
          size="compact"
          tone="violet"
          value={countValue(overview.forcedPasswordResets)}
        />
        <AdminStatCard
          description="Failed sign-in attempts in the last 24 hours, counted exactly."
          icon={<ShieldAlert className="h-4 w-4" />}
          label="Failed sign-ins (24 hours)"
          size="compact"
          tone="orange"
          value={countValue(overview.failedSignIns24h)}
        />
        <AdminStatCard
          description="Different internet addresses those failed attempts came from."
          icon={<Globe className="h-4 w-4" />}
          label="Addresses behind them"
          size="compact"
          tone="blue"
          value={countValue(overview.distinctFailedIps24h)}
        />
      </div>

      <AdminTableShell
        description={`Patterns in the last ${signals.windowDays} days of sign-in attempts. A new location means an address not seen for that account in the ${signals.baselineDays} days before. Times are Cairo.`}
        title="Security lens"
        action={
          attemptsDown ? (
            <AdminInsightChip tone="slate">Unavailable</AdminInsightChip>
          ) : (
            <AdminInsightChip tone={lensSignalCount > 0 ? "orange" : "emerald"}>
              {lensSignalCount > 0 ? `${lensSignalCount} signals` : "No signals"}
            </AdminInsightChip>
          )
        }
      >
        <div className="grid grid-cols-1 @min-[960px]:grid-cols-2">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-phx-xs font-bold uppercase tracking-[0.16em] text-rose-700">
              <Lock className="h-3.5 w-3.5 shrink-0" /> Locked right now
            </h3>
            {lockedDown ? (
              <LensUnavailable what="the locked accounts" />
            ) : signals.lockedAccounts.length === 0 ? (
              <LensEmpty>No account is locked.</LensEmpty>
            ) : (
              <ul className="divide-y divide-slate-200">
                {signals.lockedAccounts.map((account) => (
                  <li className="px-4 py-2.5" key={`locked-${account.hrId}`}>
                    <p className="break-words text-sm font-bold text-slate-950">{personName(account.name)}</p>
                    <p className="text-xs font-semibold text-rose-700">
                      {account.failedAttempts} failed attempts · locked until {cairoDateTime(account.lockedUntil)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="min-w-0 border-t border-slate-200 @min-[960px]:border-t-0 @min-[960px]:border-l">
            <h3 className="flex items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-phx-xs font-bold uppercase tracking-[0.16em] text-amber-700">
              <UsersRound className="h-3.5 w-3.5 shrink-0" /> Accounts under repeated attack
            </h3>
            {attemptsDown ? (
              <LensUnavailable what="the sign-in attempts" />
            ) : signals.hammeredAccounts.length === 0 ? (
              <LensEmpty>No account drew repeated failed sign-ins.</LensEmpty>
            ) : (
              <ul className="divide-y divide-slate-200">
                {signals.hammeredAccounts.map((account) => (
                  <li className="px-4 py-2.5" key={`hammered-${account.hrId}`}>
                    <p className="break-words text-sm font-bold text-slate-950">
                      {personName(account.name)}
                      {account.distributed ? <Flag tone="rose">From many addresses</Flag> : null}
                    </p>
                    <p className="text-xs font-semibold text-amber-800">
                      {account.failCount} failed attempts from {account.distinctIps} addresses · last {cairoDateTime(account.lastSeen)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="min-w-0 border-t border-slate-200">
            <h3 className="flex items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-phx-xs font-bold uppercase tracking-[0.16em] text-amber-700">
              <Globe className="h-3.5 w-3.5 shrink-0" /> Suspicious addresses
            </h3>
            {attemptsDown ? (
              <LensUnavailable what="the sign-in attempts" />
            ) : signals.bruteForceIps.length === 0 ? (
              <LensEmpty>No address made repeated failed sign-ins.</LensEmpty>
            ) : (
              <ul className="divide-y divide-slate-200">
                {signals.bruteForceIps.map((entry) => (
                  <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5" key={`ip-${entry.ip}`}>
                    <div className="min-w-0">
                      <p className="break-all font-mono text-sm font-bold text-slate-950">
                        {entry.ip}
                        {entry.credentialStuffing ? <Flag tone="rose">Tried many accounts</Flag> : null}
                        {entry.blocked ? <Flag tone="slate">Blocked</Flag> : null}
                      </p>
                      <p className="text-xs font-semibold text-amber-800">
                        {entry.failCount} failed attempts on {entry.distinctAccounts} accounts · last {cairoDateTime(entry.lastSeen)}
                      </p>
                      <p className={cn("text-xs font-semibold", entry.sharedNetwork ? "text-rose-700" : "text-slate-600")}>
                        {successfulSignInsLine(entry.successfulAccounts)}
                        {entry.sharedNetwork ? " — probably an office or a mobile network" : ""}
                      </p>
                    </div>
                    {!entry.blocked && !blockedDown && sharedBlock?.ip !== entry.ip ? (
                      <DenseButton
                        disabled={busyIp === entry.ip}
                        onClick={() =>
                          requestBlock(
                            entry.ip,
                            `${entry.failCount} failed sign-ins on ${entry.distinctAccounts} accounts in ${signals.windowDays} days`,
                            entry.successfulAccounts,
                            entry.sharedNetwork,
                          )
                        }
                        tone="danger"
                      >
                        {busyIp === entry.ip ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                        Block for {BLOCK_DAYS} days
                      </DenseButton>
                    ) : null}
                    {sharedBlock?.ip === entry.ip ? (
                      <div className="w-full border border-rose-200 bg-rose-50 px-3 py-2.5" role="alert">
                        <p className="break-words text-sm font-semibold text-rose-800">
                          {sharedBlock.people.toLocaleString("en-US")} {sharedBlock.people === 1 ? "person" : "people"} signed in
                          successfully from this address — block it anyway?
                        </p>
                        <p className="mt-0.5 break-words text-xs text-rose-700">
                          Everyone signing in from it would be refused for {BLOCK_DAYS} days.
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <DenseButton
                            disabled={busyIp === entry.ip}
                            onClick={() => void manageIp(sharedBlock.ip, "block", sharedBlock.reason, true)}
                            tone="danger"
                          >
                            {busyIp === entry.ip ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                            Block anyway
                          </DenseButton>
                          <DenseButton disabled={busyIp === entry.ip} onClick={() => setSharedBlock(null)} tone="ghost">
                            Keep it open
                          </DenseButton>
                        </div>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="min-w-0 border-t border-slate-200 @min-[960px]:border-l">
            <h3 className="flex items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-phx-xs font-bold uppercase tracking-[0.16em] text-sky-700">
              <Globe className="h-3.5 w-3.5 shrink-0" /> Sign-ins from a new location
            </h3>
            {locationsDown ? (
              <LensUnavailable what="the sign-in locations" />
            ) : signals.newLocationLogins.length === 0 ? (
              <LensEmpty>Every successful sign-in came from a known address.</LensEmpty>
            ) : (
              <ul className="divide-y divide-slate-200">
                {signals.newLocationLogins.map((login, index) => (
                  <li className="px-4 py-2.5" key={`new-${login.hrId}-${login.ip}-${index}`}>
                    <p className="break-words text-sm font-bold text-slate-950">{personName(login.name)}</p>
                    <p className="break-all text-xs font-semibold text-sky-800">
                      <span className="font-mono">{login.ip}</span> · {cairoDateTime(login.at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </AdminTableShell>

      <AdminTableShell
        description={`Addresses refused at sign-in. A block from this screen lasts ${BLOCK_DAYS} days unless removed sooner. Times are Cairo.`}
        title="Blocked addresses"
      >
        {blockedDown ? (
          <LensUnavailable what="the block list" />
        ) : signals.blockedIps.length === 0 ? (
          <LensEmpty>No address is blocked.</LensEmpty>
        ) : (
          <ul className="divide-y divide-slate-200">
            {signals.blockedIps.map((blocked) => (
              <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5" key={`blocked-${blocked.ip}`}>
                <div className="min-w-0">
                  <p className="break-all font-mono text-sm font-bold text-slate-950">{blocked.ip}</p>
                  <p className="break-words text-xs font-semibold text-slate-600">
                    {blocked.expiresAt ? `Until ${cairoDateTime(blocked.expiresAt)}` : "No end date"}
                    {blocked.reason ? ` · ${blocked.reason}` : ""}
                  </p>
                </div>
                <DenseButton disabled={busyIp === blocked.ip} onClick={() => void manageIp(blocked.ip, "unblock")} tone="ghost">
                  {busyIp === blocked.ip ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Unblock
                </DenseButton>
              </li>
            ))}
          </ul>
        )}
      </AdminTableShell>

      <AdminTableShell
        description="Sign-ins, sign-outs and account changes, newest first. Search by a person's name or by words in the entry. Times are Cairo."
        title="Recent security activity"
      >
        <form className="flex flex-col gap-2 border-b border-slate-200 px-4 py-3 @min-[560px]:flex-row @min-[560px]:items-end" onSubmit={submitSearch}>
          <FormField className="flex-1" htmlFor="login-security-search" label="Search">
            <input
              className={phxFieldClassName}
              id="login-security-search"
              maxLength={120}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="A name or words in the entry"
              type="search"
              value={searchDraft}
            />
          </FormField>
          <button className={phxButtonPrimaryClassName} disabled={loading} type="submit">
            <Search className="h-4 w-4" />
            Search
          </button>
        </form>

        {!activity ? (
          <LensUnavailable what="the security activity" />
        ) : activity.rows.length === 0 ? (
          <LensEmpty>{activity.search ? `Nothing matches “${activity.search}”.` : "No security activity recorded."}</LensEmpty>
        ) : (
          <>
            <table className="hidden w-full table-fixed text-left @min-[820px]:table">
              <colgroup>
                <col className="w-[18%]" />
                <col className="w-[12%]" />
                <col className="w-[22%]" />
                <col className="w-[48%]" />
              </colgroup>
              <thead className="bg-slate-50 text-phx-xs font-bold uppercase tracking-[0.16em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Kind</th>
                  <th className="px-4 py-3">Person</th>
                  <th className="px-4 py-3">What happened</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {activity.rows.map((row) => (
                  <tr className="align-top" key={row.id}>
                    <td className="px-4 py-3 text-xs font-semibold text-slate-600">{row.createdAt ? cairoDateTime(row.createdAt) : "Time not recorded"}</td>
                    <td className="px-4 py-3 text-sm font-semibold text-slate-800">{row.kindLabel}</td>
                    <td className="break-words px-4 py-3 text-sm font-bold text-slate-950">
                      {row.actorName ?? (row.actorLoginId ? "Account not in the directory" : "System")}
                    </td>
                    <td className="px-4 py-3 text-sm leading-relaxed text-slate-700">
                      <p className="whitespace-pre-wrap break-words">{row.summary}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-slate-200 @min-[820px]:hidden">
              {activity.rows.map((row) => (
                <li className="space-y-1 px-4 py-3" key={row.id}>
                  <p className="text-sm font-bold text-slate-950">
                    {row.actorName ?? (row.actorLoginId ? "Account not in the directory" : "System")}
                    <span className="ml-2 text-xs font-semibold text-slate-500">{row.kindLabel}</span>
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">{row.summary}</p>
                  <p className="text-xs font-semibold text-slate-500">{row.createdAt ? cairoDateTime(row.createdAt) : "Time not recorded"}</p>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
              <p className="text-xs font-semibold text-slate-500">
                {activity.total.toLocaleString("en-US")} entries · page {activity.page} of {activity.pageCount}
              </p>
              {activity.pageCount > 1 ? (
                <div className="flex items-center gap-2">
                  <button
                    className={phxButtonGhostClassName}
                    disabled={loading || activity.page <= 1}
                    onClick={() => void refresh(activity.page - 1, activity.search)}
                    type="button"
                  >
                    Previous
                  </button>
                  <button
                    className={phxButtonGhostClassName}
                    disabled={loading || activity.page >= activity.pageCount}
                    onClick={() => void refresh(activity.page + 1, activity.search)}
                    type="button"
                  >
                    Next
                  </button>
                </div>
              ) : null}
            </div>
          </>
        )}
      </AdminTableShell>
    </section>
  );
}
