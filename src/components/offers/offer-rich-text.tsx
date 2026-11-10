"use client";

// The letter's PROSE, edited as prose.
//
// The owner's ask was "any single letter I want to be able to edit in it", and the paragraphs were
// the one part of the letter that did not allow it: the greeting and the body lived in a single
// `html` prop, edited as raw markup in a textarea. Changing one word of "Dear …" meant finding it
// inside `<p class='lead'>Dear <strong>{{salutationName}}</strong>,</p>` — and one deleted bracket
// silently broke the letter for whoever it was next sent to.
//
// WHY THIS IS NOT THE FREE CANVAS THE DESIGNER DELIBERATELY AVOIDS. The block model is untouched.
// This edits the text INSIDE one block; it cannot move, merge, or restructure blocks, which is what
// would break the letter's second rendering into Outlook-safe tables. The structure stays blocks;
// only the words became words.
//
// TWO RENDERERS, ONE TAG SET. Everything typed here has to survive both `render.ts` (the PDF) and
// `render-email.ts` (the email body). `src/lib/offers/rich-text.ts` holds that tag set and does the
// conversion in both directions; this file is the surface, not the rules.
//
// SOURCE IS NEVER TAKEN AWAY. The Source button shows the same markup the textarea always did.
// Nothing that could be written before can no longer be written — it just no longer has to be.

import { Bold, Braces, Code2, Eraser, Italic, Link2, List, ListOrdered, Underline } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ClipboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { offerHintClassName, offerTextareaClassName } from "@/components/offers/offer-ui";
import { OFFER_PLACEHOLDERS } from "@/lib/offers/placeholders";
import {
  OFFER_TOKEN_CHIP_CLASS,
  offerEditorToStoredHtml,
  offerStoredToEditorHtml,
  offerTokenChipHtml,
} from "@/lib/offers/rich-text";
import { cn } from "@/lib/utils";

export type OfferTokenTarget = {
  /**
   * The canvas itself, so the designer can tell a live editor from one whose block has since been
   * deselected or deleted. Writing into a detached node updates nothing and reads as a dead click.
   */
  element: HTMLElement;
  insert: (token: string) => void;
};

const TOKEN_LABELS: ReadonlyMap<string, string> = new Map(
  OFFER_PLACEHOLDERS.map((placeholder) => [placeholder.key, placeholder.label]),
);

const toolbarButtonClassName =
  "flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-phx-ink-2 transition hover:border-phx-accent-line hover:bg-phx-accent-soft hover:text-phx-accent-press disabled:cursor-not-allowed disabled:opacity-40";

/**
 * The toolbar, as data rather than as closures.
 *
 * Deliberately OUTSIDE the component. Built inside it, every entry would close over `run`, which
 * reads the editor ref — and mapping over that while rendering is what `react-hooks/refs` refuses,
 * because a ref read during render is not guaranteed to be the value React is rendering against.
 * These are plain descriptors; the ref is touched in the click handler, which is where it is real.
 */
const TOOLBAR_BUTTONS: ReadonlyArray<{ command: string; icon: LucideIcon; label: string }> = [
  { command: "bold", icon: Bold, label: "Bold" },
  { command: "italic", icon: Italic, label: "Italic" },
  { command: "underline", icon: Underline, label: "Underline" },
  { command: "insertUnorderedList", icon: List, label: "Bulleted list" },
  { command: "insertOrderedList", icon: ListOrdered, label: "Numbered list" },
  { command: "link", icon: Link2, label: "Link" },
  { command: "removeFormat", icon: Eraser, label: "Clear formatting" },
];

