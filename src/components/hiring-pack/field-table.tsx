"use client";

// THE FIELD TABLE — every field a template has, and the rule that decides what goes in it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THE OWNER ASKED FOR, 2026-09-03, in his own words: "I want a table out of the template. In
// this table, the first column, it is showing every field needed for the template as a header. And
// in the second column, a suggestion at what will be added in each field. First thing I want to be
// able to edit this, this what will be added … then I want to be able to tell him that this word
// will be replaced from this field." And, an hour later, the reason: "My goal is not to bulk many.
// My goal is to be able to control … I want to move anything I want anywhere. And I want to be able
// to change in anything anywhere."
//
// So this is the mail-merge half of the editor and the page is the layout half. THE TABLE IS FOR
// CONTENT, THE PAGE IS FOR POSITION — his choice, put to him directly — and both write to the same
// field-layer row, so the two screens can never disagree about one field.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE RULE IS THE TEMPLATE'S, NOT THE EMPLOYEE'S. Typing here changes what this field prints for
// EVERYONE this document is printed for, which is the opposite of clicking the value on the page —
// that edits this one person's record. Both are legitimate and they are not the same act, so the
// screen says which one it is doing rather than leaving it to be inferred.
//
// A rule may carry `{{placeholders}}`, which is the part he described as Canva's bulk create: "this
// word will be replaced from this field". `{{employeeName}}` in the middle of a sentence fills per
// employee. An unknown name is refused here while he is still looking at it, and — whatever slips
// past that — `resolveFieldTemplate` blanks the WHOLE field rather than printing a brace, because a
// sentence quietly missing its middle still reads as a finished sentence.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY RETYPING A RULE IS PAGE-SURFACE ONLY, and why the screen says so instead of hiding it. A page
// document (Form 1, Form 6, the two exit letters) prints from absolute placements, and an override
// row carries its own source — so pointing one at fixed text is exactly what `movedPlacement`
// already does. A flow document (the contract, the worker form, custody, clearance) has no compiled
// overrides at all: `flowFieldLayer` renders ADDED rows only. Retyping a contract clause's token
// would need an override path that does not exist, and pretending otherwise with a disabled-looking
// input is worse than saying it plainly. Adding a box works on both.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { AlertTriangle, Check, Eye, EyeOff, History, MapPin, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { DocumentFieldInventoryEntry } from "@/lib/hiring-pack/document-inventory";
import { literalValueKey } from "@/lib/hiring-pack/field-layout";
import type { DocumentFieldRow, DocumentSurface } from "@/lib/hiring-pack/field-layout";
import {
  fieldTemplateKeys,
  resolveFieldTemplate,
  validateFieldTemplate,
} from "@/lib/hiring-pack/field-template";
import {
  FILLS_FOR_EVERYONE,
  useFieldFillRates,
  type FieldFillRate,
} from "@/components/hiring-pack/use-field-fill-rates";
import type { FieldHistorySummary } from "@/lib/hiring-pack/field-layout-store";

export type FieldTableProps = {
  busy: boolean;
  /**
   * Per field-layer row id, how often it has been rewritten and when it last was.
   *
   * Empty until the history migration is applied, which is deliberate: every row reads its own entry
   * and simply shows nothing when there is none, so the table is unchanged on a database that does
   * not have the table yet.
   */
  changed: Readonly<Record<string, FieldHistorySummary>>;
  /** Every field this template can print, as the server measured it against this employee. */
  entries: readonly DocumentFieldInventoryEntry[];
  error: string | null;
  loading: boolean;
  /** Arm the page to receive a new box carrying this key — the operator clicks where it goes. */
  onAddBox: (key: string | null) => void;
  /**
   * Show a rule ON THE PAPER before it is saved — the dry run.
   *
   * `text: null` means the rule resolves to nothing for this employee, which the page shows as an
   * empty box in a red ring rather than as no box at all. `null` for the whole argument takes the
   * overlay off and puts the document back exactly as the server rendered it.
   */
  onDryRun: (dry: { key: string; text: string | null } | null) => void;
  /** Remove a field-layer row: an added field goes, an override returns to its compiled default. */
  onDeleteRow: (row: DocumentFieldRow) => void;
  /** Open what this field used to say. Only ever offered on a row that has been rewritten. */
  onOpenHistory: (row: DocumentFieldRow) => void;
  /** Write a rule for a field the template already places. `null` restores the record value. */
  onSaveRule: (entry: DocumentFieldInventoryEntry, text: string | null) => void;
  /** Retype the text of a field the operator added. */
  onSaveRowText: (row: DocumentFieldRow, text: string) => void;
  /**
   * Put a hidden field back on the paper.
   *
   * THIS TAB IS THE ONLY WAY BACK, and that is why the prop exists. `mergePagePlacements` skips a
   * hidden override outright — `if (override.hidden) continue` — so a hidden field renders NO box,
   * not even a dashed one in layout mode. There is nothing on the page left to click, which made
   * hiding a one-way door out of which the only exit was "Reset this document", throwing away every
   * other change on it. The table lists the template's INVENTORY rather than what rendered, so a
   * hidden field is still here to be shown again.
   */
  onToggleHidden: (row: DocumentFieldRow) => void;
  rows: readonly DocumentFieldRow[];
  surface: DocumentSurface;
};

