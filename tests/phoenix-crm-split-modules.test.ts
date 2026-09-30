import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  allowedPhoenixCrmModules,
  isPhoenixCrmModuleKey,
  PHOENIX_CRM_MODULE_KEYS,
  PHOENIX_CRM_MODULES,
  PHOENIX_CRM_PORTAL_BASE,
  phoenixCrmModuleForSlug,
  phoenixCrmModulePath,
  type PhoenixCrmModuleKey,
} from "../src/lib/phoenix-crm/modules.ts";

/**
 * Phoenix CRM — the sidebar opens a CHOOSER, and every module is its own page.
 *
 * 🔴 OWNER, 2026-09-30, given priority over everything else he had in hand: "make the Phoenix CRM a
 * button in the sidebar that does NOT direct me into what it directs me today — it directs me to a
 * page that has the SPLIT modules." Pressing Phoenix CRM landed straight on Today with every other
 * module mounted beside it in one screen.
 *
 * What this pins:
 *   1. The chooser lives at the sidebar's own address, and renders no module.
 *   2. Each module has its own route, and an unknown segment is a 404.
 *   3. `?tab=` is FORWARDED, not dropped — the portal's "+" actions and notification links carry it.
 *   4. A module the viewer may not open is a SENTENCE, never a dead page.
 *   5. The module list and the overview's tab flags cannot drift apart.
 */

