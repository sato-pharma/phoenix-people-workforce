/**
 * Masking for the Phoenix visual explorer: nothing a person typed or the database returned may reach a
 * screenshot, an accessibility snapshot, a log or a model.
 *
 * FAIL-CLOSED, by inversion: the explorer does not try to recognise sensitive text (names, ids,
 * salaries — an endless list). It masks EVERY visible string, every accessible name and every form
 * value, and keeps only text that appears verbatim as a string literal in the module's reviewed source
 * files (the KPIs components, the navigation config, the portal layout) or in a short list of calendar
 * words. Everything else is replaced character for character — Latin letters by x/X, Arabic letters
 * by a tatweel, digits by 0 — so the page keeps its shape and density for the visual audit.
 *
 * Pictures, video, canvas and frames are hidden (their box stays). A MutationObserver re-masks any text
 * React writes after the pass, before the browser paints it.
 *
 * After the screenshot the explorer runs a SECOND, independent pass (verifyDocument): every text node
 * must either be a kept literal with no sensitive pattern in it, or have a masked shape. Any failure
 * deletes the screenshot and records the kind of leak and its length — never the text itself.
 *
 * The character logic lives in `maskerHelpers`, a self-contained factory: the same function body runs
 * in the page (serialized into the evaluate call) and in Node (tests/phoenix-inspect-redaction.test.ts),
 * so what is tested is what runs.
 */

/**
 * Calendar words kept everywhere: they carry no personal data and the boards are full of them.
 * "May" is deliberately absent — it is also a common first name (Mai / May), and a kept word inside a
 * masked name would leave that name half visible.
 */
export const SAFE_WORDS = Object.freeze([
  "January", "February", "March", "April", "June", "July", "August", "September", "October",
  "November", "December", "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov",
  "Dec", "Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Sat", "Sun",
  "Mon", "Tue", "Wed", "Thu", "Fri", "AM", "PM", "Q1", "Q2", "Q3", "Q4", "H1", "H2",
]);