/** A flow token is UPPER_SNAKE and has no binding to name it, so it is titled from its own spelling. */
function humaniseKey(key: string): string {
  const spaced = key.includes("_")
    ? key.toLowerCase().replace(/_/g, " ")
    : key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The operator's own rule for a field, or null when it still prints straight from the record. */
function currentRule(override: DocumentFieldRow | null): string | null {
  if (!override) return null;
  return override.source.kind === "literal" ? override.source.text : null;
}

/**
 * Which record values a field depends on — the question the roster count is asked about.
 *
 * A rule is a template: its dependencies are its placeholders, and a plain literal with none has no
 * dependencies at all, so it prints for everybody. With NO rule the field still prints the compiled
 * default, which reads one value straight off the record — so its dependency is its own key.
 */
function keySetFor(rule: string | null, defaultKey: string | null): string[] {
  if (rule !== null) return fieldTemplateKeys(rule);
  return defaultKey === null ? [] : [defaultKey];
}

/**
 * The `data-hp-key` the PAGE marks a field's span with — which is not always the key the table
 * lists it under, and getting that wrong is a dry run that silently does nothing.
 *
 * A field with no rule of its own renders under its compiled key. The moment it carries a LITERAL
 * rule — an override or an added field — `fieldPrintedValue` mints `hpLiteral:<rowId>` for it and
 * the span is marked with that instead, because two fixed strings on one page sharing a key would
 * make the second print the first's text. So the target follows the row, not the table.
 */
function dryRunTargetKey(row: DocumentFieldRow | null, fallbackKey: string): string {
  if (!row) return fallbackKey;
  return row.source.kind === "literal" ? literalValueKey(row.id) : row.source.key;
}

/**
 * "Fills for 2 of 169 · blank for 167" — what this rule does to everybody who is not on screen.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ONE THING THE PREVIEW ABOVE IT CANNOT TELL YOU. "Prints:" resolves the rule against the ONE
 * employee the screen is showing, and the rule being written applies to every person the document
 * is printed for. On production `job_title_ar` is stored for 2 of 108 active employees, so a rule
 * reading {{jobTitleAr}} previews perfectly against either of those two and prints an empty field
 * for everybody else — silently and by design, because one unresolvable placeholder blanks the
 * whole field.
 *
 * IT WARNS, IT NEVER BLOCKS. The owner's standing rule is that the system flags and a person
 * decides; a rule that blanks for most of the roster is often exactly right, and being told is the
 * whole ask.
 *
 * SILENT WHEN THERE IS NOTHING TO SAY. A field with no record dependency does not vary by person,
 * and printing "fills for everyone" on every fixed line would bury the rows that matter under rows
 * that do not.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
/**
 * "Changed 12 Sep, 14:20" — an answer to what this field used to print.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * IT LEADS WITH THE DATE AND NOT THE NAME, on purpose. A save overwrites, so before the history
 * existed there was no answer at all to "what did this field print in September" — on papers people
 * sign. The timestamp is the half that can be relied on: `updated_by_hr_id` is known to be
 * unreliable across this system, and on a DELETE there is no actor to record at all, so the history
 * stores null rather than the field's last editor. A name shown where it might be wrong gets
 * defended rather than looked up.
 *
 * SHOWN ONLY ON A ROW THAT HAS BEEN REWRITTEN. A field still printing what the document was built
 * with has no history and gets no line, which is also what keeps the table quiet on a database where
 * the history migration has not been applied yet — every row simply has no entry.
 *
 * IN CAIRO, because this is an instant this system stamped itself (`now()` on the history row), not
 * a date column and not a vendor's wall clock.
 */
function ChangedNote({
  onOpen,
  summary,
}: {
  onOpen: () => void;
  summary: FieldHistorySummary | undefined;
}) {
  if (!summary) return null;
  return (
    <button
      className="mt-1 inline-flex items-center gap-1 text-phx-2xs font-semibold text-phx-ink-soft underline decoration-dotted underline-offset-2 hover:text-phx-ink"
      onClick={onOpen}
      title={
        summary.changes === 1
          ? "See what this field used to say"
          : `See all ${summary.changes} earlier versions of this field`
      }
      type="button"
    >
      <History className="h-3 w-3" />
      Changed {formatChangeStamp(summary.lastChangedAt)}
      {summary.changes > 1 ? ` · ${summary.changes} versions` : ""}
    </button>
  );
}

/** A recorded instant, in Cairo local time — never raw UTC. See `ChangedNote`. */
function formatChangeStamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
  });
}

