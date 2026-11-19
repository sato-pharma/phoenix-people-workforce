---
name: product-flyers-start-from-a-chatgpt-hero-photo
description: "Product flyers built only from HTML/CSS boxes scored 0-2/10; start from a ChatGPT hero photo with the real packs, then lay type over it."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 21f0c779-a0cb-4588-acf8-2bc3502486eb
  modified: 2026-11-19T14:31:05.142Z
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
- **The ChatGPT badge failed (19 Nov 2026, ~00:05 Cairo).** He answered "awful logo he created". So I repaired the stock badge in place, with the letters left untouched, in `repair_badge3.py 18 <out> crescent`, and showed it on E, both sides, before building anything. The repair:
  - The pink and sky ends are crescents that follow the rounded rim, 18 px wide at mid height and 10 px clear of the A and the d. The centre is flat white.
  - The rim is one flat silver `#B5B6B7`. The darker line under part of its top was the old box's edge, so it went with the box.
  - The brand's letters were un-blended from the old grey ground; none of their solid pixels changed.
  - Traps I hit: a slanted cut leaves white corners; square caps read as thin strips; the 10 px rim eats a shift taken from the OUTER edge; a band taken as `inside × (1 − shifted inside)` leaves hairlines under the straight rim, so take the DIFFERENCE of smooth coverage; the outer edge pixel keeps the old darker rim unless it is re-coloured.
  - Output: `Downloads\Lacto-Advanced-logo-repaired-badge.png`, previews `...-badge-repair-preview.png` and `...-badge-repair-closeup.png`. His verdict was pending when this was written.
- **The second ChatGPT badge worked (19 Nov 2026, ~00:20 Cairo).** Offered "Repaired badge (Recommended)", "Keep the stock logo" and "Try ChatGPT again", he picked "Try ChatGPT again". He attached the clean straight reference (`Downloads\Lacto-Advanced-badge-reference-clean.png`) with a "copy it, do not reinterpret it" prompt.
  - ChatGPT came back spelled right: 8 letters, one flat colour per letter, flat pink and sky crescents, a 24 px grey rim on a 2000×667 picture.
  - **How to apply:** ChatGPT copies well from a clean, straightened picture of the real artwork, and invents badly from a description.
