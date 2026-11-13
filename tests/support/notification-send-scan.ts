// The static reader behind tests/notification-type-registry.test.ts: it finds every place the code
// sends a notice that carries a type, and resolves each one to the (module, eventType) pairs it can
// send. It reads comment-stripped source only — nothing is imported or executed.
//
// A "send" is any of these three shapes:
//
//   1. An object literal that names BOTH a `module` and an `eventType` — the input of
//      createSystemNotification / createSystemNotificationForRecipients, of
//      notifyConversationMessage, of a module's own `send(...)` helper, and the `origin` a direct
//      sendPhoenixEmail carries. Wherever such an object is built, it is a notice going out.
//   2. A call to a module's own wrapper that fixes the module itself and takes only the event
//      (WRAPPERS below) — e.g. `notifyDirectOrder({ eventType: "submitted" })`.
//   3. Every `eventType:` literal in a file that is wholly a notifier for one module
//      (FILE_WIDE below — Phoenix CRM's notifications.ts builds `Delivery` objects).
//
// Each value is resolved through string literals, ternaries, local and exported `const`s, and
// constant maps. What cannot be resolved statically comes back `unresolved`, and the test demands
// it be acknowledged with its documented set of values; a template literal comes back as a
// `pattern` the registry's entries for that file must match.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { stripComments } from "./comment-strip.ts";

export type ResolvedValue =
  | { kind: "values"; values: string[] }
  | { kind: "pattern"; regex: RegExp; text: string }
  | { kind: "unresolved"; text: string };

export type NotificationSendSite = {
  eventType: ResolvedValue;
  file: string;
  line: number;
  module: ResolvedValue;
  /** "direct-email": the `origin` of an email sent straight through sendPhoenixEmail, outside the policy. */
  shape: "object" | "direct-email" | "wrapper" | "file-wide";
};

/** Wrappers that fix the module themselves; `field` is the property of their first argument that carries the event. */
export const WRAPPERS: ReadonlyArray<{ callee: string; field: string; file: string; module: string }> = [
  { callee: "fanOut", field: "eventType", file: "src/lib/automated-payroll/notify.ts", module: "payroll" },
  { callee: "notifyDirectOrder", field: "eventType", file: "src/lib/direct-orders/service.ts", module: "direct_orders" },
  // Its third argument names the event a held order's move into the chain is announced as.
  { callee: "moveHeldDirectOrdersIntoChain", field: "eventType", file: "src/lib/direct-orders/service.ts", module: "direct_orders" },
  { callee: "notifyHrVisibilityRecipients", field: "eventType", file: "src/lib/excuses/service.ts", module: "excuse" },
  { callee: "send", field: "eventType", file: "src/lib/hr-ops-reports/notify.ts", module: "hr_ops_reports" },
  { callee: "send", field: "eventType", file: "src/lib/marketing-functions/notify.ts", module: "marketing_functions" },
  { callee: "notifyMarketingWorkflow", field: "eventType", file: "src/lib/marketing-requests/service.ts", module: "marketing_requests" },
  // The vacation module's own helper names the event `type`, and passes it on as `eventType`.
  { callee: "notifyRecipients", field: "type", file: "src/lib/vacation/service.ts", module: "vacation" },
  { callee: "notifyRecipients", field: "eventType", file: "src/lib/weekly-planning/service.ts", module: "weekly_plans" },
];

/** Files that are wholly one module's notifier: every `eventType:` object property in them is a send. */
export const FILE_WIDE: ReadonlyArray<{ file: string; module: string }> = [
  { file: "src/lib/phoenix-crm/server/notifications.ts", module: "phoenix_crm" },
];

/**
 * The notification engine itself and the screens that READ notices. They handle `module` and
 * `eventType` of notices other files send (relaying a Telegram failure as email, rendering a
 * template, listing deliveries), so nothing they build is a type of its own.
 */
