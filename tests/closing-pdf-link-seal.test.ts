import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import {
  EXCEL_HYPERLINK_LIMIT,
  openClosingSelectionSeal,
  sealClosingSelection,
  sealedPdfRequest,
  sealedReaderAccess,
  sealedRepCardPdfBase,
  type SealedClosingSelection,
} from "../src/lib/sales/closing-pdf-link-seal.ts";
import { canRevealClosingSource } from "../src/lib/sales/closing-source-mask.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * ANYONE WHO RECEIVES THE CLOSING CAN EXPORT ITS PDF (owner, 2026-09-14).
 *
 * A District Manager sent a Pedia workbook filtered to Giza clicked Export PDF and was refused with
 * "This report covers the whole line"; a reader whose browser was not signed in was told he had no
 * permission. The links now carry a seal of the selection the workbook was built from, and the PDF
 * route reads the selection out of the seal. These tests are the proof that the seal cannot be
 * stretched past the file: an edited URL, an edited payload and a signature minted for another purpose
 * all fail, and the reader is never handed El Qema's source.
 */

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

const SECRET = "closing-pdf-link-seal-test-secret";

const PEDIA_GIZA: SealedClosingSelection = {
  filter: { areaCodes: [], productCodes: [], regionCodes: ["GZ"], search: "" },
  headOffice: false,
  line: "Pedia",
  period: "2026-08",
};

const guest: AccessContext = { hrId: null, loginId: null, role: "Employee", scope: "none", source: "guest" };
const districtManager: AccessContext = {
  hrId: "S-1042",
  loginId: "S-1042",
  role: "District Manager",
  scope: "team",
  source: "session",
};
const superAdmin: AccessContext = { hrId: "B-10", loginId: "B-10", role: "Super Admin", scope: "company", source: "session" };

