import type { EmailActivityData } from "@/lib/email/engagement";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

// Presentational, server-rendered. Filters use a plain GET form (no client JS): submitting
// re-renders the page with new search params.

type Filters = { activity: "all" | "bounced" | "clicked" | "not_sent" | "opened"; days: number; provider: "all" | "brevo" | "resend"; search: string };

const cairoFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
});

function formatCairo(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : cairoFormatter.format(date);
}

// A lifecycle stage cell: green tick when reached, muted dash otherwise.
function Stage({ on, label }: { on: boolean; label: string }) {
  return on ? (
    <span className="inline-flex items-center bg-phx-ok-bg px-2 py-0.5 text-xs font-medium text-phx-ok">✓ {label}</span>
  ) : (
    <span className="inline-flex items-center bg-phx-paper px-2 py-0.5 text-xs text-phx-ink-soft">— {label}</span>
  );
}

export function EmailEngagementView({ data, filters }: { data: EmailActivityData; filters: Filters }) {
  return (
    <section className="space-y-4">
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Search person, email or subject
          <input className={cn(phxFieldClassName, "w-72")} defaultValue={filters.search} name="search" placeholder="e.g. Anwar, payslip…" type="text" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Provider
          <select className={phxSelectClassName} defaultValue={filters.provider} name="provider">
            <option value="all">All</option>
            <option value="resend">Resend</option>
            <option value="brevo">Brevo</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Activity
          <select className={phxSelectClassName} defaultValue={filters.activity} name="activity">
            <option value="all">All</option>
            <option value="opened">Opened</option>
            <option value="clicked">Clicked</option>
            <option value="not_sent">Not sent</option>
            <option value="bounced">Bounced / failed</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Window
          <select className={phxSelectClassName} defaultValue={String(filters.days)} name="days">
            <option value="1">Last 24h</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </label>
        <button className="h-9 rounded-md bg-slate-900 px-4 text-sm font-medium text-white" type="submit">Apply</button>
      </form>

      <div className="border border-slate-200 bg-white">
        <table className="hidden w-full table-fixed border-collapse text-left text-sm md:table">
          <colgroup>
            <col className="w-[24%]" />
            <col className="w-[26%]" />
            <col className="w-[8%]" />
            <col className="w-[24%]" />
            <col className="w-[18%]" />
          </colgroup>
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-3">Person</th>
              <th className="px-3 py-3">Email subject</th>
              <th className="px-3 py-3">Via</th>
              <th className="px-3 py-3">Situation</th>
              <th className="px-3 py-3">Last activity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.rows.length === 0 ? (
              <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={5}>No emails in this window.</td></tr>
            ) : (
              data.rows.map((row) => {
                const notSent = row.sendStatus !== "sent";
                return (
                  <tr key={row.id} className="align-top">
                    <td className="min-w-0 break-words px-3 py-3">
                      <div className="font-medium text-slate-900">{row.recipientName ?? row.recipientEmail}</div>
                      {row.recipientName ? <div className="text-xs text-slate-500">{row.recipientEmail}</div> : null}
                    </td>
                    <td className="min-w-0 break-words px-3 py-3 text-slate-700">{row.subject ?? "—"}</td>
                    <td className="min-w-0 break-words px-3 py-3 capitalize text-slate-600">{row.provider}</td>
                    <td className="min-w-0 break-words px-3 py-3">
                      {notSent ? (
                        <div>
                          <span className="inline-flex items-center bg-phx-danger-bg px-2 py-0.5 text-xs font-medium text-phx-danger">
                            {row.sendStatus === "failed" ? "Failed" : row.sendStatus === "pending" ? "Pending (retrying)" : row.sendStatus}
                          </span>
                          {row.failedReason ? <div className="mt-1 break-words text-xs text-slate-500">{row.failedReason}</div> : null}
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          <Stage on label="Sent" />
                          <Stage on={row.delivered} label="Delivered" />
                          <Stage on={row.opened} label="Opened" />
                          <Stage on={row.clicked} label="Clicked" />
                          {row.bounced ? <span className="inline-flex items-center bg-phx-danger-bg px-2 py-0.5 text-xs font-medium text-phx-danger">Bounced</span> : null}
                        </div>
                      )}
                    </td>
                    <td className="min-w-0 break-words px-3 py-3 text-slate-600">{formatCairo(row.lastActivityAt ?? row.sentAt)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        <div className="divide-y divide-slate-100 md:hidden">
          {data.rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-500">No emails in this window.</p>
          ) : (
            data.rows.map((row) => {
              const notSent = row.sendStatus !== "sent";
              return (
                <div key={row.id} className="min-w-0 space-y-1.5 px-4 py-3">
                  <p className="break-words text-sm font-medium text-slate-900">{row.recipientName ?? row.recipientEmail}</p>
                  {row.recipientName ? <p className="break-words text-xs text-slate-500">{row.recipientEmail}</p> : null}
                  <p className="break-words text-sm text-slate-700">{row.subject ?? "—"}</p>
                  <p className="text-xs capitalize text-slate-600">{row.provider} · {formatCairo(row.lastActivityAt ?? row.sentAt)}</p>
                  {notSent ? (
                    <div>
                      <span className="inline-flex items-center bg-phx-danger-bg px-2 py-0.5 text-xs font-medium text-phx-danger">
                        {row.sendStatus === "failed" ? "Failed" : row.sendStatus === "pending" ? "Pending (retrying)" : row.sendStatus}
                      </span>
                      {row.failedReason ? <div className="mt-1 break-words text-xs text-slate-500">{row.failedReason}</div> : null}
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      <Stage on label="Sent" />
                      <Stage on={row.delivered} label="Delivered" />
                      <Stage on={row.opened} label="Opened" />
                      <Stage on={row.clicked} label="Clicked" />
                      {row.bounced ? <span className="inline-flex items-center bg-phx-danger-bg px-2 py-0.5 text-xs font-medium text-phx-danger">Bounced</span> : null}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      <p className="text-xs text-slate-400">
        &quot;Delivered&quot; comes from the provider webhook — enable the Delivered event in Brevo for it to fill in on Brevo sends. Opens rely on a tracking pixel and are approximate; clicks are reliable. Times shown in Cairo.
      </p>
    </section>
  );
}
