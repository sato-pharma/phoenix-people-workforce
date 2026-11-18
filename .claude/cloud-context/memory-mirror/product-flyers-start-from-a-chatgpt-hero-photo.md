---
name: product-flyers-start-from-a-chatgpt-hero-photo
description: "Product flyers built only from HTML/CSS boxes scored 0-2/10; start from a ChatGPT hero photo with the real packs, then lay type over it."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 21f0c779-a0cb-4588-acf8-2bc3502486eb
  modified: 2026-11-17T23:32:53.825Z
---

On 17 Nov 2026 the Lacto Advanced A5 flyer went through three versions, all laid out in HTML/CSS with cut-out can photos, a baby photo and a teal field. The owner scored them 0/10, 2/10 and 0.5/10. His complaints, picked from a multiple-choice question: "looks cheap / like a webpage", "cans look pasted on", "two halves don't connect", and "back page is a boring table". He then picked "ChatGPT hero image" as the base for the next version.

**Why:** boxes, chips, thin rules and cut-outs with no real light read as a website, not a premium pharma print piece. A real photographic scene is what makes it look premium.

**How to apply:**
- For any product flyer or poster, ask for, or write, the ChatGPT hero-photo prompt first. That follows the global rule "a design needing a picture → hand him the exact ChatGPT prompt".
- Put the real pack cut-outs exactly over the generated packs, so the labels and logo stay true while the scene supplies the light and shadow.
- Only then lay the text over the photo.
- Never iterate on a fourth box layout on your own judgement.
- A data back page must be few words. On 18 Nov 2026, v7's back combined the photo, three big numbers, a seven-row table, a legend, a note and three references. He called it "poor crowded untidy".
- Cutting the table down was NOT enough: v8's back (the same two cans again, four stage-1-against-stage-2 rows, white ground) scored 1/10. He ticked all four faults: "Repeats the front's cans", "Rows look like a spreadsheet", "Too white and empty", "Feels like another flyer".
- What worked for the back (v9, which he then only asked to polish): a SECOND ChatGPT scene of the same baby (he sent a crawling-baby photo), the same eyebrow, logo and serif title as the front, then one flat teal field holding four tiles, each a gold line icon, a micro label, ONE big number and a two-line caption. The back must look like the front's other half, never a table.
- Never repeat the front's numbers or its packs on the back.
- Keep every gap even, including the gap above the foot.
- The company's own Sato Pharma logo file goes on both sides (he asked "sato logo" at v10), in its own colours, aligned by its ink.

**Print finishing that the final pass (v12) needed, so check these on the first build:**
- Look at every photo with its near-whites stretched (225-255 to 0-255) and at print-resolution crops. That showed what a 150 dpi proof hid: a pink band on the floor from a full-width fill, a grey slab under the cans, and a can edge and a knee washed out by an 80 px edge blend.
- Paint a removed object out with flat white, set the ground to pure 255 through a soft subject mask, and keep edge blends to a few pixels. Page background `#FFFFFF`, never 254.
- The pack's widest edge and the logo's ink sit on the text margin; small text ends at least 4 mm inside the trim.
- Two photos of the same subject are measured and matched (the back baby was 15% more saturated than the front one).
- Compare the baselines of sibling tiles at print resolution. A label holding a character from a fallback face (the prime in 2′-FL) made that tile's line taller and dropped its figure 0.3 mm below its neighbours; every micro label gets an explicit `line-height`.
- A facts row on white with hairlines was the last part of the front that still read as a webpage. In v13 (18 Nov 2026, after he clicked "Push it further" on v12) it moved onto the back's own foot: gold line, flat teal field, gold icons, white figures, deeper base for the notice. That was my choice; he had not rated v13 when this was written.
- "Publish" for a flyer = a final folder in Downloads: print PDF with bleed, crop marks and trim/bleed boxes, a small screen PDF trimmed to A5, PNG previews and the source. This machine has no CMYK tool, so say the print file is RGB.

Related: [[the-next-step-box-must-not-manufacture-the-next-task]]