export function OfferRichText({
  canManage,
  onChange,
  onFocusProse,
  value,
}: {
  canManage: boolean;
  onChange: (storedHtml: string) => void;
  /** Registers this canvas as the box the Placeholders panel writes into. */
  onFocusProse?: (target: OfferTokenTarget) => void;
  value: string;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const lastEmitted = useRef<string | null>(null);
  const savedRange = useRef<Range | null>(null);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    try {
      // Enter makes a paragraph, not a `<div>`, and Bold emits a styled span rather than a legacy
      // `<b>`. Both are normalised on the way out anyway — this only keeps the canvas's own DOM
      // close to what is stored, so the Source view is not a surprise.
      document.execCommand("defaultParagraphSeparator", false, "p");
      document.execCommand("styleWithCSS", false, "true");
    } catch {
      /* older engine — the conversion on save handles whatever it emitted */
    }
  }, []);

  /**
   * Pull an external change into the canvas — but never while it is focused.
   *
   * Every keystroke emits, the parent stores it, and it comes back down as `value`. Rebuilding
   * `innerHTML` on that echo would destroy the caret on every character typed. Comparing against
   * what this component last emitted is what tells an echo from a real external change, such as
   * loading a different template or restoring a built-in.
   */
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || showSource) return;
    if (value === lastEmitted.current) return;
    if (lastEmitted.current !== null && document.activeElement === editor) return;
    editor.innerHTML = offerStoredToEditorHtml(value, TOKEN_LABELS);
    lastEmitted.current = value;
  }, [showSource, value]);

  const emit = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const stored = offerEditorToStoredHtml(editor.innerHTML);
    lastEmitted.current = stored;
    onChange(stored);
  }, [onChange]);

  const rememberSelection = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) savedRange.current = range.cloneRange();
  }, []);

  /**
   * Put the caret back where it was before the toolbar took focus.
   *
   * Falls back to the end of the text rather than doing nothing: a Bold click with no remembered
   * caret would otherwise apply to the whole document or to nothing at all, and both look broken.
   */
  const restoreSelection = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    if (savedRange.current && editor.contains(savedRange.current.commonAncestorContainer)) {
      selection.addRange(savedRange.current);
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.addRange(range);
  }, []);

  const run = useCallback(
    (command: string, commandValue?: string) => {
      restoreSelection();
      document.execCommand(command, false, commandValue);
      rememberSelection();
      emit();
    },
    [emit, rememberSelection, restoreSelection],
  );

  const insertHtml = useCallback(
    (html: string) => {
      restoreSelection();
      document.execCommand("insertHTML", false, html);
      rememberSelection();
      emit();
    },
    [emit, rememberSelection, restoreSelection],
  );

  const insertToken = useCallback(
    (token: string) => {
      insertHtml(`${offerTokenChipHtml(token, TOKEN_LABELS.get(token) ?? token)}&nbsp;`);
    },
    [insertHtml],
  );

  const registerFocus = useCallback(() => {
    const editor = editorRef.current;
    if (editor) onFocusProse?.({ element: editor, insert: insertToken });
  }, [insertToken, onFocusProse]);

  const addLink = useCallback(() => {
    const url = window.prompt("Link address (https://… or mailto:…)")?.trim();
    if (!url) return;
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && !selection.getRangeAt(0).collapsed) {
      run("createLink", url);
      return;
    }
    insertHtml(`<a href="${url.replace(/"/g, "&quot;")}">${url.replace(/</g, "&lt;")}</a>&nbsp;`);
  }, [insertHtml, run]);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      // Always plain text. A paste out of Word or a browser carries markup this letter has no way
      // to render — and forcing it through plain text is also what keeps the conversion on save a
      // matter of reading THIS toolbar's own output rather than arbitrary web HTML.
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain");
      if (!text) return;
      document.execCommand("insertText", false, text);
      rememberSelection();
      emit();
    },
    [emit, rememberSelection],
  );

  return (
    <div className="rounded-xl border border-phx-line bg-white shadow-none">
      <style>{`
        .phx-offer-prose p { margin: 0 0 10px; }
        .phx-offer-prose p:last-child { margin-bottom: 0; }
        .phx-offer-prose ul { list-style: disc; margin: 0 0 10px; padding-left: 1.4rem; }
        .phx-offer-prose ol { list-style: decimal; margin: 0 0 10px; padding-left: 1.4rem; }
        .phx-offer-prose li { margin: 0 0 3px; }
        .phx-offer-prose a { color: #1D4ED8; text-decoration: underline; }
        .phx-offer-prose:empty::before { color: #94A3B8; content: attr(data-placeholder); }
        .phx-offer-prose .${OFFER_TOKEN_CHIP_CLASS} {
          background: #FFF7ED; border: 1px solid #FED7AA; color: #B45309; cursor: default;
          display: inline-block; font-size: 12px; font-weight: 700; line-height: 1.4;
          margin: 0 1px; padding: 0 6px; white-space: nowrap;
        }
      `}</style>

      <div className="flex flex-wrap items-center gap-1 border-b border-phx-line px-2 py-1.5">
        {TOOLBAR_BUTTONS.map((action) => (
          <button
            aria-label={action.label}
            className={toolbarButtonClassName}
            disabled={!canManage || showSource}
            key={action.label}
            onClick={() => (action.command === "link" ? addLink() : run(action.command))}
            onMouseDown={(event) => event.preventDefault()}
            title={action.label}
            type="button"
          >
            <action.icon className="h-4 w-4" />
          </button>
        ))}
        <label
          className={cn(toolbarButtonClassName, "cursor-pointer", (!canManage || showSource) && "cursor-not-allowed opacity-40")}
          title="Text colour"
        >
          <span className="text-xs font-black">A</span>
          <input
            aria-label="Text colour"
            className="sr-only"
            disabled={!canManage || showSource}
            onChange={(event) => run("foreColor", event.target.value)}
            type="color"
          />
        </label>

        <button
          className={cn(
            "ml-auto flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-phx-xs font-black uppercase tracking-[0.12em] transition",
            showSource
              ? "border-phx-accent-line bg-phx-accent-soft text-phx-accent-press"
              : "border-transparent text-phx-ink-faint hover:border-phx-line hover:bg-slate-50",
          )}
          onClick={() => setShowSource((current) => !current)}
          type="button"
        >
          {showSource ? <Braces className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
          {showSource ? "Letter" : "Source"}
        </button>
      </div>

      {showSource ? (
        <div className="p-3">
          <textarea
            className={cn(offerTextareaClassName, "font-mono text-phx-sm")}
            disabled={!canManage}
            onChange={(event) => {
              // Straight through, unconverted. Source is the escape hatch — normalising what is
              // typed here would quietly undo the very edit somebody opened it to make.
              lastEmitted.current = event.target.value;
              onChange(event.target.value);
            }}
            rows={12}
            value={value}
          />
          <p className={offerHintClassName}>
            The letter&rsquo;s own HTML. Switch back to Letter to type on the page instead.
          </p>
        </div>
      ) : (
        <div
          className="phx-offer-prose min-h-[190px] px-4 py-3 text-sm leading-[1.7] text-slate-900 outline-none"
          contentEditable={canManage}
          data-placeholder="Write the letter here…"
          onBlur={rememberSelection}
          onFocus={registerFocus}
          onInput={emit}
          onKeyUp={rememberSelection}
          onMouseUp={rememberSelection}
          onPaste={handlePaste}
          ref={editorRef}
          role="textbox"
          suppressContentEditableWarning
        />
      )}
    </div>
  );
}
