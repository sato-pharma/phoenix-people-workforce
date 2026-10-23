import { existsSync, readdirSync } from "node:fs";
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

/**
 * ── Reading an ENTRY CONDITION, not just a pattern ───────────────────────────────────────────────
 *
 * Every pattern above matches a shape wherever it appears in the file. The two gate shapes below
 * cannot be read that way: both need to know which `if (…)` a fragment belongs to, and what that
 * `if` DOES when it fires. So this section does the small amount of structural reading they need —
 * balanced brackets and top-level operator splitting, nothing more.
 *
 * All of it runs on `blankOut(source)`, whose length is preserved, so an offset found in the blanked
 * text indexes the ORIGINAL. That is what makes it safe: a `&&` inside a string literal cannot split
 * a condition, and a `redirect(` inside a comment cannot qualify one.
 */

/** Index of the bracket closing the one at `open`, or -1 if it is unbalanced. */
function matchingBracket(blanked: string, open: number): number {
  const closerFor: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const wanted = closerFor[blanked[open]!];
  if (!wanted) return -1;
  let depth = 0;
  for (let i = open; i < blanked.length; i += 1) {
    const c = blanked[i]!;
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      if (depth === 0) return c === wanted ? i : -1;
    }
  }
  return -1;
}

/** The spans of `blanked[start,end)` separated by `operator` at bracket depth 0. */
function splitTopLevel(
  blanked: string,
  start: number,
  end: number,
  operator: "||" | "&&",
): [number, number][] {
  const spans: [number, number][] = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i += 1) {
    const c = blanked[i]!;
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (depth === 0 && blanked.startsWith(operator, i)) {
      spans.push([from, i]);
      i += operator.length - 1;
      from = i + 1;
    }
  }
  spans.push([from, end]);
  return spans;
}

/**
 * Drop surrounding whitespace and redundant wrapping parentheses, keeping absolute offsets.
 *
 * Whitespace is judged on the SOURCE and brackets on the BLANKED text, and mixing those up is not a
 * style choice — `blankOut` replaces a string literal INCLUDING ITS QUOTES with spaces, so
 * `access.role !== "Super Admin"` ends in twelve blanks. Trimming on the blanked text ate the role
 * name and left `access.role !==`, which matches nothing: the first cut of this function read zero
 * gates on all 25 files while looking like it worked.
 */
function tighten(source: string, blanked: string, span: [number, number]): [number, number] {
  let [start, end] = span;
  for (;;) {
    while (start < end && /\s/.test(source[start]!)) start += 1;
    while (end > start && /\s/.test(source[end - 1]!)) end -= 1;
    if (start < end && blanked[start] === "(" && matchingBracket(blanked, start) === end - 1) {
      start += 1;
      end -= 1;
      continue;
    }
    return [start, end];
  }
}

/**
 * What an entry gate's body does when it fires: it forwards, or it returns a bounce screen instead
 * of the page. The JSX arm is not a nicety — `app/employee-portals/account-activation/page.tsx`
 * refuses everyone but HR Advisory by returning `<EmployeePortalEmptyState … />`, and the permission
 * half of that very condition is already counted as a gate by `PAGE_ENTRY_GATE`, which matches
 * regardless of consequent. Reading one half and not the other would be the inconsistency.
 */
