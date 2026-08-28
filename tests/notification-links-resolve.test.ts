import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every notification link in the source must point at a page that exists.
 *
 * ## Why this test exists
 *
 * A notification whose button 404s is close to invisible. Nothing throws, nothing is logged, no
 * dashboard goes red — the send succeeds, the row lands in `notification_events`, the email and the
 * Telegram message arrive looking perfect. The only person who finds out is the recipient, who taps
 * "Confirm the holiday date" and gets a Not Found page, and who has no way to report anything more
 * useful than "the link didn't work". So the defect survives for months.
 *
 * Two were live when this test was written, found by querying production rather than by anyone
 * reporting them:
 *
 *   /admin/attendance/holiday-calendar  — the page is /attendance/holiday-calendar. It was moved out
 *     of /admin and this href was left behind. 3 sent, most recently 2026-08-24, all 404.
 *   /contracts/renewals                 — never existed at that address. 82 sent. The route that
 *     generates the real notification had already been corrected to /contracts; the Telegram
 *     template beside it had not, so the same wrong URL was still there to be copied.
 *
 * That second one is the reason this is a test and not a one-line fix. The class regenerates: the
 * fix lands in one of the several places that build a link for the same event, and the others keep
 * the stale copy, ready to be pasted into the next module by someone who reasonably assumes a
 * committed constant is correct.
 *
 * ## What it does
 *
 * Builds the real route table from the filesystem, then checks every statically-known notification
 * link literal against it. No network, no database, no dev server — it reads the repository, so it
 * is as fast as the file walk and cannot flake.
 *
 * ## What it deliberately cannot check
 *
 * A link whose PATH is built at runtime (`` `/admin/x/${id}` ``) is skipped: the static prefix alone
 * would not tell us whether the dynamic segment matches a real `[param]` folder. Query strings are
 * ignored — `?confirm=` is read by the page, not by the router. The check is therefore a floor, not
 * a ceiling: it cannot prove every link works, only that no link points at an address that is not a
 * route at all. That is exactly the failure both live defects had.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Every URL the app can actually serve, derived from the files rather than from a list. */
function routeTable(): Set<string> {
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
        // Route groups — `(admin)`, `(desks)` — organise files without appearing in the URL.
        const isGroup = entry.startsWith("(") && entry.endsWith(")");
        // `@modal` parallel routes and `_private` folders are not URL segments either.
        const isNonSegment = entry.startsWith("@") || entry.startsWith("_");
        walk(full, isGroup || isNonSegment ? url : `${url}/${entry}`);
      } else if (/^(page|route)\.tsx?$/.test(entry)) {
        routes.add(url || "/");
      }
    }
  };
  walk(join(repoRoot, "app"), "");
  return routes;
}

/**
 * Sources of permanent redirects, read from `redirects()` ONLY.
 *
 * Scoped deliberately: `next.config.ts` also has a `headers()` block whose entries use the same
 * `source:` key, and several of those are broad globs (`/:path*`). Counting those as redirects
 * would make almost any dead link appear to resolve — which would leave this test passing while
 * asserting nothing.
 */
function redirectSources(): Set<string> {
  const config = readFileSync(join(repoRoot, "next.config.ts"), "utf8");
  const start = config.indexOf("async redirects()");
  assert.ok(start > 0, "expected a redirects() block in next.config.ts");
  const end = config.indexOf("async headers()", start);
  const block = config.slice(start, end > start ? end : undefined);
  return new Set([...block.matchAll(/source:\s*"([^"]+)"/g)].map((m) => m[1]));
}

function resolvesTo(path: string, routes: Set<string>, redirects: Set<string>): string | null {
  const segments = path.split("/").filter(Boolean);
  for (const candidate of [...routes, ...redirects]) {
    const parts = candidate.split("/").filter(Boolean);
    if (parts.length !== segments.length) continue;
    // `[id]` is an App Router dynamic segment; `:id` is the next.config redirect spelling.
    const matches = parts.every(
      (part, i) => part.startsWith("[") || part.startsWith(":") || part === segments[i],
    );
    if (matches) return candidate;
  }
  return null;
}

/** Every `actionUrl` / `ctaHref` / `action_url` string literal that names a fixed path. */
function notificationLinkLiterals(): Map<string, string[]> {
  const pattern = /(?:actionUrl|ctaHref|action_url)\s*[:=]\s*[`"']([^`"']*)/g;
  const found = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      const lines = readFileSync(full, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const match of line.matchAll(pattern)) {
          const raw = match[1];
          if (!raw.startsWith("/")) continue;
          const head = raw.split("?")[0].split("#")[0];
          // Built at runtime — the static prefix alone cannot be checked against a [param] folder.
          if (head.includes("${")) continue;
          const path = head.replace(/\/+$/, "") || "/";
          const where = `${full.slice(repoRoot.length).replace(/\\/g, "/")}:${index + 1}`;
          found.set(path, [...(found.get(path) ?? []), where]);
        }
      });
    }
  };
  walk(join(repoRoot, "src"));
  walk(join(repoRoot, "app"));
  return found;
}

export function runNotificationLinksResolveTests() {
  const routes = routeTable();
  const redirects = redirectSources();
  const literals = notificationLinkLiterals();

  // Guard the guard. If the walk or the pattern silently stops matching — a rename, a moved folder,
  // a refactor to a helper this regex does not see — every assertion below passes vacuously and the
  // test reports green while checking nothing. These floors are well under the real counts
  // (1,045 routes and 34 literals when written) so ordinary churn never trips them.
  assert.ok(routes.size > 500, `route table looks broken: only ${routes.size} routes found`);
  assert.ok(literals.size > 15, `link scan looks broken: only ${literals.size} literals found`);
  assert.ok(redirects.size >= 5, `redirect scan looks broken: only ${redirects.size} sources found`);

  const dead: string[] = [];
  for (const [path, sites] of literals) {
    if (!resolvesTo(path, routes, redirects)) {
      dead.push(`${path}  <-  ${sites.join(", ")}`);
    }
  }
  assert.deepEqual(
    dead,
    [],
    `these notification links point at pages that do not exist — every one of them 404s when a real person taps it:\n  ${dead.join("\n  ")}`,
  );

  // The two that were live in production. Pinned by name because the generator fix and the redirect
  // are separate halves: correcting the href only helps the NEXT send, while the redirect is what
  // repairs the 85 notifications already sitting in inboxes. Losing either half silently un-fixes
  // one group of people.
  assert.ok(
    routes.has("/attendance/holiday-calendar"),
    "the holiday calendar page must stay at /attendance/holiday-calendar, or the notification href is wrong again",
  );
  for (const legacy of ["/contracts/renewals", "/admin/attendance/holiday-calendar"]) {
    assert.ok(
      redirects.has(legacy),
      `${legacy} must keep its permanent redirect — notifications already sent to real people point there`,
    );
  }
  const holidayRoute = readFileSync(
    join(repoRoot, "app/api/notifications/holiday-confirmation/route.ts"),
    "utf8",
  );
  assert.ok(
    holidayRoute.includes("`/attendance/holiday-calendar?confirm="),
    "the holiday confirmation notification must link to /attendance/holiday-calendar (no /admin prefix)",
  );
}
