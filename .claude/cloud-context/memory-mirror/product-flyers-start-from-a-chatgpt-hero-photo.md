---
name: product-flyers-start-from-a-chatgpt-hero-photo
description: "Product flyers built only from HTML/CSS boxes scored 0-2/10; start from a ChatGPT hero photo with the real packs, then lay type over it."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 21f0c779-a0cb-4588-acf8-2bc3502486eb
  modified: 2026-11-18T21:41:55.699Z
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
- The "Advanced" badge in the stock Lacto Advanced logo file is too small and too faint at flyer size (rainbow letters on silver). On 18 Nov 2026, on v13, he asked: "make the advanced under lacto more bigger, more clearer". v14 enlarged the logo's own badge 1.6 times. While v14 was being packaged he went further: "you don't have to be stick to the advance as they are writing it. You can change it, but I want the advanced word to be obvious clear... there is a product called Lacto. This is a different product... Lacto Advanced must be perfectly obvious, clear."
- So on every Lacto Advanced piece the word "Advanced" may be redrawn, and it must be unmissable, because plain Lacto is a different product.
- 🔴 Do NOT replace the brand's badge with a flat teal band and white letters. v15 did that (my own pick from six treatments, never shown to him), and he answered: "no advanced now is very awful". Show the options, then build only the one he picks.
- What he picked (18 Nov 2026, option A of four shown on the real front): the brand's own pill redrawn about 1.7 times larger. White fill, silver border `#A9AEB0`, a magenta end `#E0278F` and a sky end `#5BC3E3`, and heavy Inter 800 letters in the brand's colour run with the yellows deepened: `#D91F86 #C41F3F #D4600F #C98700 #6E9F14 #2F9A3A #119276 #1386AD`. Built as SVG in the logo's pixel frame (`viewBox 0 0 1868 789`, `rotate(-9.93 1415 479)`, rect x 1330, y 476, 1330 x 290, rx 84, type 214 px) over `logo-nobadge.png`. On a 72 mm logo it is a 51 x 11 mm pill with 6.1 mm capitals. Source: `build_v16.py` and `make_logo_nobadge.py` in the flyer's `source` folder. The options he passed over: the same pill with teal letters, "Advanced" in the wordmark's own outlined lettering, and spaced capitals.
- 🔴 **Then he threw out all three.** At 22:53 Cairo on 18 Nov 2026, after v16 (the pill he had picked himself), he wrote: "return to yesterday version i donot like today". So v13 was restored as the final, with the stock logo file and its small badge left untouched. The rejected attempts were the 1.6× enlarged badge (v14), the teal band (v15) and the redrawn pill (v16).
- **How to apply:** on a Lacto Advanced piece, keep the stock logo file as it is. Do not enlarge or redraw the "Advanced" badge on my own. If he asks again, show the change on the whole page, both sides, before packaging anything.
- In his words, "yesterday" meant the night before (all of v1 to v13 were made between 23:45 and 01:34 Cairo), even though most of it was already the same calendar day. "Today" meant this evening's session.
- Which version he meant was not clear at first. After v13 was restored he wrote "no this is not yesterdays version". I sent a sheet of the last five versions, lettered A to E with their times, front above back. He picked D (v12, the recommended first option) in the multiple-choice question, then typed "e" and confirmed "Yes, put E back". So E (v13, 01:34) is the final again (23:09 Cairo, 18 Nov 2026), and the v12 copy is in `Downloads\Lacto-Advanced-A5-flyer-restored-v12-copy`.
- **How to apply:** when he disputes which version is meant, send one lettered sheet of the candidates with their times, and let him name a letter. My reading, not his words: he may accept the recommended first option without reading it, so a single letter he types afterwards is a correction. Confirm it with a two-option question before moving any folder.
- A clean wordmark without the badge is possible: the "o"'s hidden arc = its white body grown by the outline width (37 px), plus four shadow steps offset (6, 6) px in `#0E7E71 #55988C #87B2AA #B7CEC9`, plus a soft shadow (offset 30, blur 15, alpha 70).
- The old badge cannot simply be erased: it sits over part of the "o" outline, so whatever replaces it must start at or outside the badge's own edges (x 1334-1864, y 478-653 in that tilted frame). Check the render for leftover magenta, yellow or silver pixels.
- A word centred with `text-anchor: middle` is centred by its advance width, not its ink ("Advanced" stood 0.2 mm left); measure and nudge.
- When a cut-out is enlarged, the soft shadow of whatever it touched travels with it: the wordmark's faint shadow, enlarged with the badge, printed as a smear above it. Check the cut-out's surroundings with the near-whites stretched.
- Text set at the same `left` as a box does not start on the same line, because each letter has space on its left. Measure the first letter's ink on the render and move each text block onto the line (they were 0.08 to 0.36 mm off).
- **Self-score round (18 Nov 2026, ~23:15 Cairo).** He asked for an honest score per item. I gave E 7/10. He replied: "go and dont comeback until u are minimum 9.5 or more per item and overall". The result is v21, in `Downloads\Lacto-Advanced-A5-flyer-POLISHED`, beside the untouched FINAL. He had not given a verdict when this was written. What it changed:
  - "Lacto Advanced" is made obvious WITHOUT touching the logo: the product names are set in bold under each can, in the stage colours, on the back timeline and in the notice.
  - The front's facts carry only what both stages share. The back carries only what changes, and nothing is repeated.
  - Every figure is per 100 ml. E had mixed g/L, per 100 ml and per 100 g, so nucleotides read "4→8 mg" on one side and "0.54→1.08 mg" on the other.
  - The Sato Pharma mark moved to the empty top-right corner.