const CONSEQUENT_FORWARDS = /\b(?:permanentRedirect|redirect|notFound)\s*\(/;
const CONSEQUENT_RETURNS_JSX = /return\s*\(?\s*</;

/**
 * Only the consequent's OWN statements count, never a nested block's.
 * `if (cond) { if (somethingElse) redirect(…) }` forwards CONDITIONALLY, and reading it as an
 * unconditional gate would invent an admit list the page does not enforce — the fail-CLOSED mirror
 * of the fail-open this module exists to prevent, and just as wrong. Everything inside a nested
 * `{…}` is blanked; the braces themselves go too, so the depth test cannot be fooled by a JSX
 * expression container.
 */
function ownStatementsOf(body: string): string {
  let depth = 0;
  let out = "";
  for (const c of body) {
    if (c === "{") {
      depth += 1;
      out += " ";
    } else if (c === "}") {
      depth = Math.max(0, depth - 1);
      out += " ";
    } else {
      out += depth === 0 ? c : " ";
    }
  }
  return out;
}

/** Every `if (…)` in the file whose consequent exits the page, as offsets into the source. */
function entryGateConditions(blanked: string): [number, number][] {
  const conditions: [number, number][] = [];
  const ifKeyword = /\bif\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = ifKeyword.exec(blanked))) {
    const open = match.index + match[0].length - 1;
    const close = matchingBracket(blanked, open);
    if (close < 0) continue;

    let at = close + 1;
    while (at < blanked.length && /\s/.test(blanked[at]!)) at += 1;
    let body: string;
    if (blanked[at] === "{") {
      const blockEnd = matchingBracket(blanked, at);
      if (blockEnd < 0) continue;
      body = blanked.slice(at + 1, blockEnd);
    } else {
      let depth = 0;
      let end = at;
      while (end < blanked.length) {
        const c = blanked[end]!;
        if (c === "(" || c === "[" || c === "{") depth += 1;
        else if (c === ")" || c === "]" || c === "}") depth -= 1;
        else if (c === ";" && depth === 0) break;
        end += 1;
      }
      body = blanked.slice(at, end);
    }

    const own = ownStatementsOf(body);
    if (CONSEQUENT_FORWARDS.test(own) || CONSEQUENT_RETURNS_JSX.test(own)) {
      conditions.push([open + 1, close]);
    }
  }
  return conditions;
}

/** A conjunct that is exactly one role inequality, and nothing else. */
const ROLE_INEQUALITY_ALONE = /^access\.role\s*!==\s*"([^"]+)"$/;
/** `access.scope !== "system"` — some OTHER access field compared to a literal. */
const ACCESS_FIELD_INEQUALITY_ALONE = /^access\.[A-Za-z_$][\w$]*\s*!==\s*"[^"]*"$/;

/**
 * SHAPE A — the admit list a page states by INEQUALITY rather than by a named set.
 *
 *     if (access.role !== "Super Admin") redirect("/employee-portals");
 *
 * 25 page files carry this and none of it was readable until 2026-09-05.
 * `app/(admin)/attendance/employee-day-report/page.tsx` is the worked example: its own comment says
 * *"gate it to Super Admin only, not just the coarse attendance:read permission"*, and this reader
 * reported its gate as `attendance:read` alone — so every role holding that grant read as able to
 * open it. Same for /attendance/analytics and /sales/normalizer.
 *
 * ## Why it is read as OR-of-ANDs, and why some groups are deliberately refused
 *
 * The condition is a DENY condition, so the admit set is its negation. That inverts both operators,
 * and the two halves then behave differently — which is the whole reason this is not one regex:
 *
 *   · `a || b` denies ⇒ admit needs ¬a AND ¬b. Each OR-group is an INDEPENDENT requirement, so each
 *     yields its own admit list and the caller intersects them by requiring all of them. Dropping a
 *     group whose shape is unreadable is safe — the permission half of `role !== "X" || !(await
 *     canAccess(…))` is separately read by `PAGE_ENTRY_GATE` and separately required.
 *   · `a && b` denies ⇒ admit needs ¬a OR ¬b. Here each conjunct is an ALTERNATIVE way IN, so
 *     dropping one silently NARROWS the admit list and starts accusing pages of bouncing people they
 *     admit. A group is therefore reduced only when EVERY conjunct is an `access.<field> !== "…"`
 *     comparison, and refused whole otherwise.
 *
 * That refusal is not theoretical. Four files write the deny condition with a hoisted boolean:
 *
 *     const canReadPlans = await canAccess(access, "weekly_plans", "read");
 *     if (!canReadPlans && access.role !== "CEO" && access.role !== "Super Admin") redirect(…);
 *
 * — /admin/weekly-plans, /admin/weekly-plans/calendar and /employee-portals/plans on `canReadPlans`,
 * /sales/monthly-closing on `isSystemAdministratorViewer`. Reducing those to {CEO, Super Admin} and
 * {SFE Manager, CEO} would be WRONG, not merely conservative: everyone holding weekly_plans:read gets
 * in, and so does Super Admin. (/sales/monthly-closing/performance-review was the fifth until
 * 2026-09-16; its gate is now `canOpenClosingPerformanceReview`, reported as an unreadable predicate.)
 * hr-seat-route-coherence.test.ts already records /hr/admin/weekly-plans/calendar as unparseable for
 * exactly this reason — *"an OR chain … which is why it cannot be parsed"* — and both HR seats hold
 * weekly_plans:read, so a naive admit list would have made that test accuse two rows that work.
 *
 * ## What the four reducible forms measure to, checked one by one on 2026-09-05
 *
 *   `role !== "X"`                          EXACT  — 12 files, e.g. /attendance/employee-day-report
 *   `role !== "X" && role !== "Y"`          EXACT  — the admit set is precisely both names
 *   `role !== "X" || <another gate>`        EXACT  — 2 files; the other disjunct is `!(await
 *                                                   canAccess(…))` in both, read and required
 *                                                   separately, so the intersection is the truth
 *   `role !== "X" && access.scope !== "…"`  EXACT  — 5 files; `scopeForRole()` in
 *                                                   src/lib/auth/permissions.ts returns
 *                                                   self|team|hierarchy|line|company|none and never
 *                                                   "system", and `createAccessContext` derives
 *                                                   scope from role alone, so that conjunct admits
 *                                                   nobody today. It is dropped the way an
 *                                                   unreadable conjunct would be, which makes the
 *                                                   list a LOWER bound — exact while that holds, and
 *                                                   narrowing, never widening, if a role ever gains
 *                                                   system scope.
 *
 * Two of the 25 grep hits are not entry gates at all, and are excluded by the consequent test rather
 * than by a name list: /admin/field-workforce-compliance writes the inequality as a JSX PROP with no
 * `if` at all, and /coaching/[id] writes `if (access.role !== "Training Manager") return true;`
 * inside a helper that answers a question about ownership.
 */
