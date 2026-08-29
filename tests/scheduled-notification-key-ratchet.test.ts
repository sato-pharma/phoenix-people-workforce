import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// A QUEUED notification's dedupe key must not be built from the date it is
// queued for. This ratchet pins how many rows still do it, so the number can
// only fall, never rise.
//
// THE ANTI-PATTERN
// notification_events rows are written with `onConflict: "event_key"`. A row
// that is scheduled into the FUTURE therefore sits in `pending` for days or
// weeks, and during that window the data it was derived from can be corrected.
// If the key embeds a value derived from that data, the correction re-keys the
// row: the upsert sees no conflict, inserts a fresh row, and the stale one is
// ORPHANED in `pending` rather than updated. The sweep that sends probation
// reminders filters only on category + status + `scheduled_for <= today`, so
// BOTH rows fire and the manager is asked to review the same person twice, on
// two dates weeks apart. Nothing errors, and nothing surfaces it until the day
// the first one fires.
//
// That is not hypothetical. On 2026-08-29 two hire-date corrections (AI-0009,
// AI-0012) left exactly 6 stale `pending` probation reminders, the first due to
// fire on 16 September. They were found by accident.
//
// THE GENERAL RULE
// Never key a dedupe on a value derived from mutable source data. The key
// cannot notice that its own input moved, so the row is orphaned instead of
// corrected — and a dedupe key that no longer matches the row it was meant to
// dedupe is worse than no key at all.
//
// WHAT COUNTS (a member of the baseline set)
// One object literal that does all three:
//   1. sets a dedupe key (`event_key` / `eventKey` / `dedupeKey` /
//      `idempotencyKey`) from a template literal,
//   2. sets `scheduled_for` / `scheduledFor` on that SAME object to something
//      that is not a now-expression — i.e. the row is genuinely queued, and
//   3. interpolates into the key either the very expression it is scheduled by,
//      or an identifier whose name marks it as a date derived from a record
//      field (see DERIVED_DATE).
// Condition 3's first arm needs no name heuristic at all: it asks whether the
// key embeds the row's own schedule date, which is the defect exactly.
//
// WHAT IS NOT A VIOLATION
//   - AN IMMEDIATE SEND. src/lib/resignations/service.ts builds
//     `resignation:${hrId}:${status}:${record.effectiveDate}` — a mutable date
//     in a key — but the row goes out now, with `scheduled_for` = today. There
//     is no pending window for the source to move in, and re-keying on a
//     changed effective date re-notifies deliberately. Condition 2 is what
//     separates it from the defect, and a self-check below pins that.
//   - A BUCKETING DATE. `${today}`, `${weekKey}`, `${monthKey}`, `${weekStart}`
//     and cairoTodayIso() are the intended dedupe dimension — one alert per day
//     or per week. A new day is MEANT to be a new row. These are not derived
//     from a record field and are not in DERIVED_DATE.
//   - A now-scheduled row. notifications/in-app.ts and notifications/system.ts
//     both write `scheduled_for: now`, which is an immediate send wearing a
//     schedule column.
//
// THE ONE BASELINE MEMBER IS NEUTRALISED, NOT FIXED
// src/lib/probation/service.ts still keys its reminders on
// `${employee.hrId}:probation:${reminder.reminderType}:${reminder.scheduledFor}`.
// The consequence is closed at the DATABASE layer instead:
// `trg_probation_reanchor_on_hire_date` (migration 20260829223000, PR #2684)
// re-anchors the open case on a hire-date change and cancels any probation
// reminder not sitting on one of the three correct dates. So the orphan is
// swept up rather than prevented. To fold this member and take BASELINE to 0,
// drop `:${reminder.scheduledFor}` from the key and write the row with
// `ignoreDuplicates: false` so a moved date UPDATES the existing row — but that
// changes live notification behaviour on a system that pays people, and is a
// deliberate decision, not a tidy-up. The ratchet exists so the NEXT queue
// cannot copy the shape in the meantime.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Measured 2026-08-29 across app/ + src/: one member, probation/service.ts.
 *
 * Lower this when a queue genuinely stops keying on its own schedule date;
 * never raise it to turn a red run green — a rise means a new future-dated
 * notification was keyed on data that can move underneath it.
 */
