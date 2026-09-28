import assert from "node:assert/strict";

import JSZip from "jszip";

import { packDocumentHtml } from "@/lib/business-review/pack/pdf";
import { renderPackPptx } from "@/lib/business-review/pack/pptx";
import type { SalesReviewPack } from "@/lib/business-review/pack/model";

/**
 * The leaver mark is RED WHEREVER IT APPEARS — owner, 2026-09-28 ("make the left red colored").
 *
 * 🔴 WHY THIS SUITE EXISTS, MEASURED. The first cut coloured the mark in a table CELL and nowhere
 * else, which looked complete on every screen used to check it. Reading the eleven packs that
 * shipped that day back out of the emitted PDFs — every page, counting red pixels — found
 * **43 of 138 marks printed in plain ink, in 10 of the 11 packs** (the eleventh has no leavers at
 * all): every one of them sat on a chart's own label column, on a section heading or in the cover's
 * contents list, where the name travels as a LABEL rather than as a cell. The CNS pack alone
 * carried three, on the rep chart, directly above the same three names set in red in the table
 * underneath.
 *
 * So the pin is not "the cell is red". It is: **take the whole emitted document, find every
 * "(left …)" in it, and prove each one is inside a red run.** A renderer that grows a new place to
 * print a name — another chart, another heading, a summary strip — fails this the moment it forgets
 * the mark, which is exactly how the first three got through.
 *
 * The XLSX is deliberately NOT swept here: its section band is white on solid navy, where this red
 * is all but unreadable, and `workbook.ts` records that choice at the line that makes it. Its
 * cells are pinned in `business-review-pack-model.test.ts`.
 */

const DANGER_HEX = "#B91C1C";
const DANGER_ARGB = "B91C1C";
const MARK = /\(left[^)]*\)/g;

/**
 * 🔴 NO `as SalesReviewPack` HERE, deliberately. The local runner strips types, so a fixture that
 * does not match the model still runs green on this machine and fails only in CI's typecheck —
 * which is exactly what a cast on the first cut of this file bought (a chart with no `kind`, and a
 * metric id that does not exist). Letting the return type check the object catches it while editing.
 */
function pack(): SalesReviewPack {
  return {
    coverageNote: "Every figure covers Jul - Aug 2026.",
    generatedAt: "2026-09-26T19:20:00.000Z",
    sections: [
      {
        align: ["left", "right"],
        // A chart whose bars are PEOPLE — the case that was missed. Two of the three have gone.
        chart: {
          kind: "bars",
          items: [
            { label: "Gehad Khalifa (left 31 Aug 2026)", value: 720 },
            { label: "Yomna Salah Abdelrazik Algafar Mahmoud (left 15 Sept 2026)", value: 673 },
            { label: "A Serving Rep", value: 640 },
          ],
          unit: "count",
          countSuffix: "visits",
        },
        columns: ["Rep", "Visits"],
        metric: "rep-rows",
        note: "Visits counted from the CRM feed.",
        rows: [
          ["Gehad Khalifa (left 31 Aug 2026)", 720],
          ["Yomna Salah Abdelrazik Algafar Mahmoud (left 15 Sept 2026)", 673],
          ["A Serving Rep", 640],
        ],
        // A TITLE that names a person — the cover's contents list prints it a second time.
        title: "What the list is made of — Engy Said Mohamed Elsayed (left 26 Aug 2026)",
      },
    ],
    subject: { level: "line", line: "cns", title: "CNS line", windowLabel: "Jul - Aug 2026" },
  };
}

/**
 * Every "(left …)" in the string, with the markup that precedes it.
 *
 * 300 characters, because a PowerPoint run puts its colour at the FRONT of the run properties and
 * the typeface declarations between that and the text — about 100 characters of lead-in before the
 * mark itself. A 90-character window failed the deck while the file was correct.
 */
function marksWithLeadIn(text: string): { at: number; before: string; mark: string }[] {
  const out: { at: number; before: string; mark: string }[] = [];
  for (const m of text.matchAll(MARK)) {
    const at = m.index ?? 0;
    out.push({ at, before: text.slice(Math.max(0, at - 300), at), mark: m[0] });
  }
  return out;
}

export async function runBusinessReviewPackLeaverMarkTests() {
  const subject = pack();

  // ------------------------------------------------------------------ 1. the PDF: every mark is red
  {
    const html = packDocumentHtml(subject);
    const found = marksWithLeadIn(html);
    assert.ok(found.length >= 5, `the fixture should print several marks; found ${found.length}`);

    for (const { before, mark } of found) {
      const red =
        // a table cell, a section heading or the cover's contents entry
        /<span class="left">\s*$/.test(before) ||
        // a chart's own label column, inside the SVG
        new RegExp(`<tspan fill="${DANGER_HEX}"[^>]*>\\s*$`).test(before);
      assert.ok(
        red,
        `a leaver mark prints in plain ink in the PDF: ${JSON.stringify(mark)} — preceded by ${JSON.stringify(before.slice(-60))}`,
      );
    }

    // and the three places by name, so a future edit cannot satisfy the sweep by deleting the mark
    assert.match(html, /<h2 class="sectitle">[^<]*<span class="left">/, "the section heading lost its mark");
    assert.match(html, /class="index__t">[^<]*<span class="left">/, "the cover contents list lost its mark");
    assert.match(
      html,
      new RegExp(`<text[^>]*text-anchor="end"[^>]*>[^<]*<tspan fill="${DANGER_HEX}"`),
      "the chart's label column lost its mark",
    );
    assert.ok(html.includes(`--danger:${DANGER_HEX}`), "the danger token is not declared");
  }

  // ------------------------------------------------------------------ 2. the deck: every mark is its own red run
  {
    const zip = await JSZip.loadAsync(await renderPackPptx(subject));
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    assert.ok(slides.length >= 3, `expected a cover, a chart slide and a table slide; got ${slides.length}`);

    let seen = 0;
    for (const name of slides) {
      const xml = await (zip.file(name) as JSZip.JSZipObject).async("string");
      for (const { before, mark } of marksWithLeadIn(xml)) {
        seen++;
        // The red must belong to THIS run: no `<a:r>` may open between the colour and the mark, or
        // a red run earlier in the same paragraph would vouch for a black one after it.
        assert.ok(
          new RegExp(`<a:srgbClr val="${DANGER_ARGB}"/>(?:(?!<a:r>)[\\s\\S])*$`).test(before),
          `a leaver mark is not in a red run in ${name}: ${JSON.stringify(mark)}`,
        );
      }
    }
    assert.ok(seen >= 5, `the deck should print several marks; found ${seen}`);
  }

  // ------------------------------------------------------------------ 3. the name keeps the document's own ink
  {
    const html = packDocumentHtml(subject);
    // The red is the MARK only. If a renderer ever wraps the whole label, the name goes red too —
    // which is the loud version the owner did not ask for.
    assert.ok(
      !/<span class="left">[^<]*Gehad Khalifa/.test(html),
      "the red span swallowed the name; only the (left …) mark is coloured",
    );
    assert.ok(
      !new RegExp(`<tspan fill="${DANGER_HEX}"[^>]*>[^<]*Gehad Khalifa`).test(html),
      "the chart's red tspan swallowed the name; only the (left …) mark is coloured",
    );
  }
}
