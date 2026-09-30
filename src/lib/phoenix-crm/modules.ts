/**
 * Phoenix CRM — the modules, and the route each one lives at.
 *
 * 🔴 THE MODULE IS A PAGE, NOT A TAB IN ONE SCREEN (owner, 2026-09-30: "make the Phoenix CRM a button
 * in the sidebar that does not direct me into what it directs me today — it directs me to a page that
 * has the SPLIT modules"). Pressing Phoenix CRM in the sidebar used to land straight on Today, with
 * every other module mounted beside it in the same screen behind a tab bar. Now the sidebar opens a
 * CHOOSER, and each module is its own route with its own address:
 *
 *     /employee-portals/field-crm            the chooser
 *     /employee-portals/field-crm/today      one module, on its own page
 *     /employee-portals/field-crm/visits     …and so on
 *
 * `?tab=` still works and redirects to the module's own path, because the portal's "+" actions,
 * notification links and any address he has kept still carry it.
 *
 * This file is the ONE place the list lives, so the chooser, the router and the tests cannot drift.
 */

/**
 * Where the portal's Phoenix CRM lives. It is defined HERE, not in `server/page.ts`, because the app
 * shell is a client component and must be able to write a module's address without dragging the
 * server module into the browser bundle. `server/page.ts` re-exports it as PHOENIX_CRM_PORTAL_PATH.
 */
export const PHOENIX_CRM_PORTAL_BASE = "/employee-portals/field-crm";

/**
 * 🔴 WRITTEN OUT, NOT DERIVED FROM `PhoenixCrmTabs`. The boundary test keeps every rule module under
 * `src/lib/phoenix-crm/` free of `server/` imports so the rules stay usable without a database — and
 * an `import type` counts, because the rule is about the dependency, not about what survives the
 * build. `server/page.ts` carries a compile-time check that this union and `keyof PhoenixCrmTabs`
 * still agree, so adding a tab without giving it a card cannot compile.
 */
export type PhoenixCrmModuleKey = "today" | "visits" | "list" | "plan" | "team" | "doctors" | "reports" | "settings";

export type PhoenixCrmModule = {
  key: PhoenixCrmModuleKey;
  /**
   * The module's segment in the ADDRESS, which is not always its key.
   *
   * 🔴 THE ADDRESS BAR IS UI, AND THE BANNED WORDS REACH IT. Owner, 2026-09-23: "in
   * employee-portals/field-crm make it ALL AM PM, not doctors and accounts." The Directory tab's KEY
   * is the retired word, and routing on the key put it in the address AND in the browser tab, which
   * read "Doctors · Phoenix Workforce" — the shared title resolver names a page from its own
   * segments. So the slug is `directory`, and the key stays where it always was, in the data.
   */
  slug: string;
  /** The name on the card and in the tab bar — the same word in both, so the two never disagree. */
  label: string;
  /** One line on the card: what he opens it to do, in his own vocabulary. */
  blurb: string;
};

/**
 * Every module, in the order the chooser lists them: the rep's day first, then the work he does on it,
 * then the reading. `settings` is last because it is the Super Admin's.
 */
export const PHOENIX_CRM_MODULES: readonly PhoenixCrmModule[] = [
  { key: "today", slug: "today", label: "Today", blurb: "Your approved day — who to see, where they are, and one tap to add each visit." },
  { key: "visits", slug: "visits", label: "Visits", blurb: "Add a visit, and read back the ones you entered today." },
  { key: "list", slug: "list", label: "List", blurb: "Your customers: validate them at the clinic, keep their days and hours, ask to add or drop." },
  { key: "plan", slug: "plan", label: "Plan", blurb: "Build the month and its weeks, and send them for approval." },
  { key: "team", slug: "team", label: "Team", blurb: "Your people's days and plans, and the decisions waiting on you." },
  // The one module whose slug is NOT its key — see `slug` above.
  { key: "doctors", slug: "directory", label: "Directory", blurb: "Search every customer you are allowed to see." },
  { key: "reports", slug: "reports", label: "Reports", blurb: "Coverage, frequency and the call rate, AM and PM apart." },
  { key: "settings", slug: "settings", label: "Settings", blurb: "The module's own settings." },
];

export const PHOENIX_CRM_MODULE_KEYS: readonly PhoenixCrmModuleKey[] = PHOENIX_CRM_MODULES.map((entry) => entry.key);

/** Is this path segment one of the modules? Used by the route before it reads anything. */
export function isPhoenixCrmModuleKey(value: string | null | undefined): value is PhoenixCrmModuleKey {
  return typeof value === "string" && (PHOENIX_CRM_MODULE_KEYS as readonly string[]).includes(value);
}

/** The modules this viewer may open, in the chooser's order. Never a module his role cannot reach. */
export function allowedPhoenixCrmModules(tabs: Record<PhoenixCrmModuleKey, boolean>): PhoenixCrmModule[] {
  return PHOENIX_CRM_MODULES.filter((entry) => tabs[entry.key]);
}

/** The module for a slug in the address, or null — the route's own 404 test. */
export function phoenixCrmModuleForSlug(slug: string | null | undefined): PhoenixCrmModule | null {
  return PHOENIX_CRM_MODULES.find((entry) => entry.slug === slug) ?? null;
}

/** The module's own address under a base path (the portal's, or the admin shell's twin). */
export function phoenixCrmModulePath(base: string, key: PhoenixCrmModuleKey): string {
  const found = PHOENIX_CRM_MODULES.find((entry) => entry.key === key);
  return `${base}/${found ? found.slug : key}`;
}