function roleAdmitLists(source: string, blanked: string): string[][] {
  const lists: string[][] = [];
  for (const [conditionStart, conditionEnd] of entryGateConditions(blanked)) {
    for (const group of splitTopLevel(blanked, conditionStart, conditionEnd, "||")) {
      const [groupStart, groupEnd] = tighten(source, blanked, group);
      const admits: string[] = [];
      let reducible = true;
      for (const conjunct of splitTopLevel(blanked, groupStart, groupEnd, "&&")) {
        const [start, end] = tighten(source, blanked, conjunct);
        const text = source.slice(start, end);
        const role = ROLE_INEQUALITY_ALONE.exec(text);
        if (role) {
          admits.push(role[1]!);
          continue;
        }
        // Another access-field inequality narrows the deny condition further; ignoring it can only
        // shrink the admit list, never grow it. Anything else is an alternative way IN — refuse.
        if (ACCESS_FIELD_INEQUALITY_ALONE.test(text)) continue;
        reducible = false;
        break;
      }
      if (reducible && admits.length) lists.push(admits);
    }
  }
  return lists;
}

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

  // SHAPE A — the same statement written as inequalities instead of a named set. Appended rather
  // than merged: each list is an independent requirement and a caller satisfies them all, which is
  // exactly the semantics an OR-group needs (see roleAdmitLists).
  gates.push(...roleAdmitLists(source, blankOut(source)));
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

/**
 * A call taking the WHOLE access context as its first argument, anywhere inside a const initializer.
 *
 * `access` must be followed by `,` or `)` — a predicate about the viewer is handed the context, not
 * one of its fields. Without that, `normalizeHrId(access.hrId)` in
 * app/employee-portals/training-manager/field-coaching/page.tsx read as a gate predicate, which is
 * simply a string helper on an id.
 */
const CALL_ON_ACCESS = /\b([A-Za-z_$][\w$]*)\s*\(\s*access\s*[,)]/g;
/** Any identifier, so a const initializer can be followed through to the const it names. */
const ANY_IDENTIFIER = /\b([A-Za-z_$][\w$]*)\b/g;
/**
 * `!allowed` — a negated NAME that is NOT itself a call and NOT a property read. `!pred(access)` is
 * the direct shape above, and `!access.loginId` is a field test, so both are skipped here.
 */