const BASELINE = 1;

const ROOTS = ["app", "src"];

/** The dedupe-key properties of a notification_events row. */
const KEY_PROP = "(?:event_key|eventKey|dedupeKey|idempotencyKey)";

/** A key property assigned a template literal: `event_key: ` + backtick. */
const KEY_RE = new RegExp(`\\b(${KEY_PROP})\\s*:\\s*\``, "g");

/** The row's schedule column, in either casing. */
const SCHEDULE_RE = /\b(?:scheduled_for|scheduledFor)\s*:/;

/**
 * Identifiers naming a date DERIVED from a record field — the second arm of
 * condition 3. Deliberately excludes today/weekKey/monthKey/weekStart, which
 * are bucketing dimensions rather than derived values.
 */
const DERIVED_DATE =
  /\b(?:scheduledFor|scheduled_for|scheduledAt|dueAt|dueDate|due_date|endDate|end_date|startDate|start_date|expiresAt|expires_at|effectiveDate|effective_date|hireDate|hire_date|probationEnd|probationStart|anniversary|nextAttemptAt)\b/;

/** A schedule value that is really "now" — an immediate send with a date column. */
const NOW_EXPR = /\bnow\b|new Date\(|Date\.now\(|cairoToday|todayDateOnly|todayIso/i;

/**
 * Blank comments before measuring, so a sentence describing the anti-pattern is
 * never counted as one. Newlines survive, so every file:line stays accurate.
 * The `[^:]` guard stops `https://…` reading as a line comment.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Replace the INTERIOR of every string and template literal with spaces,
 * preserving length, newlines and the delimiters themselves. All brace and
 * paren balancing runs on this masked copy, so a `}` inside a message string
 * can never mis-count depth — while the original stays index-compatible, so
 * the key template's text is still extractable at the same offsets.
 */
function maskLiterals(source: string): string {
  const out = source.split("");
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote) {
      if (ch === "\\") {
        if (out[i + 1] !== "\n") out[i + 1] = " ";
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch !== "\n") out[i] = " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
  }
  return out.join("");
}

/** Index of the `{` opening the innermost object literal that contains `index`. */
function enclosingObjectStart(masked: string, index: number): number {
  let depth = 0;
  for (let i = index; i >= 0; i -= 1) {
    const ch = masked[i];
    if (ch === "}") depth += 1;
    else if (ch === "{") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/** Index just past the `}` matching the `{` at `start`. */
function objectEnd(masked: string, start: number): number {
  let depth = 0;
  for (let i = start; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return masked.length;
}

/**
 * The value expression of the object's own `scheduled_for` property, or null.
 * Only depth-1 properties count: an `idempotencyKey` nested inside `metadata`
 * must not borrow a `scheduled_for` from the row that wraps it, and a
 * `scheduled_for` nested deeper must not be read as this row's schedule.
 */
function scheduleValueOf(masked: string, source: string, start: number, end: number): string | null {
  let depth = 0;
  for (let i = start; i < end; i += 1) {
    const ch = masked[i];
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (depth === 1) {
      const ahead = masked.slice(i, i + 24);
      const hit = SCHEDULE_RE.exec(ahead);
      if (hit && hit.index === 0) {
        const valueStart = i + hit[0].length;
        let d = 0;
        for (let j = valueStart; j < end; j += 1) {
          const c = masked[j];
          if (c === "{" || c === "[" || c === "(") d += 1;
          else if (c === "}" || c === "]" || c === ")") {
            if (d === 0) return source.slice(valueStart, j).trim();
            d -= 1;
          } else if (c === "," && d === 0) return source.slice(valueStart, j).trim();
        }
        return source.slice(valueStart, end).trim();
      }
    }
  }
  return null;
}

/** The `${...}` interiors of a template literal. */
function interpolations(template: string): string[] {
  const out: string[] = [];
  const re = /\$\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) out.push(m[1]!.trim());
  return out;
}

type Site = {
  site: string;
  prop: string;
  scheduled: boolean;
  embedsSchedule: boolean;
  derivedDate: boolean;
};

/** Every template-literal dedupe key in one file, classified. */
function scan(label: string, rawSource: string): Site[] {
  const source = stripComments(rawSource);
  const masked = maskLiterals(source);
  const sites: Site[] = [];
  KEY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = KEY_RE.exec(masked))) {
    const open = match.index + match[0].length - 1;
    const close = masked.indexOf("`", open + 1);
    if (close === -1) continue;
    const template = source.slice(open + 1, close);

    const objStart = enclosingObjectStart(masked, match.index);
    const objEnd = objStart === -1 ? -1 : objectEnd(masked, objStart);
    const scheduleValue =
      objStart === -1 ? null : scheduleValueOf(masked, source, objStart, objEnd);

    const scheduled = scheduleValue !== null && !NOW_EXPR.test(scheduleValue);
    const parts = interpolations(template);
    const norm = (s: string) => s.replace(/\s+/g, "");

    sites.push({
      site: `${label}:${source.slice(0, match.index).split("\n").length}`,
      prop: match[1]!,
      scheduled,
      embedsSchedule:
        scheduleValue !== null && parts.some((p) => norm(p) === norm(scheduleValue)),
      derivedDate: parts.some((p) => DERIVED_DATE.test(p)),
    });
  }
  return sites;
}

/** A member of the baseline set: a genuinely queued row keyed on data that can move. */
function isViolation(s: Site): boolean {
  return s.scheduled && (s.embedsSchedule || s.derivedDate);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

export function runScheduledNotificationKeyRatchetTests() {
  // ───────────────────────────────────────────────────────────────────────────
  // Prove the classifier discriminates BEFORE trusting it across the tree. A
  // ratchet whose detector is wrong still reports a number, and a wrong number
  // looks exactly as authoritative as a right one. Cases 2 and 3 are the two
  // shapes this must never confuse: the immediate send that legitimately keys
  // on a mutable date, and the fix.
  // ───────────────────────────────────────────────────────────────────────────
  const one = (snippet: string): Site => {
    const s = scan("probe.ts", snippet);
    assert.equal(s.length, 1, `probe should define exactly one key, got ${s.length}: ${snippet}`);
    return s[0]!;
  };

  // 1. The defect: a future-dated row keyed on its own schedule date.
  assert.equal(
    isViolation(
      one(
        "const row = { event_key: `${e.hrId}:probation:${r.reminderType}:${r.scheduledFor}`, scheduled_for: r.scheduledFor, status: 'pending' };",
      ),
    ),
    true,
    "a queued row keyed on its own scheduled_for is the anti-pattern this file counts",
  );

  // 2. The near-miss: a mutable date in the key, but sent NOW. Not a violation —
  //    there is no pending window for the source to move in. This is the exact
  //    shape of resignations/service.ts and must never be flagged.
  assert.equal(
    isViolation(
      one("const m = { idempotencyKey: `resignation:${r.employeeHrId}:${r.status}:${r.effectiveDate}` };"),
    ),
    false,
    "an immediate send has no pending window — a mutable date in its key re-notifies deliberately",
  );

  // 3. The fix: still queued, but the key no longer embeds the moving date.
  assert.equal(
    isViolation(
      one("const row = { event_key: `${e.hrId}:probation:${r.reminderType}`, scheduled_for: r.scheduledFor };"),
    ),
    false,
    "dropping the date from the key is the fix — it must read as clean or the ratchet can never reach 0",
  );

  // 4. A now-scheduled row is an immediate send wearing a schedule column.
  assert.equal(
    isViolation(one("const row = { event_key: `alert:${today}`, scheduled_for: now.slice(0, 10) };")),
    false,
    "scheduled_for: now is not a future queue — in-app.ts and system.ts both write this",
  );

  // 5. A bucketing date is the intended dedupe dimension, not a derived value.
  assert.equal(
    isViolation(one("const m = { idempotencyKey: `marketing-field-capture:${today}:${owner.hrId}` };")),
    false,
    "a per-day bucket key is correct — a new day is MEANT to be a new row",
  );

  // 6. The second arm: queued, and keyed on a DIFFERENT derived date than the
  //    one it is scheduled by. Still orphans when the hire date moves.
  assert.equal(
    isViolation(
      one("const row = { event_key: `${e.hrId}:review:${e.probationEnd}`, scheduled_for: r.firesOn };"),
    ),
    true,
    "a queued row keyed on any derived date can be orphaned, not just the one it fires on",
  );

  // 7. Nesting: a key inside `metadata` must not borrow the outer row's schedule.
  assert.equal(
    isViolation(
      one(
        "const row = { scheduled_for: r.scheduledFor, metadata: { idempotencyKey: `x:${r.scheduledFor}` } };",
      ),
    ),
    false,
    "only the key's OWN object counts — otherwise every nested key inherits a schedule it does not have",
  );

  // 8. A comment naming the anti-pattern is documentation, not code.
  assert.equal(
    scan("probe.ts", "// never write event_key: `${x}:${r.scheduledFor}` on a queued row\nconst x = 1;").length,
    0,
    "a comment describing the rule is not an occurrence of it",
  );

  // 9. A brace inside a message string must not break object balancing.
  assert.equal(
    isViolation(
      one(
        "const row = { subject: 'a } brace in prose', event_key: `${e.hrId}:${r.scheduledFor}`, scheduled_for: r.scheduledFor };",
      ),
    ),
    true,
    "literal masking must hold, or a stray brace in copy hides the row's schedule column",
  );

  // 10. Line numbers survive stripping, or every site printed below is shifted.
  assert.equal(
    scan("probe.ts", "/*\n * a note\n */\nconst row = { event_key: `${a}:${r.scheduledFor}`, scheduled_for: r.scheduledFor };")[0]
      ?.site,
    "probe.ts:4",
    "stripping must preserve line numbers, or every reported site is wrong",
  );

  // ───────────────────────────────────────────────────────────────────────────

  const files = ROOTS.flatMap((r) => walk(r));
  assert.ok(
    files.length > 1000,
    `only ${files.length} source files were scanned — the walk is not reaching the tree, so any count it reports is meaningless`,
  );

  const population: Site[] = [];
  for (const file of files) {
    const rel = file.replace(/\\/g, "/");
    population.push(...scan(rel, readFileSync(file, "utf8")));
  }

  // Anti-vacuity: this repo builds dozens of dedupe keys from template literals.
  // If the population collapses, the detector has stopped matching and a count
  // of zero violations would mean nothing at all.
  assert.ok(
    population.length >= 30,
    `only ${population.length} template-literal dedupe keys were found (expected ~44) — the key-property pattern has stopped matching, so the ratchet count is meaningless`,
  );

  const violations = population.filter(isViolation);
  const sites = violations.map((s) => `${s.site}  ${s.prop}`).sort();

  // The ratchet, both arms.
  assert.ok(
    violations.length <= BASELINE,
    `${violations.length - BASELINE} new future-dated notification(s) keyed on data that can move — the count went ${BASELINE} -> ${violations.length}.\n` +
      `A queued row's dedupe key must not embed its schedule date, or a correction to the source data orphans the pending row instead of updating it and the recipient is notified twice.\n` +
      `Key the row on its stable identity instead (hr id + reminder type), and let the date live in scheduled_for alone.\n` +
      `Queued rows keyed on moving data:\n  ${sites.join("\n  ")}`,
  );
  assert.ok(
    violations.length >= BASELINE,
    `Good news: future-dated notifications keyed on moving data dropped ${BASELINE} -> ${violations.length}. Lower BASELINE in this file to ` +
      `${violations.length} so the ground that was won cannot be given back.\n` +
      `Queued rows keyed on moving data:\n  ${sites.join("\n  ")}`,
  );
}