- **Fitting it** (`fit_chatgpt_badge.py`, then `preview_three_badges.py` on the final's own 200 dpi PNGs, no Chrome):
  - Scale it by LETTER height, so the ascender-to-baseline equals the stock badge's 81.7 px (s = 0.296).
  - The left end sits at frame u 1334, centred on v 565.5, tilted −9.93°.
  - The pill is longer (569×161 against 530×175), so the logo canvas grows to 1916 px. In the HTML the logo widths become 72×1916/1868 and 44×1916/1868 mm, so the wordmark keeps its printed size; only the badge's right end runs about 1 mm further right.
  - It hides none of the "o" that the stock badge showed.
- **Traps from the fit:**
  - `distance_transform_edt(~outside)` is 0 on EVERY surround pixel. Taking "≤ 3 px from the edge" from it gave the whole white surround about 1% grey, which printed as a faint tilted box round the pill (1 to 3 levels, invisible until the near-whites were stretched). Take the band from `edt(pill)` inside and `edt(outside)` outside, and count 250 to 255 as paper.
  - The wordmark's own soft shadow is warm grey (184,174,171). Its pinkish pixels are the brand's, not a leftover of the old magenta: the stock file has 14,851 of them away from the badge.
- Comparison sheet: `Downloads\Lacto-Advanced-three-badges-on-flyer.png` (A stock, B repaired, C ChatGPT, both sides). Logo: `Downloads\Lacto-Advanced-logo-chatgpt-badge.png`. His pick was pending when this was written.
- Before picking, at ~00:52 Cairo on 19 Nov 2026, he wrote: "make chatgpt create a full new lacto advanced logo but with displaced advanced and bigger and more clear".
  - So he got a ChatGPT prompt for the WHOLE logo. "Lacto" keeps its lettering. "Advanced" leaves the small pill under the "o" and gets its own line under "Lacto", in ChatGPT's own badge style, about half as tall as the L.
  - References attached: `Downloads\Lacto-Advanced-logo-reference.png` and `Downloads\Lacto-Advanced-badge-chatgpt.png`.
  - A taller logo means the flyer's logo slot must be re-laid on both sides when it arrives; show the whole page before packaging.
- **Print check that works on this laptop:** Windows ships `C:\Windows\System32\spool\drivers\color\RSWOP.icm`, an old US SWOP press profile. `print_check_v17.py` soft-proofs flat colours with it and reports the effective dpi of every picture.
  - Two colours were outside what a press can print: the stage-2 blue `#3848B8` (ΔE 7.3) and the pale aqua labels `#A8EBDD` (ΔE 6.2). They became `#334B9E` and `#A9D8CC`.
  - Dark teals and the ink colour read flatter through RSWOP. This is a press limit and cannot be confirmed without the printer's own profile.
  - Chrome writes the variable fonts as Type 3. fontTools is not installed, so static fonts cannot be made here.
- Balance a field by measuring the ink of its contents against its edges, and check the direction before nudging. I moved the wrong way twice.
- "Publish" for a flyer = a final folder in Downloads: print PDF with bleed, crop marks and trim/bleed boxes, a small screen PDF trimmed to A5, PNG previews and the source. This machine has no CMYK tool, so say the print file is RGB.
- **The landscape version (19 Nov 2026, request at ~11:05 Cairo).** He attached E's PRINT.pdf, ChatGPT's new full logo ("Lacto" over a big "Advanced" pill, with a yellow splash and a green swoosh) and a new baby photo (lying on a cream rug, peach wall). His six points: use E; use the new logo; A5 landscape; use the new baby; put the dosage on the back ("1 scoop in 30ml water"); restyle the Pedia app's "Why Lacto?" slide in the flyer's colours "as it is the back of the flyer".
  - Built from E's exact tokens, fonts, field, base and facts, turned on its side: 216×154 mm page, type 10 mm from the page edge. Front: the baby as a hard-edged photo panel on the right, mirrored so she looks toward the logo, with 28 px of reflected picture on top so the trim falls on her hair line. The cans (22.5 mm, E's finish and shadows) and their stage tags sit in the left column; the Sato mark is bottom left; the four facts are horizontal tiles in the teal field. Back: the crawling baby on white, and the dosage in its own column of the field behind a gold line ("1 scoop / in 30 ml of water / One level 4.5 g scoop · both stages").
  - Output: `Downloads\Lacto-Advanced-A5-landscape` (PRINT, SCREEN, two PNGs, source). The FINAL and POLISHED folders are untouched. His verdict was pending when this was written.
  - Pedia app: GitLab merge request !6 (`feat/why-lacto-flyer`, commit fce81f7) dresses only the `.sl.why.lac` slide as the flyer's back. It needs his merge.
  - 🔴 Trap: Chrome rounds a 216×154 mm page to 612×437.04 pt, and the art ends at 436.51 pt. That leaves a 0.19 mm white strip at the bottom, inside the bleed box (E's portrait has the same strip on its right edge). Clip the source at the art's real edge (436.5 pt) when packaging, then render the bleed box and read its edge rows.
  - 🔴 Trap: the Pedia app runs on an API 19 (Android 4.4) web view. Its CSS uses no grid, no flex gap and no custom properties, and every gradient also needs its `-webkit-` form. The app's Playfair draws old-style figures unless `font-feature-settings: "lnum" 1` is set.
- **Round 2 (19 Nov ~14:40 Cairo):** he sent `images/28.webp` (the same baby, already cut out: RGBA with clean straight alpha) and asked for a "from scratch premium polish sweep end to end godmode".
  - The front's photo panel became E's look: the baby cut out on pure white, mirrored toward the logo. She is 90 mm tall at 306 dpi, her body runs x 116.9–208.5 mm, and her forearms rest at y 103 on the cans' floor line. The cans moved 1.5 mm left so there is 8 mm of white between stage 2's can and her forearm. `prep_front28.py` draws her floor shadow from the lowest edge of each body column (contact 0.34, ambient 0.13), composes it on 255 white with wide margins, and fades the one hair wisp the picture's top edge clips.
  - 🔴 Trap: the flyer's Inter has no non-breaking hyphen (U+2011), so Chrome drew every "2′‑FL" hyphen in Segoe UI. Use a plain hyphen inside a `white-space:nowrap` span. To find any fallback, list the Segoe spans with pymupdf `rawdict`. The only Segoe glyph left on purpose is E's → arrow.
  - Pedia merge request !6 got commit 9f890c7: the gold "?" sits 1 px after the title (the shared Why-slide rule gave 4 px), and "2′-FL" uses a true prime. The app's Playfair-700.woff has U+2032 but not U+2011. fontTools isn't installed; read a WOFF's cmap by hand with `zlib` + `struct`.
  - Left open: the front (yellow bodysuit) and back (E's green bodysuit) are two different children. I handed him a ChatGPT prompt for the same baby crawling on white, with `Downloads\Lacto-Advanced-baby-reference.png` as the reference.
  - Superseded packages were moved aside, never deleted, to `lacto-flyer-ls\superseded-package-r1-panel` and `...-r2-segoe-hyphen` in the scratchpad.
- **Round 3 (19 Nov ~15:00 Cairo, in Arabic).** He asked for: the 3 ingredients as stacked points with a mark beside each; bigger cans and a slightly smaller baby; 2′-FL written as "0.02 g/100ml water"; the whole "Lacto Advanced" name bigger. The result, packaged from r6:
  - Front logo 51 mm (was 46).
  - Headline 20 pt (was 21).
  - Three points (2′-FL HMO, DHA and ARA, Nucleotides), each behind a flat teal disc with a white tick, then "In both stages, / from birth to 12 months."
  - Cans 26 mm wide (was 22.5), bottoms at 104. The baby is 84 mm tall (was 90) at 328 dpi.
  - The field moved to 120 mm and the base to 138.4 mm, to give the can lids air under the headline.
  - The measured gaps are even: logo to headline 4.15 mm, headline to points 3.6 mm, points to the stages line 3.4 mm. Stage 2's can to her forearm is 9 mm.
  - In r6 I left "water" off the 2′-FL tile, arguing from the label (20 mg per 100 ml of ready-to-feed formula). **He refused that** ("FOLLOW THIS FUCKEN DIRECTIOINS"). When he dictates wording, print it exactly as he wrote it and do not argue the claim.
- **Round 3b, r7 (19 Nov ~15:10 Cairo), done literally and made clearly visible.** This build is the one now in `Downloads\Lacto-Advanced-A5-landscape`; r6 was moved aside to `superseded-package-r6-subtle`.
  - Front logo 60 mm wide (it was 46 mm originally). The headline now stands to the RIGHT of the logo, centred on it (x 78 mm, 20 pt).
  - The points are 11 pt with 4.2 mm ticks.
  - The cans are 30 mm wide, bottoms at 105.
  - The baby is 76.4 mm tall at 361 dpi, her forearms at 105.5.
  - The 2′-FL tile reads "0.02 g /100 ml water" over "human-milk oligosaccharide".
  - Back logo 40 mm wide (it was 34); everything from the back's field down moved 1.5 mm lower.
  - Measured gaps: can 2 to the baby 7 mm; the logo pill to can 1's lid 4 mm.
- **Round 4, r8 (19 Nov ~15:35 Cairo).** His words: the cans bigger still, the baby may shrink a bit, and "THE BABY IN YELLOW RELAOCATE THEM TO REAch godmode premium poliush". He REFUSED it ("no i dont like"); it is kept aside as `superseded-package-r8-refused`, and r7 as `superseded-package-r7-baby-right`.
  - Why the layout had to change: under the 60 mm logo a can cannot be wider than about 33 mm, so the cans moved out from under it.
  - The cans are now on the RIGHT, 36.5 mm wide (they were 30), their right edge on the 206 mm margin, bottoms at 105.
  - The headline stands over the cans, on can 1's left edge, still 20 pt.
  - The baby is in the MIDDLE, 60 mm tall (she was 76.4), and no longer mirrored, so she turns toward the cans. `prep_front28.py` has `MIRROR = False`; the mirrored picture is kept as `z-baby-front-mirrored-r7.png`.
  - Measured gaps: her hair to the logo 6.7 mm; her hand to can 1 6.2 mm; the headline to the can lids 6.3 mm.
  - The back did not change.
  - Pedia merge request !6 was MERGED at his word at 14:59 Cairo (merge 5b19d83, carries 9f890c7 and the other session's palette-check fix 9a33f27). The branch is deleted; new Pedia work starts from main. Nothing has been deployed to the web or to Play.

- **Round 5, r9 (19 Nov ~16:40 Cairo) — built, never packaged.** After refusing r8 he added mid-turn: do not change where the baby looks, "same as original photo"; "change hmo to HMOs"; and polish the text style of the three points.
  - Layout that stayed: logo 60 mm at the left; the headline (20 pt) centred over the two cans; cans 37 mm wide beside the logo (visible x 74–111 and 115–152, bottoms at 105).
  - The points are Playfair 600, 14 pt, deep teal, a flat gold disc (#A8741A) with a white tick, a hairline between rows: "2′-FL HMOs", "DHA and ARA", "Nucleotides". The tile label is "2′-FL HMOs" too.
  - The baby stood at the right as shot, 62 mm tall, with can 2 hiding 6.6 mm of her hip. Kept as `z-src-r9.html` and `z-baby-front-asshot-r9.png`.
- **Round 6, r10 (19 Nov ~16:50 Cairo) — the build now in `Downloads\Lacto-Advanced-A5-landscape`.** On seeing r9 he wrote "make the baby look the opposite position", so she is MIRRORED again (`prep_front28.py` has `MIRROR = True`) and faces the cans.
  - 🔴 The lesson: **the baby faces the product, into the page.** "Same as original photo" lasted one draft; as shot she looks off the right edge. Flip her toward the cans unless he says otherwise in that same message.
  - Mirrored, her reaching hand is the leftmost point, so nothing can tuck behind a can any more: she is whole, 56 mm tall at 492 dpi (she was 62), body box x 152.5–209.5, forearms at 104.
  - Measured on the render: 2.5 mm of white between her hand and can 2; 3.6 mm from her hip to the trim. Everything left of x 149 and the whole back are pixel-identical to r9.
  - Rejected on the way: her hand in front of can 2 (hides the pack; her picture is flat RGB on white), her hip bleeding off the right edge (a cut baby), 57 mm with a 1.6 mm gap (cramped).
  - ✅ **He APPROVED this front at 16:52 Cairo ("Approve front").** It is FINAL: fix defects only, never the look. Packaged from `Lacto-Advanced-A5-landscape-r10b.pdf`; the source is `lacto-advanced-a5-landscape.html` beside it. The back has not been approved or refused.
  - He reacts to drafts he sees in the transcript mid-turn — a draft opened with the Read tool is in front of him.

Related: [[the-next-step-box-must-not-manufacture-the-next-task]]

- **Round 7, the Why Lacto slide (19 Nov 2026, 17:28 Cairo):** on seeing the flyer-dressed Why Lacto slide (Pedia app 1.3.5) he said "RETURN THE APP AS IT WAS". It was reverted to the original blue 1.3.4 slide as 1.3.6 (code 16), GitLab main a71c230, on his "Merge 8 now". **Never re-dress the app's Why Lacto slide as the flyer unless he asks again in his own words.**
