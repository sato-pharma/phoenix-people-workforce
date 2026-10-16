import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import {
  DOM_GUARD_COUNTER_KEY,
  DOM_TRANSLATE_GUARD_BOOT_SCRIPT,
  domGuardMarker,
} from "../src/lib/error-monitor/dom-translate-guard.ts";
import { reportClientError } from "../src/lib/error-monitor/report-client-error.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The Google Translate guard: a translated page must survive React touching a node the
 * translation already moved — "Failed to execute 'insertBefore' on 'Node'", 88 production rows in
 * the 30 days to 2026-10-16, mostly Arabic readers on /login and /password-setup.
 *
 * The boot script is a string that runs before any bundle, so it is tested the way a browser runs
 * it: evaluated in its own context against a small DOM whose removeChild and insertBefore refuse a
 * node that is not their child, exactly as the real ones do. Each scenario gets a fresh DOM class,
 * because the script patches the prototype it finds.
 */

type FakeNode = {
  name: string;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  removeChild(child: FakeNode | null): FakeNode;
  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode;
  contains(other: FakeNode | null): boolean;
};

type FakeNodeClass = { new (name: string): FakeNode; prototype: FakeNode };

/** A DOM class with the browser's refusals and none of its patience. */
function makeDom(): FakeNodeClass {
  // Raw tree edits the script cannot see or patch — the translation uses these, as Google's
  // script effectively does, without going through the prototype React calls.
  const detach = (node: FakeNode) => {
    const parent = node.parentNode;
    if (!parent) return;
    parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
    node.parentNode = null;
  };
  const insertAt = (parent: FakeNode, node: FakeNode, index: number) => {
    detach(node);
    parent.childNodes.splice(index, 0, node);
    node.parentNode = parent;
  };

  class Node {
    name: string;
    parentNode: FakeNode | null = null;
    childNodes: FakeNode[] = [];

    constructor(name: string) {
      this.name = name;
    }

    removeChild(child: FakeNode | null): FakeNode {
      if (!child || child.parentNode !== (this as unknown as FakeNode)) {
        throw new Error("NotFoundError: Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.");
      }
      detach(child);
      return child;
    }

    insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
      const self = this as unknown as FakeNode;
      if (ref && ref.parentNode !== self) {
        throw new Error("NotFoundError: Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.");
      }
      detach(node);
      insertAt(self, node, ref ? self.childNodes.indexOf(ref) : self.childNodes.length);
      return node;
    }

    contains(other: FakeNode | null): boolean {
      for (let n = other; n; n = n.parentNode) if (n === (this as unknown as FakeNode)) return true;
      return false;
    }

    static detach = detach;
    static insertAt = insertAt;
  }
  return Node as unknown as FakeNodeClass;
}

type Dom = FakeNodeClass & {
  detach(node: FakeNode): void;
  insertAt(parent: FakeNode, node: FakeNode, index: number): void;
};

/** What Google Translate does to one text node: out of the document, a `<font>` in its place. */
function translateReplacing(dom: Dom, text: FakeNode): FakeNode {
  const parent = text.parentNode!;
  const at = parent.childNodes.indexOf(text);
  const font = new dom(`font(${text.name})`);
  dom.insertAt(font, new dom(`ar(${text.name})`), 0);
  dom.detach(text);
  dom.insertAt(parent, font, at);
  return font;
}

/** The other shape: the original node kept, but wrapped, so its parent is the wrapper. */
function translateWrapping(dom: Dom, text: FakeNode): FakeNode {
  const parent = text.parentNode!;
  const at = parent.childNodes.indexOf(text);
  const font = new dom(`font(${text.name})`);
  dom.insertAt(parent, font, at);
  dom.insertAt(font, text, 0);
  return font;
}

type Sandbox = Record<string, unknown> & { warnings: string[] };

function install(dom: FakeNodeClass | undefined, times = 1): Sandbox {
  const warnings: string[] = [];
  // Only `warn` exists on this console: a guard that reached for console.error would throw here,
  // and GlobalErrorReporter would file its notice as a crash in a browser.
  const sandbox: Sandbox = { console: { warn: (...args: unknown[]) => warnings.push(args.join(" ")) }, warnings };
  sandbox.window = sandbox;
  if (dom) sandbox.Node = dom;
  vm.createContext(sandbox);
  for (let i = 0; i < times; i += 1) vm.runInContext(DOM_TRANSLATE_GUARD_BOOT_SCRIPT, sandbox);
  return sandbox;
}

