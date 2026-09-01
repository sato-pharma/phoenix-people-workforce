import { ChevronDown } from "lucide-react";
import Link from "next/link";

import { buildPermissionLookup, permissionMatrix, usesHrNamespace, type AccessContext } from "@/lib/auth/permissions";
import { toHrNamespacePath } from "@/lib/navigation/shell-headers";
import {
  resolvePersonalWorkspaceTabs,
  type PersonalWorkspaceTabGroup,
} from "@/lib/workspace/personal-workspace-nav";

/**
 * The HR seats' own personal pages, as one strip under the identity banner — on EVERY page.
 *
 * ## Why it is here and not on the dashboard
 *
 * Owner instruction, 2026-09-01: *"Make the my pages as a strip or as a line in the top of the page
 * under the identity banner. And make it fix it in every page she opens, either the HR operational
 * or either the HR business partner. We will make this the two changes in the two accounts."*
 *
 * It used to be the last block of the HR Overview page (inside HrMyRecord). That put a seat's own
 * leave, payslip and excuse pages behind a navigation step: she had to go back to the landing page
 * to reach her own payslip. As chrome it is one click from anywhere, which is what those links are
 * for.
 *
 * ## Where it renders
 *
 * Inside AppShell's FROZEN CHROME block, directly after the Topbar and above the two horizontal nav
 * rows. That position is load-bearing in the same way the nav rows' is, and for the reason spelled
 * out in the comment there: `sticky` is bounded by its containing block, so a strip rendered inside
 * a page would unpin the moment that page's hero scrolled away. Rendered here it travels with the
 * Topbar as one sticky unit and cannot come unstuck.
 *
 * ## The palette is the ADMIN CHROME's, and the first version got that wrong
 *
 * The first version shipped `bg-white` with `text-phx-ink-soft` — the EMPLOYEE PORTAL's palette.
 * Both HR seats resolve to `usesAdminChrome` (`navigation-mode: "hr"`), so that put a white band
 * between the black Topbar above it and the black upper nav row below it: a bright horizontal seam
 * across the top of all 243 pages, which reads as an unstyled element rather than as a feature.
 * The colours below are the nav rows' own, taken verbatim from horizontal-nav-rows.tsx so the
 * three bands are one piece of chrome — same `#1c1c1c` hairline, same `#F8B56B` accent, and the
 * SAME active treatment (`bg-[#17120c]` on an inset ring), so "where am I" looks identical
 * whichever of the three rows the current page is lit in.
 *
 * The ground is `#0C0C0C` rather than the rows' `#000000`/`#080808`. It is a deliberate step, not
 * a near-miss: the two nav rows are the COMPANY's modules and this row is HER OWN record, so the
 * band is lifted a shade and given a warm top hairline. Below about a 6/255 step the difference
 * stops being visible and the bands read as one tall slab — the same mistake the lower nav row's
 * own comment records making with `#050505`.
 *
 * ## No icons, deliberately
 *
 * The two nav rows directly beneath are icon+label chips. A third icon+label row stacked on them
 * is not more polish, it is three rows competing to be read first. This one is typographic —
 * micro-caps, hairline-separated groups, one accent marker — so it reads as a different CLASS of
 * thing at a glance, which is exactly what it is.
 *
 * ## Grouped, because the data already says how
 *
 * `PersonalWorkspaceTab.group` exists to draw "a hairline between groups", and the tab order is
 * documented there as the order a person meets their own record: what am I looking at, what am I
 * paid, what did I ask for and where was I, what am I planning, what did I spend, who do I ask.
 * Rendering fifteen chips in one undifferentiated run threw that away and made the strip a wall.
 * The runs are built from the RESOLVED list, so a group whose every page this seat cannot open
 * contributes no hairline — an empty run would otherwise show as a double separator.
 *
 * ## Who sees it
 *
 * `usesHrNamespace` — `HR Advisory` and `HR Operations`, exactly the two accounts the owner named,
 * and nobody else. Deliberately NOT `isHrAuthorityRole`, which also contains Super Admin: his rail
 * is the admin one and these are `/hr/…` addresses.
 *
 * ## The fits-the-screen rule
 *
 * The chips wrap to about six rows at 375px, which would swallow a phone screen in permanently
 * frozen chrome. So the mobile half is a native `<details>` disclosure — closed, it costs one line;
 * open, it wraps. No horizontal scroll at any width, which is the rule
 * (`never-horizontal-scroll-always-mobile-and-desktop-friendly`) — note the nav rows below solve
 * the same problem with `overflow-x-auto`, which this row deliberately does NOT copy. And no
 * JavaScript, because `<details>` needs none: this stays a server component and adds nothing to the
 * hydration cost of all 243 pages.
 *
 * Returns null rather than an empty bar when the viewer has no personal pages at all, so the chrome
 * does not gain a blank strip on an account that cannot use it.
 */

type StripPage = { group: PersonalWorkspaceTabGroup; href: string; label: string };