export const ENGINE_FILES: ReadonlySet<string> = new Set([
  // The registry's own screen lists types; it sends nothing.
  "app/(admin)/admin/notification-types/page.tsx",
  "src/lib/email/send-phoenix-email.ts",
  "src/lib/notifications/confidence-gate.ts",
  "src/lib/notifications/email-admin.ts",
  "src/lib/notifications/email.ts",
  "src/lib/notifications/notification-types.ts",
  "src/lib/notifications/policy.ts",
  "src/lib/notifications/system.ts",
  "src/lib/notifications/telegram-admin.ts",
  // Telegram templates are keyed by module with an `eventType: "*"` wildcard — a template, not a send.
  "src/lib/notifications/telegram-templates.ts",
  "src/lib/notifications/templates.ts",
  // A nightly check that RESOLVES the recipients of a type sent elsewhere (attendance ingestion).
  "src/lib/reconciliation/checks/notifications-integrity.ts",
]);

const ROOTS = ["src", "app"];

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (name === "node_modules" || name === "tests" || name === "mobile") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(full.split(path.sep).join("/"));
    }
  }
}

export function listSourceFiles(root = process.cwd()): string[] {
  const out: string[] = [];
  for (const r of ROOTS) walk(path.join(root, r), out);
  return out.map((file) => path.relative(root, file).split(path.sep).join("/")).sort();
}

/**
 * Blanks the CONTENT of every string and template literal (quotes kept), so structure — braces,
 * commas, `?` — can be read without a literal's text confusing it. Same length as the input, so an
 * index into the mask is an index into the source.
 */
export function maskLiterals(code: string): string {
  const out = code.split("");
  const stack: Array<"tpl" | number> = [];
  let mode: "code" | "sq" | "dq" | "tpl" = "code";
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (mode === "code") {
      if (c === '"') mode = "dq";
      else if (c === "'") mode = "sq";
      else if (c === "`") {
        mode = "tpl";
        stack.push("tpl");
      } else if (c === "{" && typeof stack[stack.length - 1] === "number") {
        stack[stack.length - 1] = (stack[stack.length - 1] as number) + 1;
      } else if (c === "}" && typeof stack[stack.length - 1] === "number") {
        const depth = stack[stack.length - 1] as number;
        if (depth === 0) {
          stack.pop();
          mode = "tpl";
        } else stack[stack.length - 1] = depth - 1;
      }
      if (stack.length > 0 && !(mode === "tpl" && c === "`")) out[i] = c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (mode === "sq" || mode === "dq") {
      const quote = mode === "sq" ? "'" : '"';
      if (c === "\\") {
        out[i] = " ";
        if (i + 1 < code.length) out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === quote || c === "\n") {
        mode = "code";
        if (stack.length > 0) out[i] = " ";
        i += 1;
        continue;
      }
      out[i] = " ";
      i += 1;
      continue;
    }
    // template text
    if (c === "\\") {
      out[i] = " ";
      if (i + 1 < code.length) out[i + 1] = " ";
      i += 2;
      continue;
    }
    if (c === "`") {
      stack.pop();
      mode = "code";
      if (stack.length > 0) out[i] = " ";
      i += 1;
      continue;
    }
    if (c === "$" && code[i + 1] === "{") {
      out[i] = " ";
      out[i + 1] = " ";
      stack.push(0);
      mode = "code";
      i += 2;
      continue;
    }
    out[i] = c === "\n" ? "\n" : " ";
    i += 1;
  }
  return out.join("");
}

const OPEN = "({[";
const CLOSE = ")}]";

function enclosingOpen(masked: string, index: number): number {
  let depth = 0;
  for (let s = index - 1; s >= 0; s -= 1) {
    const c = masked[s];
    if (CLOSE.includes(c)) depth += 1;
    else if (OPEN.includes(c)) {
      if (depth === 0) return s;
      depth -= 1;
    }
  }
  return -1;
}

function matchingClose(masked: string, open: number): number {
  let depth = 0;
  for (let e = open; e < masked.length; e += 1) {
    const c = masked[e];
    if (OPEN.includes(c)) depth += 1;
    else if (CLOSE.includes(c)) {
      depth -= 1;
      if (depth === 0) return e;
    }
  }
  return -1;
}

