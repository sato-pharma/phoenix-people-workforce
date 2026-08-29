import { existsSync } from "node:fs";
import path from "node:path";

/**
 * ONE reader for "what gate does this page put in front of a visitor".
 *
 * ## Why this file exists
 *
 * Three tests need to answer that question and two of them had written their own parser. They did
 * not agree, and the disagreement was not cosmetic — it was measured on 2026-08-29 across the 377
 * `page.tsx` files in `app/`:
 *
 *     the reader in every-offered-link-opens.test.ts saw a gate on   86 pages
 *     the reader in hr-seat-route-coherence.test.ts saw one on      157 pages
 *
 * 72 gated pages were invisible to the weaker one. Two reasons, both worth keeping in mind before
 * anyone "simplifies" the patterns below:
 *
 *  1. It matched `!await canAccess(` only. The shape this codebase actually writes is
 *     `!(await canAccess(…))`. That single missing `\(?` is the same bug hr-seat-route-coherence
 *     records in its own floor comment — its first version "read 8 gated pages where there are 12".
 *  2. It anchored to a two-space indent, so a gate one level deeper was dropped.
 *
 * The direction of that miss is what makes it worth a shared module rather than a patch. In
 * every-offered-link-opens a gate it cannot see means "this page requires no grant", so an
 * unreadable gate does not fail — it PASSES, quietly, for every role. A parser that under-reads is
 * therefore a fail-open parser, and two of them drifting apart is the exact defect class this
 * repository keeps paying for: one rule, several copies, nothing forcing them to agree.
 *
 * ## What a caller gets, and what it must still decide
 *
 * This module reads; it does not judge. It reports the permission gates, the hard-coded role-set
 * gates, whether the page carries the shell gate, and whether it exits at all. Whether a given seat
 * or role SATISFIES those gates is the calling test's business, because each asks a different
 * question of the same facts.
 *
 * It deliberately reports nothing about gates it cannot parse beyond `hasEntryExit`. A caller that
 * wants to distinguish "ungated" from "gated in a shape I cannot read" must use that signal — see
 * `GATE_SHAPE_NOT_MACHINE_READABLE` in hr-seat-route-coherence.test.ts, which requires the
 * unreadable set to match a hand-verified list EXACTLY so that "unchecked" can never quietly read
 * as "fine".
 */

/**
 * Comments and string CONTENTS replaced by spaces, LENGTH PRESERVED, so offsets computed on the
 * blanked text still index the original. Without this a brace inside a string or a comment ends a
 * function body early and its assertions land under the wrong handler.
 *
 * Note this blanks string CONTENTS, so it must NOT be applied before the permission patterns below
 * run — those read the resource and action out of string literals. It is for brace matching.
 */
export function blankOut(source: string): string {
  const chars = source.split("");
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") {
        chars[i] = " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] !== "\n") chars[i] = " ";
        i += 1;
      }
      if (i < n) {
        chars[i] = " ";
        chars[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      chars[i] = " ";
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          chars[i] = " ";
          if (i + 1 < n && source[i + 1] !== "\n") chars[i + 1] = " ";
          i += 2;
          continue;
        }
        if (source[i] === c) {
          chars[i] = " ";
          i += 1;
          break;
        }
        if (source[i] !== "\n") chars[i] = " ";
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return chars.join("");
}

/**
 * An ENTRY gate, not a capability flag. `if (!(await canAccess(...))) redirect(...)` decides whether
 * the page opens at all; `const canDelete = await canAccess(...)` is a prop passed to a component
 * and must NOT be counted — treating one as the other reports a page as closed when it merely hides
 * a button. The optional `(` is the load-bearing character described in this file's header.
 */
