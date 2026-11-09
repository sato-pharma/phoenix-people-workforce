"use client";

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Eraser,
  Image as ImageIcon,
  Italic,
  Link2,
  Link2Off,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  SquareMousePointer,
  Strikethrough,
  Table,
  Underline,
  Undo2,
} from "lucide-react";
import type { ClipboardEvent, DragEvent } from "react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { EDITOR_IMAGE_ACCEPT, nonPicturesFromTransfer, picturesFromTransfer } from "@/lib/email/transfer-files";


export type EditorVariable = {
  label: string;
  sampleValue: string;
  token: string;
};

export type EmailBodyEditorHandle = {
  focusBody: () => void;
  insertToken: (token: string) => void;
};

const tokenPattern = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * The house table cell.
 *
 * Declared once because a row or column added later has to look exactly like the ones the Insert
 * table button drew — an unstyled `<td>` renders with no rule around it, and email clients do not
 * apply a stylesheet, so a single bare cell is visible to every recipient.
 *
 * The values are the house grid and the house padding, `TABLE_GRID` and `CELL_BASE` in
 * `src/lib/sato-email/render.ts`. A cell drawn here is a cell the reader sees, and the Sato
 * renderer stamps exactly these onto it on the way out — writing anything else here would show the
 * sender one table in the composer and send him another.
 */
const TABLE_CELL_STYLE = "border: 1px solid #CFDCE7; padding: 8px 11px";
const TABLE_HEADER_STYLE = `${TABLE_CELL_STYLE}; background-color: #f8fafc; text-align: left`;
/** The size grid the Insert table button opens — Word and Gmail both stop around here. */
const TABLE_PICK_MAX_COLUMNS = 8;
const TABLE_PICK_MAX_ROWS = 6;

/** One toolbar button's look, shared by the icon buttons and the Insert table popover's trigger. */
const TOOLBAR_BUTTON_CLASS =
  "flex h-8 w-8 items-center justify-center border border-transparent text-phx-ink-2 hover:border-[#FED7AA] hover:bg-phx-accent-soft hover:text-phx-accent-press";

/** A fresh cell, styled like the ones already in the table so a recipient cannot tell them apart. */
function newCell(header: boolean) {
  const cell = document.createElement(header ? "th" : "td");
  cell.setAttribute("style", header ? TABLE_HEADER_STYLE : TABLE_CELL_STYLE);
  cell.innerHTML = header ? "Column" : "&nbsp;";
  return cell;
}

/** A table with nothing left in it becomes an empty paragraph, so the caret still has a home. */
function replaceTableWithParagraph(table: HTMLTableElement) {
  const paragraph = document.createElement("p");
  paragraph.innerHTML = "<br>";
  table.replaceWith(paragraph);
  return paragraph;
}

/**
 * A table of any shape, with the first row as its header.
 *
 * Owner 2026-09-17: "the table now is obligatory three columns. What if I want to add or delete a
 * column or a row?" — the size is chosen on the grid before the table is inserted, and changed
 * afterwards with the row and column controls.
 */
function tableHtml(rows: number, columns: number) {
  const header = `<th style="${TABLE_HEADER_STYLE}">Column</th>`.repeat(columns);
  const bodyRow = `<tr>${`<td style="${TABLE_CELL_STYLE}">&nbsp;</td>`.repeat(columns)}</tr>`;
  return (
    `<table style="border-collapse: collapse; width: 100%"><tbody>` +
    `<tr>${header}</tr>${bodyRow.repeat(Math.max(0, rows - 1))}` +
    `</tbody></table><p><br /></p>`
  );
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function chipHtml(token: string, label: string) {
  const safeToken = token.replace(/[^a-zA-Z0-9_]/g, "");
  return `<span class="phx-var-chip" contenteditable="false" data-token="${safeToken}" title="Filled automatically by the backend">${escapeHtml(label)}</span>`;
}

/**
 * Stored template HTML -> editable HTML: every `{{token}}` inside TEXT becomes a
 * non-editable chip. Tokens inside attributes (e.g. href="{{ctaUrl}}") are left as-is so
 * the markup stays valid; they round-trip untouched.
 */
export function storedHtmlToEditorHtml(html: string, variables: EditorVariable[]): string {
  if (typeof window === "undefined") return html;
  const labels = new Map(variables.map((variable) => [variable.token, variable.label]));
  const doc = new DOMParser().parseFromString(`<div id="phx-root">${html}</div>`, "text/html");
  const root = doc.getElementById("phx-root");
  if (!root) return html;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const node of textNodes) {
    const value = node.nodeValue ?? "";
    if (!value.includes("{{")) continue;
    const fragment = doc.createDocumentFragment();
    let lastIndex = 0;
    for (const match of value.matchAll(tokenPattern)) {
      const index = match.index ?? 0;
      if (index > lastIndex) fragment.appendChild(doc.createTextNode(value.slice(lastIndex, index)));
      const token = match[1];
      const template = doc.createElement("template");
      template.innerHTML = chipHtml(token, labels.get(token) ?? token);
      fragment.appendChild(template.content);
      lastIndex = index + match[0].length;
    }
    if (lastIndex < value.length) fragment.appendChild(doc.createTextNode(value.slice(lastIndex)));
    node.parentNode?.replaceChild(fragment, node);
  }
  return root.innerHTML;
}

// Mirrors the server's sanitize-html allowlist (email-safety.ts) so what survives the
// editor is exactly what survives the save.
const allowedAttributes: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "rel", "target", "title", "style", "dir"]),
  img: new Set(["src", "alt", "width", "height", "style"]),
  span: new Set(["title", "style", "dir"]),
  table: new Set(["width", "cellpadding", "cellspacing", "border", "style", "dir"]),
  td: new Set(["colspan", "rowspan", "style", "dir"]),
  th: new Set(["colspan", "rowspan", "style", "dir"]),
};
const defaultKeptAttributes: ReadonlySet<string> = new Set(["style", "dir"]);

