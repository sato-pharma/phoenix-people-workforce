"use client";

import {
  AlignCenter,
  AlignLeft,
  Bold,
  Eraser,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  SquareMousePointer,
  Strikethrough,
  Table,
  Underline,
} from "lucide-react";
import type { ClipboardEvent, DragEvent } from "react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";


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
    if (!/(^|;)\s*border\s*:/i.test(style)) appendStyle(cell, "border: 1px solid #cbd5e1");
    if (!/(^|;)\s*padding\s*:/i.test(cell.getAttribute("style") ?? "")) appendStyle(cell, "padding: 8px");
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
  /** Toolbar action labels to hide, e.g. ["Action button"] where {{ctaUrl}} cannot resolve. */
  hiddenActions?: string[];
  onChange: (storedHtml: string) => void;
  onFocusBody?: () => void;
  value: string;
  variables: EditorVariable[];
};

export const EmailBodyEditor = forwardRef<EmailBodyEditorHandle, Props>(function EmailBodyEditor(
  { hiddenActions, onChange, onFocusBody, value, variables },
  ref,
) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const lastEmittedRef = useRef<string | null>(null);
  const savedRangeRef = useRef<Range | null>(null);

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

  const addImage = useCallback(() => {
    const url = window.prompt("Paste the image address (must start with https://)");
    const trimmed = url?.trim();
    if (!trimmed) return;
    if (!/^https:\/\//i.test(trimmed)) {
      window.alert("Images must use an https:// address so email apps can load them.");
      return;
    }
    insertHtmlAtCaret(`<img src="${escapeHtml(trimmed)}" alt="" style="max-width: 100%" />`);
  }, [insertHtmlAtCaret]);

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

  const addTable = useCallback(() => {
    const headerCell = `<th style="border: 1px solid #cbd5e1; padding: 8px; background-color: #f8fafc; text-align: left">Column</th>`;
    const bodyCell = `<td style="border: 1px solid #cbd5e1; padding: 8px">&nbsp;</td>`;
    const bodyRow = `<tr>${bodyCell.repeat(3)}</tr>`;
    insertHtmlAtCaret(
      `<table style="border-collapse: collapse; width: 100%"><tbody><tr>${headerCell.repeat(3)}</tr>${bodyRow.repeat(2)}</tbody></table><p><br /></p>`,
    );
  }, [insertHtmlAtCaret]);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      // Word/Outlook/Gmail paste carries heavy markup the email sanitizer would strip
      // unpredictably - paste as plain text so what you see survives the save.
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain");
      if (!text) return;
      document.execCommand("insertText", false, text);
      rememberSelection();
      emit();
    },
    [emit, rememberSelection],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
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
    [emit, insertToken, rememberSelection, variables],
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
    { icon: Link2, label: "Link", run: addLink },
    { icon: SquareMousePointer, label: "Action button", run: addCtaButton },
    { icon: Table, label: "Insert table", run: addTable },
    { icon: ImageIcon, label: "Insert image (https link)", run: addImage },
    { icon: Minus, label: "Divider line", run: () => insertHtmlAtCaret("<hr />") },
    { icon: Eraser, label: "Clear formatting", run: () => runCommand("removeFormat") },
  ].filter((action) => !hiddenActions?.includes(action.label));

  return (
    <div className="border-y border-[#E2E8F0]">
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
        .phx-email-editor table { border-collapse: collapse; margin: 0 0 14px; width: 100%; }
        .phx-email-editor td, .phx-email-editor th { border: 1px solid #cbd5e1; min-width: 36px; padding: 8px; }
        .phx-email-editor .phx-var-chip {
          background: #FFF7ED; border: 1px solid #FED7AA; color: #C2410C; cursor: default;
          display: inline-block; font-size: 12px; font-weight: 700; line-height: 1.4;
          margin: 0 1px; padding: 1px 7px; white-space: nowrap;
        }
      `}</style>
      <div className="flex flex-wrap items-center gap-1 border-b border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2">
        <SearchableSelect
          aria-label="Font"
          className="h-8 max-w-[110px] border border-[#E2E8F0] bg-white px-1 text-xs font-bold text-[#334155]"
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
          className="h-8 border border-[#E2E8F0] bg-white px-1 text-xs font-bold text-[#334155]"
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
          aria-label="Line spacing"
          className="h-8 border border-[#E2E8F0] bg-white px-1 text-xs font-bold text-[#334155]"
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
          className="h-8 border border-[#E2E8F0] bg-white px-1 text-xs font-bold text-[#334155]"
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
          className="flex h-8 items-center justify-center border border-transparent px-1.5 text-xs font-black text-[#334155] hover:border-[#FED7AA] hover:bg-[#FFF7ED] hover:text-[#C2410C]"
          onClick={() => applyToSelectedBlocks((block) => block.setAttribute("dir", "rtl"))}
          onMouseDown={(event) => event.preventDefault()}
          title="Right-to-left paragraph (Arabic)"
          type="button"
        >
          {"ع"}
        </button>
        <button
          aria-label="Left-to-right paragraph (English)"
          className="flex h-8 items-center justify-center border border-transparent px-1.5 text-[10px] font-black text-[#334155] hover:border-[#FED7AA] hover:bg-[#FFF7ED] hover:text-[#C2410C]"
          onClick={() => applyToSelectedBlocks((block) => block.setAttribute("dir", "ltr"))}
          onMouseDown={(event) => event.preventDefault()}
          title="Left-to-right paragraph (English)"
          type="button"
        >
          LTR
        </button>
        <label className="flex h-8 w-8 cursor-pointer items-center justify-center border border-transparent hover:border-[#FED7AA] hover:bg-[#FFF7ED]" title="Text color">
          <span className="text-xs font-black text-[#334155]">A</span>
          <input
            aria-label="Text color"
            className="h-3 w-3 cursor-pointer border-0 bg-transparent p-0"
            onChange={(event) => runCommand("foreColor", event.target.value)}
            type="color"
          />
        </label>
        <label className="flex h-8 w-8 cursor-pointer items-center justify-center border border-transparent hover:border-[#FED7AA] hover:bg-[#FFF7ED]" title="Highlight color">
          <span className="bg-[#FDE68A] px-0.5 text-xs font-black text-[#334155]">A</span>
          <input
            aria-label="Highlight color"
            className="h-3 w-3 cursor-pointer border-0 bg-transparent p-0"
            defaultValue="#fde68a"
            onChange={(event) => runCommand("hiliteColor", event.target.value)}
            type="color"
          />
        </label>
        {actions.map((action) => (
          <button
            aria-label={action.label}
            className="flex h-8 w-8 items-center justify-center border border-transparent text-[#334155] hover:border-[#FED7AA] hover:bg-[#FFF7ED] hover:text-[#C2410C]"
            key={action.label}
            onClick={action.run}
            onMouseDown={(event) => event.preventDefault()}
            title={action.label}
            type="button"
          >
            <action.icon className="h-4 w-4" />
          </button>
        ))}
        <span className="ml-auto hidden text-xs font-bold text-[#94A3B8] xl:block">
          Write here like Gmail - check the Preview for the exact employee view.
        </span>
      </div>
      <div
        className="phx-email-editor min-h-[320px] w-full bg-white px-5 py-4 text-[15px] leading-[1.75] text-[#111827] outline-none"
        contentEditable
        data-placeholder="Write the email message here..."
        onBlur={rememberSelection}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        onFocus={() => onFocusBody?.()}
        onInput={emit}
        onKeyUp={rememberSelection}
        onMouseUp={rememberSelection}
        onPaste={handlePaste}
        ref={editorRef}
        role="textbox"
        suppressContentEditableWarning
      />
    </div>
  );
});