export const PAGE_ENTRY_GATE =
  /!\(?\s*await\s+canAccess\(\s*access\s*,\s*"([a-z_]+)"\s*,\s*"([a-z_]+)"\s*\)/g;
export const PAGE_ENTRY_ASSERT =
  /await\s+assertPermission\(\s*access\s*,\s*"([a-z_]+)"\s*,\s*"([a-z_]+)"\s*\)/g;

/**
 * A hard-coded ROLE SET gate — `VIEW_ROLES.has(access.role)`, `ALLOWED.includes(access.role)`. This
 * is the shape a permission cannot express and therefore the shape the sidebar cannot reason about,
 * which is exactly why it is worth reading: /hr/admin/deductions admits {Super Admin, CEO} by name
 * and redirects everyone else, so offering that row on `deductions:read` handed HR Operations a link
 * that bounced her on arrival. Nothing in the permission matrix could have shown that.
 */
const PAGE_ROLE_SET_MEMBER = /"([^"]+)"/g;
/** `const VIEW_ROLES = new Set([...])` / `const ALLOWED = [...]` — the set is almost never inline. */
const PAGE_ROLE_SET_BINDING = /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:new Set\(\s*)?\[([^\]]*)\]/g;
/** `!VIEW_ROLES.has(access.role)` — negated only: an un-negated test is a deny list or a flag. */
const PAGE_ROLE_SET_USE = /!\s*([A-Za-z_$][\w$]*)\s*\.\s*(?:has|includes)\(\s*access\.role\s*\)/g;
/** The same thing written inline, `!new Set([...]).has(access.role)`. Rare, but free to cover. */
const PAGE_ROLE_SET_INLINE =
  /!\s*(?:new Set\(\s*)?\[([^\]]*)\]\)?\s*\.\s*(?:has|includes)\(\s*access\.role\s*\)/g;

/**
 * The SHELL gate: `if (resolveNavigationMode(access) === "employee-portal") redirect(...)`. It asks
 * which shell the viewer belongs in, not what they may do, so it is satisfied or not by the role
 * alone. A caller should settle it by CALLING resolveNavigationMode rather than assuming.
 */
export const PAGE_SHELL_GATE = /resolveNavigationMode\(\s*access\s*\)\s*===\s*"employee-portal"/;

/**
 * The MIRROR IMAGE of the shell gate: `resolveNavigationMode(access) !== "employee-portal"`, which
 * a page under `app/employee-portals/` uses to send admin-shell roles to its admin twin —
 * `app/employee-portals/cv-database/page.tsx` redirects them to `/cv-database`, same loader, same
 * rows, different shell.
 *
 * Added 2026-08-29 by the reverse guard (navigation-granted-but-unreachable). `PAGE_SHELL_GATE`
 * above is deliberately one-directional and its callers are right to want it that way, but a reader
 * that knows only that direction believes a portal twin opens for EVERYONE — so the CEO and Super
 * Admin read as able to open `/employee-portals/cv-database` when the page bounces them on the
 * first statement. Measured across `app/`: 69 pages carry the `===` form and **63 the `!==` form**,
 * so this is a systematic pairing, not a one-off.
 *
 * Kept as a separate export rather than folded into `isShellGated`, whose two existing callers ask
 * "does this admin page refuse portal roles" and would silently change meaning.
 */
export const PAGE_PORTAL_TWIN_GATE =
  /resolveNavigationMode\(\s*access\s*\)\s*!==\s*"employee-portal"/;

/** Does the page refuse anyone at all? Used to tell "ungated" from "gated in an unreadable shape". */
export const PAGE_ENTRY_EXIT = /\b(?:redirect|notFound)\(/;

function literalStrings(body: string): string[] {
  const names: string[] = [];
  PAGE_ROLE_SET_MEMBER.lastIndex = 0;
  let member: RegExpExecArray | null;
  while ((member = PAGE_ROLE_SET_MEMBER.exec(body))) names.push(member[1]!);
  return names;
}

/** Every `resource:action` this page's entry gate demands, as a set of `"resource:action"` keys. */
export function permissionGateKeys(source: string): Set<string> {
  const needs = new Set<string>();
  for (const re of [PAGE_ENTRY_GATE, PAGE_ENTRY_ASSERT]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source))) needs.add(`${match[1]}:${match[2]}`);
  }
  return needs;
}

/** Every hard-coded admit-list the page's entry gate tests `access.role` against. */
export function roleSetGates(source: string): string[][] {
  const bindings = new Map<string, string[]>();
  PAGE_ROLE_SET_BINDING.lastIndex = 0;
  let binding: RegExpExecArray | null;
  while ((binding = PAGE_ROLE_SET_BINDING.exec(source))) {
    const names = literalStrings(binding[2]!);
    if (names.length) bindings.set(binding[1]!, names);
  }

  const gates: string[][] = [];
  PAGE_ROLE_SET_USE.lastIndex = 0;
  let use: RegExpExecArray | null;
  while ((use = PAGE_ROLE_SET_USE.exec(source))) {
    const names = bindings.get(use[1]!);
    if (names) gates.push(names);
  }
  PAGE_ROLE_SET_INLINE.lastIndex = 0;
  let inline: RegExpExecArray | null;
  while ((inline = PAGE_ROLE_SET_INLINE.exec(source))) {
    const names = literalStrings(inline[1]!);
    if (names.length) gates.push(names);
  }
  return gates;
}