/** Idle and active chip, lifted verbatim from the nav rows so all three bands light the same way. */
const CHIP_BASE =
  "inline-flex shrink-0 items-center rounded-lg px-2.5 py-1 text-phx-2xs font-bold uppercase tracking-[0.1em] transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#F8B56B]/70";
const CHIP_ACTIVE =
  "bg-[#17120c] text-[#F8B56B] shadow-[inset_0_0_0_1px_#33261a,inset_0_1px_0_rgba(248,181,107,0.12)]";
const CHIP_IDLE =
  "text-[#C9D4E2] hover:bg-[#141414] hover:text-[#F0D5B0] hover:shadow-[inset_0_0_0_1px_#1f1f1f]";

/** Consecutive runs of the same group, in the resolver's order. Empty groups contribute nothing. */
function groupRuns(pages: StripPage[]): StripPage[][] {
  const runs: StripPage[][] = [];
  for (const page of pages) {
    const last = runs[runs.length - 1];
    if (last && last[0]?.group === page.group) last.push(page);
    else runs.push([page]);
  }
  return runs;
}

export function HrMyPagesStrip({
  access,
  pathname,
}: {
  access: Pick<AccessContext, "role" | "scope">;
  pathname: string | null;
}) {
  if (!usesHrNamespace(access.role)) return null;

  // The SAME resolver the dashboard used, called the same way — the strip and the pages behind it
  // cannot disagree about what she can open, and a tab she cannot open is never offered.
  //
  // `/workspace` is dropped for the reason it always was: it is the old second landing page, and
  // the HR Overview IS that page now, so the link would point at a redirect back to where she is.
  const pages: StripPage[] = resolvePersonalWorkspaceTabs(
    access,
    buildPermissionLookup(permissionMatrix, access.role),
  )
    .filter((tab) => tab.href !== "/workspace")
    .map((tab) => ({ group: tab.group, href: toHrNamespacePath(tab.href), label: tab.label }));

  if (pages.length === 0) return null;

  // Longest match wins, so /hr/workspace/plans/calendar marks Planning Calendar rather than My
  // Plans. Same rule as activePersonalWorkspaceTab, applied to the already-namespaced hrefs.
  const current = pathname
    ? pages
        .filter((page) => pathname === page.href || pathname.startsWith(`${page.href}/`))
        .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null
    : null;
  const currentLabel = current ? pages.find((page) => page.href === current)?.label : undefined;

  const runs = groupRuns(pages);

  const chips = runs.map((run, index) => (
    // The key is the run's group plus its index: a group can legitimately appear twice if the tab
    // list is ever reordered, and the index alone would reshuffle every chip on a re-render.
    <span className="flex flex-wrap items-center gap-1.5" key={`${run[0]?.group}-${index}`}>
      {index > 0 ? <span aria-hidden="true" className="mx-0.5 h-3.5 w-px shrink-0 bg-[#242424]" /> : null}
      {run.map((page) => (
        <Link
          aria-current={page.href === current ? "page" : undefined}
          className={`${CHIP_BASE} ${page.href === current ? CHIP_ACTIVE : CHIP_IDLE}`}
          href={page.href}
          key={page.href}
        >
          {page.label}
        </Link>
      ))}
    </span>
  ));

  // The accent tick that marks this band as the personal one. Purely decorative, so it is hidden
  // from the accessibility tree — the `aria-label` on the nav already names the region.
  const marker = (
    <span aria-hidden="true" className="h-3 w-[3px] shrink-0 rounded-full bg-[#F8B56B]" />
  );

  return (
    <nav
      aria-label="My pages"
      className="border-b border-[#1c1c1c] bg-[#0C0C0C] px-3 py-1.5 shadow-[inset_0_1px_0_rgba(248,181,107,0.09)] sm:px-6"
    >
      {/* DESKTOP — every chip, wrapped, hairlines between the groups. */}
      <div className="hidden flex-wrap items-center gap-x-1.5 gap-y-1 sm:flex">
        <span className="mr-1 inline-flex shrink-0 items-center gap-1.5">
          {marker}
          <span className="text-phx-2xs font-black uppercase tracking-[0.18em] text-[#7E8896]">My pages</span>
        </span>
        {chips}
      </div>

      {/* MOBILE — one line closed, wrapped when opened. The summary names the page she is on, so
          the strip still answers "where am I" without being expanded. `list-none` plus the webkit
          marker rule removes BOTH default triangles: Safari and older WebKit ignore `list-style`
          on a summary and need the pseudo-element hidden as well, and a stray triangle beside a
          hand-drawn chevron is the tell that a disclosure was styled by halves. */}
      <details className="group sm:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 [&::-webkit-details-marker]:hidden">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {marker}
            <span className="min-w-0 break-words text-phx-2xs font-black uppercase tracking-[0.18em] text-[#7E8896]">
              My pages
              {currentLabel ? <span className="text-[#F8B56B]">{` · ${currentLabel}`}</span> : null}
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-[#7E8896] transition-transform duration-200 group-[[open]]:rotate-180"
          />
        </summary>
        <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1">{chips}</div>
      </details>
    </nav>
  );
}