const NEGATED_NAME = /!\s*\(?\s*([A-Za-z_$][\w$]*)\s*([(.]?)/g;

/** `const NAME = <initializer>` for every simple const in the file, keyed by name. */
function constInitializers(blanked: string): Map<string, string> {
  const bindings = new Map<string, string>();
  const declaration = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(blanked))) {
    const from = match.index + match[0].length;
    let depth = 0;
    let at = from;
    while (at < blanked.length) {
      const c = blanked[at]!;
      if (c === "(" || c === "[" || c === "{") depth += 1;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth -= 1;
      } else if (c === ";" && depth === 0) break;
      at += 1;
    }
    bindings.set(match[1]!, blanked.slice(from, at));
  }
  return bindings;
}

/**
 * The unreadable predicates a const name stands for, following const → const until it runs out.
 * Two hops are needed by real code: `app/(admin)/admin/email-control-center/page.tsx` writes
 * `const isSuperAdmin = canAccessSystemAdministratorWorkspace(access)` and then
 * `const allowed = access.role === "CEO" || isSuperAdmin`, and the gate negates `allowed`.
 */
function predicatesBehindConst(
  name: string,
  bindings: Map<string, string>,
  seen: Set<string>,
): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const initializer = bindings.get(name);
  if (initializer === undefined) return [];

  const predicates: string[] = [];
  CALL_ON_ACCESS.lastIndex = 0;
  let call: RegExpExecArray | null;
  while ((call = CALL_ON_ACCESS.exec(initializer))) {
    if (!PREDICATES_THIS_READER_PARSES.has(call[1]!)) predicates.push(call[1]!);
  }
  ANY_IDENTIFIER.lastIndex = 0;
  let identifier: RegExpExecArray | null;
  while ((identifier = ANY_IDENTIFIER.exec(initializer))) {
    const next = identifier[1]!;
    if (bindings.has(next)) predicates.push(...predicatesBehindConst(next, bindings, seen));
  }
  return predicates;
}

export function unreadableGatePredicates(source: string): string[] {
  const found = new Set<string>();
  PAGE_UNREADABLE_PREDICATE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PAGE_UNREADABLE_PREDICATE.exec(source))) {
    const name = match[1]!;
    if (!PREDICATES_THIS_READER_PARSES.has(name)) found.add(name);
  }

  // SHAPE B — the same predicate reached through a const, which the pattern above cannot see
  // because it requires the `!` immediately before the CALL:
  //
  //     const allowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
  //     if (!allowed) redirect("/admin");
  //
  // 8 page files are written this way — the CEO, finance and payroll command centres, the company
  // calendar, email control center and system issues — and every one of them reported NO role gate
  // at all until 2026-09-05, so `canOpen()` answered true for every admin-shell role on pages that
  // admit two. The predicate is genuinely unevaluable here, so it is reported as one rather than
  // guessed at: the `"CEO"` literal beside it is only ONE arm of an `||`, and an admit list of
  // {CEO} would silently lock out the Super Admin the other arm lets in.
  //
  // Scoped to entry conditions on purpose. The direct pattern above matches anywhere, which it can
  // afford to because `!pred(access)` is unambiguous; a bare `!name` is not, and a page holds many
  // that gate nothing.
  //
  // Measured 2026-09-05, this arm adds a name on 23 pages across `app/`. Eight are the shape above
  // and eight more are the same idea written once — `const audience = resolvePayslipCenterAudience(access)`,
  // `const canView = await canViewAllReports(access)`, `canAccessCompanyOrganogram`,
  // `resolveEmployeeCoachingPortalMode`, `canViewProbationAnalytics`, `resolveEarlyBirdsScope`. The
  // remaining seven are DATA loads whose empty result bounces the visitor — `const data = await
  // getNsmTeamCalendar(access, …); if (!data) notFound()` and its six siblings. Those are reported
  // too, and deliberately: the export's claim is "the page refuses on this and nothing here can say
  // who for", which is exactly true of a 404 on an empty load. It is a WIDER claim than "role gate",
  // so a caller that wants only role gates must read `roleSetGates`, not this.
  //
  // An "await means it is a loader, not a gate" filter was considered and rejected on the evidence:
  // `canViewAllReports` is awaited and is a real gate, so that rule would have dropped one.
  const blanked = blankOut(source);
  const bindings = constInitializers(blanked);
  for (const [start, end] of entryGateConditions(blanked)) {
    const condition = blanked.slice(start, end);
    NEGATED_NAME.lastIndex = 0;
    let negated: RegExpExecArray | null;
    while ((negated = NEGATED_NAME.exec(condition))) {
      if (negated[2] === "(" || negated[2] === ".") continue;
      for (const predicate of predicatesBehindConst(negated[1]!, bindings, new Set())) {
        found.add(predicate);
      }
    }
  }
  return [...found].sort();
}