type ObjectProp = { key: string; terminator: string; value: string };

/** The direct-child properties of the object literal spanning [open, close]. */
function objectProps(code: string, masked: string, open: number, close: number): ObjectProp[] {
  const props: ObjectProp[] = [];
  let depth = 0;
  let start = open + 1;
  const push = (end: number, terminator: string) => {
    const segMasked = masked.slice(start, end);
    const seg = code.slice(start, end);
    const keyMatch = /^\s*([A-Za-z_$][\w$]*)\s*(\??:)?/.exec(segMasked);
    if (keyMatch && !segMasked.trimStart().startsWith("...")) {
      if (keyMatch[2]) props.push({ key: keyMatch[1], terminator, value: seg.slice(keyMatch[0].length).trim() });
      else if (/^\s*[A-Za-z_$][\w$]*\s*$/.test(segMasked)) props.push({ key: keyMatch[1], terminator, value: keyMatch[1] });
    }
    start = end + 1;
  };
  for (let i = open + 1; i < close; i += 1) {
    const c = masked[i];
    if (OPEN.includes(c)) depth += 1;
    else if (CLOSE.includes(c)) depth -= 1;
    else if (depth === 0 && (c === "," || c === ";")) push(i, c);
  }
  push(close, "}");
  return props;
}

// ── Resolving an expression to the strings it can be ──────────────────────────────────────────

type ConstIndex = Map<string, { file: string; expr: string }>;

function constDeclarations(code: string, masked: string, exportedOnly: boolean): Array<{ name: string; expr: string }> {
  const out: Array<{ name: string; expr: string }> = [];
  // Module-level declarations only (they start a line): a `const` inside a function is scoped to
  // it, and reading the first one of that name anywhere in the file would resolve a value from
  // somewhere else entirely.
  const re = exportedOnly
    ? /^export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/gm
    : /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=(?!=|>)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const start = m.index + m[0].length;
    let depth = 0;
    let end = start;
    for (; end < masked.length; end += 1) {
      const c = masked[end];
      if (OPEN.includes(c)) depth += 1;
      else if (CLOSE.includes(c)) {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && (c === ";" || c === "\n")) {
        // A line ending in an operator continues the expression.
        const before = masked.slice(start, end).trimEnd();
        if (c === "\n" && (before.length === 0 || /[?:=|&+(,]$/.test(before))) continue;
        if (c === "\n" && /^\s*[?:|&.]/.test(masked.slice(end + 1, end + 40))) continue;
        break;
      }
    }
    out.push({ name: m[1], expr: code.slice(start, end).trim() });
  }
  return out;
}

function topLevelIndex(masked: string, predicate: (c: string, i: number) => boolean): number {
  let depth = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const c = masked[i];
    if (OPEN.includes(c)) depth += 1;
    else if (CLOSE.includes(c)) depth -= 1;
    else if (depth === 0 && predicate(c, i)) return i;
  }
  return -1;
}

function isTernaryQuestion(masked: string, i: number) {
  return masked[i] === "?" && masked[i + 1] !== "?" && masked[i + 1] !== "." && masked[i - 1] !== "?";
}

function cleanExpr(rawExpr: string): string {
  let expr = rawExpr.trim().replace(/\s+as\s+const\s*$/, "").replace(/\s+satisfies\s+[\s\S]+$/, "").trim();
  while (expr.startsWith("(") && matchingClose(maskLiterals(expr), 0) === expr.length - 1) expr = expr.slice(1, -1).trim();
  return expr;
}

/** `cond ? yes : no` at the top level of the expression, or null. */
export function ternaryParts(rawExpr: string): { cond: string; no: string; yes: string } | null {
  const expr = cleanExpr(rawExpr);
  const masked = maskLiterals(expr);
  const q = topLevelIndex(masked, (_c, i) => isTernaryQuestion(masked, i));
  if (q === -1) return null;
  let nested = 0;
  let d = 0;
  for (let i = q + 1; i < masked.length; i += 1) {
    const c = masked[i];
    if (OPEN.includes(c)) d += 1;
    else if (CLOSE.includes(c)) d -= 1;
    else if (d === 0 && isTernaryQuestion(masked, i)) nested += 1;
    else if (d === 0 && c === ":") {
      if (nested === 0) return { cond: expr.slice(0, q).replace(/\s+/g, " ").trim(), no: expr.slice(i + 1), yes: expr.slice(q + 1, i) };
      nested -= 1;
    }
  }
  return null;
}