// execCommand("fontSize") emits legacy <font size="1-7"> tags; map them to the CSS
// keywords the server sanitizer accepts.
const legacyFontSizes: Record<string, string> = {
  "1": "x-small",
  "2": "small",
  "3": "medium",
  "4": "large",
  "5": "x-large",
  "6": "xx-large",
  "7": "xx-large",
};

/**
 * Editable HTML -> stored template HTML: chips collapse back to `{{token}}` text,
 * browser-generated `<div>` lines become `<p>`, and editor-only attributes (class, style,
 * data-*, contenteditable) are stripped. The server's sanitize-html allowlist remains the
 * final authority on save.
 */
export function editorHtmlToStoredHtml(rootEl: HTMLElement): string {
  const clone = rootEl.cloneNode(true) as HTMLElement;
  const doc = clone.ownerDocument;
  for (const chip of Array.from(clone.querySelectorAll("[data-token]"))) {
    chip.replaceWith(doc.createTextNode(`{{${chip.getAttribute("data-token") ?? ""}}}`));
  }
  // Browsers emit legacy tags for some commands: <font> for size/color, <strike> for
  // strikethrough. Convert them to the sanitizer-approved span/s equivalents.
  for (const font of Array.from(clone.querySelectorAll("font"))) {
    const span = doc.createElement("span");
    const styles: string[] = [];
    const size = legacyFontSizes[font.getAttribute("size") ?? ""];
    const color = font.getAttribute("color");
    if (size) styles.push(`font-size: ${size}`);
    if (color) styles.push(`color: ${color}`);
    if (styles.length > 0) span.setAttribute("style", styles.join("; "));
    while (font.firstChild) span.appendChild(font.firstChild);
    font.replaceWith(span);
  }
  for (const strike of Array.from(clone.querySelectorAll("strike"))) {
    const s = doc.createElement("s");
    while (strike.firstChild) s.appendChild(strike.firstChild);
    strike.replaceWith(s);
  }
  for (const div of Array.from(clone.querySelectorAll("div"))) {
    const paragraph = doc.createElement("p");
    if (div.getAttribute("style")) paragraph.setAttribute("style", div.getAttribute("style") ?? "");
    while (div.firstChild) paragraph.appendChild(div.firstChild);
    div.replaceWith(paragraph);
  }
  // Convert heading tags to styled paragraphs so they survive server sanitization.
  // The server sanitizer discards h1–h6 AND their content (disallowedTagsMode:discard);
  // converting them here keeps the content visible after save.
  const headingSizes: Record<string, string> = { h1: "20px", h2: "18px", h3: "16px", h4: "14px", h5: "13px", h6: "12px" };
  for (const [tag, size] of Object.entries(headingSizes)) {
    for (const heading of Array.from(clone.querySelectorAll(tag))) {
      const paragraph = doc.createElement("p");
      const existing = heading.getAttribute("style") ?? "";
      const base = `font-size: ${size}; font-weight: bold`;
      paragraph.setAttribute("style", existing ? `${base}; ${existing}` : base);
      while (heading.firstChild) paragraph.appendChild(heading.firstChild);
      heading.replaceWith(paragraph);
    }
  }
  // Canvas-only CSS (branded links, table borders) must be inlined at save time - email
  // clients only see inline styles, so without this the sent email silently loses what
  // the canvas showed.
  const appendStyle = (element: Element, declaration: string) => {
    const style = element.getAttribute("style") ?? "";
    element.setAttribute("style", style ? `${style.replace(/;\s*$/, "")}; ${declaration}` : declaration);
  };
  for (const anchor of Array.from(clone.querySelectorAll("a"))) {
    if (!/(^|;)\s*color\s*:/i.test(anchor.getAttribute("style") ?? "")) {
      appendStyle(anchor, "color: #C2410C; font-weight: 700; text-decoration: underline");
    }
  }
  for (const cell of Array.from(clone.querySelectorAll("td, th"))) {
    const style = cell.getAttribute("style") ?? "";
    if (!/(^|;)\s*border\s*:/i.test(style)) appendStyle(cell, "border: 1px solid #CFDCE7");
    if (!/(^|;)\s*padding\s*:/i.test(cell.getAttribute("style") ?? "")) appendStyle(cell, "padding: 8px 11px");
  }
  for (const image of Array.from(clone.querySelectorAll("img"))) {
    // Outlook's Word renderer ignores max-width; a width attribute keeps large images
    // inside the 680px email shell (small images get capped too - lesser evil).
    if (!image.getAttribute("width")) image.setAttribute("width", "620");
  }
  for (const element of Array.from(clone.querySelectorAll("*"))) {
    const allowed = allowedAttributes[element.tagName.toLowerCase()] ?? defaultKeptAttributes;
    for (const attribute of Array.from(element.attributes)) {
      if (!allowed.has(attribute.name.toLowerCase())) element.removeAttribute(attribute.name);
    }
  }
  return clone.innerHTML.trim();
}

function blockText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  if (!(node instanceof HTMLElement)) return "";
  const tag = node.tagName.toLowerCase();
  if (tag === "br") return "\n";
  if (tag === "hr") return "\n----------\n";
  const children = Array.from(node.childNodes).map(blockText).join("");
  if (tag === "li") return `- ${children.trim()}\n`;
  if (tag === "img") return node.getAttribute("alt") || "[image]";
  if (tag === "tr") {
    return `${Array.from(node.childNodes).map(blockText).join(" | ").replace(/\s+\|\s+/g, " | ").trim()}\n`;
  }
  if (tag === "table") return `${children}\n`;
  if (["blockquote", "div", "ol", "p", "ul"].includes(tag)) return `${children}\n\n`;
  if (tag === "a") {
    const href = node.getAttribute("href") ?? "";
    const text = children.trim();
    return href && href !== text && !href.startsWith("{{") ? `${text} (${href})` : text;
  }
  return children;
}

