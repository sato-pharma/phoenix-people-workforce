// The paper editor's own stylesheet — what a hiring document looks like while it is being worked
// on, and never on paper.
//
// WHY THIS IS NOT IN `paper-editor.tsx`, WHERE IT LIVED UNTIL NOW. Squaring one corner in it meant
// proving the corner was square in the EMITTED stylesheet rather than in the file, and that was not
// possible from a `.tsx`: this repo's test runner is `node --experimental-strip-types`, which
// refuses one outright — `Unknown file extension ".tsx"` — so no test could ever hold this string
// as a value. The only check available was a grep of the component's source text, which is the
// check that has already shipped three defects here (a backslash that survived the file and died in
// the browser, a font stack fixed in one copy of two, a quoted family that closed a `style=""`).
// A `.ts` module makes the stylesheet importable, so an assertion can be made against the bytes the
// browser actually receives — the same arrangement `PRINT_BANNER_CSS` already has in
// `render-shared.ts`.
//
// NOTHING ABOUT THE STYLESHEET ITSELF MOVED. The component still injects it, once per document
// load, into the framed document's own head.

/**
 * What the page looks like while it is being worked on, and never on paper.
 *
 * Wrapped in `@media screen` throughout, so none of it can reach a printer. The document's own
 * stylesheet is untouched — this is appended to its head after load, which means an editing
 * affordance can never be the reason a printed page differs from the preview.
 */
export const EDITOR_CSS = `
@media screen {
  /* The document's own print banner. This panel has its own controls, and two Print buttons on one
     screen is how somebody prints from the wrong one. */
  .print-banner { display: none !important; }

  /* An added flow field is inert to the pointer by design (field-layout.ts's flowFieldLayer) so it
     never steals a click from the prose it sits on top of, on the printed page or the ordinary
     preview. Inside the editor that is exactly backwards — it is the one thing on a flow document
     that can be selected, edited or dragged — so this reopens it, at a specificity nothing else in
     this stylesheet or the document's own can out-rank. */
  .hp-added { pointer-events: auto !important; }

  [data-hp-live] {
    outline: 1px dashed rgba(37, 99, 235, 0.45);
    outline-offset: 2px;
    cursor: text;
    transition: background-color 120ms ease, outline-color 120ms ease;
  }
  [data-hp-live]:hover { background-color: rgba(37, 99, 235, 0.12); }
  [data-hp-live]:focus {
    outline: 2px solid #2563eb;
    background-color: rgba(37, 99, 235, 0.16);
  }
  [data-hp-selected] {
    outline: 2px solid #2563eb !important;
    background-color: rgba(37, 99, 235, 0.2) !important;
  }
  [data-hp-saving] {
    outline: 2px solid #f59e0b !important;
    background-color: rgba(245, 158, 11, 0.2) !important;
  }
  /* A RULE BEING TRIED, NOT ONE THAT IS SAVED. Green rather than the editor's blue, because blue
     already means "you can edit this" everywhere else on the page and a second blue would read as
     one more editable box. The dashed ring plus the tint says the words under it are not what the
     document would print if it were printed right now. */
  [data-hp-dry] {
    outline: 2px dashed #059669 !important;
    outline-offset: 2px;
    background-color: rgba(5, 150, 105, 0.14) !important;
  }
  /* A rule that resolves to nothing keeps its ring so the box does not simply vanish — an empty
     outline IS the warning, and a field that disappeared would read as the preview being broken. */
  [data-hp-dry][data-hp-dry-empty] {
    background-color: rgba(220, 38, 38, 0.12) !important;
    outline-color: #dc2626 !important;
  }

  /* A value the page prints but nothing can store — the company's own registry numbers, a figure
     derived from another one. Marked as locked rather than left looking ordinary, so it is obvious
     WHY it will not take a keystroke. */
  [data-hp-locked] { cursor: not-allowed; }
  [data-hp-locked]:hover { background-color: rgba(100, 116, 139, 0.16); }

  body.hp-free-edit [data-hp-locked] {
    outline: 1px dashed rgba(217, 119, 6, 0.6);
    outline-offset: 2px;
    cursor: text;
  }
  body.hp-free-edit { caret-color: #b45309; }
  body.hp-free-edit [data-hp-locked][contenteditable="false"] { cursor: not-allowed; }

  /* Layout mode replaces value-editing with position-editing: every dashed box becomes something to
     pick up rather than type into, and "add a field" turns the whole page into a drop target. */
  body.hp-layout-edit [data-hp-live] { cursor: move; }
  body.hp-layout-edit [data-hp-locked] { cursor: default; }
  /* A PLACED STAMP OR SIGNATURE IS LOCKED FOR TYPING AND FREE TO MOVE — the one combination the two
     rules above cannot produce between them. It carries data-hp-locked because there is no text in
     it to edit, so the line above would hand it the default cursor and it would read as something
     that cannot be picked up, when moving it is the entire point. The ring is what says it is yours
     to drag: every other field gets one from data-hp-live, and a mark is the only field on the page
     that would otherwise have no boundary drawn round it at all. */
  body.hp-layout-edit .mark {
    cursor: move;
    outline: 1px dashed rgba(37, 99, 235, 0.55);
    outline-offset: 2px;
  }
  body.hp-layout-edit.hp-adding-field,
  body.hp-layout-edit.hp-adding-field * { cursor: crosshair !important; }
  [data-hp-dragging] {
    z-index: 30;
    box-shadow: 0 0 0 2px #2563eb, 0 4px 10px rgba(37, 99, 235, 0.35);
    background-color: rgba(37, 99, 235, 0.14) !important;
  }
}
`;