function unionOf(parts: ResolvedValue[], text: string): ResolvedValue {
  const unresolved = parts.find((part) => part.kind === "unresolved");
  if (unresolved) return { kind: "unresolved", text };
  const pattern = parts.find((part) => part.kind === "pattern");
  if (pattern) return pattern;
  return { kind: "values", values: Array.from(new Set(parts.flatMap((part) => (part.kind === "values" ? part.values : [])))) };
}

export class ExpressionResolver {
  private readonly exported: ConstIndex = new Map();
  private readonly local = new Map<string, Map<string, string>>();
  private readonly sources: Map<string, { code: string; masked: string }>;

  constructor(sources: Map<string, { code: string; masked: string }>) {
    this.sources = sources;
    for (const [file, { code, masked }] of sources) {
      for (const decl of constDeclarations(code, masked, true)) this.exported.set(decl.name, { file, expr: decl.expr });
    }
  }

  private localConsts(file: string) {
    let map = this.local.get(file);
    if (!map) {
      map = new Map();
      const source = this.sources.get(file);
      if (source) for (const decl of constDeclarations(source.code, source.masked, false)) if (!map.has(decl.name)) map.set(decl.name, decl.expr);
      this.local.set(file, map);
    }
    return map;
  }

  private lookup(file: string, name: string): { expr: string; file: string } | null {
    const local = this.localConsts(file).get(name);
    if (local !== undefined) return { expr: local, file };
    return this.exported.get(name) ?? null;
  }

