import { CalendarDays, CalendarRange, ClipboardList, FileBarChart, FlaskConical, ListChecks, Search, Settings, Target, Users } from "lucide-react";

// The one client piece: it starts the module's page and its screen at the touch (module-link.tsx).
import { PhoenixCrmNewBadge } from "@/components/phoenix-crm/new-badge";
import { PhoenixCrmModuleLink } from "@/components/phoenix-crm/module-link";
// The other: "Get Phoenix CRM messages on Telegram", a client card the server decides to draw.
import { TelegramConnectCard } from "@/components/phoenix-crm/telegram-connect-card";
import { allowedPhoenixCrmModules, phoenixCrmModulePath, type PhoenixCrmModuleKey } from "@/lib/phoenix-crm/modules";
import type { PhoenixCrmUnreadByModule } from "@/lib/phoenix-crm/notice-badge-rules";
import { showsTelegramCard } from "@/lib/phoenix-crm/telegram-card";
// Through `view-types`, never `server/overview`: a component may not import server code (the
// boundary test), and that file exists to re-export exactly these shapes for the screens.
import type { PhoenixCrmOverview } from "@/lib/phoenix-crm/view-types";

/**
 * Phoenix CRM — the chooser the sidebar opens.
 *
 * 🔴 OWNER, 2026-09-30: "make the Phoenix CRM a button in the sidebar that does NOT direct me into
 * what it directs me today — it directs me to a page that has the SPLIT modules." Pressing Phoenix CRM
 * landed straight on Today with every other module mounted beside it in one screen; now it opens this,
 * and each module is its own page with its own address.
 *
 * It is a server component and links: no state, and the browser's own Back works between the chooser
 * and a module. The only client code is each card's link (module-link.tsx), which starts the module's
 * page and its screen downloading at the touch (2026-10-01, "slow to transfer between page and page").
 *
 * Square corners and no ellipsis, per the module's look. One column on a phone, two from `sm`, three
 * from `lg` — the cards carry a sentence each, so three across is the widest that keeps them readable.
 */

// The keys are QUOTED deliberately: `doctors` is the tab key whose visible label is "Directory", and
// the module's word guard allows it only in that form — a bare `doctors:` identifier reads, to a
// regex sweep, exactly like a screen string saying "doctors" (owner, 2026-09-23: all AM and PM).
const MODULE_ICONS: Record<PhoenixCrmModuleKey, typeof ClipboardList> = {
  visits: ClipboardList,
  list: ListChecks,
  plan: CalendarDays,
  // The CNS daily forecast: today's boxes against the target.
  forecast: Target,
  team: Users,
  // A RANGE, not the Plan tab's single calendar: the two cards sit near each other and the
  // month grid is the one that spans days.
  calendar: CalendarRange,
  "doctors": Search,
  reports: FileBarChart,
  settings: Settings,
  // The Super Admin's own tab for the test personas' approvals (owner, 2026-10-22).
  testAccounts: FlaskConical,
};

export function PhoenixCrmModuleChooser({
  base,
  overview,
  unread,
}: {
  base: string;
  overview: PhoenixCrmOverview;
  /** The viewer's unread notices by module (owner, 2026-10-08), or null when they could not be read. */
  unread: PhoenixCrmUnreadByModule | null;
}) {
  const modules = allowedPhoenixCrmModules(overview.tabs);
  // The Super Admin's counts are test entries, so the badge follows the same rule the tab bar uses.
  // The off-plan visits are in the sum since 2026-10-02: an off-plan visit counts in nothing until it
  // is decided, so leaving it out made the one delay that costs a rep his figures the invisible one.
  const waiting =
    overview.waitingForYou.plans +
    overview.waitingForYou.requests +
    overview.waitingForYou.planEdits +
    overview.waitingForYou.offPlanVisits +
    overview.waitingForYou.visitAsks;
  // A product manager has no Team module: the visits his line's reps ask of him wait on Reports
  // (owner, 2026-10-02), so that card carries the count instead.
  const reportsWaiting = overview.tabs.team ? 0 : overview.waitingForYou.visitAsks;
  // The Super Admin's counts are the test world's (owner, 2026-10-22): they belong on his test tab.
  const testWaiting =
    overview.tabs.testAccounts && overview.waitingForYou.isTest && !overview.viewer.isTestPersona
      ? overview.waitingForYou.plans +
        overview.waitingForYou.requests +
        overview.waitingForYou.planEdits +
        overview.waitingForYou.offPlanVisits
      : 0;

  return (
    <div className="grid min-w-0 gap-4">
      {/* Owner, 2026-10-02: the reps and managers the notices go to are asked to connect Telegram, at the
          top of Phoenix CRM, until the server says they have. */}
      {showsTelegramCard(overview.telegram) ? <TelegramConnectCard cairoToday={overview.cairoToday} /> : null}
      <p className="break-words text-sm font-semibold leading-6 text-slate-600">
        Choose what to open. Each one is its own page, so you can keep its address and come back to it.
      </p>
      <ul className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {modules.map((module) => {
          const Icon = MODULE_ICONS[module.key];
          const badge =
            module.key === "team" && waiting > 0 && !overview.tabs.testAccounts
              ? waiting
              : module.key === "reports" && reportsWaiting > 0
                ? reportsWaiting
                : module.key === "testAccounts" && testWaiting > 0
                  ? testWaiting
                  : null;
          return (
            <li className="min-w-0" key={module.key}>
              <PhoenixCrmModuleLink
                className="flex min-h-full min-w-0 items-start gap-3 rounded-none border border-l-[3px] border-slate-200 border-l-orange-500 bg-white px-4 py-3.5 transition hover:border-slate-300 hover:bg-orange-50/40"
                href={phoenixCrmModulePath(base, module.key)}
                moduleKey={module.key}
              >
                <Icon aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-orange-700" />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="break-words text-sm font-black text-slate-950">{module.label}</span>
                    {/* A pulsing mark for what is NEW (an unread notice), beside the static count of what is WAITING. */}
                    <PhoenixCrmNewBadge count={unread?.[module.key]?.count ?? 0} />
                    {badge === null ? null : (
                      <span className="inline-flex shrink-0 items-center border border-orange-300 bg-orange-100 px-1.5 py-px text-phx-sm font-black uppercase tracking-[0.08em] text-orange-800">
                        {badge} waiting
                      </span>
                    )}
                  </span>
                  <span className="mt-1 block break-words text-xs font-semibold leading-5 text-slate-500">{module.blurb}</span>
                </span>
              </PhoenixCrmModuleLink>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
