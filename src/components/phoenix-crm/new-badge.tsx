import { newBadgeText, type PhoenixCrmModuleNotices } from "@/lib/phoenix-crm/notice-badge-rules";

/**
 * Phoenix CRM — the pulsing "N new" mark (owner, 2026-10-08: "show pumping badges beside the thing that
 * has a notification. I want the people to be alerted").
 *
 * A server component: it draws from counts the page already loaded and ships no script. The pulse is a
 * square ring behind the badge (the module's square-edge rule), `motion-safe` so a reader who has asked
 * their device for less motion gets a still badge — the colour and the words carry the message either way.
 */
export function PhoenixCrmNewBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="relative inline-flex shrink-0 items-center">
      <span aria-hidden className="absolute inset-0 rounded-none bg-red-500/60 motion-safe:animate-ping" />
      <span className="relative inline-flex items-center rounded-none border border-red-700 bg-red-600 px-1.5 py-px text-phx-sm font-black uppercase tracking-[0.08em] text-white">
        {newBadgeText(count)}
        <span className="sr-only"> notice{count === 1 ? "" : "s"} for you</span>
      </span>
    </span>
  );
}

/**
 * The strip at the top of a module page: what is new for the viewer there, newest first, each with its
 * own pulsing marker. It names the notices the viewer was ALREADY sent (the same words as his bell), and
 * says nothing more about anyone.
 */
export function PhoenixCrmNewNotices({ entry }: { entry: PhoenixCrmModuleNotices | undefined }) {
  if (!entry || entry.count <= 0) return null;
  const more = entry.count - entry.notices.length;
  return (
    <section aria-label="New for you" className="min-w-0 border border-l-[3px] border-red-200 border-l-red-600 bg-white px-4 py-3">
      <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-black text-slate-950">
        <PhoenixCrmNewBadge count={entry.count} />
        <span className="min-w-0 break-words">New for you</span>
      </p>
      <ul className="mt-2 grid min-w-0 gap-1.5">
        {entry.notices.map((notice) => (
          <li className="flex min-w-0 items-start gap-2 text-sm font-semibold leading-5 text-slate-700" key={notice.id}>
            <span aria-hidden className="relative mt-1.5 inline-flex h-2 w-2 shrink-0">
              <span className="absolute inset-0 rounded-none bg-red-500 motion-safe:animate-ping" />
              <span className="relative h-2 w-2 rounded-none bg-red-600" />
            </span>
            <span className="min-w-0 break-words">{notice.title}</span>
          </li>
        ))}
      </ul>
      {more > 0 ? <p className="mt-2 break-words text-xs font-semibold text-slate-500">and {more} more.</p> : null}
    </section>
  );
}