function FillRateNote({ rate, roster }: { rate: FieldFillRate | null; roster: number }) {
  if (!rate || roster === 0) return null;
  if (rate.filled === FILLS_FOR_EVERYONE) return null;

  const blank = roster - rate.filled;
  if (blank === 0) {
    return (
      <p className="text-phx-2xs text-phx-ink-faint">Fills for all {roster} people on the list.</p>
    );
  }

  // AMBER BELOW HALF, plain above it. Almost every record-bound field is blank for SOMEBODY — a
  // missing mobile number, an employee hired last week — so colouring every shortfall would make
  // the whole table amber and the colour would stop meaning anything. Under half the roster is
  // where "this rule mostly does not print" starts being the honest reading of the number.
  const tone = rate.filled * 2 < roster ? "text-amber-700 font-semibold" : "text-phx-ink-soft";
  const names = rate.blankNames.join(", ");

  return (
    <p className={`text-phx-2xs break-words ${tone}`}>
      Fills for {rate.filled} of {roster} · blank for {blank}
      {names === "" ? "" : ` — including ${names}`}
      {rate.unbound.length > 0 ? ` (${rate.unbound.join(", ")} is the same for everyone)` : ""}
    </p>
  );
}

export function FieldTable({
  busy,
  changed,
  entries,
  error,
  loading,
  onAddBox,
  onDryRun,
  onDeleteRow,
  onOpenHistory,
  onSaveRule,
  onSaveRowText,
  onToggleHidden,
  rows,
  surface,
}: FieldTableProps) {
  /**
   * Drafts, keyed by field. A key absent from here is NOT being edited — which is different from
   * being edited to an empty string, and the difference is the whole cancel behaviour.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  /**
   * NARROWING THE LIST, because the list is long enough that scrolling it is the slow part.
   * Form 1 carries 33 fields and the employment contract 28, and the field somebody opens this tab
   * to change is exactly one of them. `search` matches the English name, the key, and the value on
   * the paper — the value because "2807693" is often what you remember about a field whose name you
   * do not. `changedOnly` answers the other question: what have I already rewritten for everyone.
   */
  const [search, setSearch] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);

  /** The values map, for previewing a rule exactly as the renderer will resolve it. */
  const values = useMemo(() => {
    const map: Record<string, string> = {};
    for (const entry of entries) map[entry.key] = entry.value;
    return map;
  }, [entries]);

  const knownKeys = useMemo(() => new Set(entries.map((entry) => entry.key)), [entries]);
  const isKnownKey = useMemo(() => (key: string) => knownKeys.has(key), [knownKeys]);

  /** Overrides, by the compiled key they replace. Page surfaces only — see the header. */
  const overrides = useMemo(() => {
    const map = new Map<string, DocumentFieldRow>();
    for (const row of rows) {
      if (row.defaultKey !== null) map.set(row.defaultKey, row);
    }
    return map;
  }, [rows]);

  /** Fields the operator added, which are rows in their own right rather than rules over a default. */
  const added = useMemo(() => rows.filter((row) => row.defaultKey === null), [rows]);

  /**
   * WHAT HAS BEEN REWRITTEN FOR EVERYONE, counted before anything is filtered away.
   *
   * The page tab has always said "Nothing moved, hidden or added yet" — this tab had no equivalent,
   * so the only way to know which of 33 rules you had changed was to read all 33. It counts rules
   * and added boxes separately because they undo differently: a rule goes back with "Use the
   * record", an added box goes with Delete, and telling somebody "4 changes" without saying which
   * kind is telling them to go and look.
   *
   * Counted from `entries` and `rows` directly, NEVER from the filtered lists below — a summary that
   * shrinks when you type in the search box is worse than no summary, because it reads as though
   * changes disappeared.
   */
  const rewritten = useMemo(
    () => entries.filter((entry) => currentRule(overrides.get(entry.key) ?? null) !== null).length,
    [entries, overrides],
  );

  /** A field is "changed by you" if you rewrote its rule OR took it off the paper. Both are edits to
   *  the template, and a filter that showed one and swallowed the other would hide the more drastic
   *  of the two. */
  const changedByOperator = (key: string) => {
    const override = overrides.get(key) ?? null;
    return currentRule(override) !== null || (override?.hidden ?? false);
  };
  const hidden = useMemo(() => rows.filter((row) => row.hidden).length, [rows]);

  /**
   * The two lists as the screen shows them. An entry matches on its English name, its key, or the
   * value it currently prints; `changedOnly` keeps rules you wrote and drops the rest.
   *
   * ADDED FIELDS ARE NEVER DROPPED BY `changedOnly` — every one of them IS a change, by definition.
   */
  const needle = search.trim().toLowerCase();
  const matches = (...parts: (string | null)[]) =>
    needle === "" || parts.some((part) => (part ?? "").toLowerCase().includes(needle));

  const visibleEntries = useMemo(
    () =>
      entries.filter((entry) => {
        if (changedOnly && !changedByOperator(entry.key)) return false;
        return matches(entry.labelEn, entry.key, humaniseKey(entry.key), entry.value);
      }),
    // `matches` closes over `needle`, which is what actually changes between renders.
    [changedOnly, entries, needle, overrides],
  );

  const visibleAdded = useMemo(
    () =>
      added.filter((row) =>
        matches(
          row.source.kind === "literal" ? row.source.text : humaniseKey(row.source.key),
          row.source.kind === "value" ? row.source.key : null,
        ),
      ),
    [added, needle],
  );

  /**
   * Every key set the table needs a roster count for — the saved rules, the compiled defaults, and
   * whatever is being typed right now.
   *
   * ASKED FOR THE WHOLE TABLE, NOT JUST THE VISIBLE ROWS. The counts are cached by key set, so
   * asking for all of them once costs one request, while asking per filter would re-ask on every
   * keystroke in the search box. And the number is most useful exactly when you are SCANNING: it is
   * how you find the field that quietly prints nothing for most of the company.
   *
   * DRAFTS ARE IN HERE TOO, which is what makes the count arrive before the rule is saved rather
   * than after. A half-typed placeholder is a key set of its own; the hook's debounce is what stops
   * each intermediate spelling from being asked about.
   */
  const keySets = useMemo(() => {
    const sets: string[][] = [];
    for (const entry of entries) {
      sets.push(keySetFor(currentRule(overrides.get(entry.key) ?? null), entry.key));
    }
    for (const row of added) {
      sets.push(
        row.source.kind === "literal"
          ? fieldTemplateKeys(row.source.text)
          : [row.source.key],
      );
    }
    for (const draft of Object.values(drafts)) {
      if (validateFieldTemplate(draft) === null) sets.push(fieldTemplateKeys(draft));
    }
    return sets.filter((keys) => keys.length > 0);
  }, [added, drafts, entries, overrides]);

  const fillRates = useFieldFillRates(keySets, entries.length > 0);

  /**
   * WHICH FIELD IS BEING TRIED ON THE PAPER — one at a time, and only while it is being edited.
   *
   * Driven from the handlers rather than from an effect that watches the draft. Both work; this one
   * is honest about what is happening — a keystroke changes the paper, so the keystroke is what
   * writes to it — and it keeps the overlay out of the render cycle entirely.
   */
  const [dryKey, setDryKey] = useState<string | null>(null);

  /** What that rule resolves to right now: the text, or null when it would print nothing. */
  const dryTextFor = (text: string) =>
    validateFieldTemplate(text, isKnownKey) === null ? resolveFieldTemplate(text, values) : null;

  /**
   * Which span each open draft is aimed at, so a keystroke can refresh the overlay without the row
   * that owns it being in scope. Filled in when a dry run starts and read by `setDraft`.
   */
  const [dryTarget, setDryTarget] = useState<string | null>(null);

  const showDryRun = (key: string, target: string, text: string) => {
    setDryKey(key);
    setDryTarget(target);
    onDryRun({ key: target, text: dryTextFor(text) });
  };

  const stopDryRun = () => {
    setDryKey(null);
    setDryTarget(null);
    onDryRun(null);
  };

  /**
   * Leaving this tab, or the editor, takes the overlay off the paper. Without it the document would
   * keep showing unsaved text with nothing on screen left to explain where it came from.
   *
   * THROUGH A REF, WITH AN EMPTY DEPENDENCY LIST, and the alternative is a real bug rather than a
   * style point. `onDryRun` is a plain function on the parent, so it has a new identity every
   * render; depending on it directly would run this cleanup after EVERY keystroke and wipe the
   * overlay the keystroke had just drawn. The ref is written in its own effect rather than during
   * render, because a render can be thrown away and a discarded render that had already moved a ref
   * leaves it describing a state that never existed.
   */
  const onDryRunRef = useRef(onDryRun);
  useEffect(() => {
    onDryRunRef.current = onDryRun;
  });
  useEffect(() => () => onDryRunRef.current(null), []);

  const setDraft = (key: string, text: string) => {
    setDrafts((current) => ({ ...current, [key]: text }));
    if (dryKey === key && dryTarget !== null) onDryRun({ key: dryTarget, text: dryTextFor(text) });
  };
  const clearDraft = (key: string) => {
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    if (dryKey === key) stopDryRun();
  };

  /**
   * Save on Enter, abandon on Escape.
   *
   * PLAIN ENTER IS SAFE HERE and that had to be checked rather than assumed: a placement is a
   * `<span>` with a fixed `line-height`, so a newline inside a rule collapses to a space on the
   * paper and can never mean anything. Shift+Enter still writes one, for anybody who reaches for it
   * out of habit. Escape restores the saved rule rather than clearing the field — the draft is
   * discarded, which is what Cancel does, because an editor that empties the box on Escape is one
   * keystroke away from wiping a rule that applies to everyone.
   */
  const editorKeys = (
    key: string,
    canSave: boolean,
    save: () => void,
  ) => (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      clearDraft(key);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSave) save();
    }
  };

  const insertPlaceholder = (key: string, placeholder: string, fallback: string) => {
    if (!placeholder) return;
    setDrafts((current) => ({ ...current, [key]: `${current[key] ?? fallback}{{${placeholder}}}` }));
  };

  if (loading) {
    return <p className="px-1 py-6 text-phx-xs text-phx-ink-faint">Reading this template’s fields…</p>;
  }

  if (entries.length === 0 && added.length === 0) {
    return (
      <p className="px-1 py-6 text-phx-xs text-phx-ink-faint">
        No fields found on this template. If the document is still loading in the panel, give it a
        moment and open this tab again.
      </p>
    );
  }

  const canRetype = surface === "page";

  return (
    <div className="space-y-4">
      <p className="text-phx-xs leading-relaxed text-phx-ink-soft">
        Every field this document prints, and what goes in each one.{" "}
        <strong>What you type here is the template’s rule — it applies to everyone</strong>, not just
        this employee. To correct one person’s own details instead, click the value on the page.
      </p>

      <div className="rounded-xl border border-phx-line bg-phx-surface-soft px-3 py-2 text-phx-2xs leading-relaxed text-phx-ink-soft">
        Write a sentence and pull values into it with{" "}
        <code className="rounded bg-white px-1 py-0.5 font-mono">{"{{fieldName}}"}</code> — use{" "}
        <em>Insert a field</em> so the name is always one this document has. If a placeholder has no
        value for someone, that whole field prints blank for them rather than printing half a
        sentence. While a field is open, <strong>Enter</strong> saves it and <strong>Esc</strong>
        abandons the edit.
        {fillRates.roster > 0 ? (
          <>
            {" "}
            Under each field is how many of the{" "}
            <strong>{fillRates.roster} people this module can print for</strong> it would actually
            fill.
          </>
        ) : null}
      </div>

      {/*
        A FAILED COUNT IS SAID OUT LOUD RATHER THAN LEFT BLANK. Every "fills for N of M" line
        disappears when the count cannot be fetched, and a silently missing warning reads exactly
        like a field with nothing to warn about — which is the one reading that must not happen on a
        screen whose whole purpose is to report emptiness.
      */}
      {fillRates.error ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-phx-2xs text-amber-800">
          Could not count how many people each field fills for: {fillRates.error} The rules below
          still work — you are editing without that check.
        </p>
      ) : null}

      {dryKey !== null ? (
        <p className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-phx-2xs font-semibold text-emerald-800">
          You are trying a rule on the page. The green box is not saved — press Save to keep it, or
          Cancel and it goes back to what the document prints today.
        </p>
      ) : null}

      {/*
        THE TOOLBAR — find one field, and see what you have already changed.

        Both halves exist because of the same measurement: this template has 33 fields, and the one
        being looked for is one of them. The count on the right is deliberately NOT filtered, so it
        keeps telling the truth while the list below it narrows.
      */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-phx-ink-faint" />
            <input
              aria-label="Find a field"
              className="w-full rounded-lg border border-phx-line bg-white py-1.5 pl-8 pr-8 text-phx-xs text-phx-ink outline-none focus:border-phx-accent"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find a field — name, key or value"
              type="search"
              value={search}
            />
            {search !== "" ? (
              <button
                aria-label="Clear the search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-phx-ink-faint hover:text-phx-ink"
                onClick={() => setSearch("")}
                type="button"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <Button
            className="shrink-0 gap-1.5"
            disabled={rewritten === 0 && hidden === 0}
            onClick={() => setChangedOnly((current) => !current)}
            size="sm"
            type="button"
            variant={changedOnly ? "default" : "outline"}
          >
            Only what I changed
          </Button>
        </div>

        <p className="text-phx-2xs text-phx-ink-soft">
          {rewritten === 0 && added.length === 0 ? (
            <span className="text-phx-ink-faint">
              Nothing rewritten yet — every field prints the template’s own value.
            </span>
          ) : (
            <>
              <span className="font-semibold text-phx-accent">
                {rewritten} rule{rewritten === 1 ? "" : "s"} rewritten
              </span>
              {added.length > 0 ? (
                <>
                  {" · "}
                  <span className="font-semibold text-phx-ink">
                    {added.length} field{added.length === 1 ? "" : "s"} added
                  </span>
                </>
              ) : null}
              {hidden > 0 ? (
                <>
                  {" · "}
                  <span className="font-semibold text-phx-ink-soft">{hidden} hidden</span>
                </>
              ) : null}
              {" · for everyone"}
            </>
          )}
        </p>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-phx-xs text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      {!canRetype ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-phx-2xs leading-relaxed text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            This document is typeset rather than printed onto a fixed form, so its own wording cannot
            be retyped from here — the list below shows what each field holds. You can still add a
            field anywhere on it and write whatever you need in that.
          </span>
        </div>
      ) : null}

      <div className="space-y-2">
        {visibleEntries.length === 0 ? (
          <p className="rounded-xl border border-dashed border-phx-line px-3 py-4 text-phx-2xs text-phx-ink-faint">
            {changedOnly && rewritten === 0 && hidden === 0
              ? "You have not rewritten any of this template’s own rules. Everything below prints the value the document was built with."
              : "No field here matches that. Try part of the name, the key, or the value it prints."}
          </p>
        ) : null}
        {visibleEntries.map((entry) => {
          const override = overrides.get(entry.key) ?? null;
          const saved = currentRule(override);
          const editing = entry.key in drafts;
          const draft = drafts[entry.key] ?? saved ?? "";
          const message = editing ? validateFieldTemplate(draft, isKnownKey) : null;
          const preview = editing && !message ? resolveFieldTemplate(draft, values) : null;
          const hiddenHere = override?.hidden === true ? override : null;
          // A HIDDEN FIELD IS NOT A MISSING ONE, and conflating them offered the wrong repair. The
          // inventory reads `placed` off what actually rendered, and a hidden override renders
          // nothing — so without this the row read "Has a value but no box on the paper" and put an
          // "Add a box" button beside it. Pressing that would have added a SECOND box while the
          // original sat there hidden, which is the opposite of what was wanted.
          const missing = entry.value !== "" && !entry.placed && hiddenHere === null;

          return (
            <div
              className="rounded-xl border border-phx-line bg-white px-3 py-2.5"
              key={entry.key}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
                {/* Column one — what the field IS. */}
                <div className="sm:w-[34%] sm:shrink-0">
                  <p className="text-phx-xs font-semibold text-phx-ink break-words">
                    {entry.labelEn ?? humaniseKey(entry.key)}
                  </p>
                  <p className="mt-0.5 font-mono text-phx-2xs text-phx-ink-faint break-all">
                    {entry.key}
                  </p>
                  {hiddenHere ? (
                    <p className="mt-1 inline-flex items-center gap-1 text-phx-2xs font-semibold text-phx-ink-soft">
                      <EyeOff className="h-3 w-3" />
                      Hidden by you — this prints nothing
                    </p>
                  ) : null}
                  {missing ? (
                    <p className="mt-1 text-phx-2xs font-semibold text-amber-700">
                      Has a value but no box on the paper
                    </p>
                  ) : null}
                  {!entry.editable ? (
                    <p className="mt-1 text-phx-2xs text-phx-ink-faint">
                      Standing company text — not part of this person’s record
                    </p>
                  ) : null}
                  {override ? (
                    <div>
                      <ChangedNote
                        onOpen={() => onOpenHistory(override)}
                        summary={changed[override.id]}
                      />
                    </div>
                  ) : null}
                </div>

                {/* Column two — what goes IN it. */}
                <div className="min-w-0 flex-1 space-y-1.5">
                  {editing ? (
                    <>
                      <textarea
                        className="w-full resize-y rounded-lg border border-phx-accent-line bg-white px-2 py-1.5 text-phx-xs leading-relaxed text-phx-ink outline-none focus:border-phx-accent"
                        dir="auto"
                        onChange={(event) => setDraft(entry.key, event.target.value)}
                        onKeyDown={editorKeys(entry.key, !busy && message === null, () => {
                          onSaveRule(entry, draft);
                          clearDraft(entry.key);
                        })}
                        rows={2}
                        value={draft}
                      />
                      {message ? (
                        <p className="text-phx-2xs font-semibold text-red-700 break-words">{message}</p>
                      ) : (
                        <>
                          <p className="text-phx-2xs text-phx-ink-soft break-words">
                            <span className="text-phx-ink-faint">Prints: </span>
                            {preview === null ? (
                              <em className="text-amber-700">
                                nothing for this employee — a placeholder has no value
                              </em>
                            ) : preview === "" ? (
                              <em className="text-phx-ink-faint">nothing</em>
                            ) : (
                              <span dir="auto">{preview}</span>
                            )}
                          </p>
                          <FillRateNote
                            rate={fillRates.rateFor(fieldTemplateKeys(draft))}
                            roster={fillRates.roster}
                          />
                        </>
                      )}
                    </>
                  ) : (
                    <p className="text-phx-xs leading-relaxed text-phx-ink break-words" dir="auto">
                      {saved !== null ? (
                        saved
                      ) : entry.value !== "" ? (
                        entry.value
                      ) : (
                        <em className="text-phx-ink-faint">empty for this employee</em>
                      )}
                    </p>
                  )}
                  {saved !== null && !editing ? (
                    <p className="text-phx-2xs font-semibold text-phx-accent">
                      Set by you for everyone
                    </p>
                  ) : null}
                  {editing ? null : (
                    <FillRateNote
                      rate={fillRates.rateFor(keySetFor(saved, entry.key))}
                      roster={fillRates.roster}
                    />
                  )}
                </div>

                {/* Column three — what you can DO. */}
                <div className="flex flex-wrap items-center gap-1.5 sm:w-[22%] sm:shrink-0 sm:justify-end">
                  {editing ? (
                    <>
                      <select
                        aria-label="Insert a field"
                        className="max-w-full rounded-lg border border-phx-line bg-white px-1.5 py-1 text-phx-2xs text-phx-ink-soft"
                        onChange={(event) => {
                          insertPlaceholder(entry.key, event.target.value, saved ?? "");
                          event.currentTarget.selectedIndex = 0;
                        }}
                        value=""
                      >
                        <option value="">Insert a field…</option>
                        {entries.map((option) => (
                          <option key={option.key} value={option.key}>
                            {option.labelEn ?? humaniseKey(option.key)}
                          </option>
                        ))}
                      </select>
                      {/*
                        TRY IT ON THE PAPER — the answer to "where does this land", which the
                        resolved text alone cannot give. Disabled when the field has no box on the
                        page: an empty compiled placement is dropped from the markup entirely, so
                        there is nothing to write into, and a button that appeared to work and did
                        nothing would be worse than one that says why.
                      */}
                      <Button
                        className="gap-1"
                        disabled={busy || message !== null || !entry.placed}
                        onClick={() =>
                          dryKey === entry.key
                            ? stopDryRun()
                            : showDryRun(entry.key, dryRunTargetKey(override, entry.key), draft)
                        }
                        size="sm"
                        title={
                          entry.placed
                            ? "Show this rule on the page without saving it"
                            : "This field has no box on the paper yet, so there is nothing to show it in."
                        }
                        type="button"
                        variant={dryKey === entry.key ? "secondary" : "ghost"}
                      >
                        <Eye className="h-3.5 w-3.5" />
                        {dryKey === entry.key ? "Stop" : "Try it"}
                      </Button>
                      <Button
                        className="gap-1"
                        disabled={busy || message !== null}
                        onClick={() => {
                          onSaveRule(entry, draft);
                          clearDraft(entry.key);
                        }}
                        size="sm"
                        type="button"
                      >
                        <Check className="h-3.5 w-3.5" />
                        Save
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() => clearDraft(entry.key)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      {hiddenHere ? (
                        <Button
                          className="gap-1"
                          disabled={busy}
                          onClick={() => onToggleHidden(hiddenHere)}
                          size="sm"
                          type="button"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          Show it again
                        </Button>
                      ) : null}
                      {canRetype && entry.placed ? (
                        <Button
                          disabled={busy}
                          onClick={() => setDraft(entry.key, saved ?? entry.value)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Change
                        </Button>
                      ) : null}
                      {override && saved !== null ? (
                        <Button
                          className="gap-1"
                          disabled={busy}
                          onClick={() => onSaveRule(entry, null)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          Use the record
                        </Button>
                      ) : null}
                      {!entry.placed && hiddenHere === null ? (
                        <Button
                          className="gap-1"
                          disabled={busy}
                          onClick={() => onAddBox(entry.key)}
                          size="sm"
                          type="button"
                          variant={missing ? "default" : "outline"}
                        >
                          <MapPin className="h-3.5 w-3.5" />
                          Add a box
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Fields the operator added. They are not part of the template's own list, so they get their
          own section rather than being mixed into it — the difference matters when deciding what to
          delete, because deleting one of these removes a box while "Use the record" only drops a
          rule. */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <h4 className="text-phx-xs font-semibold text-phx-ink">Fields you added</h4>
          <Button
            className="gap-1.5"
            disabled={busy}
            onClick={() => onAddBox(null)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="h-4 w-4" />
            Add a field
          </Button>
        </div>

        {added.length === 0 ? (
          <p className="text-phx-2xs text-phx-ink-faint">
            None yet. <em>Add a field</em> — then click the spot on the page where it belongs.
          </p>
        ) : visibleAdded.length === 0 ? (
          <p className="text-phx-2xs text-phx-ink-faint">
            None of the {added.length} field{added.length === 1 ? "" : "s"} you added matches that
            search.
          </p>
        ) : (
          visibleAdded.map((row) => {
            const key = `row:${row.id}`;
            const saved = row.source.kind === "literal" ? row.source.text : "";
            const editing = key in drafts;
            const draft = drafts[key] ?? saved;
            const message = editing ? validateFieldTemplate(draft, isKnownKey) : null;
            const preview = editing && !message ? resolveFieldTemplate(draft, values) : null;

            return (
              <div className="rounded-xl border border-phx-accent-line bg-phx-accent/5 px-3 py-2.5" key={row.id}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
                  <div className="sm:w-[34%] sm:shrink-0">
                    <p className="text-phx-xs font-semibold text-phx-ink">
                      {row.source.kind === "value"
                        ? humaniseKey(row.source.key)
                        : "Your own text"}
                    </p>
                    <p className="mt-0.5 text-phx-2xs text-phx-ink-faint">
                      {row.page !== null ? `Page ${row.page + 1}` : "Anchored in the text"}
                      {row.hidden ? " · hidden" : ""}
                    </p>
                    <div>
                      <ChangedNote onOpen={() => onOpenHistory(row)} summary={changed[row.id]} />
                    </div>
                  </div>

                  <div className="min-w-0 flex-1 space-y-1.5">
                    {row.source.kind === "value" ? (
                      <>
                        <p className="text-phx-xs text-phx-ink break-words" dir="auto">
                          {values[row.source.key] ?? <em className="text-phx-ink-faint">empty</em>}
                        </p>
                        <FillRateNote
                          rate={fillRates.rateFor([row.source.key])}
                          roster={fillRates.roster}
                        />
                      </>
                    ) : editing ? (
                      <>
                        <textarea
                          className="w-full resize-y rounded-lg border border-phx-accent-line bg-white px-2 py-1.5 text-phx-xs leading-relaxed text-phx-ink outline-none focus:border-phx-accent"
                          dir="auto"
                          onChange={(event) => setDraft(key, event.target.value)}
                          onKeyDown={editorKeys(key, !busy && message === null, () => {
                            onSaveRowText(row, draft);
                            clearDraft(key);
                          })}
                          rows={2}
                          value={draft}
                        />
                        {message ? (
                          <p className="text-phx-2xs font-semibold text-red-700 break-words">{message}</p>
                        ) : (
                          <>
                            <p className="text-phx-2xs text-phx-ink-soft break-words">
                              <span className="text-phx-ink-faint">Prints: </span>
                              {preview === null ? (
                                <em className="text-amber-700">nothing for this employee</em>
                              ) : preview === "" ? (
                                <em className="text-phx-ink-faint">nothing</em>
                              ) : (
                                <span dir="auto">{preview}</span>
                              )}
                            </p>
                            <FillRateNote
                              rate={fillRates.rateFor(fieldTemplateKeys(draft))}
                              roster={fillRates.roster}
                            />
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        <p className="text-phx-xs text-phx-ink break-words" dir="auto">
                          {saved === "" ? <em className="text-phx-ink-faint">empty</em> : saved}
                        </p>
                        <FillRateNote
                          rate={fillRates.rateFor(fieldTemplateKeys(saved))}
                          roster={fillRates.roster}
                        />
                      </>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 sm:w-[22%] sm:shrink-0 sm:justify-end">
                    {row.source.kind === "literal" && editing ? (
                      <>
                        <select
                          aria-label="Insert a field"
                          className="max-w-full rounded-lg border border-phx-line bg-white px-1.5 py-1 text-phx-2xs text-phx-ink-soft"
                          onChange={(event) => {
                            insertPlaceholder(key, event.target.value, saved);
                            event.currentTarget.selectedIndex = 0;
                          }}
                          value=""
                        >
                          <option value="">Insert a field…</option>
                          {entries.map((option) => (
                            <option key={option.key} value={option.key}>
                              {option.labelEn ?? humaniseKey(option.key)}
                            </option>
                          ))}
                        </select>
                        <Button
                          className="gap-1"
                          disabled={busy || message !== null}
                          onClick={() =>
                            dryKey === key
                              ? stopDryRun()
                              : showDryRun(key, dryRunTargetKey(row, key), draft)
                          }
                          size="sm"
                          title="Show this text on the page without saving it"
                          type="button"
                          variant={dryKey === key ? "secondary" : "ghost"}
                        >
                          <Eye className="h-3.5 w-3.5" />
                          {dryKey === key ? "Stop" : "Try it"}
                        </Button>
                        <Button
                          className="gap-1"
                          disabled={busy || message !== null}
                          onClick={() => {
                            onSaveRowText(row, draft);
                            clearDraft(key);
                          }}
                          size="sm"
                          type="button"
                        >
                          <Check className="h-3.5 w-3.5" />
                          Save
                        </Button>
                        <Button disabled={busy} onClick={() => clearDraft(key)} size="sm" type="button" variant="ghost">
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        {row.source.kind === "literal" ? (
                          <Button
                            disabled={busy}
                            onClick={() => setDraft(key, saved)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            Change
                          </Button>
                        ) : null}
                        <Button
                          className="gap-1 text-red-700"
                          disabled={busy}
                          onClick={() => onDeleteRow(row)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