export function hasEntryExit(source: string): boolean {
  return PAGE_ENTRY_EXIT.test(source);
}

/**
 * A page that forwards and renders nothing — `app/(admin)/admin/error-monitor/page.tsx` is ten
 * lines that call `redirect("/admin/system-audit")`.
 *
 * It matters because such a stub is a LINK, not a page. The reverse guard already treats
 * `redirect("/x")` written anywhere as a link TO /x; this is the other half of that statement — the
 * stub itself needs nothing pointing AT it, because arriving there is indistinguishable from
 * arriving at its target. Without this predicate every route this repo has ever renamed reads as a
 * stranded page, and 18 of them do.
 *
 * Deliberately narrow. Both halves are tested on the BLANKED source, so a `redirect()` sitting in a
 * comment or a string cannot qualify a real page:
 *
 *   · it forwards            — `redirect(…)` or `permanentRedirect(…)`
 *   · and it renders nothing — no `return <`, and no `return (` opening JSX
 *
 * `return\s*\(?\s*<` cannot be confused with a generic call: `return foo<Bar>(…)` puts an identifier
 * between the keyword and the angle bracket, so only a JSX return matches.
 */
const PAGE_FORWARDS = /\b(?:permanentRedirect|redirect)\s*\(/;
const PAGE_RENDERS_JSX = /return\s*\(?\s*</;

export function isRedirectOnlyStub(source: string): boolean {
  const blanked = blankOut(source);
  return PAGE_FORWARDS.test(blanked) && !PAGE_RENDERS_JSX.test(blanked);
}

/**
 * Resolve a nav href to the page file that serves it, absolute.
 *
 * `stripHrPrefix` exists because the HR shell mounts the same pages under /hr — /hr/probation is
 * served by app/(admin)/probation/page.tsx. Only the HR seat test wants that rewrite; applying it
 * everywhere would resolve an admin href to the wrong file.
 *
 * `matchDynamicSegment` resolves an href's LAST segment the way Next.js does when no static folder
 * exists: through the one `[param]` folder beside it — /employee-portals/field-crm/forecast is served
 * by app/employee-portals/field-crm/[module]/page.tsx. Opt-in, because a guard that used to skip such
 * an href would start reading a page it never read; only the registry-permission guard asks for it.
 */
export function pageFileFor(
  href: string,
  options: { repoRoot: string; stripHrPrefix?: boolean; matchDynamicSegment?: boolean },
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
  if (options.matchDynamicSegment && rel.includes("/")) {
    const parentRel = rel.slice(0, rel.lastIndexOf("/"));
    for (const parent of [
      path.join(options.repoRoot, "app", "(admin)", parentRel),
      path.join(options.repoRoot, "app", parentRel),
    ]) {
      if (!existsSync(parent)) continue;
      // A single `[param]` folder only — never a catch-all `[...param]`, and never a guess between two.
      const dynamic = readdirSync(parent).filter(
        (name) => /^\[[A-Za-z0-9_]+\]$/.test(name) && existsSync(path.join(parent, name, "page.tsx")),
      );
      if (dynamic.length === 1) return path.join(parent, dynamic[0], "page.tsx");
    }
  }
  return null;
}
