import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adminNavigationSections,
  employeePortalNavigationSections,
  hrNavigationSections,
  hubPageItemGroups,
} from "../src/config/system-navigation.ts";
import { hrNamespaceRemainder, isHrRewritablePath } from "../src/lib/navigation/shell-headers.ts";

/**
 * Every row the sidebar renders, and every hub card behind it, must point at a page that exists.
 *
 * ## Why this test exists
 *
 * A dead sidebar row is reported, not detected. Nothing throws and nothing goes red: the rail
 * renders the row, the label is right, the permission gate is right, and the only symptom is a Not
 * Found page for whoever clicks it. So it is found by a person, days or months later, and reported
 * as "this link is broken" — which is exactly how the `/hr` half of this check came to be written
 * (`tests/hr-url-namespace.test.ts` section 5, 2026-08-28).
 *
 * That `/hr` assertion has held since. The ADMIN rail, the employee-portal rail and the hub cards
 * had no equivalent — 453 hrefs with nothing checking that any of them resolves. They were all
 * clean when this was written (measured 2026-10-06: 215 admin + 64 portal + 174 hub, 0 unresolved),
 * so this is a ratchet at zero rather than a cleanup: it costs nothing today and refuses the first
 * row that goes dead.
 *
 * ## The `/hr` namespace is a REWRITE, and reading the route tree alone gets it wrong
 *
 * There is no `app/**` folder named `hr` at all, and that is correct — `proxy.ts` rewrites every
 * `/hr/<rest>` address onto `/<rest>` (`isHrRewritablePath` / `hrNamespaceRemainder`) and sets the
 * shell header that picks HR chrome. So `/hr/employees` serves `app/(admin)/employees/page.tsx`,
 * and a sweep that checks `/hr/employees` against the filesystem concludes the row 404s when it
 * does not. On 2026-10-06 a report did exactly that and proposed repointing the row at
 * `/employees` — which would have been a real regression twice over: `app-shell.tsx` redirects an
 * HR seat off a bare admin address back into the namespace (`toHrNamespacePath`), and
 * `hr-url-namespace.test.ts` requires every HR row to be authored under the prefix.
 *
 * This test therefore strips the prefix with the namespace's OWN helpers before resolving, rather
 * than re-deriving the rule. A second spelling of it is the defect the helper exists to prevent.
 *
 * 🔴 And the helper it asks is `isHrRewritablePath`, NEVER the broader `isHrNamespacePath`. The two
 * disagree on exactly one thing, and it is a security boundary rather than a detail: `proxy.ts`
 * REFUSES to rewrite `/hr/api/**`, because the CSRF guard there is scoped to paths beginning
 * `/api/` and a rewritten `/hr/api/x` would reach every API route with that guard never running. So
 * an address under `/hr/api/` is served by nothing, and stripping its prefix would resolve it as if
 * the rewrite applied — this check would then call a genuinely dead row healthy, which is the one
 * thing it exists to refuse. Asking the narrower predicate means the exclusion list can grow in
 * `shell-headers.ts` without this file having to learn about it.
 *
 * ## What it deliberately cannot check
 *
 * Only that the address is a route. Not that the page renders, not that the viewer's permission
 * admits it (`hr-url-namespace.test.ts` pins that for the HR seats, and
 * `tests/navigation-granted-but-unreachable.test.ts` the converse). Query strings are dropped —
 * `?view=` is read by the page, not the router. A redirect source is NOT accepted as a resolution:
 * a rail row should open the real page, not bounce through a 308 kept alive for links already sent
 * to people. A row that legitimately needs a redirect should be repointed at the destination.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Every page URL the app can serve, derived from the files rather than from a list. */
function pageRoutes(): Set<string> {
  const routes = new Set<string>();
  const walk = (dir: string, url: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        // Route groups — `(admin)`, `(desks)` — organise files without appearing in the URL, and
        // `@modal` parallel routes / `_private` folders are not URL segments either.
        const isGroup = entry.startsWith("(") && entry.endsWith(")");
        const isNonSegment = entry.startsWith("@") || entry.startsWith("_");
        walk(full, isGroup || isNonSegment ? url : `${url}/${entry}`);
      } else if (/^page\.tsx?$/.test(entry)) {
        routes.add(url || "/");
      }
    }
  };
  walk(join(repoRoot, "app"), "");
  return routes;
}

function resolvesToPage(href: string, routes: Set<string>): boolean {
  // The query and the fragment come off FIRST, and not for tidiness: `isHrRewritablePath("/hr?x=1")`
  // is false — that address equals neither `/hr` nor anything starting `/hr/` — so testing the raw
  // href would read a namespace row as an ordinary one and report it dead. The router matches the
  // pathname alone; `?view=` is read by the page.
  const pathname = href.split("?")[0].split("#")[0];
  // `/hr/employees` is served by `/employees` — see the namespace note above. The predicate is
  // `isHrRewritablePath`, never `isHrNamespacePath`: `/hr/api/**` is deliberately NOT rewritten, so
  // stripping its prefix would resolve an address nothing serves.
  const address = isHrRewritablePath(pathname) ? hrNamespaceRemainder(pathname) : pathname;
  const segments = address.replace(/\/+$/, "").split("/").filter(Boolean);
  if (segments.length === 0) return routes.has("/");
  for (const candidate of routes) {
    const parts = candidate.split("/").filter(Boolean);
    if (parts.length !== segments.length) continue;
    // `[hrId]` is an App Router dynamic segment and matches whatever the row put there.
    if (parts.every((part, i) => part.startsWith("[") || part === segments[i])) return true;
  }
  return false;
}