- **The stock badge's real fault, and the ChatGPT route (18 Nov 2026, ~23:40 Cairo).** He gave no verdict on v21. Instead he wrote: "i donot like the advanced word their is an issue in it give me chat gopt prompt to create enhanced version of advanced logo". The fault shows when the badge is straightened (undo `rotate(-9.93 1415 479)`, crop frame x 1334–1864, y 478–653, enlarge 3×):
  - The white centre is a slanted parallelogram, not the pill's own shape. That leaves a green wedge top right and a magenta wedge bottom left, so it reads as a misprint.
  - The "A"'s foot runs off the white onto the magenta end.
  - The centre fades to grey on the left, the yellow "a" is faint, and the letters are soft at flyer size.
  - **How to apply:** this time it was his own ask, so the badge may change. The route is the ChatGPT image (references in `Downloads\Lacto-Advanced-logo-reference.png` and `...-badge-closeup.png`). Fit the result onto `logo-nobadge.png` at the old tilt, and show it on the whole page, both sides, before packaging anything. Never redraw the badge myself again.
- **Print check that works on this laptop:** Windows ships `C:\Windows\System32\spool\drivers\color\RSWOP.icm`, an old US SWOP press profile. `print_check_v17.py` soft-proofs flat colours with it and reports the effective dpi of every picture.
  - Two colours were outside what a press can print: the stage-2 blue `#3848B8` (ΔE 7.3) and the pale aqua labels `#A8EBDD` (ΔE 6.2). They became `#334B9E` and `#A9D8CC`.
  - Dark teals and the ink colour read flatter through RSWOP. This is a press limit and cannot be confirmed without the printer's own profile.
  - Chrome writes the variable fonts as Type 3. fontTools is not installed, so static fonts cannot be made here.
- Balance a field by measuring the ink of its contents against its edges, and check the direction before nudging. I moved the wrong way twice.
- "Publish" for a flyer = a final folder in Downloads: print PDF with bleed, crop marks and trim/bleed boxes, a small screen PDF trimmed to A5, PNG previews and the source. This machine has no CMYK tool, so say the print file is RGB.

Related: [[the-next-step-box-must-not-manufacture-the-next-task]]
