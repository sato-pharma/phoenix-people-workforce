import type { EmailActivityData } from "@/lib/email/engagement";

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
    <span className="inline-flex items-center rounded-full bg-phx-ok-bg px-2 py-0.5 text-xs font-medium text-phx-ok">✓ {label}</span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-phx-paper px-2 py-0.5 text-xs text-phx-ink-soft">— {label}</span>
  );
}

export function EmailEngagementView({ data, filters }: { data: EmailActivityData; filters: Filters }) {
  return (
    <section className="space-y-4">
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Search person, email or subject
          <input className="h-9 w-72 rounded-md border border-slate-300 px-3 text-sm text-slate-900" defaultValue={filters.search} name="search" placeholder="e.g. Anwar, payslip…" type="text" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Provider
          <select className="h-9 rounded-md border border-slate-300 px-2 text-sm text-slate-900" defaultValue={filters.provider} name="provider">
            <option value="all">All</option>
            <option value="resend">Resend</option>
            <option value="brevo">Brevo</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Activity
          <select className="h-9 rounded-md border border-slate-300 px-2 text-sm text-slate-900" defaultValue={filters.activity} name="activity">
            <option value="all">All</option>
            <option value="opened">Opened</option>
            <option value="clicked">Clicked</option>
            <option value="not_sent">Not sent</option>
            <option value="bounced">Bounced / failed</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Window
          <select className="h-9 rounded-md border border-slate-300 px-2 text-sm text-slate-900" defaultValue={String(filters.days)} name="days">
            <option value="1">Last 24h</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </label>
        <button className="h-9 rounded-md bg-slate-900 px-4 text-sm font-medium text-white" type="submit">Apply</button>
      </form>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Person</th>
              <th className="px-4 py-3">Email subject</th>
              <th className="px-4 py-3">Via</th>
              <th className="px-4 py-3">Situation</th>
              <th className="px-4 py-3">Last activity</th>
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
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{row.recipientName ?? row.recipientEmail}</div>
                      {row.recipientName ? <div className="text-xs text-slate-500">{row.recipientEmail}</div> : null}
                    </td>
                    <td className="px-4 py-3 text-slate-700">{row.subject ?? "—"}</td>
                    <td className="px-4 py-3 capitalize text-slate-600">{row.provider}</td>
                    <td className="px-4 py-3">
                      {notSent ? (
                        <div>
                          <span className="inline-flex items-center rounded-full bg-phx-danger-bg px-2 py-0.5 text-xs font-medium text-phx-danger">
                            {row.sendStatus === "failed" ? "Failed" : row.sendStatus === "pending" ? "Pending (retrying)" : row.sendStatus}
                          </span>
                          {row.failedReason ? <div className="mt-1 max-w-[280px] truncate text-xs text-slate-500" title={row.failedReason}>{row.failedReason}</div> : null}
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          <Stage on label="Sent" />
                          <Stage on={row.delivered} label="Delivered" />
                          <Stage on={row.opened} label="Opened" />
                          <Stage on={row.clicked} label="Clicked" />
                          {row.bounced ? <span className="inline-flex items-center rounded-full bg-phx-danger-bg px-2 py-0.5 text-xs font-medium text-phx-danger">Bounced</span> : null}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatCairo(row.lastActivityAt ?? row.sentAt)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400">
        &quot;Delivered&quot; comes from the provider webhook — enable the Delivered event in Brevo for it to fill in on Brevo sends. Opens rely on a tracking pixel and are approximate; clicks are reliable. Times shown in Cairo.
      </p>
    </section>
  );
}