  resolve(rawExpr: string, file: string, depth = 0): ResolvedValue {
    const expr = cleanExpr(rawExpr);
    if (depth > 8) return { kind: "unresolved", text: expr };
    const masked = maskLiterals(expr);

    const ternary = ternaryParts(expr);
    if (ternary) {
      return unionOf([this.resolve(ternary.yes, file, depth + 1), this.resolve(ternary.no, file, depth + 1)], expr);
    }

    const str = /^(["'])((?:\\.|(?!\1).)*)\1$/.exec(expr);
    if (str) return { kind: "values", values: [str[2]] };

    if (expr.startsWith("`") && expr.endsWith("`") && masked.lastIndexOf("`", masked.length - 2) === 0) {
      const body = expr.slice(1, -1);
      if (!body.includes("${")) return { kind: "values", values: [body] };
      const pieces: string[] = [];
      let i = 0;
      let text = "";
      while (i < body.length) {
        if (body[i] === "$" && body[i + 1] === "{") {
          pieces.push(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
          text = "";
          const close = matchingClose(maskLiterals(body.slice(i + 1)), 0);
          i = i + 1 + (close === -1 ? body.length : close) + 1;
          pieces.push(".+");
          continue;
        }
        text += body[i];
        i += 1;
      }
      pieces.push(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      return { kind: "pattern", regex: new RegExp(`^${pieces.join("")}$`), text: expr };
    }

    const ident = /^[A-Za-z_$][\w$]*$/.exec(expr);
    if (ident) {
      const found = this.lookup(file, expr);
      if (!found) return { kind: "unresolved", text: expr };
      const value = this.resolve(found.expr, found.file, depth + 1);
      return value.kind === "unresolved" ? { kind: "unresolved", text: expr } : value;
    }

    // NAME[...] and NAME[...].prop over a constant object map.
    const member = /^([A-Za-z_$][\w$]*)\[[\s\S]*\](?:\.([A-Za-z_$][\w$]*))?$/.exec(expr);
    if (member && matchingClose(masked, member[1].length) === (member[2] ? expr.lastIndexOf(".") - 1 : expr.length - 1)) {
      const found = this.lookup(file, member[1]);
      if (found && found.expr.trim().startsWith("{")) {
        const objCode = found.expr.trim();
        const objMasked = maskLiterals(objCode);
        const close = matchingClose(objMasked, 0);
        const values = objectProps(objCode, objMasked, 0, close).map((prop) => {
          if (!member[2]) return this.resolve(prop.value, found.file, depth + 1);
          const inner = prop.value.trim();
          const innerMasked = maskLiterals(inner);
          if (!inner.startsWith("{")) return { kind: "unresolved", text: inner } as ResolvedValue;
          const field = objectProps(inner, innerMasked, 0, matchingClose(innerMasked, 0)).find((p) => p.key === member[2]);
          return field ? this.resolve(field.value, found.file, depth + 1) : ({ kind: "unresolved", text: inner } as ResolvedValue);
        });
        if (values.length > 0) return unionOf(values, expr);
      }
    }

    return { kind: "unresolved", text: expr };
  }
}

// ── Finding the sends ─────────────────────────────────────────────────────────────────────────

function lineOf(code: string, index: number) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (code[i] === "\n") line += 1;
  return line;
}

const TYPE_WORDS = /^(string|number|boolean|null|undefined|unknown|never)(\s*\|\s*(string|number|boolean|null|undefined))*$/;

function isTypeOrPattern(masked: string, open: number, close: number) {
  const before = masked.slice(Math.max(0, open - 40), open).trimEnd();
  const after = masked.slice(close + 1, close + 20).trimStart();
  // `const { module, eventType } = x`, `function f({ module, eventType }: X)`, `type X = { … }`, `x: { … }`.
  if (/\b(const|let|var)$/.test(before)) return true;
  if (/^(=(?!=|>)|:)/.test(after) && /[(,]$/.test(before)) return true;
  if (/^=(?!=|>)/.test(after)) return true;
  if (/\btype\s+[\w$]+(<[^>]*>)?\s*=$/.test(before) || /\binterface\s+[\w$]+[^{]*$/.test(before)) return true;
  // An object that is the value of a log call's labels/extra is a description of a send, not one.
  if (/\b(labels|extra|tags)\s*:$/.test(before)) return true;
  return false;
}

export function scanNotificationSendSites(root = process.cwd()): {
  resolver: ExpressionResolver;
  sites: NotificationSendSite[];
} {
  const files = listSourceFiles(root);
  const sources = new Map<string, { code: string; masked: string }>();
  for (const file of files) {
    const code = stripComments(readFileSync(path.join(root, file), "utf8"));
    sources.set(file, { code, masked: maskLiterals(code) });
  }
  const resolver = new ExpressionResolver(sources);
  const sites: NotificationSendSite[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (ENGINE_FILES.has(file)) continue;
    const { code, masked } = sources.get(file)!;
    const fileWide = FILE_WIDE.find((rule) => rule.file === file);

    // Shapes 1 and 3: object literals carrying `eventType`.
    const keyRe = /(?<![\w$.])eventType\s*(?=[:,}\n])/g;
    let m: RegExpExecArray | null;
    while ((m = keyRe.exec(masked))) {
      const open = enclosingOpen(masked, m.index);
      if (open === -1 || masked[open] !== "{") continue;
      const close = matchingClose(masked, open);
      if (close === -1 || seen.has(`${file}:${open}`)) continue;
      if (isTypeOrPattern(masked, open, close)) continue;
      const props = objectProps(code, masked, open, close);
      const eventProp = props.find((prop) => prop.key === "eventType");
      if (!eventProp || eventProp.terminator === ";" || TYPE_WORDS.test(eventProp.value)) continue;
      const moduleProp = props.find((prop) => prop.key === "module");
      if (moduleProp && (moduleProp.terminator === ";" || TYPE_WORDS.test(moduleProp.value))) continue;
      if (!moduleProp && !fileWide) continue;
      seen.add(`${file}:${open}`);
      const line = lineOf(code, open);
      if (!moduleProp) {
        sites.push({ eventType: resolver.resolve(eventProp.value, file), file, line, module: { kind: "values", values: [fileWide!.module] }, shape: "file-wide" });
        continue;
      }
      // `module: purpose === "setup" ? A : B, eventType: purpose === "setup" ? X : Y` pairs A with X
      // and B with Y — never the cross product, which would invent two types nobody sends.
      const pairs: Array<[string, string]> = [[moduleProp.value, eventProp.value]];
      for (let i = 0; i < pairs.length; i += 1) {
        const [m1, e1] = pairs[i];
        const mt = ternaryParts(m1);
        const et = ternaryParts(e1);
        if (mt && et && mt.cond === et.cond) {
          pairs.splice(i, 1, [mt.yes, et.yes], [mt.no, et.no]);
          i -= 1;
        }
      }
      const direct = /(?<![\w$.])origin\s*:\s*$/.test(masked.slice(Math.max(0, open - 30), open));
      for (const [moduleExpr, eventExpr] of pairs) {
        sites.push({ eventType: resolver.resolve(eventExpr, file), file, line, module: resolver.resolve(moduleExpr, file), shape: direct ? "direct-email" : "object" });
      }
    }

    // Shape 2: a module's own wrapper.
    for (const rule of WRAPPERS.filter((w) => w.file === file)) {
      const callRe = new RegExp(`(?<![\\w$.])${rule.callee}\\(`, "g");
      let call: RegExpExecArray | null;
      while ((call = callRe.exec(masked))) {
        const paren = call.index + call[0].length - 1;
        const before = masked.slice(Math.max(0, call.index - 20), call.index);
        if (/function\s*$/.test(before)) continue;
        // The first argument that is an object literal.
        const parenClose = matchingClose(masked, paren);
        let open = -1;
        let depth = 0;
        for (let i = paren + 1; i < parenClose; i += 1) {
          const c = masked[i];
          if (c === "{" && depth === 0) {
            open = i;
            break;
          }
          if (OPEN.includes(c)) depth += 1;
          else if (CLOSE.includes(c)) depth -= 1;
        }
        if (open === -1) continue;
        const close = matchingClose(masked, open);
        const props = objectProps(code, masked, open, close);
        if (props.some((prop) => prop.key === "module")) continue; // already read as shape 1
        const prop = props.find((p) => p.key === rule.field);
        sites.push({
          eventType: prop ? resolver.resolve(prop.value, file) : { kind: "unresolved", text: `(no ${rule.field})` },
          file,
          line: lineOf(code, open),
          module: { kind: "values", values: [rule.module] },
          shape: "wrapper",
        });
      }
    }
  }
  return { resolver, sites };
}

/** The raw senders that carry NO event type: each file calling one must say what it sends. */
export const UNKEYED_SEND_CALLEES = [
  "enqueueInAppNotification",
  "safeSendNotificationEmail",
  "sendNotificationEmail",
  "sendTelegramNotification",
  "sendPushNotification",
  "sendPhoenixEmail",
  "sendTemplatedEmail",
] as const;

export function scanUnkeyedSendFiles(root = process.cwd()): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of listSourceFiles(root)) {
    if (ENGINE_FILES.has(file)) continue;
    const code = stripComments(readFileSync(path.join(root, file), "utf8"));
    const masked = maskLiterals(code);
    for (const callee of UNKEYED_SEND_CALLEES) {
      const re = new RegExp(`(?<![\\w$.])${callee}\\(`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(masked))) {
        const before = masked.slice(Math.max(0, m.index - 30), m.index);
        if (/function\s*$/.test(before)) continue;
        // A sendPhoenixEmail that names its `origin` module and event is a typed send, read above.
        if (callee === "sendPhoenixEmail" || callee === "sendTemplatedEmail") {
          const close = matchingClose(masked, m.index + callee.length);
          if (/(?<![\w$.])origin\s*:/.test(masked.slice(m.index, close))) {
            const args = masked.slice(m.index, close);
            if (/(?<![\w$.])eventType\s*:/.test(args)) continue;
          }
        }
        const list = out.get(file) ?? [];
        if (!list.includes(callee)) list.push(callee);
        out.set(file, list);
      }
    }
  }
  return out;
}
