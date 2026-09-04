// Placeholders inside a field's fixed text: "يعمل لدى {{companyName}} بوظيفة {{jobTitleAr}}".
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. The owner, 2026-09-03, describing what he wanted the field table to do: "I want
// to be able to tell him that this word will be replaced from this field." Until now a field's text
// was all-or-nothing — either a fixed string, or one value read straight from the record. A
// sentence with two record values in the middle of it could not be expressed at all, so the only
// way to print one was to place three separate fields side by side and hope the spacing survived a
// longer name.
//
// THIS IS STORED AS A LITERAL, NOT AS A THIRD SOURCE KIND, AND THAT IS DELIBERATE. A literal whose
// text happens to contain `{{key}}` IS a template; giving it its own `source_kind` would have meant
// a CHECK-constraint change on `hiring_pack_document_fields`, which is a production migration, for
// a distinction that is derivable from the text in one pass. Every literal already stored keeps
// working unchanged: text with no placeholders resolves to itself, so nothing that prints today
// prints differently tomorrow.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// TWO FAILURES THIS FILE EXISTS TO PREVENT, both of which put wrong ink on paper somebody signs.
//
//   1. A TYPO PRINTING ITSELF. `{{jobTitlAr}}` is a placeholder naming nothing. Left alone it would
//      print the literal characters `{{jobTitlAr}}` in the middle of an employment contract. So an
//      unknown key is refused at SAVE time, by `validateFieldTemplate`, before it can ever reach a
//      page — the one moment a person is present to be told.
//
//   2. A HOLE IN A SENTENCE. If `jobTitleAr` is empty for this employee, "يعمل لدى فاركو بوظيفة
//      اعتباراً من" reads as a finished sentence that simply says something false. A compiled field
//      with no value prints nothing at all, and a template follows the same rule: ONE unresolved
//      placeholder blanks the WHOLE field. A missing field is visible; a sentence quietly missing
//      its middle is not.
//
// Direction marks are tolerated inside the braces and stripped from the key. A Latin identifier
// typed into an Arabic input reliably collects an RLM or an LRM at one end, and a placeholder that
// stopped matching because of an invisible character would look exactly like a placeholder someone
// spelled wrong.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Anything with braces around it. The KEY is validated separately, so a typo is reported, not ignored.
 *
 * A FACTORY, NOT A SHARED CONSTANT, and that is a correctness matter rather than a style. A `/g`
 * regex carries `lastIndex` between calls: `test` advances it, and `String.prototype.matchAll`
 * COPIES it into the iterator it builds. So a shared instance asked `isFieldTemplate(text)` and then
 * `validateFieldTemplate(text)` would begin the second pass PAST the first placeholder — and skip
 * checking it. A misspelt first key would validate clean and go on to print nothing, on a field
 * somebody had just been told was fine. Every call gets its own.
 */
function placeholderPattern(): RegExp {
  return /\{\{([^{}]*)\}\}/g;
}

/** LRM, RLM, the embedding/override run, and the isolates. Invisible, and none of them belong in a key. */
const DIRECTION_MARKS = /[‎‏‪-‮⁦-⁩]/g;

/** A key is an identifier — the same shape as every key in `PAPER_FIELD_BINDINGS`. */
const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_]*$/;

function cleanKey(raw: string): string {
  return raw.replace(DIRECTION_MARKS, "").trim();
}

/** Whether this text carries at least one placeholder, so the UI can label it as a merged sentence. */
export function isFieldTemplate(text: string): boolean {
  return placeholderPattern().test(text);
}

/**
 * Every key the text refers to, in the order written, without repeats.
 *
 * Includes malformed ones — a caller listing what a template depends on wants to see `job title`
 * sitting there unresolvable, not a list that quietly agrees with itself.
 */
export function fieldTemplateKeys(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(placeholderPattern())) {
    const key = cleanKey(match[1] ?? "");
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * Check a field's text before it is stored. Returns the message to show, or null when it is fine.
 *
 * `isKnownKey` is OPTIONAL, and which caller passes it is the whole layering here.
 *
 * THERE IS NO SINGLE ALLOW-LIST OF KEYS, because there are two key spaces. A page document places
 * camelCase record keys (`employeeName`), while a flow document fills UPPER_SNAKE tokens
 * (`COMPANY_NAME`) that never appear in `PAPER_FIELD_BINDINGS` at all — so a store-level check
 * against the binding table would refuse `{{COMPANY_NAME}}` on a contract, where it resolves
 * perfectly. Each document knows its own keys and nothing else does.
 *
 * So the STORE validates shape only, and the EDITOR — which has just fetched this document's live
 * inventory — passes `isKnownKey` and catches the typo while the person is still looking at it.
 * Neither is the safety net: `resolveFieldTemplate` blanks the whole field for a key it cannot
 * resolve, so an unknown key prints nothing whether or not anybody checked it first. Braces cannot
 * reach paper by any route.
 */
export function validateFieldTemplate(
  text: string,
  isKnownKey?: (key: string) => boolean,
): string | null {
  for (const match of text.matchAll(placeholderPattern())) {
    const key = cleanKey(match[1] ?? "");
    if (!key) return "A placeholder is empty. Write the field name inside the braces, like {{employeeName}}.";
    if (!KEY_SHAPE.test(key)) {
      return `"${key}" is not a field name. Use letters and numbers with no spaces, like {{jobTitleAr}}.`;
    }
    if (isKnownKey && !isKnownKey(key)) {
      return `This document has no field called "${key}". Pick one from the list, or it will print as nothing.`;
    }
  }

  // A brace left over after every well-formed placeholder has been accounted for is a half-written
  // one — `{{employeeName}` or `{ {employeeName}}`. It matches nothing above, so without this it
  // would sail through validation and then print its own braces onto the document.
  const remainder = text.replace(placeholderPattern(), "");
  if (remainder.includes("{{") || remainder.includes("}}")) {
    return "There is an unfinished placeholder. Each one needs two braces at both ends, like {{employeeName}}.";
  }

  return null;
}

/**
 * Fill a field's text for one employee. Returns null when the field must print NOTHING.
 *
 * Null rather than a partly-filled string, for the reason at the top of this file: a sentence
 * missing its middle still reads as a sentence. The caller treats null exactly as it treats a
 * compiled field whose value is absent, which is the behaviour every one of these documents already
 * has — see `render-placement.ts`, "A key with no value prints nothing at all".
 *
 * Text with no placeholders comes back unchanged, so every literal stored before this existed keeps
 * printing what it printed.
 */
export function resolveFieldTemplate(
  text: string,
  values: Partial<Record<string, string>>,
): string | null {
  let unresolved = false;

  const filled = text.replace(placeholderPattern(), (_whole, raw: string) => {
    const value = values[cleanKey(raw)];
    if (value === undefined || value === null || value === "") {
      unresolved = true;
      return "";
    }
    return value;
  });

  return unresolved ? null : filled;
}