const names = (node: FakeNode) => node.childNodes.map((c) => c.name);

export async function runDomTranslateGuardTests() {
  // ---------------------------------------------------------------- the fixture reproduces the crash

  // Without this, every assertion below could pass against a fake DOM too forgiving to ever throw.
  {
    const dom = makeDom() as Dom;
    const p = new dom("p");
    const text = new dom("text");
    p.insertBefore(text, null);
    translateReplacing(dom, text);
    assert.throws(() => p.removeChild(text), /not a child of this node/,
      "unguarded, removing a node the translation took out must throw — the production crash");
    assert.throws(() => p.insertBefore(new dom("span"), text), /insertBefore/,
      "unguarded, inserting before a translated node must throw the exact production message");
  }

  // ---------------------------------------------------------------- a node the translation removed

  {
    const dom = makeDom() as Dom;
    const sandbox = install(dom);
    const p = new dom("p");
    const text = new dom("text");
    p.insertBefore(text, null);
    const font = translateReplacing(dom, text);

    assert.equal(p.removeChild(text), text, "removeChild returns the node, as the real one does");
    assert.deepEqual(names(p), [font.name], "the translation's wrapper is left exactly where it was");
    assert.equal(sandbox[DOM_GUARD_COUNTER_KEY], 1, "each redirected call is counted on window");

    const span = new dom("span");
    assert.equal(p.insertBefore(span, text), span);
    assert.deepEqual(names(p), [font.name, "span"],
      "a reference that left the document puts the new node at the end — visible, not lost");
    assert.equal(sandbox[DOM_GUARD_COUNTER_KEY], 2);
  }

  // ---------------------------------------------------------------- a node the translation wrapped

  {
    const dom = makeDom() as Dom;
    const sandbox = install(dom);
    const p = new dom("p");
    const before = new dom("before");
    const text = new dom("text");
    p.insertBefore(before, null);
    p.insertBefore(text, null);
    const font = translateWrapping(dom, text);

    const span = new dom("span");
    p.insertBefore(span, text);
    assert.deepEqual(names(p), ["before", "span", font.name],
      "a wrapped reference puts the new node before its wrapper — where React meant it to go");

    p.removeChild(text);
    assert.equal(text.parentNode, null, "a wrapped node is removed from where it really is");
    assert.deepEqual(names(font), [], "and only from there");
    assert.deepEqual(names(p), ["before", "span", font.name], "the parent's own children are untouched");
    assert.equal(sandbox[DOM_GUARD_COUNTER_KEY], 2);
  }

  // ---------------------------------------------------------------- an untranslated page is untouched

  {
    const dom = makeDom() as Dom;
    const sandbox = install(dom);
    const p = new dom("p");
    const a = new dom("a");
    const b = new dom("b");
    p.insertBefore(b, null);
    p.insertBefore(a, b);
    assert.deepEqual(names(p), ["a", "b"], "an ordinary insertBefore still inserts before its reference");
    p.removeChild(a);
    assert.deepEqual(names(p), ["b"], "an ordinary removeChild still removes");
    assert.equal(sandbox[DOM_GUARD_COUNTER_KEY], undefined,
      "nothing is counted on a page no translation touched, so the marker stays off every ordinary row");
    assert.deepEqual(sandbox.warnings, []);
    assert.throws(() => p.removeChild(null), "a call that is wrong for another reason still fails as the browser would");
  }

  // ---------------------------------------------------------------- one quiet notice per kind

  {
    const dom = makeDom() as Dom;
    const sandbox = install(dom);
    const p = new dom("p");
    for (let i = 0; i < 3; i += 1) {
      const text = new dom(`t${i}`);
      p.insertBefore(text, null);
      translateReplacing(dom, text);
      p.removeChild(text);
      p.insertBefore(new dom(`s${i}`), text);
    }
    assert.equal(sandbox[DOM_GUARD_COUNTER_KEY], 6);
    assert.equal(sandbox.warnings.length, 2, "one console.warn per kind per page, not one per call");
    assert.ok(sandbox.warnings.some((w) => w.includes("removeChild")) && sandbox.warnings.some((w) => w.includes("insertBefore")));
  }

  // ---------------------------------------------------------------- safe to run twice, safe with no DOM

  {
    const dom = makeDom() as Dom;
    const sandbox = install(dom);
    const guardedRemove = dom.prototype.removeChild;
    const guardedInsert = dom.prototype.insertBefore;
    vm.runInContext(DOM_TRANSLATE_GUARD_BOOT_SCRIPT, sandbox);
    // Measured: a second wrapper would still count each redirect once, because the outer layer
    // returns before the inner is reached — so the count cannot see stacking. The function can.
    assert.equal(dom.prototype.removeChild, guardedRemove,
      "a second copy of the script must leave the guard as it found it, not wrap it in itself");
    assert.equal(dom.prototype.insertBefore, guardedInsert);
  }
  assert.doesNotThrow(() => install(undefined),
    "where Node does not exist the script must do nothing — it runs above every error boundary");

  // Plain ES5: it runs before any bundle, on every engine an employee might bring.
  assert.doesNotThrow(() => new vm.Script(DOM_TRANSLATE_GUARD_BOOT_SCRIPT));
  assert.ok(!/=>|\blet\b|\bconst\b|`/.test(DOM_TRANSLATE_GUARD_BOOT_SCRIPT),
    "the boot script must stay ES5 — no arrow functions, let, const or template strings");

  // ---------------------------------------------------------------- it runs before React

  const layout = stripComments(readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8"));
  const guardTag = layout.indexOf("<script dangerouslySetInnerHTML={{ __html: DOM_TRANSLATE_GUARD_BOOT_SCRIPT }} />");
  assert.ok(guardTag > 0, "app/layout.tsx must render the guard as an inline script");
  for (const later of ["<GlobalErrorReporter", "<ThemeProvider", "<ReportingErrorBoundary"]) {
    const at = layout.indexOf(later);
    assert.ok(at > guardTag, `the guard must render before ${later} — React's first DOM write has to see it`);
  }

  // ---------------------------------------------------------------- the Error Monitor says it fired

  assert.equal(domGuardMarker(undefined), null, "no guard activity, no marker");
  assert.equal(domGuardMarker(0), null);
  assert.equal(domGuardMarker(Number.NaN), null);
  assert.equal(domGuardMarker(-2), null);
  assert.equal(domGuardMarker("3"), null, "only the guard's own number counts");
  assert.equal(domGuardMarker(3), "domGuard=3");

  // Through the real reporter, with just enough browser to run it: the row a crash files from a
  // guarded page must carry the count.
  const keys = ["window", "document", "fetch"] as const;
  const saved = keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  const bodies: Array<{ clientContext: string | null }> = [];
  const fakeWindow: Record<string, unknown> = {
    addEventListener: () => {},
    location: { pathname: "/login" },
    [DOM_GUARD_COUNTER_KEY]: 4,
  };
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow, writable: true });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: {
        body: null,
        documentElement: { className: "translated-rtl", getAttributeNames: () => ["lang", "class"], lang: "ar" },
        getElementsByTagName: () => ({ length: 12 }),
        querySelector: () => null,
        readyState: "complete",
        visibilityState: "visible",
      },
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return Promise.resolve();
      },
    });

    reportClientError({ error: new Error("Failed to execute 'insertBefore' on 'Node'") });
    fakeWindow[DOM_GUARD_COUNTER_KEY] = undefined;
    reportClientError({ error: new Error("an ordinary error") });
  } finally {
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  }

  assert.equal(bodies.length, 2, "both reports must have been sent through the stubbed fetch");
  assert.match(bodies[0].clientContext ?? "", /(?:^| )domGuard=4(?: |$)/,
    "a row filed from a guarded page must say how many calls the guard redirected");
  assert.match(bodies[0].clientContext ?? "", /domRewriter=google-translate/,
    "and still name the translation beside it");
  assert.doesNotMatch(bodies[1].clientContext ?? "", /domGuard=/,
    "a page where the guard never fired carries no marker");
}
