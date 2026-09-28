import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import JSZip from "jszip";

import { renderPackPptx } from "@/lib/business-review/pack/pptx";
import type { PackSection, SalesReviewPack } from "@/lib/business-review/pack/model";

import { stripComments } from "./support/comment-strip.ts";

/**
 * The Sales Review deck — the EMITTED FILE, not the source that wrote it.
 *
 * A .pptx is a zip of XML parts, and PowerPoint's failure mode is total: one malformed part, one
 * unescaped ampersand, one relationship pointing at nothing, and the whole presentation refuses to
 * open with a message that names none of it. There is no partial render to notice in review. So
 * this suite opens what the renderer produced and reads it back.
 *
 * 🔴 WHAT THIS SUITE CANNOT DO, AND WHAT WAS DONE INSTEAD. It cannot prove a real Office consumer
 * opens the file — CI has no PowerPoint and no LibreOffice. When this landed, the deck was
 * converted locally with headless LibreOffice (`soffice --convert-to pdf`, and again to `odp`),
 * which produced a 110 KB five-page PDF and an .odp whose `content.xml` carried every band title,
 * every honesty note, the capped-rows line and both XML-hostile names correctly re-escaped. That is
 * the proof the file OPENS. What is pinned below is everything about it that a later edit could
 * silently break.
 */

const PPTX = "src/lib/business-review/pack/pptx.ts";

function pack(overrides: Partial<SalesReviewPack> = {}): SalesReviewPack {
  return {
    coverageNote: "Every figure covers Jul - Aug 2026.",
    generatedAt: "2026-09-26T19:20:00.000Z",
    sections: [
      {
        align: ["left", "left", "right"],
        columns: ["Area", "District manager", "Achievement"],
        metric: "achievement",
        note: "Achievement is sales in targeted months over target.",
        // An ampersand, angle brackets and an apostrophe — the three characters that turn a deck
        // into "PowerPoint cannot open this file".
        rows: [["Tanta & Mahalla", "Sons & Co <Holdings>", "131.1%"], ["O'Brien Area", "A Manager", "92.0%"]],
        title: "Areas",
      },
    ],
    subject: { level: "district", line: "pedia", title: "A District", windowLabel: "Jul - Aug 2026" },
    ...overrides,
  } as SalesReviewPack;
}

const wideSection = (rows: number): PackSection => ({
  align: ["left", "right", "right"],
  columns: ["Brick", "Sales", "Share"],
  metric: "brick-spread",
  note: "Spread across many bricks.",
  rows: Array.from({ length: rows }, (_, i) => [`Brick ${i + 1}`, 1000 - i, `${i}%`]),
  title: "Bricks",
});

async function open(p: SalesReviewPack) {
  const buffer = await renderPackPptx(p);
  return { buffer, zip: await JSZip.loadAsync(buffer) };
}

const read = async (zip: JSZip, name: string) => {
  const file = zip.file(name);
  assert.ok(file, `the deck has no ${name}`);
  return await file.async("string");
};

