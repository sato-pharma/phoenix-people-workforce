/**
 * Keeps a page alive when a browser translation has moved the nodes React is about to touch.
 *
 * Google Translate (and Chrome's built-in translate, which is the same engine) rewrites a page by
 * taking each text node OUT of the document and putting a `<font>` wrapper holding the translated
 * text in its place. React still holds the original node. The next time it removes that node, or
 * inserts a sibling before it, the browser refuses — the node's parent is no longer the parent
 * React names — and the throw unmounts the whole tree:
 *
 *   Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be
 *   inserted is not a child of this node.
 *
 * Measured on production over the 30 days to 2026-10-16: 88 rows of exactly that, almost all
 * stamped `domRewriter=google-translate,lang=ar`, and 50 of them on /login and /password-setup —
 * the screen an Arabic-reading employee sees before anything else, where a crash reads as "the
 * system does not work".
 *
 * The opt-out (`translate="no"`) is NOT the answer here and is not coming back: the owner removed
 * it on 2026-09-11 because it cost every Arabic-speaking reader the translate offer (app/layout.tsx
 * carries the account). This keeps the translation AND the page. It is the shape React's own
 * maintainers point people at for this exact error (facebook/react#11538), with one change: a node
 * that is still inside the parent, only wrapped, is handled where it really is rather than dropped.
 *
 * - removeChild of a node whose parent is no longer `this`: if it is still somewhere below `this`
 *   (wrapped in a `<font>`), it is removed from its real parent; if it already left the document,
 *   there is nothing to remove and the node is simply returned.
 * - insertBefore a reference node whose parent is no longer `this`: the new node goes before the
 *   child of `this` that now holds the reference (its wrapper); if the reference left the document,
 *   the new node is appended, so the content still appears rather than vanishing.
 *
 * Every redirected call is counted on `window`, and the Error Monitor's reporter appends
 * `domGuard=<n>` to any row filed from that page — so a crash that still happens after a guarded
 * call says so, and "the guard swallowed something" is never invisible. One `console.warn` per kind
 * per page, never an error: GlobalErrorReporter must not file the guard's own notice as a crash.
 *
 * This runs as an inline script BEFORE any bundle (app/layout.tsx), because React's first DOM
 * write must already see the patched prototype. Plain ES5, try/catch around everything, and a
 * no-op where `Node` does not exist: like the display-scale script beside it, it runs above every
 * error boundary React has, so its worst case must be "the browser behaves as it did before".
 */

/** Where the count of redirected calls lives on `window`. */
export const DOM_GUARD_COUNTER_KEY = "__phxDomGuard";

/** Set once the prototype is patched, so a second copy of the script is a no-op. */
const DOM_GUARD_INSTALLED_KEY = "__phxDomGuardInstalled";

export const DOM_TRANSLATE_GUARD_BOOT_SCRIPT = `(function(){try{var w=window;if(typeof Node!=="function"||!Node.prototype||w[${JSON.stringify(
  DOM_GUARD_INSTALLED_KEY,
)}])return;w[${JSON.stringify(DOM_GUARD_INSTALLED_KEY)}]=true;var p=Node.prototype,rc=p.removeChild,ib=p.insertBefore,warned={};function note(k){w[${JSON.stringify(
  DOM_GUARD_COUNTER_KEY,
)}]=(w[${JSON.stringify(DOM_GUARD_COUNTER_KEY)}]||0)+1;if(!warned[k]&&w.console&&w.console.warn){warned[k]=1;w.console.warn("Phoenix kept the page running: "+k+" named a node something outside the app (usually a browser translation) had already moved.");}}p.removeChild=function(c){if(c&&c.parentNode!==this){note("removeChild");if(c.parentNode&&this.contains(c))return rc.call(c.parentNode,c);return c;}return rc.apply(this,arguments);};p.insertBefore=function(n,r){if(r&&r.parentNode!==this){note("insertBefore");var a=r;while(a&&a.parentNode!==this)a=a.parentNode;return ib.call(this,n,a||null);}return ib.apply(this,arguments);};}catch(e){}})();`;

/**
 * The reporter's marker for a page where the guard redirected at least one call, or null.
 *
 * Absent on a clean page, so it costs nothing on the ordinary row — the same rule as the
 * `domRewriter=` probe it sits beside.
 */
export function domGuardMarker(count: unknown): string | null {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;
  return `domGuard=${Math.floor(count)}`;
}