/** Self-contained: no closure over module scope, because its source text is sent into the page. */
export function maskerHelpers() {
  const ARABIC_LETTER = /[ؠ-يٮ-ۓەۺ-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/u;
  const DIGIT = /[0-9٠-٩۰-۹]/u;
  const LETTER = /\p{L}/u;

  function maskChar(ch) {
    if (DIGIT.test(ch)) return "0";
    if (ARABIC_LETTER.test(ch)) return "ـ";
    if (/[A-Z]/.test(ch)) return "X";
    if (LETTER.test(ch)) return "x";
    if (/\p{M}/u.test(ch)) return "";
    return ch;
  }

  function maskAll(text) {
    let out = "";
    for (const ch of String(text)) out += maskChar(ch);
    return out;
  }

  /** Keep the whole node if its trimmed text is a kept literal; otherwise keep only safe words. */
  function maskString(text, keep, safeWords) {
    const value = String(text);
    const trimmed = value.trim();
    if (trimmed === "") return value;
    if (keep.has(trimmed)) return value;
    return value.replace(/[\p{L}\p{N}\p{M}]+/gu, (word) => (safeWords.has(word) ? word : maskAll(word)));
  }

  /** True when no letter other than x, X or a tatweel and no digit other than 0 is left. */
  function isMaskedShape(text, safeWords) {
    const stripped = String(text).replace(/[\p{L}\p{N}\p{M}]+/gu, (word) => (safeWords.has(word) ? "" : word));
    for (const ch of stripped) {
      if (DIGIT.test(ch) && ch !== "0") return false;
      if (LETTER.test(ch) && ch !== "x" && ch !== "X" && ch !== "ـ") return false;
    }
    return true;
  }

  /** Pattern names found in text that is about to be KEPT. Masked text is never searched. */
  function findSensitivePatterns(text) {
    const value = String(text);
    const hits = [];
    if (/[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/.test(value)) hits.push("email");
    // 01X XXXX XXXX, or +20 1X XXXX XXXX, with spaces or dashes anywhere between the digits.
    if (/(?:\+?20[\s-]?|\b0)1[0125](?:[\s-]?\d){8}\b/.test(value)) hits.push("egyptian-mobile");
    if (/(?<!\d)[23]\d{13}(?!\d)/.test(value)) hits.push("national-id");
    if (/\b[A-Z]{1,4}-\d{1,6}\b/.test(value)) hits.push("hr-id-like");
    if (/(?<![\d.])\d{6,}(?![\d.])/.test(value)) hits.push("long-number");
    // Arabic is not searched here: a kept literal comes from reviewed source, and Arabic text from the
    // database is never kept (it is masked to tatweels like any other data).
    return hits;
  }

  return { maskChar, maskAll, maskString, isMaskedShape, findSensitivePatterns };
}

const helpers = maskerHelpers();
export const { maskString, isMaskedShape, findSensitivePatterns, maskAll } = helpers;

/**
 * Every string literal and JSX text run in a source file that could be visible text. Comments are
 * removed first, so a comment's words are never kept.
 */
export function extractSourceLiterals(source) {
  const withoutComments = String(source)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const out = new Set();
  const add = (raw) => {
    const text = raw.replace(/\\n/g, " ").replace(/\\(["'`\\])/g, "$1").replace(/\s+/g, " ").trim();
    if (text.length < 2 || text.length > 240) return;
    if (!/\p{L}/u.test(text)) return;
    out.add(text);
  };
  for (const match of withoutComments.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)) add(match[1] ?? match[2] ?? "");
  for (const match of withoutComments.matchAll(/`((?:[^`\\$]|\\.|\$(?!\{))*)`/g)) add(match[1]);
  // Template literals WITH interpolations: their static pieces are separate text runs on screen.
  for (const match of withoutComments.matchAll(/`([^`]*\$\{[^`]*)`/g)) {
    for (const piece of match[1].split(/\$\{[^}]*\}/)) add(piece);
  }
  for (const match of withoutComments.matchAll(/>([^<>{}]+)</g)) add(match[1]);
  // JSX text that sits next to an expression: `{count} reps` renders " reps" as its own node.
  for (const match of withoutComments.matchAll(/\}([^<>{}\n]+)(?=[<{])/g)) add(match[1]);
  for (const match of withoutComments.matchAll(/>([^<>{}\n]+)\{/g)) add(match[1]);
  return out;
}

/** literal -> set of files it appears in. */
export function buildKeepIndex(files) {
  const index = new Map();
  for (const { file, source } of files) {
    for (const literal of extractSourceLiterals(source)) {
      if (!index.has(literal)) index.set(literal, new Set());
      index.get(literal).add(file);
    }
  }
  return index;
}

/**
 * Which source files a screenshot's kept text came from. A file that is the ONLY source of at least
 * one visible literal is "high"; a file sharing every literal with up to two others is "medium";
 * anything wider is "low". Shared vocabulary (a word in more than six files) is ignored.
 */
export function sourceCandidatesFor(keptTexts, index) {
  const score = new Map();
  for (const text of new Set(keptTexts)) {
    const files = index.get(text.trim());
    if (!files || files.size > 6) continue;
    for (const file of files) {
      const entry = score.get(file) ?? { file, unique: 0, shared: 0, literals: [] };
      if (files.size === 1) entry.unique += 1;
      else entry.shared += 1;
      if (entry.literals.length < 5) entry.literals.push(text.trim());
      score.set(file, entry);
    }
  }
  return [...score.values()]
    .map((entry) => ({
      file: entry.file,
      confidence: entry.unique > 0 ? "high" : entry.shared > 0 && entry.literals.length > 0 ? "medium" : "low",
      evidence: entry.literals,
      uniqueLiterals: entry.unique,
    }))
    .sort((a, b) => b.uniqueLiterals - a.uniqueLiterals || a.file.localeCompare(b.file));
}

// ---------------------------------------------------------------------------------------------------
// In-page functions. Each receives the helper FACTORY as its first argument (see pageCall).

/** Masks the document in place and keeps it masked. Returns counts and the kept literals seen. */
export function maskDocument(factory, keepList, safeList) {
  const { maskString } = factory();
  const keep = new Set(keepList);
  const safe = new Set(safeList);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const ATTRS = ["aria-label", "title", "alt", "placeholder", "aria-valuetext", "aria-description", "data-tooltip"];
  const stats = { maskedNodes: 0, keptNodes: 0, maskedAttributes: 0, maskedValues: 0, hiddenMedia: 0, keptTexts: [] };
  const keptSeen = new Set();

  const maskTextNode = (node) => {
    const parent = node.parentElement;
    if (!parent || SKIP.has(parent.tagName)) return;
    const before = node.nodeValue ?? "";
    if (before.trim() === "") return;
    const after = maskString(before, keep, safe);
    if (after === before && keep.has(before.trim())) {
      stats.keptNodes += 1;
      if (!keptSeen.has(before.trim())) {
        keptSeen.add(before.trim());
        stats.keptTexts.push(before.trim());
      }
      return;
    }
    if (after !== before) node.nodeValue = after;
    stats.maskedNodes += 1;
  };
  const maskElement = (element) => {
    for (const name of ATTRS) {
      const value = element.getAttribute(name);
      if (value && value.trim() !== "") {
        const after = maskString(value, keep, safe);
        if (after !== value) {
          element.setAttribute(name, after);
          stats.maskedAttributes += 1;
        }
      }
    }
    if ((element.tagName === "INPUT" || element.tagName === "TEXTAREA") && element.value) {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (!["checkbox", "radio", "range", "color", "button", "submit", "reset", "hidden"].includes(type)) {
        const masked = maskString(element.value, keep, safe);
        if (masked !== element.value) {
          element.value = masked;
          stats.maskedValues += 1;
        }
      }
    }
    if (["IMG", "VIDEO", "CANVAS", "PICTURE", "IFRAME", "OBJECT", "EMBED"].includes(element.tagName)) {
      element.style.setProperty("visibility", "hidden", "important");
      stats.hiddenMedia += 1;
    } else if (element.tagName === "image" || element.tagName === "IMAGE") {
      element.setAttribute("visibility", "hidden");
      stats.hiddenMedia += 1;
    } else {
      const background = getComputedStyle(element).backgroundImage;
      if (background && background.includes("url(")) {
        element.style.setProperty("background-image", "none", "important");
        stats.hiddenMedia += 1;
      }
    }
  };
  const walk = (root) => {
    if (root.nodeType === Node.TEXT_NODE) return maskTextNode(root);
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) {
      if (SKIP.has(root.tagName)) return;
      maskElement(root);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) maskTextNode(node);
      else if (!SKIP.has(node.tagName)) maskElement(node);
      node = walker.nextNode();
    }
  };
  walk(document.body);
  if (!window.__phxMaskObserver) {
    window.__phxMaskObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") maskTextNode(record.target);
        else if (record.type === "attributes") maskElement(record.target);
        else for (const added of record.addedNodes) walk(added);
      }
    });
    window.__phxMaskObserver.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "title", "alt", "placeholder", "aria-valuetext", "aria-description", "data-tooltip", "src", "style"],
    });
  }
  return stats;
}

/** The second, independent check. Returns leak KINDS and lengths only — never the text. */
export function verifyDocument(factory, keepList, safeList) {
  const { isMaskedShape, findSensitivePatterns } = factory();
  const keep = new Set(keepList);
  const safe = new Set(safeList);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const leaks = [];
  const check = (text, where) => {
    const trimmed = String(text ?? "").trim();
    if (trimmed === "") return;
    if (keep.has(trimmed)) {
      for (const kind of findSensitivePatterns(trimmed)) leaks.push({ kind: `kept-literal-${kind}`, where, length: trimmed.length });
      return;
    }
    if (!isMaskedShape(trimmed, safe)) leaks.push({ kind: "unmasked-text", where, length: trimmed.length });
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.parentElement && !SKIP.has(node.parentElement.tagName)) check(node.nodeValue, node.parentElement.tagName.toLowerCase());
    } else {
      for (const name of ["aria-label", "title", "alt", "placeholder", "aria-valuetext", "aria-description", "data-tooltip"]) {
        const value = node.getAttribute(name);
        if (value) check(value, `@${name}`);
      }
      if ((node.tagName === "INPUT" || node.tagName === "TEXTAREA") && node.value) {
        const type = (node.getAttribute("type") ?? "text").toLowerCase();
        if (!["checkbox", "radio", "range", "color", "button", "submit", "reset", "hidden"].includes(type)) check(node.value, "input-value");
      }
      if (["IMG", "VIDEO", "CANVAS", "IFRAME", "OBJECT", "EMBED"].includes(node.tagName)) {
        const box = node.getBoundingClientRect();
        if (box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== "hidden") {
          leaks.push({ kind: "visible-media", where: node.tagName.toLowerCase(), length: 0 });
        }
      }
    }
    node = walker.nextNode();
  }
  return { leaks: leaks.slice(0, 50), leakCount: leaks.length };
}

/**
 * The accessibility snapshot names each link's address (`- /url: /admin/kpis/call-rate/Z-9043?month=…`),
 * and an address carries ids and dates the masker never sees (it masks TEXT, not hrefs). Every `/url:`
 * value is rewritten the way the network log writes an address: path ids masked, query keys only.
 * @param {string} aria
 * @param {string} origin
 * @param {(url: string, origin: string) => string} sanitizeUrl fence.mjs sanitizeUrlForLog
 */
export function sanitizeAriaSnapshot(aria, origin, sanitizeUrl) {
  return String(aria).replace(/^(\s*-?\s*\/url:\s*)(.*)$/gm, (_, lead, value) => {
    const raw = value.trim().replace(/^"(.*)"$/, "$1");
    let href;
    try {
      href = new URL(raw, origin).href;
    } catch {
      return `${lead}(unparseable)`;
    }
    return `${lead}${sanitizeUrl(href, origin)}`;
  });
}

/**
 * Sensitive patterns left in an accessibility snapshot AFTER masking. A masked value keeps its shape
 * (an HR id becomes X-0000, an email xxxxx@xxxxx.xxx), and findSensitivePatterns, written for KEPT
 * text, would flag those shapes. So every token made only of mask characters is dropped first, and
 * only what is still unmasked is searched.
 */
export function findAriaLeaks(aria) {
  const unmasked = String(aria).replace(/[^\s"'(),[\]=]+/gu, (token) => (/^[xXـ0@._\-/:+…?&]*$/u.test(token) ? "" : token));
  return findSensitivePatterns(unmasked);
}

/** The expression string handed to page.evaluate: the in-page function called with the factory. */
export function pageCall(fn, ...args) {
  return `(${fn.toString()})(${maskerHelpers.toString()}, ${args.map((arg) => JSON.stringify(arg)).join(", ")})`;
}
