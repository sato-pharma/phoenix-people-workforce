import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  HOME_ENTRY,
  PROFILE_ENTRY,
  visiblePortalNavEntries,
} from "../src/components/employee-portal/employee-portal-nav-registry.ts";
import {
  homeTabWaitingBadges,
  nextChromeScrollState,
  replaceBottomNavHref,
  type PortalNavBadge,
} from "../src/lib/employee-portal/portal-chrome.ts";
import { portalQuickActions } from "../src/lib/employee-portal/portal-quick-actions.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";
import { isEmployeePortalOwnedRoute } from "../src/lib/employee-portal/routes.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The phone bottom bar's 2026-09-29 enhancements (the owner's seven-point list).
 *
 * The RULES live in React-free lib files so they can be called here; the WIRING is pinned by source
 * shape with comments stripped, so prose cannot satisfy or trip its own assertion.
 *
 * The bar's own hard constraints are pinned elsewhere and deliberately not duplicated here:
 * tests/employee-portal-bottom-nav.test.ts owns the six-tab width arithmetic, and
 * tests/employee-portal-bottom-nav-badges.test.ts owns the badge markup.
 */

const BOTTOM_NAV = "src/components/employee-portal/employee-portal-bottom-nav.tsx";
const HAPTICS = "src/lib/employee-portal/haptics.ts";
const LAYOUT = "src/components/employee-portal/employee-portal-layout.tsx";
const QUICK_ACTIONS = "src/lib/employee-portal/portal-quick-actions.ts";
const WIDGETS = "src/components/employee-portal/portal-bottom-nav-widgets.tsx";

/** Visibility for a role, with Phoenix CRM open — the same shape the other portal tests use. */
function visibilityFor(role: string) {
  return resolveEmployeePortalNavVisibility(role, role, null, null, null, false, false, true);
}

