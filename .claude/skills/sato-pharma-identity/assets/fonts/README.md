# The faces that travel with the documents

## The certificate's script

`certificate-name.ttf` is **Pinyon Script Regular**, by Sorkin Type, under the
**SIL Open Font License 1.1** — the full licence is in `OFL.txt` beside it, which
is a condition of the licence and not a courtesy.

It sets exactly one line in the whole project: the intern's name on the
certificate (`src/lib/certificate-pdf.ts`), read from here at request time by
`src/lib/truetype.ts` and embedded in the PDF as `/FontFile2`.

**It has to be OFL, and `fsType` is not what decides that.** Every script face
installed on a Windows machine permits *embedding* by its OS/2 `fsType` bits, and
several are `fsType 0` (Installable) — but this file is committed to the
repository and shipped to a Linux server on Railway, which is redistribution, and
a Windows or Monotype licence does not allow it. Reading `fsType` and concluding
"embedding is allowed" is how a licensed font ends up in a public repository.

**It must also be a TrueType-outline build.** `parseTrueType()` refuses
OpenType/CFF (`OTTO`) outright, because CFF outlines under `/FontFile2` render as
nothing at all — a certificate with no name on it. Replacing this file means
checking that the replacement is `glyf`-flavoured, not `CFF `.

A missing or refused font is not an error: the name falls back to Helvetica Bold,
which is what it was set in before there was a script at all.

## The card's sans

`sans-regular.ttf` and `sans-bold.ttf` are **Montserrat** Regular and Bold, by
Julieta Ulanovsky and the Montserrat Project Authors, under the **same SIL Open
Font License 1.1** — `OFL.txt` beside them covers both faces, which is why
there is one copy of it here and not two.

They set the whole of the business card (`src/lib/business-card.ts`): six of its
eight items in bold — the name, the role, the posting, the row labels, the
roster id, the programme strap — and the phone and email in regular.

**They are named by their ROLE in the family and not by the document.** The
certificate's file is `certificate-name.ttf` because it sets one line on one
page and nothing else will ever use it; these two set a whole document and are
the obvious face for the next one, so the name says which weight of the sans it
is. Replacing the family means replacing two files at these names and touching
no code — and the metrics move with them, because business-card.ts reads the
cap height and the descender off the file rather than writing them down.

**Two faces or none.** The card sets both weights, so one file failing to load
would give a card whose name is Montserrat and whose email address is
Helvetica, which is plainly worse than Helvetica throughout and which nothing on
the page would announce. `cardType()` drops both if either is missing, and
`tests/business-card.test.mts` asserts every run on both sides is one family.

**The cost is 220KB a document, and it is not subsetted.** Each face is about
110KB deflated, both travel in every card PDF, and a ten-up sheet of 65 cards
pays it once rather than 65 times. Subsetting would save most of it and is
deliberately not done, for the reason `truetype.ts` states: rebuilding four
tables and three checksums to save some kilobytes has a failure mode of a
document that opens with the wrong letters in it.

The same two rules as above apply unchanged: it has to be OFL because the file
is committed and shipped, and it has to be the TrueType-outline build.