export function runNavHrefsResolveTests() {
  const routes = pageRoutes();

  // Guard the guard. If the walk stops matching — a renamed folder, a moved `app/` — every
  // assertion below passes vacuously while checking nothing. The floor is well under the real
  // count (448 pages when written) so ordinary churn never trips it.
  assert.ok(routes.size > 350, `route table looks broken: only ${routes.size} page routes found`);

  const catalogues: readonly { name: string; hrefs: readonly string[] }[] = [
    {
      name: "the admin sidebar",
      hrefs: adminNavigationSections.flatMap((section) => section.items.map((item) => item.href)),
    },
    {
      name: "the employee-portal sidebar",
      hrefs: employeePortalNavigationSections.flatMap((section) => section.items.map((item) => item.href)),
    },
    {
      name: "the HR sidebar",
      hrefs: hrNavigationSections.flatMap((section) => section.items.map((item) => item.href)),
    },
    {
      name: "the hub cards",
      hrefs: hubPageItemGroups.flatMap((group) => group.items.map((item) => item.href)),
    },
  ];

  const dead: string[] = [];
  let checked = 0;
  for (const { name, hrefs } of catalogues) {
    const unique = [...new Set(hrefs)];
    // Each catalogue gets its own floor for the same reason as the route table: an export that
    // becomes an empty array would otherwise silently retire this check for that whole rail.
    assert.ok(unique.length > 20, `${name} looks broken: only ${unique.length} hrefs found`);
    checked += unique.length;
    for (const href of unique) {
      if (!resolvesToPage(href, routes)) dead.push(`${href}  <-  ${name}`);
    }
  }

  assert.deepEqual(
    dead,
    [],
    `these navigation rows point at addresses that are not routes — each one is a Not Found page for whoever clicks it:\n  ${dead.join("\n  ")}`,
  );
  assert.ok(checked > 450, `expected the four catalogues to total over 450 hrefs, counted ${checked}`);

  // The row this test was written over, pinned by name in both halves. `/hr/employees` is the HR
  // seats' spelling of the admin register and must stay the `/hr` one (the namespace is authored
  // under the prefix, and a bare admin address redirects an HR seat straight back here), while
  // `/employees` is the page that actually serves it. Asserting only "it resolves" above would let
  // a future session repoint the row at `/employees` and still go green.
  assert.ok(
    routes.has("/employees"),
    "the admin employee register must stay at /employees — it is what /hr/employees is rewritten onto",
  );
  const hrHrefs = new Set(hrNavigationSections.flatMap((section) => section.items.map((item) => item.href)));
  assert.ok(
    hrHrefs.has("/hr/employees"),
    "Employee Directory must stay at /hr/employees for the HR seats: proxy.ts rewrites it onto /employees, and a bare /employees row would be redirected back into the namespace by app-shell",
  );
  assert.ok(
    !routes.has("/hr/employees"),
    "there must be no app/ folder at /hr/employees — the namespace is a proxy.ts rewrite, and a real page there would be a second copy of the register",
  );

  // The resolver itself, against route sets written here rather than read from `app/`. Both cases
  // below PASS the real tree today whichever predicate the resolver asks, because no nav row sits
  // under `/hr/api/` and no page.tsx sits under `app/api/` — so a catalogue sweep cannot tell the
  // two apart and the mistake would survive until one of those became true. A synthetic route set
  // makes the difference observable now: with `isHrNamespacePath` in place of `isHrRewritablePath`
  // the first assertion fails, because the prefix comes off an address proxy.ts refuses to rewrite.
  assert.ok(
    !resolvesToPage("/hr/api/x", new Set(["/api/x"])),
    "/hr/api/** is NOT rewritten (the CSRF guard in proxy.ts is scoped to /api/), so a row there is served by nothing and must not resolve through /api/x",
  );
  assert.ok(
    resolvesToPage("/hr/x", new Set(["/x"])),
    "an ordinary /hr address IS rewritten, so /hr/x must resolve through the page at /x",
  );
  // A query string must not hide the namespace. `/hr?tab=x` is inside it, yet equals neither `/hr`
  // nor anything starting `/hr/`, so a resolver that tests the raw href calls the HR landing dead.
  assert.ok(
    resolvesToPage("/hr?tab=x", new Set(["/"])),
    "/hr?tab=x is the namespace root with a query: the pathname is stripped before the namespace test, so it resolves to /",
  );
}
