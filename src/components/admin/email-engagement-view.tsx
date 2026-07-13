import type { EmailEngagementData } from "@/lib/email/engagement";

// Presentational, server-rendered. Filters use a plain GET form (no client JS): submitting
// re-renders the page with new search params.

type Filters = { days: number; search: string; status: "all" | "clicked" | "opened" };

const cairoFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
});

function formatCairo(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : `${cairoFormatter.format(date)} (Cairo)`;
}

export function EmailEngagementView({ data, filters }: { data: EmailEngagementData; filters: Filters }) {
  return (
    <section className="space-y-4">
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Search person or email
          <input
            className="h-9 w-64 rounded-md border border-slate-300 px-3 text-sm text-slate-900"
            defaultValue={filters.search}
            name="search"
            placeholder="e.g. Anwar or name@…"
            type="text"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Activity
          <select className="h-9 rounded-md border border-slate-300 px-2 text-sm text-slate-900" defaultValue={filters.status} name="status">
            <option value="all">Opened + Clicked</option>
            <option value="opened">Opened only</option>
            <option value="clicked">Clicked only</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Window
          <select className="h-9 rounded-md border border-slate-300 px-2 text-sm text-slate-900" defaultValue={String(filters.days)} name="days">
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </label>
        <button className="h-9 rounded-md bg-slate-900 px-4 text-sm font-medium text-white" type="submit">
          Apply
        </button>
      </form>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Person</th>
              <th className="px-4 py-3">Activity</th>
              <th className="px-4 py-3">Email subject</th>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Via</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.events.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-slate-500" colSpan={5}>
                  No opens or clicks recorded for this window yet. (Data appears once the provider webhooks start posting events.)
                </td>
              </tr>
            ) : (
              data.events.map((event) => (
                <tr key={event.id} className="align-top">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{event.recipientName ?? event.recipientEmail}</div>
                    {event.recipientName ? <div className="text-xs text-slate-500">{event.recipientEmail}</div> : null}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        event.status === "clicked"
                          ? "inline-flex rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700"
                          : "inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"
                      }
                    >
                      {event.status === "clicked" ? "Clicked" : "Opened"}
                    </span>
                    {event.link ? (
                      <div className="mt-1 max-w-[240px] truncate text-xs text-slate-500" title={event.link}>
                        {event.link}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-slate-700">{event.subject ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatCairo(event.occurredAt)}</td>
                  <td className="px-4 py-3 capitalize text-slate-600">{event.provider}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400">
        Opens rely on a tracking pixel and are approximate (image-blocking / Apple Mail Privacy inflate or hide them). Clicks are reliable.
      </p>
    </section>
  );
}
