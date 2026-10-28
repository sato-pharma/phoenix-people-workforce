import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { anchorRootFor } from "../src/lib/hiring-pack/anchor-root.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// AN ANCHOR IS STORED RELATIVE TO ONE COPY, SO IT REACHES ALL OF THEM.
//
// The flow layer clones a field into EVERY element its stored selector matches inside the scope,
// and the scope is each `.copy` or, for a document with none, the whole body. So for those
// documents the stored path must be relative to ONE copy: a path rooted at the body begins with a
// step that names one of them, and `querySelectorAll` then finds exactly that one.
//
// Measured in Chromium against the English certificate of experience on 2026-09-29 — two
// `<article class="cert">`, no `.copy` anywhere. The certificate's own design (2026-10-28) keeps that
// shape — `<article class="cert xc">`, the signing block still the second `section` and its row still
// that section's first `div` — so the same two paths still answer 1 and 2:
//
//   article:nth-of-type(1) > section:nth-of-type(2) > div:nth-of-type(1) > span:nth-of-type(3)  -> 1 match
//   section:nth-of-type(2) > div:nth-of-type(1) > span:nth-of-type(3)                           -> 2 matches
//
// One match is a stamped copy for the employee and a blank one for the service file.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The smallest element stub `anchorRootFor` can read: a tag, a parent, children, and `.closest`. */
type Node = {
  tagName: string;
  className: string;
  children: Node[];
  parentElement: Node | null;
  closest: (selector: string) => Node | null;
};

function el(tagName: string, className = "", children: Node[] = []): Node {
  const node: Node = {
    tagName: tagName.toUpperCase(),
    className,
    children,
    parentElement: null,
    closest(selector: string) {
      const want = selector.replace(/^\./, "");
      let here: Node | null = this as Node;
      while (here) {
        if (here.className.split(/\s+/).includes(want)) return here;
        here = here.parentElement;
      }
      return null;
    },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

/**
 * The English certificate's shape: two sibling articles under the body, and no `.copy` anywhere. Its
 * children are the certificate design's (`experience-certificate-en.ts`): the premium masthead and its
 * band, the hero and the holder, the words, the signing block, and the page chrome last.
 */
function englishCertificate(): { body: Node; stampCells: Node[] } {
  const stampCells: Node[] = [];
  const copy = () => {
    const cell = el("span", "xc-cell", [el("em", "xc-lbl")]);
    stampCells.push(cell);
    return el("article", "cert xc", [
      el("header", "pm-mast", [el("img"), el("div", "pm-mast__mid")]),
      el("svg"),
      el("div", "xc-hero"),
      el("div", "xc-holder"),
      el("section", "cert__body xc-text", [el("p")]),
      el("section", "cert__sign xc-sign", [
        el("p", "pm-shead xc-micro"),
        el("p", "cert__signfor"),
        el("div", "cert__signrow xc-cells", [
          el("span", "xc-cell", [el("em", "xc-lbl")]),
          el("span", "xc-cell", [el("em", "xc-lbl")]),
          cell,
        ]),
      ]),
      el("div", "pm-chrome"),
    ]);
  };
  const body = el("body", "", [el("div", "print-banner"), copy(), copy()]);
  return { body, stampCells };
}

function testACopylessDocumentIsRootedAtItsOwnCopy() {
  const { body, stampCells } = englishCertificate();
  assert.equal(stampCells.length, 2, "the fixture has two copies, like the real paper");

  for (const [i, cell] of stampCells.entries()) {
    const root = anchorRootFor(cell as never, body as never);
    assert.equal(
      root.tagName,
      "ARTICLE",
      `copy ${i + 1}: rooted at its own article, never the body — a body-rooted path names one copy`,
    );
    assert.equal(root, body.children[i + 1], `copy ${i + 1}: and at the article it was clicked in`);
  }
}

/** A document that DOES wrap its copies keeps the behaviour it has always had. */
function testACopyWrapperStillWins() {
  const cell = el("td");
  const copyA = el("div", "copy", [el("table", "", [el("tbody", "", [el("tr", "", [cell])])])]);
  const copyB = el("div", "copy");
  const body = el("body", "", [copyA, copyB]);
  assert.equal(anchorRootFor(cell as never, body as never), copyA, "`.copy` is still the root");
}

/** One copy, nothing to be relative to — the body, exactly as before. */
function testASingleCopyDocumentStillRootsAtTheBody() {
  const cell = el("td");
  const only = el("article", "cert", [el("table", "", [el("tbody", "", [el("tr", "", [cell])])])]);
  const body = el("body", "", [el("div", "print-banner"), only]);
  assert.equal(
    anchorRootFor(cell as never, body as never),
    body,
    "nothing repeats, so rooting at the article would only lengthen the path",
  );
}

/**
 * The editor must actually USE it. Without this pin the module can sit there correct and unreferenced
 * while `paper-editor.tsx` goes on rooting at the body — which is the state this fix found.
 */
function testTheEditorRootsThroughIt() {
  const editor = readFileSync(
    new URL("../src/components/hiring-pack/paper-editor.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    editor.includes("anchorRootFor(target, doc.body)"),
    "the editor resolves its anchor root through anchor-root.ts",
  );
  assert.ok(
    !editor.includes('target.closest(".copy") ?? doc.body'),
    "and no longer roots at the body when a document has no .copy",
  );
}

export function runHiringPackAnchorRootTests() {
  testACopylessDocumentIsRootedAtItsOwnCopy();
  testACopyWrapperStillWins();
  testASingleCopyDocumentStillRootsAtTheBody();
  testTheEditorRootsThroughIt();
}
