// Which element a stored anchor selector is measured FROM.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS ITS OWN MODULE AND NOT A HELPER INSIDE THE EDITOR. It decides, for every field and
// every mark anybody ever drags onto a paper, whether that field reaches ONE copy of the document or
// all of them. That is worth a test, and a test cannot import `paper-editor.tsx` — it is a
// "use client" React component. Pure, DOM-typed, no React: it takes the element clicked and the
// document it lives in, and answers with the element the path should be rooted at.
//
// THE DEFECT IT CLOSES, measured on production data 2026-09-29. The flow layer resolves a stored
// selector with `scope.querySelectorAll(...)` and clones the field into EVERY match (field-layout.ts
// says why — it used to be a singular lookup, and that half-stamped a two-copy certificate). The
// scope is each `.copy`, or the body when a document has none. So a document with no `.copy`
// depends entirely on the stored path being relative to ONE copy: `querySelectorAll` then finds the
// same node inside each of them.
//
// The editor was rooting at `doc.body` in exactly that case, which produces a path whose first step
// is `article:nth-of-type(1)` — a step that names one copy. Measured in Chromium against the English
// certificate of experience, which renders TWO `<article class="cert">` and carries no `.copy`
// anywhere: the body-rooted path matched **1** of its 2 stamp cells, the copy-relative path matched
// **2**. So the resolver's every-match fix was only half the repair; a seal dragged on by hand would
// still have stamped the employee's copy and left the service file's blank.
//
// It is the same failure the owner's rule is about: a paper that looks stamped and a paper that is
// not, going out together, with nobody noticing until both are signed.

/** True when `body` holds more than one child of this element's tag — i.e. this looks like a copy. */
function isRepeatedUnderBody(node: Element, body: Element): boolean {
  let twins = 0;
  for (const child of Array.from(body.children)) {
    if (child.tagName === node.tagName) twins += 1;
    if (twins > 1) return true;
  }
  return false;
}

/**
 * The root a `cssPathWithin` path should be measured from, for an element the user just clicked.
 *
 * In order:
 *  1. Its own `.copy`, when the document wraps its copies in one. Most do, and nothing changes for
 *     them — a path inside a `.copy` already resolves to exactly one node per copy.
 *  2. The child of `<body>` it sits in, when `<body>` repeats that tag. That element IS a copy in
 *     all but name, so rooting there drops the `:nth-of-type` step that would have named one of
 *     them.
 *  3. `<body>`, unchanged, for a single-copy document where there is nothing to be relative to.
 *
 * Returning the target itself is possible (a direct child of a repeating body) and is the caller's
 * existing "click on some text or a cell" case — `cssPathWithin` answers null for it, which is the
 * right refusal: there is no path from a node to itself, and a field anchored to a whole copy has
 * no cell to sit in.
 */
export function anchorRootFor(target: Element, body: Element): Element {
  const copy = typeof target.closest === "function" ? target.closest(".copy") : null;
  if (copy) return copy;

  // Walk up to the child of <body> that contains the target.
  let node: Element = target;
  while (node.parentElement && node.parentElement !== body) node = node.parentElement;
  if (node.parentElement !== body) return body; // detached, or the target IS the body

  return isRepeatedUnderBody(node, body) ? node : body;
}