export async function runClosingPdfLinkSealTests() {
  const previousSecret = process.env.PHOENIX_AUTH_SECRET;
  process.env.PHOENIX_AUTH_SECRET = SECRET;
  try {
    const token = sealClosingSelection(PEDIA_GIZA);
    assert.ok(token, "a seal is minted when the secret is present");

    // ==== An edited URL cannot reach a line, month or region the file does not hold ===============
    const edited = new URLSearchParams({ line: "CNS", period: "2026-07", seal: token, sheet: "Details" });
    edited.append("region", "CA");
    edited.append("product", "SECRET-PRODUCT");
    const request = sealedPdfRequest(edited);
    assert.ok(request, "a valid seal opens");
    assert.equal(
      request.selection.line,
      "Pedia",
      "HEADLINE: the PDF must read its line from the seal — `line=CNS` on the query string is the reader editing the link",
    );
    assert.equal(request.selection.period, "2026-08", "the month comes from the seal, never the query string");
    assert.deepEqual(request.selection.filter.regionCodes, ["GZ"], "the region filter comes from the seal");
    assert.deepEqual(request.selection.filter.productCodes, [], "an appended product cannot narrow or widen a sealed PDF");
    assert.equal(request.sheet, "Details", "the page is the one thing a page link may choose");

    // The Rep Card's formula appends the dropdown's area LAST.
    const card = new URLSearchParams({ seal: token, sheet: "Rep Card" });
    card.append("area", "GZ3");
    assert.equal(sealedPdfRequest(card)?.cardArea, "GZ3", "the Rep Card draws the area its own dropdown appended");

    // ==== Round trip, and one selection always seals to one text ================================
    assert.deepEqual(openClosingSelectionSeal(token), PEDIA_GIZA, "the seal carries the selection exactly");
    assert.equal(
      sealClosingSelection({ ...PEDIA_GIZA, filter: { ...PEDIA_GIZA.filter, regionCodes: [" GZ", "GZ", ""] } }),
      token,
      "blank, padded and repeated codes seal to the same text",
    );

    // ==== Nothing but the seal the server minted opens ==========================================
    const [encoded, signature] = token.split(".");
    for (const forged of [null, undefined, "", "true", encoded, `${encoded}.`, `.${signature}`, `${token}.extra`]) {
      assert.equal(openClosingSelectionSeal(forged), null, `a forged seal (${JSON.stringify(forged)}) must not open`);
    }

    const cnsPayload = Buffer.from(JSON.stringify([1, "CNS", "2026-08", [], [], [], "", 0]), "utf8").toString("base64url");
    assert.equal(
      openClosingSelectionSeal(`${cnsPayload}.${signature}`),
      null,
      "an edited payload under the original signature must not open — that is a whole line the reader was never sent",
    );

    const truncated = signature.slice(0, -2);
    assert.equal(openClosingSelectionSeal(`${encoded}.${truncated}`), null, "a truncated signature must not open");

    // The session and unsubscribe signers use this same secret with no purpose prefix.
    const crossPurpose = createHmac("sha256", SECRET).update(encoded).digest();
    assert.equal(
      openClosingSelectionSeal(`${encoded}.${crossPurpose.toString("base64url")}`),
      null,
      "a signature minted for another purpose under the same secret must not open as a seal",
    );
    assert.equal(
      openClosingSelectionSeal(`${encoded}.${crossPurpose.subarray(0, 16).toString("base64url")}`),
      null,
      "nor its first 128 bits",
    );

    // ==== The reader never inherits the downloader's view of El Qema =============================
    for (const reader of [guest, districtManager]) {
      const loaded = sealedReaderAccess(PEDIA_GIZA, reader);
      assert.equal(
        canRevealClosingSource(loaded),
        false,
        `a ${reader.source === "guest" ? "signed-out reader" : reader.role} must see El Qema's source masked on a sealed PDF`,
      );
      assert.equal(loaded.role, "Finance Manager", "a non-Head-Office file is loaded as a company-wide viewer without Head Office");
      assert.equal(loaded.scope, "company", "the file was company-wide, so the detail rows are too");
    }
    assert.equal(
      sealedReaderAccess({ ...PEDIA_GIZA, headOffice: true }, guest).role,
      "CEO",
      "a file downloaded by someone who sees Head Office keeps its Head Office detail rows",
    );
    assert.equal(canRevealClosingSource(sealedReaderAccess({ ...PEDIA_GIZA, headOffice: true }, guest)), false, "and still masks El Qema");
    assert.equal(sealedReaderAccess(PEDIA_GIZA, superAdmin), superAdmin, "the Super Admin reads his own link as himself");
    assert.equal(
      canRevealClosingSource(sealedReaderAccess(PEDIA_GIZA, { ...guest, role: "Super Admin" })),
      false,
      "a signed-out context never counts as the Super Admin",
    );

    // ==== The Rep Card's link fits inside Excel's cap ==========================================
    const longestOrigin = "https://phoenix-people-workforce-staging.up.railway.app";
    const antiInfective = sealClosingSelection({
      ...PEDIA_GIZA,
      filter: { ...PEDIA_GIZA.filter, productCodes: ["AUG1"], regionCodes: ["GZ", "UE-1"] },
      line: "Anti Infective",
    });
    assert.ok(antiInfective);
    const base = sealedRepCardPdfBase(longestOrigin, antiInfective);
    assert.ok(base, "an ordinary filtered Anti Infective workbook gets a sealed Rep Card link");
    assert.ok(
      `${base}&area=ALX12`.length <= EXCEL_HYPERLINK_LIMIT,
      `the Rep Card link must fit Excel's 255-character cap — it is ${`${base}&area=ALX12`.length}`,
    );
    const crowded = sealClosingSelection({
      ...PEDIA_GIZA,
      filter: { ...PEDIA_GIZA.filter, areaCodes: Array.from({ length: 30 }, (_, index) => `GZ${index}`) },
    });
    assert.ok(crowded);
    assert.equal(
      sealedRepCardPdfBase(longestOrigin, crowded),
      null,
      "a selection too long for Excel gets no sealed base, rather than a link Excel refuses",
    );

    // ==== No secret, no seal — and nothing opens =================================================
    delete process.env.PHOENIX_AUTH_SECRET;
    assert.equal(sealClosingSelection(PEDIA_GIZA), null, "without a secret nothing seals");
    assert.equal(openClosingSelectionSeal(token), null, "without a secret nothing opens");
    process.env.PHOENIX_AUTH_SECRET = SECRET;

    // ==== Both routes are wired to the seal ======================================================
    const workbookRoute = stripComments(source("app/api/sales/monthly-closing/premium-export/route.ts"));
    assert.match(workbookRoute, /sealClosingSelection\(/, "the workbook export seals the selection it was built from");
    assert.match(workbookRoute, /query\.set\("seal", seal\)/, "every page's Export PDF link carries the seal");
    assert.match(workbookRoute, /sealedRepCardPdfBase\(origin, seal\)/, "the Rep Card's link carries the seal");

    const pdfRoute = stripComments(source("app/api/sales/monthly-closing/premium-export/pdf/route.ts"));
    assert.match(pdfRoute, /sealedPdfRequest\(params\)/, "the PDF route opens the seal");
    assert.match(
      pdfRoute,
      /access: sealedReaderAccess\(sealed\.selection, access\)[\s\S]{0,120}filter: sealed\.selection\.filter,[\s\S]{0,80}line: sealed\.selection\.line,[\s\S]{0,80}period: sealed\.selection\.period/,
      "a sealed PDF is loaded from the sealed selection, as the sealed reader",
    );
    assert.match(pdfRoute, /returnUrl/, "an unsealed link sends a signed-out reader to sign in, not to a permission error");
  } finally {
    if (previousSecret === undefined) delete process.env.PHOENIX_AUTH_SECRET;
    else process.env.PHOENIX_AUTH_SECRET = previousSecret;
  }
}