/** Plain-text fallback derived from the rich body, so admins never maintain two copies. */
export function htmlToPlainText(html: string): string {
  if (typeof window === "undefined") {
    return html.replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim();
  }
  const doc = new DOMParser().parseFromString(`<div id="phx-root">${html}</div>`, "text/html");
  const root = doc.getElementById("phx-root");
  return (root ? blockText(root) : "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type CaretPointDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offset: number; offsetNode: Node } | null;
};

function caretRangeAtPoint(x: number, y: number): Range | null {
  if (typeof document.caretRangeFromPoint === "function") {
    return document.caretRangeFromPoint(x, y);
  }
  const position = (document as CaretPointDocument).caretPositionFromPoint?.(x, y);
  if (!position) return null;
  const range = document.createRange();
  range.setStart(position.offsetNode, position.offset);
  range.collapse(true);
  return range;
}

type ToolbarAction = {
  icon: typeof Bold;
  label: string;
  run: () => void;
};

type Props = {
  /**
   * Attach a file that is not a picture — a PDF, a spreadsheet — that was dropped or pasted into
   * the body. Supplied only by a screen with an attachments row. Without it such a file is still
   * kept from opening in the tab, but it goes nowhere: on 2026-10-24 that sent a welcome email
   * saying "the handbook is attached" with nothing attached.
   */
  attachFiles?: (files: File[]) => void;
  /** Toolbar action labels to hide, e.g. ["Action button"] where {{ctaUrl}} cannot resolve. */
  hiddenActions?: string[];
  /**
   * Which image types the picker offers, when the host supplies `uploadImage`. The host owns this
   * because the host owns the store that will refuse anything else - a list written twice drifts.
   */
  imageAccept?: string;
  onChange: (storedHtml: string) => void;
  onFocusBody?: () => void;
  /**
   * Upload a picture the sender chose on his own machine, and return the https address it will be
   * served from. Supplied only by a screen that owns a file store; without it the image button
   * keeps asking for an address, which is all the template manager and the HR reply composer can
   * honestly offer. The host owns the error message - it has somewhere to put one, and the toolbar
   * does not.
   */
  uploadImage?: (file: File) => Promise<string>;
  value: string;
  variables: EditorVariable[];
};

export const EmailBodyEditor = forwardRef<EmailBodyEditorHandle, Props>(function EmailBodyEditor(
  { attachFiles, hiddenActions, imageAccept, onChange, onFocusBody, uploadImage, value, variables },
  ref,
) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const lastEmittedRef = useRef<string | null>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    try {
      document.execCommand("defaultParagraphSeparator", false, "p");
      // Make bold/color/etc. emit inline-styled spans (the sanitizer's language) instead of
      // legacy presentational tags where the browser supports it.
      document.execCommand("styleWithCSS", false, "true");
    } catch {
      /* unsupported browser - legacy tags are normalized on save anyway */
    }
  }, []);

  // Pull external value into the editor only when it did not originate from typing here,
  // so the caret never jumps mid-keystroke. The save round-trip echoes a server-sanitized
  // copy that differs textually from what was emitted - never rebuild while the admin is
  // actively typing in the editor (it would stomp the caret and in-flight edits). A late
  // variables-catalog load DOES force one rebuild so chips show labels instead of tokens.
  // The catalog is compared by CONTENT, not reference - hosts may pass a fresh array on
  // every render (e.g. after a recipient search reloads options) and a reference compare
  // would rebuild the DOM mid-keystroke on each of those.
  const variablesKey = variables.map((variable) => `${variable.token}:${variable.label}`).join("|");
  const variablesRef = useRef(variablesKey);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const variablesChanged = variablesRef.current !== variablesKey;
    variablesRef.current = variablesKey;
    const externalValue = value !== lastEmittedRef.current;
    if (!externalValue && !variablesChanged) return;
    if (externalValue && !variablesChanged && lastEmittedRef.current !== null && document.activeElement === editor) return;
    editor.innerHTML = storedHtmlToEditorHtml(externalValue ? value : (lastEmittedRef.current ?? value), variables);
    if (externalValue) lastEmittedRef.current = value;
  }, [value, variables, variablesKey]);

  const emit = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const stored = editorHtmlToStoredHtml(editor);
    lastEmittedRef.current = stored;
    onChange(stored);
  }, [onChange]);

  const rememberSelection = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) savedRangeRef.current = range.cloneRange();
  }, []);

  const restoreSelection = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    if (savedRangeRef.current && editor.contains(savedRangeRef.current.commonAncestorContainer)) {
      selection.addRange(savedRangeRef.current);
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.addRange(range);
  }, []);

  const runCommand = useCallback(
    (command: string, commandValue?: string) => {
      restoreSelection();
      document.execCommand(command, false, commandValue);
      rememberSelection();
      emit();
    },
    [emit, rememberSelection, restoreSelection],
  );

  const insertHtmlAtCaret = useCallback(
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
      const label = variables.find((variable) => variable.token === token)?.label ?? token;
      insertHtmlAtCaret(`${chipHtml(token, label)}&nbsp;`);
    },
    [insertHtmlAtCaret, variables],
  );

  useImperativeHandle(ref, () => ({ focusBody: restoreSelection, insertToken }), [insertToken, restoreSelection]);

  const addLink = useCallback(() => {
    const url = window.prompt("Paste the link address (https://...)");
    const trimmed = url?.trim();
    if (!trimmed) return;
    const selection = window.getSelection();
    const hasTextSelected = Boolean(
      selection && selection.rangeCount > 0 && !selection.getRangeAt(0).collapsed,
    );
    if (hasTextSelected) {
      runCommand("createLink", trimmed);
      return;
    }
    insertHtmlAtCaret(`<a href="${escapeHtml(trimmed)}">${escapeHtml(trimmed)}</a>&nbsp;`);
  }, [insertHtmlAtCaret, runCommand]);

  const addCtaButton = useCallback(() => {
    insertHtmlAtCaret(
      `<p><a href="{{ctaUrl}}">${chipHtml("ctaLabel", "Action Button Text")}</a></p>`,
    );
  }, [insertHtmlAtCaret]);

  /**
   * Insert a picture from the machine when the host can store one, and by address when it cannot.
   *
   * 🔴 THE SELECTION IS REMEMBERED BEFORE THE FILE DIALOG OPENS. Choosing a file takes focus out of
   * the editor and the browser does not hand the caret back, so without this the picture would land
   * at the end of the body rather than where the sender was typing.
   */
  const addImage = useCallback(() => {
    if (uploadImage) {
      rememberSelection();
      imageInputRef.current?.click();
      return;
    }
    const url = window.prompt("Paste the image address (must start with https://)");
    const trimmed = url?.trim();
    if (!trimmed) return;
    if (!/^https:\/\//i.test(trimmed)) {
      window.alert("Images must use an https:// address so email apps can load them.");
      return;
    }
    insertHtmlAtCaret(`<img src="${escapeHtml(trimmed)}" alt="" style="max-width: 100%" />`);
  }, [insertHtmlAtCaret, rememberSelection, uploadImage]);

  const insertUploadedImage = useCallback(
    async (file: File | null | undefined) => {
      if (!file || !uploadImage) return;
      try {
        const url = await uploadImage(file);
        if (!url) return;
        insertHtmlAtCaret(`<img src="${escapeHtml(url)}" alt="" style="max-width: 100%" />`);
      } catch {
        // Swallowed here on purpose: the host reports the failure on its own screen, and a toolbar
        // button has nowhere to put a message. An unhandled rejection is the only alternative.
      }
    },
    [insertHtmlAtCaret, uploadImage],
  );

  /**
   * Several pictures from one gesture, one after another rather than all at once.
   *
   * Sequential on purpose: each insert puts the caret after the picture it just placed, so the
   * pictures land in the order they were dropped. Uploading them in parallel would race for that
   * caret and scramble the order.
   */
  const insertUploadedImages = useCallback(
    async (files: readonly File[]) => {
      for (const file of files) {
        await insertUploadedImage(file);
      }
    },
    [insertUploadedImage],
  );

  // Apply a change to every top-level block (paragraph/list/table) the selection touches —
  // used for line spacing, letter spacing, and Arabic RTL direction, which are
  // paragraph-level concepts in email HTML.
  const applyToSelectedBlocks = useCallback(
    (apply: (block: HTMLElement) => void) => {
      restoreSelection();
      const editor = editorRef.current;
      const selection = window.getSelection();
      if (!editor || !selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const blocks = Array.from(editor.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement && range.intersectsNode(child),
      );
      if (blocks.length === 0) {
        const container = range.startContainer instanceof HTMLElement
          ? range.startContainer
          : range.startContainer.parentElement;
        const block = container?.closest("p, div, li, blockquote, td, th");
        // Never style the contenteditable root itself - root attributes are not part of
        // innerHTML, so the change would show in the editor but silently never save.
        if (block instanceof HTMLElement && block !== editor && editor.contains(block)) blocks.push(block);
      }
      for (const block of blocks) apply(block);
      rememberSelection();
      emit();
    },
    [emit, rememberSelection, restoreSelection],
  );

  /**
   * Whether the row and column controls are showing.
   *
   * Kept in state rather than read during render: the editor's content is not React's to own (it is
   * a contentEditable the effect fills by hand), so nothing re-renders when the caret moves and a
   * value read inline would be whatever it was at the last unrelated render.
   */
  const [inTable, setInTable] = useState(false);
  const [tablePickerOpen, setTablePickerOpen] = useState(false);
  const [tableHover, setTableHover] = useState({ columns: 0, rows: 0 });

  const addTable = useCallback(
    (rows: number, columns: number) => {
      insertHtmlAtCaret(tableHtml(rows, columns));
      setTablePickerOpen(false);
      setInTable(true);
    },
    [insertHtmlAtCaret],
  );

  /** The cell the caret is in, or null when the caret is not in a table at all. */
  const currentCell = useCallback((): HTMLTableCellElement | null => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    const node = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).startContainer : null;
    const element = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
    const cell = element?.closest("td, th") ?? null;
    return cell instanceof HTMLTableCellElement && editor?.contains(cell) ? cell : null;
  }, []);

  const syncSelection = useCallback(() => {
    rememberSelection();
    setInTable(currentCell() !== null);
  }, [currentCell, rememberSelection]);

  const placeCaretIn = useCallback((node: Node) => {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  /**
   * Every row/column control runs through here: restore the caret the toolbar click moved away
   * from, change the table, then leave the caret somewhere sensible and tell the host.
   */
  const editTable = useCallback(
    (apply: (cell: HTMLTableCellElement, table: HTMLTableElement) => Node | null) => {
      restoreSelection();
      const cell = currentCell();
      const table = cell?.closest("table");
      if (!cell || !(table instanceof HTMLTableElement)) return;
      const caretTarget = apply(cell, table);
      if (caretTarget) placeCaretIn(caretTarget);
      syncSelection();
      emit();
    },
    [currentCell, emit, placeCaretIn, restoreSelection, syncSelection],
  );

  const addRow = useCallback(
    (below: boolean) => {
      editTable((cell) => {
        const row = cell.parentElement;
        if (!(row instanceof HTMLTableRowElement)) return null;
        const fresh = document.createElement("tr");
        // Always body cells: a second header row is never what "add a row" means, even when the
        // caret happens to be sitting in the header.
        for (let index = 0; index < row.children.length; index += 1) fresh.appendChild(newCell(false));
        row.parentElement?.insertBefore(fresh, below ? row.nextSibling : row);
        return fresh.firstElementChild;
      });
    },
    [editTable],
  );

  const addColumn = useCallback(
    (after: boolean) => {
      editTable((cell, table) => {
        const index = Array.from(cell.parentElement?.children ?? []).indexOf(cell);
        if (index < 0) return null;
        let caretTarget: Node | null = null;
        for (const row of Array.from(table.rows)) {
          const reference = row.children[index] ?? null;
          const header = reference ? reference.tagName === "TH" : row.querySelector("th") !== null;
          const fresh = newCell(header);
          row.insertBefore(fresh, after ? (reference?.nextSibling ?? null) : reference);
          if (!caretTarget) caretTarget = fresh;
        }
        return caretTarget;
      });
    },
    [editTable],
  );

  const deleteRow = useCallback(() => {
    editTable((cell, table) => {
      const row = cell.parentElement;
      if (!(row instanceof HTMLTableRowElement)) return null;
      if (table.rows.length <= 1) return replaceTableWithParagraph(table);
      const neighbour = (row.nextElementSibling ?? row.previousElementSibling) as HTMLElement | null;
      row.remove();
      return neighbour?.firstElementChild ?? table;
    });
  }, [editTable]);

  const deleteColumn = useCallback(() => {
    editTable((cell, table) => {
      const index = Array.from(cell.parentElement?.children ?? []).indexOf(cell);
      if (index < 0) return null;
      const columns = table.rows[0]?.children.length ?? 0;
      if (columns <= 1) return replaceTableWithParagraph(table);
      let caretTarget: Node | null = null;
      for (const row of Array.from(table.rows)) {
        const target = row.children[index];
        const neighbour = (target?.nextElementSibling ?? target?.previousElementSibling) ?? null;
        target?.remove();
        if (!caretTarget) caretTarget = neighbour;
      }
      return caretTarget;
    });
  }, [editTable]);

  const deleteTable = useCallback(() => {
    editTable((_cell, table) => replaceTableWithParagraph(table));
  }, [editTable]);

  const addQuote = useCallback(() => {
    runCommand("formatBlock", "<blockquote>");
  }, [runCommand]);

  /**
   * Heading / Sub-heading / Normal.
   *
   * Written as an inline style rather than a real <h2>, because the server sanitizer discards
   * heading tags and rebuilds them as exactly this styled paragraph. Setting the style here
   * means the canvas already shows what will be sent, instead of showing an <h2> that quietly
   * turns into something else on save. 18px and 16px are the sizes the house renderer reads
   * back when it draws a section heading, so these are not free-hand numbers.
   */
  const applyHeading = useCallback(
    (size: "" | "16px" | "18px") => {
      applyToSelectedBlocks((block) => {
        block.style.fontSize = size;
        block.style.fontWeight = size ? "bold" : "";
      });
    },
    [applyToSelectedBlocks],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      // A screenshot or a copied photo arrives as a file on the clipboard, with no text beside it.
      // Before this it fell through to the plain-text branch below, found nothing, and returned —
      // so Ctrl+V on a picture did nothing at all, with nothing on screen to say why.
      const pastedFiles = Array.from(event.clipboardData.files);
      const pictures = uploadImage ? picturesFromTransfer(pastedFiles) : [];
      // A PDF copied in File Explorer and pasted here is an attachment, not text — handed to the
      // host's attachments row rather than falling through to the empty plain-text branch.
      const others = attachFiles ? nonPicturesFromTransfer(pastedFiles) : [];
      if (others.length > 0) attachFiles?.(others);
      if (pictures.length > 0) {
        event.preventDefault();
        rememberSelection();
        void insertUploadedImages(pictures);
        return;
      }
      if (others.length > 0) {
        event.preventDefault();
        return;
      }
      // Word/Outlook/Gmail paste carries heavy markup the email sanitizer would strip
      // unpredictably - paste as plain text so what you see survives the save.
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain");
      if (!text) return;
      document.execCommand("insertText", false, text);
      rememberSelection();
      emit();
    },
    [attachFiles, emit, insertUploadedImages, rememberSelection, uploadImage],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      // A picture dragged in from a folder, dropped where the pointer is rather than at the end of
      // the body — the caret is taken from the drop point BEFORE the upload starts, because by the
      // time the bytes come back the pointer is long gone.
      const droppedFiles = Array.from(event.dataTransfer.files);
      const pictures = uploadImage ? picturesFromTransfer(droppedFiles) : [];
      // A PDF, a spreadsheet or a Word file dropped on the body goes to the attachments row. Before
      // 2026-10-24 it was stopped from opening in the tab and then simply lost (see `attachFiles`).
      const others = attachFiles ? nonPicturesFromTransfer(droppedFiles) : [];
      if (others.length > 0) attachFiles?.(others);
      if (pictures.length > 0) {
        event.preventDefault();
        const dropRange = caretRangeAtPoint(event.clientX, event.clientY);
        const dropEditor = editorRef.current;
        if (dropRange && dropEditor && dropEditor.contains(dropRange.commonAncestorContainer)) {
          savedRangeRef.current = dropRange;
        }
        void insertUploadedImages(pictures);
        return;
      }
      // A file this editor cannot place — a PDF, a spreadsheet — must not be opened in the tab,
      // which is what a browser does with an un-handled drop and would lose the whole draft.
      if (event.dataTransfer.files.length > 0) {
        event.preventDefault();
        return;
      }
      const token = event.dataTransfer.getData("text/plain").trim();
      const draggedHtml = event.dataTransfer.getData("text/html");
      // A chip dragged from the Variables panel carries only its token as plain text.
      // Anything carrying HTML is the browser's own drag of editor content (moving a chip
      // or selected text) - let the native move happen, then sync state afterwards.
      if (token && !draggedHtml && variables.some((variable) => variable.token === token)) {
        event.preventDefault();
        const range = caretRangeAtPoint(event.clientX, event.clientY);
        const editor = editorRef.current;
        if (range && editor && editor.contains(range.commonAncestorContainer)) {
          savedRangeRef.current = range;
        }
        insertToken(token);
        return;
      }
      window.setTimeout(() => {
        rememberSelection();
        emit();
      }, 0);
    },
    [attachFiles, emit, insertToken, insertUploadedImages, rememberSelection, uploadImage, variables],
  );

  const actions: ToolbarAction[] = [
    { icon: Bold, label: "Bold", run: () => runCommand("bold") },
    { icon: Italic, label: "Italic", run: () => runCommand("italic") },
    { icon: Underline, label: "Underline", run: () => runCommand("underline") },
    { icon: Strikethrough, label: "Strikethrough", run: () => runCommand("strikeThrough") },
    { icon: List, label: "Bulleted list", run: () => runCommand("insertUnorderedList") },
    { icon: ListOrdered, label: "Numbered list", run: () => runCommand("insertOrderedList") },
    { icon: AlignLeft, label: "Align left", run: () => runCommand("justifyLeft") },
    { icon: AlignCenter, label: "Align center", run: () => runCommand("justifyCenter") },
    // Left and center shipped without right, which left the third of the pair missing: an English
    // paragraph could not be pushed right at all. (An Arabic one already sits right by default —
    // dir="rtl" carries its own alignment — so this is about the choice, not about Arabic.)
    { icon: AlignRight, label: "Align right", run: () => runCommand("justifyRight") },
    { icon: Quote, label: "Quote", run: addQuote },
    { icon: Link2, label: "Link", run: addLink },
    { icon: Link2Off, label: "Remove link", run: () => runCommand("unlink") },
    { icon: SquareMousePointer, label: "Action button", run: addCtaButton },
    // "Insert table" is not here: it opens a size grid, so it renders as its own control below,
    // in this same position. `hiddenActions` still governs it.
    { icon: ImageIcon, label: "Insert image", run: addImage },
    { icon: Minus, label: "Divider line", run: () => insertHtmlAtCaret("<hr />") },
    { icon: Eraser, label: "Clear formatting", run: () => runCommand("removeFormat") },
    { icon: Undo2, label: "Undo", run: () => runCommand("undo") },
    { icon: Redo2, label: "Redo", run: () => runCommand("redo") },
  ].filter((action) => !hiddenActions?.includes(action.label));

  /**
   * Insert table keeps the place it has always had — between the action button and the image — but
   * it opens a size grid rather than running a command, so it cannot sit in `actions` with the
   * plain buttons. When a host hides Insert image it lands last among them instead of jumping
   * somewhere the sender would have to hunt for.
   */
  const imageAt = actions.findIndex((action) => action.label === "Insert image");
  const beforeTable = imageAt < 0 ? actions : actions.slice(0, imageAt);
  const afterTable = imageAt < 0 ? [] : actions.slice(imageAt);
  const tableShown = !hiddenActions?.includes("Insert table");

  /**
   * The row and column controls, shown only while the caret is inside a table.
   *
   * Owner 2026-09-17: "what if I want to add or delete a column or a row? I want to be able to do
   * this manual" — so these are words, not icons: there is no icon for "column left" a sender
   * would read correctly the first time.
   */
  const tableControls: { label: string; run: () => void }[] = [
    { label: "Row above", run: () => addRow(false) },
    { label: "Row below", run: () => addRow(true) },
    { label: "Column left", run: () => addColumn(false) },
    { label: "Column right", run: () => addColumn(true) },
    { label: "Delete row", run: deleteRow },
    { label: "Delete column", run: deleteColumn },
    { label: "Delete table", run: deleteTable },
  ];

  const toolbarButton = (action: ToolbarAction) => (
    <button
      aria-label={action.label}
      className={TOOLBAR_BUTTON_CLASS}
      key={action.label}
      onClick={action.run}
      onMouseDown={(event) => event.preventDefault()}
      title={action.label}
      type="button"
    >
      <action.icon className="h-4 w-4" />
    </button>
  );

  return (
    <div className="border-y border-phx-line">
      <style>{`
        .phx-email-editor { font-family: Arial, Helvetica, sans-serif; }
        .phx-email-editor:empty::before { color: #94A3B8; content: attr(data-placeholder); }
        .phx-email-editor p { margin: 0 0 14px; }
        .phx-email-editor ul { list-style: disc; margin: 0 0 14px; padding-left: 1.5rem; }
        .phx-email-editor ol { list-style: decimal; margin: 0 0 14px; padding-left: 1.5rem; }
        .phx-email-editor li { margin: 0 0 4px; }
        .phx-email-editor hr { border: 0; border-top: 1px solid #E2E8F0; margin: 14px 0; }
        .phx-email-editor a { color: #C2410C; font-weight: 700; text-decoration: underline; }
        .phx-email-editor blockquote { border-left: 3px solid #FED7AA; color: #475569; margin: 0 0 14px; padding-left: 12px; }
        .phx-email-editor img { height: auto; max-width: 100%; }
        /*
          🔴 THE TABLE IS SHOWN THE WAY IT WILL BE SENT. Owner 2026-09-23, on an email built from an
          uploaded policy: "it should be premium polished designed perfectly zebra tabled". The mail
          itself already gets the house look stamped onto every cell inline by styleSenderTables()
          in src/lib/sato-email/render.ts — Outlook has no stylesheet and no :nth-child — but the
          composer showed a grey grid until this rule, so the sender could not see what they were
          about to send. Same grid (#CFDCE7), same head rule, same Brand Blue at 6% (#F2F6FA), which
          is the ONE fill the house identity allows.

          The stripe lands on the same rows as the mail's: the renderer counts DATA rows and tints
          every second one, so a table with a header row starts its count at the header's next
          sibling. Hence :nth-child(odd) where a <th> exists and :nth-child(even) where none does —
          both land on the second data row, then every second one after it.

          🔴 THE !important AND THE EXTRA table IN THE SELECTOR ARE LOAD-BEARING, not style. The
          admin shell paints a light-orange hairline on every cell it contains — RULE 2 in
          app/globals.css puts border: 1px solid rgba(249,115,22,0.22) !important on
          .admin-shell th and .admin-shell td — which is right for a data table and wrong for a
          canvas showing an email. Measured in the running composer 2026-09-23: the cells came out
          orange while the mail went out blue-grey. The !important answers theirs, and the extra
          table makes this selector the more specific of the two, so the outcome does not depend on
          which stylesheet the bundler happens to write last.
        */
        .phx-email-editor table { border-collapse: collapse; margin: 0 0 14px; width: 100%; }
        .phx-email-editor table td, .phx-email-editor table th {
          border: 1px solid #CFDCE7 !important; min-width: 36px; padding: 8px 11px; vertical-align: top;
        }
        .phx-email-editor table th {
          border-bottom: 2px solid #0A6BA6 !important; color: #0A527D; font-weight: 700; text-align: left;
        }
        .phx-email-editor table:has(th) tr:nth-child(odd) td { background: #F2F6FA; }
        .phx-email-editor table:not(:has(th)) tr:nth-child(even) td { background: #F2F6FA; }
        .phx-email-editor .phx-var-chip {
          background: #FFF7ED; border: 1px solid #FED7AA; color: #C2410C; cursor: default;
          display: inline-block; font-size: 12px; font-weight: 700; line-height: 1.4;
          margin: 0 1px; padding: 1px 7px; white-space: nowrap;
        }
      `}</style>
      <div className="flex flex-wrap items-center gap-1 border-b border-phx-line bg-phx-paper px-3 py-2">
        <SearchableSelect
          aria-label="Font"
          className="h-8 max-w-[110px] px-1 text-xs"
          defaultValue="Arial"
          onChange={(event) => runCommand("fontName", event.target.value)}
          title="Font (Tahoma and Segoe UI render Arabic best)"
        >
          <option value="Arial">Arial</option>
          <option value="Tahoma">Tahoma</option>
          <option value="'Segoe UI'">Segoe UI</option>
          <option value="Georgia">Georgia</option>
          <option value="'Times New Roman'">Times New Roman</option>
          <option value="Verdana">Verdana</option>
          <option value="'Courier New'">Courier New</option>
        </SearchableSelect>
        <SearchableSelect
          aria-label="Font size"
          className="h-8 px-1 text-xs"
          defaultValue="3"
          onChange={(event) => {
            runCommand("fontSize", event.target.value);
            event.target.value = "3";
          }}
          title="Font size"
        >
          <option value="2">Small</option>
          <option value="3">Normal</option>
          <option value="5">Large</option>
          <option value="7">Huge</option>
        </SearchableSelect>
        <SearchableSelect
          aria-label="Heading"
          className="h-8 px-1 text-xs"
          defaultValue=""
          onChange={(event) => {
            const value = event.target.value;
            if (!value) return;
            applyHeading(value === "normal" ? "" : value === "heading" ? "18px" : "16px");
            event.target.value = "";
          }}
          title="Heading (a section title the email design draws a rule under)"
        >
          <option disabled value="">Style</option>
          <option value="normal">Normal text</option>
          <option value="heading">Heading</option>
          <option value="subheading">Sub-heading</option>
        </SearchableSelect>
        <SearchableSelect
          aria-label="Line spacing"
          className="h-8 px-1 text-xs"
          defaultValue=""
          onChange={(event) => {
            const value = event.target.value;
            if (!value) return;
            applyToSelectedBlocks((block) => {
              block.style.lineHeight = value;
            });
            event.target.value = "";
          }}
          title="Line spacing (space between lines)"
        >
          <option disabled value="">Line</option>
          <option value="1.4">Compact</option>
          <option value="1.75">Normal</option>
          <option value="2.2">Wide</option>
        </SearchableSelect>
        <SearchableSelect
          aria-label="Letter spacing"
          className="h-8 px-1 text-xs"
          defaultValue=""
          onChange={(event) => {
            const value = event.target.value;
            if (!value) return;
            applyToSelectedBlocks((block) => {
              block.style.letterSpacing = value;
            });
            event.target.value = "";
          }}
          title="Letter spacing (space between letters)"
        >
          <option disabled value="">A-Z</option>
          <option value="normal">Normal</option>
          <option value="1px">Wide</option>
          <option value="2px">Wider</option>
        </SearchableSelect>
        <button
          aria-label="Right-to-left paragraph (Arabic)"
          className="flex h-8 items-center justify-center border border-transparent px-1.5 text-xs font-black text-phx-ink-2 hover:border-[#FED7AA] hover:bg-phx-accent-soft hover:text-phx-accent-press"
          onClick={() => applyToSelectedBlocks((block) => block.setAttribute("dir", "rtl"))}
          onMouseDown={(event) => event.preventDefault()}
          title="Right-to-left paragraph (Arabic)"
          type="button"
        >
          {"ع"}
        </button>
        <button
          aria-label="Left-to-right paragraph (English)"
          className="flex h-8 items-center justify-center border border-transparent px-1.5 text-phx-sm font-black text-phx-ink-2 hover:border-[#FED7AA] hover:bg-phx-accent-soft hover:text-phx-accent-press"
          onClick={() => applyToSelectedBlocks((block) => block.setAttribute("dir", "ltr"))}
          onMouseDown={(event) => event.preventDefault()}
          title="Left-to-right paragraph (English)"
          type="button"
        >
          LTR
        </button>
        <label className="flex h-8 w-8 cursor-pointer items-center justify-center border border-transparent hover:border-[#FED7AA] hover:bg-phx-accent-soft" title="Text color">
          <span className="text-xs font-black text-phx-ink-2">A</span>
          <input
            aria-label="Text color"
            className="h-3 w-3 cursor-pointer border-0 bg-transparent p-0"
            onChange={(event) => runCommand("foreColor", event.target.value)}
            type="color"
          />
        </label>
        <label className="flex h-8 w-8 cursor-pointer items-center justify-center border border-transparent hover:border-[#FED7AA] hover:bg-phx-accent-soft" title="Highlight color">
          <span className="bg-[#FDE68A] px-0.5 text-xs font-black text-phx-ink-2">A</span>
          <input
            aria-label="Highlight color"
            className="h-3 w-3 cursor-pointer border-0 bg-transparent p-0"
            defaultValue="#fde68a"
            onChange={(event) => runCommand("hiliteColor", event.target.value)}
            type="color"
          />
        </label>
        {beforeTable.map(toolbarButton)}
        {tableShown ? (
          <div className="relative">
            <button
              aria-label="Insert table"
              className={TOOLBAR_BUTTON_CLASS}
              onClick={() => {
                rememberSelection();
                setTablePickerOpen((open) => !open);
              }}
              onMouseDown={(event) => event.preventDefault()}
              title="Insert table"
              type="button"
            >
              <Table className="h-4 w-4" />
            </button>
            {tablePickerOpen ? (
              <div className="absolute left-0 top-9 z-20 border border-phx-line bg-white p-2 shadow-md">
                <div className="mb-1 text-phx-sm font-bold text-phx-ink-2">
                  {tableHover.rows > 0
                    ? `${tableHover.rows} rows by ${tableHover.columns} columns`
                    : "Pick the size"}
                </div>
                <div
                  className="flex flex-col gap-0.5"
                  onMouseLeave={() => setTableHover({ columns: 0, rows: 0 })}
                >
                  {Array.from({ length: TABLE_PICK_MAX_ROWS }, (_unused, row) => (
                    <div className="flex gap-0.5" key={row}>
                      {Array.from({ length: TABLE_PICK_MAX_COLUMNS }, (_cell, column) => (
                        <button
                          className={`h-4 w-4 border ${
                            row < tableHover.rows && column < tableHover.columns
                              ? "border-[#FED7AA] bg-phx-accent-soft"
                              : "border-phx-line bg-white"
                          }`}
                          key={column}
                          onClick={() => addTable(row + 1, column + 1)}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setTableHover({ columns: column + 1, rows: row + 1 })}
                          title={`${row + 1} rows by ${column + 1} columns`}
                          type="button"
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {afterTable.map(toolbarButton)}
        {uploadImage ? (
          <input
            accept={imageAccept ?? EDITOR_IMAGE_ACCEPT}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared straight away, so choosing the SAME file twice in a row still fires a change
              // event - otherwise a failed upload could not simply be retried.
              event.target.value = "";
              void insertUploadedImage(file);
            }}
            ref={imageInputRef}
            type="file"
          />
        ) : null}
        <span className="ml-auto hidden text-xs font-bold text-phx-ink-faint xl:block">
          Write here like Gmail - check the Preview for the exact employee view.
        </span>
      </div>
      {inTable && tableShown ? (
        <div className="flex flex-wrap items-center gap-1 border-b border-phx-line bg-phx-accent-soft px-3 py-1.5">
          <span className="mr-1 text-phx-sm font-black uppercase tracking-wide text-phx-ink-2">Table</span>
          {tableControls.map((control) => (
            <button
              className="h-7 border border-phx-line bg-white px-2 text-phx-sm font-bold text-phx-ink-2 hover:border-[#FED7AA] hover:bg-phx-accent-soft hover:text-phx-accent-press"
              key={control.label}
              onClick={control.run}
              onMouseDown={(event) => event.preventDefault()}
              title={control.label}
              type="button"
            >
              {control.label}
            </button>
          ))}
        </div>
      ) : null}
      <div
        className="phx-email-editor min-h-[320px] w-full bg-white px-5 py-4 text-phx-lg leading-[1.75] text-[#111827] outline-none"
        contentEditable
        data-placeholder="Write the email message here..."
        onBlur={rememberSelection}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        onFocus={() => onFocusBody?.()}
        onInput={() => {
          emit();
          syncSelection();
        }}
        onKeyUp={syncSelection}
        onMouseUp={() => {
          syncSelection();
          setTablePickerOpen(false);
        }}
        onPaste={handlePaste}
        ref={editorRef}
        role="textbox"
        suppressContentEditableWarning
      />
    </div>
  );
});