export async function runBusinessReviewPackPptxTests() {
  // ------------------------------------------------------------------ 1. it is a real package
  {
    const { buffer, zip } = await open(pack());
    assert.equal(buffer.subarray(0, 2).toString("latin1"), "PK", "a .pptx is a zip; this is not one");

    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "ppt/presentation.xml",
      "ppt/_rels/presentation.xml.rels",
      "ppt/slideMasters/slideMaster1.xml",
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      "ppt/slideLayouts/slideLayout1.xml",
      "ppt/theme/theme1.xml",
      "ppt/tableStyles.xml",
    ]) {
      assert.ok(zip.file(part), `PowerPoint refuses a package without ${part}`);
    }

    // A cover, then one slide per section.
    assert.ok(zip.file("ppt/slides/slide1.xml"), "the cover slide is missing");
    assert.ok(zip.file("ppt/slides/slide2.xml"), "the section slide is missing");
    assert.equal(zip.file("ppt/slides/slide3.xml"), null, "one section must not produce two slides");
  }

  // ------------------------------------------------------------------ 2. every part is declared and every rel resolves
  {
    const { zip } = await open(pack({ sections: [pack().sections[0], wideSection(3)] }));
    const names = Object.keys(zip.files);
    const types = await read(zip, "[Content_Types].xml");

    for (const slide of names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
      assert.ok(
        types.includes(`/${slide}`),
        `${slide} is in the zip but not in [Content_Types].xml — PowerPoint ignores a part it has no type for`,
      );
    }

    for (const name of names.filter((n) => n.endsWith(".xml") && !n.endsWith(".rels"))) {
      const xml = await read(zip, name);
      const ids = [...xml.matchAll(/r:id="([^"]+)"/g)].map((m) => m[1]);
      if (ids.length === 0) continue;
      const relPath = name.replace(/([^/]+)$/, "_rels/$1.rels");
      const rels = await read(zip, relPath);
      for (const id of ids) {
        assert.ok(rels.includes(`Id="${id}"`), `${name} references ${id}, which ${relPath} does not define`);
      }
    }
  }

  // ------------------------------------------------------------------ 3. escaping — the whole-file failure
  {
    const { zip } = await open(pack());
    const slide = await read(zip, "ppt/slides/slide2.xml");

    assert.ok(slide.includes("Sons &amp; Co &lt;Holdings&gt;"), "an ampersand or angle bracket reached the XML raw");
    assert.ok(slide.includes("O&apos;Brien Area"), "an apostrophe reached the XML raw");
    assert.ok(
      !/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(slide),
      "a bare ampersand survived into a slide — PowerPoint refuses the ENTIRE presentation, naming nothing",
    );
  }

  // ------------------------------------------------------------------ 4. the cap is real AND it is admitted
  {
    const { zip } = await open(pack({ sections: [wideSection(31)] }));
    const slide = await read(zip, "ppt/slides/slide2.xml");
    const rows = (slide.match(/<a:tr /g) ?? []).length;

    assert.equal(rows, 13, "expected one header row plus the twelve-row cap");
    assert.match(
      slide,
      /19 more rows are in the Excel version/,
      "rows were dropped WITHOUT saying so — a reader then believes the district sells through twelve bricks when it sells through thirty-one",
    );

    // And a section inside the cap says nothing about a cut, because there was none.
    const { zip: small } = await open(pack({ sections: [wideSection(4)] }));
    const short = await read(small, "ppt/slides/slide2.xml");
    assert.ok(!short.includes("more rows are in the Excel version"), "a section that fits must not claim a cut");
  }

  // ------------------------------------------------------------------ 5. the honesty notes travel into the file
  {
    const note = "The percentage is the AREA's, shared by everyone standing in it.";
    const { zip } = await open(
      pack({
        sections: [{ ...pack().sections[0], metric: "rep-rows", note, title: "Rep by rep" }],
      }),
    );
    const slide = await read(zip, "ppt/slides/slide2.xml");
    assert.ok(slide.includes("<a:t>Rep by rep</a:t>"), "the slide has no heading");
    assert.ok(
      slide.includes("shared by everyone standing in it"),
      "the note did not travel — a deck is read in a room by people who cannot ask what a column means",
    );

    const cover = await read(zip, "ppt/slides/slide1.xml");
    assert.ok(cover.includes("Every figure covers"), "the coverage note must be on the cover");
    assert.ok(cover.includes("SATO-DIS-2026-01 v1.0"), "the house document standard must be on the cover");
    assert.ok(cover.includes("Review, not a payout record"), "the pack must never read as a payout record");
  }

  // ------------------------------------------------------------------ 6. AM · PM · Pharmacies keeps its dots
  {
    const split = "AM 78 · PM 414 · Pharmacies 55";
    const { zip } = await open(
      pack({ sections: [{ ...pack().sections[0], rows: [["A Rep", "An Area", split]] }] }),
    );
    const slide = await read(zip, "ppt/slides/slide2.xml");
    assert.ok(slide.includes(split), "the three figures must reach the deck apart, with middle dots");
    assert.ok(!/AM \d+ \/ PM/.test(slide), "the golden rule forbids joining the pair with a slash");
  }

  // ------------------------------------------------------------------ 7. the house identity, in the emitted file
  {
    const { zip } = await open(pack());
    const slide = await read(zip, "ppt/slides/slide2.xml");

    assert.ok(slide.includes('val="0A527D"'), "the band must be the house deep blue");
    assert.ok(slide.includes('val="0A6BA6"'), "the header row must be the house brand blue");
    assert.ok(slide.includes('val="F2F6FA"'), "the zebra row must be the house 6% tint");
    assert.ok(slide.includes("Calibri"), "a face nobody has is substituted on the projector it is shown on");

    // The square-edge golden rule reaches a generated document too.
    for (const name of Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
      const xml = await read(zip, name);
      assert.ok(!xml.includes("roundRect"), `${name}: a rounded corner reached the deck`);
    }
  }

  // ------------------------------------------------------------------ 8. every part is well-formed
  {
    const { zip } = await open(pack({ sections: [pack().sections[0], wideSection(31)] }));
    for (const name of Object.keys(zip.files).filter((n) => n.endsWith(".xml"))) {
      const xml = await read(zip, name);
      const stack: string[] = [];
      for (const m of xml.matchAll(/<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g)) {
        const [, closing, tag, , self] = m;
        if (closing) assert.equal(stack.pop(), tag, `${name}: </${tag}> closes the wrong element`);
        else if (!self) stack.push(tag);
      }
      assert.equal(stack.length, 0, `${name}: unclosed ${stack.join(" > ")}`);
    }
  }

  // ------------------------------------------------------------------ 9. an empty pack still opens
  {
    const { zip } = await open(pack({ sections: [] }));
    const slide = await read(zip, "ppt/slides/slide2.xml");
    assert.match(slide, /No metrics were chosen/, "an empty selection must produce a slide that explains itself");
  }

  // ------------------------------------------------------------------ 10. no new dependency crept in
  {
    const source = stripComments(readFileSync(PPTX, "utf8"));
    assert.ok(
      !/from "pptxgenjs"|require\("pptxgenjs"\)/.test(source),
      `${PPTX}: a PPTX library cannot be added from a worktree here — pnpm purges the node_modules ` +
        `junction and bash-guard C6 denies it, so the lockfile change cannot be produced or tested. ` +
        `This renders OOXML into jszip, which five runtime modules already use.`,
    );
    assert.ok(source.includes('from "jszip"'), `${PPTX}: the deck is written with the zip tool the repo already has.`);
  }

  // ------------------------------------------------------------------ 11. a charted section gets its own slide
  // 🔴 NOT a native PowerPoint chart. One of those carries its own embedded workbook — a SECOND copy
  // of the figures inside the file, free to drift from the table on the next slide. These are
  // rectangles sized from the model's own numbers, so a bar and its row can never disagree.
  {
    const charted = pack();
    charted.sections[0].chart = {
      capNote: "The 2 highest of 9 graded areas — this section's table holds every one.",
      items: [
        { label: "Tanta & Mahalla", note: "Sons & Co <Holdings>", value: 131.1 },
        { label: "O'Brien Area", note: null, value: 92 },
      ],
      kind: "bars",
      reference: { label: "90% earner", value: 90 },
      unit: "pct",
    };
    const { zip } = await open(charted);
    const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    assert.equal(names.length, 3, "cover, then the chart on its own slide, then the table it was read from");

    const chart = await read(zip, "ppt/slides/slide2.xml");
    assert.equal((chart.match(/name="Bar"/g) ?? []).length, 2, "one bar per plotted item");
    assert.equal((chart.match(/name="Track"/g) ?? []).length, 2, "each on its own track, so a short bar is still readable");
    assert.match(chart, /<a:t>131\.1%<\/a:t>/, "the bar carries the very figure the table prints");
    assert.match(chart, /<a:t>90% earner<\/a:t>/, "and the earner mark it is read against");
    assert.match(chart, /Tanta &amp; Mahalla/, "XML-hostile names are escaped on the chart slide too");
    assert.ok(!/<c:chart|chart\d+\.xml/.test(chart), "no embedded chart part — that would be a second copy of the figures");
    assert.ok(!/roundRect/.test(chart), "square corners, like everything else in the deck");

    // Every shape on the slide sits inside the slide. A bar or a name running off the edge is
    // invisible in review and obvious in the room.
    for (const m of chart.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g)) {
      const [x, y, cx, cy] = m.slice(1).map(Number);
      assert.ok(x >= 0 && y >= 0, `a shape starts off-slide at ${x},${y}`);
      assert.ok(x + cx <= 12192001 && y + cy <= 6858001, `a shape runs off-slide to ${x + cx},${y + cy}`);
    }

    // Shape ids must be unique within a slide or PowerPoint refuses the file outright.
    const ids = [...chart.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, "duplicate shape ids would stop the deck opening at all");

    // The sheet counter has to count the chart slides it just added.
    assert.match(chart, /Sheet 2 of 3/, "the chart slide numbers itself within the real total");
    assert.match(await read(zip, "ppt/slides/slide3.xml"), /Sheet 3 of 3/);
  }

  // ------------------------------------------------------------------ 12. a counted bar names its unit
  {
    const counted = pack();
    counted.sections[0].chart = {
      capNote: null,
      countSuffix: "EGP",
      items: [{ label: "DM One", note: null, value: 35946 }, { label: "DM Two", note: null, value: 238 }],
      kind: "bars",
      reference: null,
      unit: "count",
    };
    const chart = await read((await open(counted)).zip, "ppt/slides/slide2.xml");
    assert.match(chart, /<a:t>35,946 EGP<\/a:t>/, "a counted bar is grouped and carries its unit — never a bare percentage");
    assert.ok(!/<a:t>35946<\/a:t>/.test(chart), "and never an ungrouped figure");
  }
}