export function runPortalBottomNavGodmodeTests() {
  // ── 1. The shared quick-action list ─────────────────────────────────────────────────────────
  const everything = visibilityFor("District Manager");
  const dmActions = portalQuickActions(everything);
  assert.ok(dmActions.length >= 2, `a District Manager should be offered several actions, got ${dmActions.length}`);
  assert.equal(dmActions[0]?.id, "vacation", "requesting vacation leads the list and is ungated");
  for (const action of dmActions) {
    assert.ok(
      isEmployeePortalOwnedRoute(action.href),
      `${action.href} must be an employee-portal route — a quick action never leaves the portal`,
    );
  }
  // Each optional entry appears only behind its own flag.
  const noFlags = { showDashboardTab: true } as ReturnType<typeof visibilityFor>;
  assert.deepEqual(
    portalQuickActions(noFlags).map((action) => action.id),
    ["vacation"],
    "with no flags at all, only the ungated action is offered",
  );
  assert.deepEqual(
    portalQuickActions({ ...noFlags, showExpenseActionTab: true }).map((action) => action.id),
    ["vacation", "expense"],
    "Submit an expense appears only behind showExpenseActionTab",
  );
  assert.deepEqual(
    portalQuickActions({ ...noFlags, showDirectOrdersTab: true }).map((action) => action.id),
    ["vacation", "direct-order"],
    "New direct order appears only behind showDirectOrdersTab",
  );
  // Phoenix CRM's two actions (owner, 2026-09-29): a medical rep with the module open gets "Add visit" and
  // "Make weekly plan" FIRST; either flag alone offers neither — a manager reaches Phoenix CRM through
  // its page, and a rep whose line has not opened has nothing to add yet.
  assert.deepEqual(
    portalQuickActions({ ...noFlags, showPhoenixCrmTab: true, showMedicalRepExpensesTab: true }).map((action) => action.id),
    ["crm-visit", "crm-plan", "vacation"],
    "a rep with Phoenix CRM open is offered Add visit and Make weekly plan first",
  );
  assert.deepEqual(
    portalQuickActions({ ...noFlags, showPhoenixCrmTab: true }).map((action) => action.id),
    ["vacation"],
    "Phoenix CRM open without the medical-rep flag offers neither",
  );
  assert.deepEqual(
    portalQuickActions({ ...noFlags, showMedicalRepExpensesTab: true }).map((action) => action.id),
    ["vacation"],
    "a medical rep whose Phoenix CRM is not open is offered neither",
  );
  const crmActions = portalQuickActions({ ...noFlags, showPhoenixCrmTab: true, showMedicalRepExpensesTab: true }).slice(0, 2);
  assert.deepEqual(
    crmActions.map((action) => action.href),
    ["/employee-portals/field-crm/visits?add=visit", "/employee-portals/field-crm/plan?add=week"],
    "each opens the module's own page directly — the chooser's `?tab=` would only redirect there, a second round trip per tap",
  );
  const widgetsSrc = readFileSync(WIDGETS, "utf8");
  assert.match(widgetsSrc, /"crm-visit": Stethoscope/, "Add visit has its own glyph");
  assert.match(widgetsSrc, /"crm-plan": CalendarRange/, "Make weekly plan has its own glyph");
  // The whole point of extracting the list: its hrefs must not sit in the layout, because
  // tests/employee-portal-bottom-nav.test.ts reads every href literal there and demands each be a
  // phone-bar registry entry — which a quick-action target never is.
  const layoutRaw = readFileSync(LAYOUT, "utf8");
  assert.ok(
    !layoutRaw.includes('"/employee-portals/direct-orders/new"'),
    "the quick-action hrefs must stay out of the layout — that literal is what turned the phone-bar guard red",
  );
  const quickActionsSrc = stripComments(readFileSync(QUICK_ACTIONS, "utf8"));
  assert.doesNotMatch(
    quickActionsSrc,
    /fetch\(|method: "(POST|PATCH|DELETE)"/i,
    "the shared action list only names destinations — it never acts",
  );

  // ── 2. What the Home tab speaks for ─────────────────────────────────────────────────────────
  const hub = "approvals-hub-pending" as PortalNavBadge;
  const leave = "vacation-approvals-pending" as PortalNavBadge;
  const marketing = "marketing-approvals-pending" as PortalNavBadge;

  assert.deepEqual(
    homeTabWaitingBadges([hub, leave, marketing], []),
    [hub, leave, marketing],
    "with no badged tab on the bar, Home speaks for every queue the viewer owns",
  );
  assert.deepEqual(
    homeTabWaitingBadges([hub, leave, marketing], [leave]),
    [hub, marketing],
    "a queue that has its own tab is dropped — the tab speaks for itself and Home stays quiet about it",
  );
  assert.deepEqual(
    homeTabWaitingBadges([hub, leave], [leave]),
    [hub],
    "the hub is KEPT when a hub-covered queue is pinned — dropping it would under-report the excuse and plan items behind it",
  );
  // Found in the browser: with the hub pinned, Home was still adding the leave and plan items the
  // hub's own tab already showed — the tab read 5 and Home read 6, three of them the same requests.
  assert.deepEqual(
    homeTabWaitingBadges([hub, leave, "plan-approvals-pending" as PortalNavBadge, marketing], [hub]),
    [marketing],
    "pinning the hub silences Home about the queues that hub already contains",
  );
  assert.deepEqual(homeTabWaitingBadges([], []), [], "a viewer who owns no queue gets nothing — never a permanent 0");
  assert.deepEqual(homeTabWaitingBadges([hub, hub], []), [hub], "each queue once, however many rows carry it");

  // The case that motivated it, asserted from the real registry rather than a fixture: a District
  // Manager's DEFAULT bar carries no badged tab at all, so before this the phone said nothing.
  {
    const dm = visibilityFor("District Manager");
    const owned = visiblePortalNavEntries(dm).flatMap((entry) => (entry.navBadge ? [entry.navBadge as PortalNavBadge] : []));
    assert.ok(owned.length > 0, "a District Manager owns at least one approval queue");
    const defaultBarBadges = [HOME_ENTRY, PROFILE_ENTRY].flatMap((entry) => (entry.navBadge ? [entry.navBadge] : []));
    assert.deepEqual(defaultBarBadges, [], "Home and Profile carry no badge of their own");
    assert.ok(
      homeTabWaitingBadges(owned, []).length > 0,
      "Home must speak for a District Manager's queues — this is the silence the change exists to end",
    );
  }

  // ── 3. The wiring ───────────────────────────────────────────────────────────────────────────
  const bar = stripComments(readFileSync(BOTTOM_NAV, "utf8"));
  assert.match(
    bar,
    /const homeWaitingBadges = homeTabWaitingBadges\(/,
    "the bar derives Home's queues through the shared rule, not its own arithmetic",
  );
  assert.match(
    bar,
    /item\.href === HOME_ENTRY\.href && homeWaitingBadges\.length > 0/,
    "only the Home tab carries the combined count, and only when something is waiting",
  );
  assert.match(
    bar,
    /<PortalPendingCount navBadges=\{homeWaitingBadges\} tone="menu" \/>/,
    "it reuses the hub-aware counter, which renders nothing at zero and caps at 99+",
  );
  assert.doesNotMatch(
    bar,
    /fetch\(|useEffect\(/,
    "the bar adds no polling of its own — every count rides the one batched badge poll",
  );

  // ── 4. The Profile tab wears the person's face ──────────────────────────────────────────────
  assert.match(
    bar,
    /item\.href === PROFILE_ENTRY\.href && !locked \? \(\s*<PortalAvatar fullName=\{fullName\} photoSrc=\{photoSrc\} size="h-\[19px\] w-\[19px\]" \/>/,
    "only Profile shows the avatar, and a LOCKED Profile keeps the padlock instead",
  );
  assert.match(
    bar,
    /size="h-\[19px\] w-\[19px\]"/,
    "the avatar is the same 19px box as every other glyph — a bigger one would change the bar's height and silently break the 61px reserve",
  );
  const layoutStripped = stripComments(readFileSync(LAYOUT, "utf8"));
  assert.match(
    layoutStripped,
    /<EmployeePortalBottomNav[\s\S]*?fullName=\{data\.employee\.fullName\}[\s\S]*?photoSrc=\{data\.employee\.photoUrl \?\? employeeProfileImageForHrId\(data\.employee\.hrId\)\}/,
    "the layout hands the bar the person — uploaded photo, else the bundled one, else initials",
  );

  // ── 5. Press feedback: the sliding marker and the tap buzz ──────────────────────────────────
  // The marker must be OUT OF FLOW. In flow it would take width from the six tabs, which is the one
  // thing the bar has none of: bottomBarWordBudgetPx(360) is pinned at 304px against a 267px worst
  // case, and that 37px of slack is what keeps a 360px Android phone from scrolling sideways.
  assert.match(
    bar,
    /className="pointer-events-none absolute left-0 top-0 z-10 h-\[3px\] bg-\[#F05A1A\][^"]*motion-reduce:transition-none"/,
    "one out-of-flow 3px marker, square-cornered, and reduced motion stops it gliding",
  );
  assert.match(
    bar,
    /<ul className="relative mx-auto flex max-w-\[640px\] items-stretch justify-around px-1" ref=\{listRef\}>/,
    "the list is the marker's positioning context AND still carries exactly px-1 — padding it would shrink the real word budget while the pinned arithmetic kept certifying 304px",
  );
  assert.match(
    bar,
    /data-active-tab=\{active \? "true" : undefined\}/,
    "the lit tab is what the marker measures, so one attribute decides it and the marker cannot disagree with the highlight",
  );
  assert.doesNotMatch(
    bar,
    /useState\(|setMarker/,
    "the marker is placed by measuring the DOM, never through React state — that would be a render on every route change",
  );
  // Found at 320px in the running app: a resize renders nothing, so without this the marker kept the
  // width and offset it measured at 375px and sat under the wrong tab after a rotation.
  assert.match(
    bar,
    /window\.addEventListener\("resize", place\)[\s\S]*window\.addEventListener\("orientationchange", place\)/,
    "the marker re-measures when the viewport changes — six tabs share the width, so every offsetLeft moves",
  );
  assert.match(
    bar,
    /window\.removeEventListener\("resize", place\)[\s\S]*window\.removeEventListener\("orientationchange", place\)/,
    "and both listeners come off again — this effect has no dependency list, so it re-runs on every render",
  );
  assert.match(
    bar,
    /onPointerDown=\{\(event\) => \{\s*if \(event\.pointerType === "touch"\) tapHaptic\(reducedMotion\);/,
    "the buzz fires at the PRESS and only for a finger — onClick would land after the finger has left",
  );
  assert.doesNotMatch(
    bar,
    /onClick=\{[^}]*tapHaptic/,
    "feedback belongs at the press, not the click",
  );

  const haptics = stripComments(readFileSync(HAPTICS, "utf8"));
  assert.match(
    haptics,
    /if \(reducedMotion\) return;/,
    "a request for no motion is the only signal a browser gives for 'do not vibrate at me' — honour it first",
  );
  assert.match(
    haptics,
    /typeof navigator\.vibrate !== "function"/,
    "iOS Safari has never implemented navigator.vibrate — the call must be absent-safe, not try/catch-only",
  );
  assert.match(haptics, /try \{[\s\S]*navigator\.vibrate\(10\)/, "and a browser that refuses the buzz never raises");

  // ── 6. The floating quick-action button ─────────────────────────────────────────────────────
  const widgets = stripComments(readFileSync(WIDGETS, "utf8"));
  assert.match(
    widgets,
    /className=\{`fixed right-3 z-\[45\]/,
    "the button is OUT OF FLOW — a seventh seat on the bar is arithmetically impossible, so anything new here is fixed and costs the six tabs nothing",
  );
  assert.match(
    widgets,
    /\[body:has\(\[data-portal-action-bar\]\)_&\]:hidden/,
    "it steps aside on a page with its own sticky action bar — it sat on top of Next on the Submit expense form (2026-10-27)",
  );
  assert.match(
    readFileSync("src/components/outstation/mobile-outstation-wizard.tsx", "utf8"),
    /data-portal-action-bar=""/,
    "the Submit expense form's Back / Next / Submit bar is marked, so the button never covers Next",
  );
  assert.match(
    widgets,
    /style=\{\{ bottom: "calc\(var\(--phx-portal-bottom-nav-reserve, 0px\) \+ 12px\)" \}\}/,
    "it rides the bar's own height variable rather than a second magic number — that variable is already 0px from lg, so the button tracks the bar for free",
  );
  assert.doesNotMatch(
    widgets,
    /fetch\(|method: "(POST|PATCH|DELETE)"/i,
    "the button only ever NAVIGATES — no action is performed from the bar, the same rule the top bar's menu obeys",
  );
  assert.match(
    widgets,
    /z-\[60\][\s\S]*z-\[61\]/,
    "backdrop then panel, both above the z-40 bar and below the z-[90] command bar",
  );
  assert.match(
    widgets,
    /document\.body\.style\.overflow = "hidden"[\s\S]*document\.body\.style\.overflow = previousOverflow/,
    "the page behind the sheet does not scroll, and the lock is given back — on a phone a sheet over a scrolling page moves the wrong layer",
  );
  assert.match(
    widgets,
    /event\.key === "Escape"/,
    "Escape closes it",
  );
  assert.match(
    widgets,
    /min-h-\[52px\]/,
    "each row clears the 44px touch minimum with room to spare",
  );
  assert.match(
    widgets,
    /if \(openedOn !== pathname\) \{\s*setOpenedOn\(pathname\);\s*setOpen\(false\);\s*setEditing\(false\);/,
    "changing page closes the sheet, adjusted during render — an effect would paint the stale sheet over the new page for a frame, and the lint rule refuses it outright",
  );
  assert.match(
    widgets,
    /const close = useCallback\(\(\) => \{\s*setOpen\(false\);\s*setEditing\(false\);/,
    "and closing always drops the Edit tabs view too, so reopening starts at the actions rather than half-way through an edit",
  );
  assert.match(
    bar,
    /<PortalBottomNavQuickActions /,
    "the button is rendered from the bar, so it inherits the focus-mode guard and the shell's square corners for free",
  );

  // ── 7. The two bottom reservations must agree, and both must clear bar + gap + button ────────
  // They cover DIFFERENT widths: the CSS rule stops at 767px, the <main> class runs at every width,
  // so the 768–1023px band — where the bar is still on screen — is served by the class alone. If
  // they drift, a long page's last row hides under the button at one size and not the other.
  const shell = readFileSync("src/components/employee-portal/enterprise-shell.tsx", "utf8");
  const cssRem = /padding-bottom: calc\((\d+(?:\.\d+)?)rem \+ env\(safe-area-inset-bottom\)\);/.exec(shell)?.[1];
  // In app mode there is no web bar and no button, so that branch keeps its own pb-0; the figure
  // pinned here is the WEB one, which is the only side either reservation covers.
  const mainRem = /appShell \? "pb-0" : "pb-\[(\d+(?:\.\d+)?)rem\]"/.exec(layoutRaw)?.[1];
  assert.ok(cssRem, "the .employee-portal-mobile-safe rule still states its padding in rem");
  assert.ok(mainRem, "the portal <main> still states its bottom padding in rem");
  assert.equal(mainRem, cssRem, "the two bottom reservations must be the SAME figure — they cover different widths");
  // 61px bar + 12px gap + 48px button = 121px. At the root 16px they must clear it.
  assert.ok(
    Number(cssRem) * 16 >= 121,
    `the reservation must clear the bar, the gap and the button (121px); ${cssRem}rem is ${Number(cssRem) * 16}px`,
  );

  // ── 8. Out of the way while reading ─────────────────────────────────────────────────────────
  // The rule is deliberately lopsided — hard to hide, trivial to bring back. Every case below is
  // one the owner named when he asked for it: "build it, revealing instantly".
  const tall = { docHeight: 4000, viewportHeight: 800 };
  const shown = { hidden: false, lastY: 0 };

  assert.deepEqual(
    nextChromeScrollState({ hidden: false, lastY: 500 }, { ...tall, y: 560 }),
    { hidden: true, lastY: 560 },
    "a deliberate scroll down hides it",
  );
  assert.deepEqual(
    nextChromeScrollState({ hidden: true, lastY: 560 }, { ...tall, y: 554 }),
    { hidden: false, lastY: 554 },
    "SIX pixels back up brings it straight back — a flick returns it before the gesture ends",
  );
  assert.deepEqual(
    nextChromeScrollState({ hidden: false, lastY: 500 }, { ...tall, y: 515 }),
    { hidden: false, lastY: 515 },
    "15px is a jitter, not a read — it neither hides nor moves the answer",
  );
  // 200px of scroll on an 800px screen: past the top zone, clear of the bottom zone, and the step
  // is a real 50px — so only the "barely taller than the screen" clause can keep it shown.
  assert.equal(
    nextChromeScrollState({ hidden: false, lastY: 100 }, { docHeight: 1000, viewportHeight: 800, y: 150 }).hidden,
    false,
    "a page barely taller than the screen never hides it — a rubber-band bounce would otherwise flash it away",
  );
  assert.equal(
    nextChromeScrollState({ hidden: true, lastY: 0 }, { ...tall, y: 60 }).hidden,
    false,
    "the top 96px always shows it — nothing has been read yet",
  );
  assert.equal(
    nextChromeScrollState({ hidden: false, lastY: 3100 }, { ...tall, y: 3190 }).hidden,
    false,
    "the bottom always shows it — there is nothing further to scroll to and the bar is what you reach for next",
  );
  // lastY advances even when nothing else changes, so a slow drift can never accumulate into a hide.
  let drifting = { ...shown, lastY: 200 };
  for (let step = 1; step <= 20; step += 1) {
    drifting = nextChromeScrollState(drifting, { ...tall, y: 200 + step * 10 });
  }
  assert.equal(drifting.hidden, false, "twenty 10px steps is still a drift, never a hide — lastY advances every time");
  assert.equal(drifting.lastY, 400, "and the last position is always recorded");

  assert.match(
    bar,
    /chromeHidden \? "translate-y-full" : ""/,
    "the bar slides out rather than unmounting — it must be able to come straight back",
  );
  assert.match(
    bar,
    /<PortalBottomNavQuickActions chromeHidden=\{chromeHidden\} visibility=\{visibility\} \/>/,
    "the button goes with the bar it sits above",
  );
  assert.doesNotMatch(bar, /\binert\b/, "the hidden bar is never inert — that would kill the focus reveal a keyboard needs");
  const hooks = stripComments(readFileSync("src/components/employee-portal/portal-chrome-hooks.ts", "utf8"));
  assert.match(
    hooks,
    /window\.addEventListener\("scroll", onScroll, \{ passive: true \}\)/,
    "the scroll listener is passive — it can never delay a scroll",
  );
  assert.match(
    hooks,
    /window\.requestAnimationFrame/,
    "and its work is deferred to a frame, so a fast scroll does not measure the document dozens of times a second",
  );
  assert.match(
    hooks,
    /document\.addEventListener\("focusin", onFocusIn\)/,
    "a focus landing in the bar forces it back — without it Tab would move focus onto a bar translated off the screen",
  );
  assert.match(
    hooks,
    /if \(shownFor !== pathname\) \{\s*setShownFor\(pathname\);\s*setHidden\(false\);/,
    "a new page starts with its chrome, adjusted during render — an effect would paint the new page once with the old page's bar still slid away",
  );

  // ── 9. Swapping a tab from the bar itself ───────────────────────────────────────────────────
  const defaults = ["/a", "/b", "/c", "/d"];
  assert.deepEqual(
    replaceBottomNavHref(["/a", "/b", "/c", "/d"], defaults, "/b", "/z"),
    ["/a", "/z", "/c", "/d"],
    "the new tab takes the old one's SEAT — nothing jumps under the thumb between choosing and looking",
  );
  // The lesson togglePinnedHref learned the hard way: an empty list means "the role's defaults".
  assert.deepEqual(
    replaceBottomNavHref([], defaults, "/b", "/z"),
    ["/a", "/z", "/c", "/d"],
    "a first edit on a device that never chose anything starts from the tabs the bar is showing — otherwise the bar collapses to one",
  );
  assert.deepEqual(
    replaceBottomNavHref(["/a", "/b", "/c", "/d"], defaults, "/b", "/d"),
    ["/a", "/d", "/c", "/b"],
    "choosing a page that is already on the bar swaps the two seats rather than listing it twice",
  );
  assert.deepEqual(
    replaceBottomNavHref(["/a", "/b"], defaults, "/b", "/b"),
    ["/a", "/b"],
    "choosing the same page changes nothing",
  );
  assert.deepEqual(
    replaceBottomNavHref(["/a", "/b"], defaults, "/employee-portals", "/z"),
    ["/a", "/b"],
    "a seat that is not on the bar changes nothing — which is also what refuses Home and Profile",
  );
  assert.equal(
    replaceBottomNavHref(["/a", "/b", "/c", "/d"], defaults, "/b", "/z").length,
    4,
    "the length never changes, so an edit can never breach the four-tab cap",
  );

  assert.match(
    widgets,
    /setSelected\(replaceBottomNavHref\(selected, shown, seat, entry\.href\)\)/,
    "the editor writes through the shared rule and the bar's own preference store, not its own arithmetic",
  );
  assert.match(
    widgets,
    /Home and Profile always stay\./,
    "the sheet says which two tabs cannot move, rather than leaving a person hunting for them",
  );
  assert.match(widgets, /entry\.fullLabel/, "the picker shows the full page name, the same field the Profile customizer shows");
}