function source(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

const ALL: Record<PhoenixCrmModuleKey, boolean> = {
  today: true,
  visits: true,
  list: true,
  plan: true,
  team: true,
  "doctors": true,
  reports: true,
  settings: true,
};

export function runPhoenixCrmSplitModulesTests(): void {
  // ── 1. The list, and its order ──────────────────────────────────────────────────────────────────
  {
    assert.deepEqual(
      PHOENIX_CRM_MODULE_KEYS,
      ["today", "visits", "list", "plan", "team", "doctors", "reports", "settings"],
      "the rep's day first, then the work he does on it, then the reading, and Settings last",
    );
    assert.equal(PHOENIX_CRM_MODULES.length, PHOENIX_CRM_MODULE_KEYS.length);
    for (const entry of PHOENIX_CRM_MODULES) {
      assert.ok(entry.label.length > 0 && entry.blurb.length > 0, `${entry.key} has a name and a line saying what it is for`);
      assert.doesNotMatch(entry.label + entry.blurb, /…/, "no ellipsis anywhere in the module's words");
      assert.doesNotMatch(entry.blurb, /\b(doctor|account)s?\b/i, "and it says AM and PM, never doctor or account");
    }
    // "Directory" is the visible name of the tab whose KEY is the retired word.
    assert.equal(PHOENIX_CRM_MODULES.find((entry) => entry.key === "doctors")?.label, "Directory");

    assert.ok(isPhoenixCrmModuleKey("plan"));
    assert.ok(!isPhoenixCrmModuleKey("nonsense"));
    assert.ok(!isPhoenixCrmModuleKey(null));
    assert.equal(phoenixCrmModulePath(PHOENIX_CRM_PORTAL_BASE, "list"), "/employee-portals/field-crm/list");
  }

  // \u2500\u2500 1b. THE ADDRESS BAR IS UI, SO THE RETIRED WORDS MAY NOT REACH IT \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  //
  // \ud83d\udd34 Owner, 2026-09-23: "in employee-portals/field-crm make it ALL AM PM, not doctors and accounts."
  // The Directory tab's KEY is the retired word, and routing on the key put it in the address AND in
  // the browser tab, which read "Doctors \u00b7 Phoenix Workforce" \u2014 measured on the preview, because the
  // app's shared title resolver names a page from its own segments. The slug is what fixes both.
  {
    for (const entry of PHOENIX_CRM_MODULES) {
      assert.doesNotMatch(entry.slug, /\b(doctor|doctors|account|accounts)\b/i, `the ${entry.label} slug says no retired word`);
      assert.match(entry.slug, /^[a-z][a-z-]{0,20}$/, `the ${entry.label} slug is a plain address segment`);
      assert.equal(phoenixCrmModuleForSlug(entry.slug)?.key, entry.key, `${entry.slug} resolves back to its own module`);
    }
    assert.equal(new Set(PHOENIX_CRM_MODULES.map((entry) => entry.slug)).size, PHOENIX_CRM_MODULES.length, "no two modules share a slug");
    assert.equal(phoenixCrmModulePath(PHOENIX_CRM_PORTAL_BASE, "doctors"), "/employee-portals/field-crm/directory", "Directory is reached by its own word");
    assert.equal(phoenixCrmModuleForSlug("doctors"), null, "and the retired word is not an address at all");
    assert.equal(phoenixCrmModuleForSlug("nonsense"), null);

    // \ud83d\udd34 And no local generateMetadata: the app has ONE title resolver, used by the layout's
    // metadata AND the client DocumentTitleSync, so a tab's name does not change as a page settles.
    // A local one fought it and lost on client navigation \u2014 "Phoenix CRM \u00b7 List" on first paint, then
    // "Doctors \u00b7 Phoenix Workforce" a moment later.
    const route = source("app/employee-portals/field-crm/[module]/page.tsx");
    assert.ok(!route.includes("generateMetadata"), "the route does not name its own tab");
    assert.match(route, /const entry = phoenixCrmModuleForSlug\(slug\);/, "it resolves the module from the slug");
  }

  // ── 2. Only the modules the viewer may open ─────────────────────────────────────────────────────
  {
    assert.deepEqual(allowedPhoenixCrmModules(ALL).map((entry) => entry.key), PHOENIX_CRM_MODULE_KEYS);
    const rep = { ...ALL, team: false, settings: false, "doctors": false };
    assert.deepEqual(allowedPhoenixCrmModules(rep).map((entry) => entry.key), ["today", "visits", "list", "plan", "reports"]);
    const none = Object.fromEntries(PHOENIX_CRM_MODULE_KEYS.map((key) => [key, false])) as Record<PhoenixCrmModuleKey, boolean>;
    assert.deepEqual(allowedPhoenixCrmModules(none), [], "and nothing at all when he holds nothing");
  }

  // ── 3. The chooser is the sidebar's destination, and renders no module ──────────────────────────
  {
    const nav = readFileSync("src/config/system-navigation.ts", "utf8");
    assert.ok(
      nav.includes('{ href: "/employee-portals/field-crm", icon: ClipboardList, label: "Phoenix CRM"'),
      "the sidebar still says Phoenix CRM and points at the chooser, not at a module",
    );

    const page = source("app/employee-portals/field-crm/page.tsx");
    assert.match(page, /<PhoenixCrmModuleChooser base=\{PHOENIX_CRM_PORTAL_PATH\} overview=\{load\.overview\} \/>/, "it renders the chooser");
    assert.ok(!page.includes("<PhoenixCrmApp"), "🔴 and never the one-screen app — that is exactly what he removed");

    // `?tab=` is forwarded with `?add=`, never dropped: the portal's "+" actions still work.
    // 🔴 THIS FORWARD WORKS, AND I REPORTED IT BROKEN ONCE. Reading `location` straight after driving
    // the browser to `?tab=list` shows the URL BEFORE the server's redirect has resolved, so it looked
    // like the chooser had swallowed it — and the server log said otherwise all along
    // ("GET /employee-portals/field-crm/list 200" on the very next line). Verify a redirect by the
    // address it SETTLES on, never the one read on the first tick.
    assert.match(page, /if \(isPhoenixCrmModuleKey\(tab\)\) \{/, "a named module is forwarded");
    assert.match(page, /redirect\(`\$\{phoenixCrmModulePath\(PHOENIX_CRM_PORTAL_PATH, tab\)\}\$\{add \? `\?add=\$\{add\}` : ""\}`\)/, "carrying ?add= with it");

    const chooser = source("src/components/phoenix-crm/module-chooser.tsx");
    assert.ok(!chooser.includes('"use client"'), "the chooser is a server component — no state, no bundle");
    assert.match(chooser, /href=\{phoenixCrmModulePath\(base, module\.key\)\}/, "each card links to that module's own page");
    assert.match(chooser, /rounded-none/, "square corners, like the rest of the module");
    assert.doesNotMatch(chooser, /truncate|text-ellipsis/, "and nothing is cut off with an ellipsis");
  }

  // ── 4. One module, one page ─────────────────────────────────────────────────────────────────────
  {
    const path = "app/employee-portals/field-crm/[module]/page.tsx";
    assert.ok(existsSync(path), "every module has its own route");
    const route = source(path);
    assert.match(route, /if \(!entry\) notFound\(\);/, "an unknown segment is a 404");
    assert.match(route, /initialTab=\{moduleKey\}/, "and it opens on that module");
    // 🔴 A module he may not open is a SENTENCE, not a dead page: a rep following a shared link must
    // read why, and `notFound()` there would tell him the module does not exist.
    assert.match(route, /if \(!load\.overview\.tabs\[moduleKey\]\) \{/, "a module not his reads as a sentence");
    assert.match(route, /is not yours to open/, "in words, never a 404");
  }

  // ── 4c. SEPARATE THEM TOTALLY ───────────────────────────────────────────────────────────────────
  //
  // 🔴 Owner, 2026-09-30, after seeing the first split: "I don't want, when I press on any one of the
  // ones you split, that they redirect me to the same screen that has all of them beside each other.
  // SEPARATE THEM TOTALLY, make them separate pages." The first split gave each module its own
  // address but every page still drew the tab bar and still mounted the other seven beside it.
  {
    const route = source("app/employee-portals/field-crm/[module]/page.tsx");
    assert.match(route, /<PhoenixCrmApp initialOverview=\{load\.overview\} initialTab=\{moduleKey\} single surface="portal" \/>/, "the module page is single");
    assert.match(route, /All of Phoenix CRM/, "and carries the way back, because it has no bar of the others");

    const shell = source("src/components/phoenix-crm/phoenix-crm-app.tsx");
    const bar = shell.slice(shell.indexOf("function tabBar()"), shell.indexOf("function tabBar()") + 200);
    assert.match(bar, /if \(single \|\| tabs\.length < 2\) return null;/, "no tab bar on a separated page");
    assert.match(shell, /\{\(single \? \[activeTab\] : tabs\)\.map\(\(key\) => \{/, "and the others are not even in the DOM");

    // Every hand-off that used to switch tabs in place now NAVIGATES, carrying its subject.
    assert.match(shell, /if \(single\) \{\s*window\.location\.assign\(moduleHref\(next, carry\)\);/, "openTab navigates");
    assert.match(shell, /openTab\("visits", \{ customer: visit\.customerId, name: visit\.customerName \}\);/, "Today sends the customer in the address");
    assert.match(shell, /openTab\("list", \{ validate: String\(validate\.contactCrmId\), name: validate\.customerName \}\);/, "and Add visit sends the entry to Validate");
    // Rebuilt on the FIRST paint, never in an effect — otherwise the tab opens on its own start
    // screen and the rep has to find the customer again.
    assert.match(shell, /const arrivedVisit: PendingVisit \| null =/, "the arriving customer is rebuilt from the address");
    assert.match(shell, /pendingVisit=\{arrivedVisit \?\? pendingVisit\}/, "and reaches the tab");
    assert.match(shell, /pendingValidate=\{arrivedValidate \?\? pendingValidate\}/);
    assert.ok(!/useEffect\([^)]*arrivedVisit/.test(shell), "never through an effect");
  }

  // ── 5. The address follows the tab, and the two lists cannot drift ──────────────────────────────
  {
    const shell = source("src/components/phoenix-crm/phoenix-crm-app.tsx");
    const open = shell.slice(shell.indexOf("function openTab("), shell.indexOf("function workDroppedBy("));
    assert.match(open, /url\.pathname = phoenixCrmModulePath\(PHOENIX_CRM_PORTAL_BASE, next\);/, "the portal writes the module's own path, BY SLUG");
    assert.match(open, /url\.searchParams\.delete\("add"\)/, "and drops ?add=, so a saved link never re-opens a form");
    assert.match(open, /url\.searchParams\.set\("tab", next\)/, "while the admin twin keeps ?tab=");
    // The switch stays IN PAGE — that is what lets the page ask before dropping work he started.
    assert.match(open, /setTab\(next\)/, "the switch is still in page, so the held-work question survives");

    const rules = source("src/lib/phoenix-crm/modules.ts");
    assert.ok(!rules.includes("/server/"), "the rule module stays pure — the boundary test's rule, restated here");
    const page = source("src/lib/phoenix-crm/server/page.ts");
    assert.match(page, /type ModuleKeysCoverTabs = PhoenixCrmModuleKey extends keyof PhoenixCrmOverview\["tabs"\] \? true : never;/);
    assert.match(page, /type TabsCoverModuleKeys = keyof PhoenixCrmOverview\["tabs"\] extends PhoenixCrmModuleKey \? true : never;/);
    assert.match(
      page,
      /const MODULES_AND_TABS_AGREE: \[ModuleKeysCoverTabs, TabsCoverModuleKeys\] = \[true, true\];/,
      "adding a tab with no card, or a card with no tab, must stop compiling",
    );
  }

  console.log("phoenix-crm split modules: OK");
}
