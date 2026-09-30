import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  allowedPhoenixCrmModules,
  isPhoenixCrmModuleKey,
  PHOENIX_CRM_MODULE_KEYS,
  PHOENIX_CRM_MODULES,
  PHOENIX_CRM_PORTAL_BASE,
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
    assert.match(route, /if \(!isPhoenixCrmModuleKey\(module\)\) notFound\(\);/, "an unknown segment is a 404");
    assert.match(route, /<PhoenixCrmApp initialOverview=\{load\.overview\} initialTab=\{module\} surface="portal" \/>/, "and it opens on that module");
    // 🔴 A module he may not open is a SENTENCE, not a dead page: a rep following a shared link must
    // read why, and `notFound()` there would tell him the module does not exist.
    assert.match(route, /if \(!load\.overview\.tabs\[module\]\) \{/, "a module not his reads as a sentence");
    assert.match(route, /is not yours to open/, "in words, never a 404");
  }

  // ── 5. The address follows the tab, and the two lists cannot drift ──────────────────────────────
  {
    const shell = source("src/components/phoenix-crm/phoenix-crm-app.tsx");
    const open = shell.slice(shell.indexOf("function openTab("), shell.indexOf("function workDroppedBy("));
    assert.match(open, /url\.pathname = `\$\{PHOENIX_CRM_PORTAL_BASE\}\/\$\{next\}`;/, "the portal writes the module's own path");
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