export function isShellGated(source: string): boolean {
  return PAGE_SHELL_GATE.test(source);
}

/**
 * Where a portal twin sends an admin-shell role, or `null` if the page is not one.
 *
 * Read POSITIONALLY — the first `redirect("…")` at or after the twin-gate condition — because a
 * twin usually carries a second, unrelated redirect underneath it. `app/employee-portals/employees`
 * is the worked example:
 *
 *     if (resolveNavigationMode(access) !== "employee-portal") redirect("/employees");   // the twin
 *     if (!(await canAccess(access, "employees", "read")))     redirect("/employee-portals");
 *
 * A first attempt demanded that every redirect in the file agree on one target, so that page
 * resolved to `null` and read as an orphan when it is a plain twin of `/employees`. Requiring
 * unanimity is the wrong shape: the twin gate and the permission gate are different questions and
 * naturally send you to different places.
 *
 * The gate itself still has to be present, which is what keeps a DENIAL exit out —
 * `app/(admin)/admin/email-notifications/page.tsx` redirects to `/employee-portals` too, but its
 * condition is `!(await canAccess(…))`, and reading that as a twin would report a genuinely
 * unlinked page as reachable.
 */
export function portalTwinRedirect(source: string): string | null {
  const gate = PAGE_PORTAL_TWIN_GATE.exec(source);
  if (!gate) return null;
  const redirects = /\bredirect\(\s*"(\/[^"]*)"\s*\)/g;
  redirects.lastIndex = gate.index;
  const match = redirects.exec(source);
  return match ? match[1]! : null;
}

/**
 * Predicates in an entry gate that this reader cannot evaluate — `!isAllVacationVisibility(access)`,
 * `!canAccessFingerprintReport(access)`. The page refuses on them and nothing here can say who for.
 *
 * `/admin/approvals/stuck` is why this exists. Its readable gates are empty, so a caller computing
 * "who can open this" answers *seven roles*, while the page's own comment says "HR / Super Admin
 * only" and `isAllVacationVisibility` enforces it. A reader that reports the empty set without this
 * signal does not merely miss a gate — it states a confident wrong answer, which is the fail-open
 * direction this whole module exists to close.
 *
 * The known names are excluded because the reader parses those itself; anything else is a predicate
 * a caller must treat as "cannot conclude" rather than "no gate".
 */
const PAGE_UNREADABLE_PREDICATE = /!\s*\(?\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(\s*access\b/g;
const PREDICATES_THIS_READER_PARSES = new Set(["canAccess", "assertPermission", "resolveNavigationMode"]);

export function unreadableGatePredicates(source: string): string[] {
  const found = new Set<string>();
  PAGE_UNREADABLE_PREDICATE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PAGE_UNREADABLE_PREDICATE.exec(source))) {
    const name = match[1]!;
    if (!PREDICATES_THIS_READER_PARSES.has(name)) found.add(name);
  }
  return [...found].sort();
}

export function hasEntryExit(source: string): boolean {
  return PAGE_ENTRY_EXIT.test(source);
}

/**
 * Resolve a nav href to the page file that serves it, absolute.
 *
 * `stripHrPrefix` exists because the HR shell mounts the same pages under /hr — /hr/probation is
 * served by app/(admin)/probation/page.tsx. Only the HR seat test wants that rewrite; applying it
 * everywhere would resolve an admin href to the wrong file.
 */
export function pageFileFor(
  href: string,
  options: { repoRoot: string; stripHrPrefix?: boolean },
): string | null {
  if (!href.startsWith("/")) return null;
  const rest = options.stripHrPrefix
    ? href.startsWith("/hr/")
      ? href.slice(3)
      : href === "/hr"
        ? "/"
        : href
    : href;
  const rel = rest.replace(/^\//, "");
  for (const candidate of [
    path.join(options.repoRoot, "app", "(admin)", rel, "page.tsx"),
    path.join(options.repoRoot, "app", rel, "page.tsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
