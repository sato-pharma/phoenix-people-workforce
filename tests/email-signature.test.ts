import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  printableLine,
  signatureAltText,
  signatureLinesFor,
} from "@/lib/email-signature/signature-content";
import {
  buildSignatureElement,
  fittedSize,
  SIGNATURE_PIXEL_HEIGHT,
  SIGNATURE_PIXEL_WIDTH,
  SIGNATURE_SCALE,
  SIGNATURE_SHOWN_HEIGHT,
  SIGNATURE_SHOWN_WIDTH,
} from "@/lib/email-signature/signature-layout";
import { openSignatureToken, sealSignatureToken } from "@/lib/email-signature/signature-token";

// ─────────────────────────────────────────────────────────────────────────────
// My Email Signature — every employee's own Sato Pharma + Phoenix signature, built from their record
// as ONE picture (owner, 2026-10-17: "make him not able to delete anything from it … if he tries to
// delete the Phoenix logo, the whole signature is deleted").
//
// A pasted signature made of a table, a logo and text cells lets a person delete one part and keep the
// rest. The only shape a mail app cannot split is a single picture, so that is the whole design — and
// what these tests pin: the picture stays ONE picture, the address that serves it names nobody and
// opens nobody else, and the page is reachable for every employee.
// ─────────────────────────────────────────────────────────────────────────────

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

type TreeNode = { props?: { children?: unknown; src?: string } | null; type?: unknown } | string | null | undefined;

function walk(node: unknown, onText: (text: string) => void, onImage: (src: string) => void) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    onText(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, onText, onImage);
    return;
  }
  const element = node as Exclude<TreeNode, string | null | undefined>;
  if (element.type === "img" && typeof element.props?.src === "string") onImage(element.props.src);
  walk(element.props?.children, onText, onImage);
}

export async function runEmailSignatureTests() {
  const previousSecret = process.env.PHOENIX_AUTH_SECRET;
  process.env.PHOENIX_AUTH_SECRET = "test-secret-for-the-email-signature-address-0123456789abcdef";
  try {
    // ── THE ADDRESS: opaque, stable, tamper-proof ──────────────────────────────────────────────
    const token = sealSignatureToken("B-10");
    assert.equal(openSignatureToken(token), "B-10", "a sealed address opens back to the same HR id");
    assert.equal(sealSignatureToken("b-10"), token, "the same person always gets the same address, whatever the case typed");
    assert.notEqual(sealSignatureToken("B-11"), token, "two people never share an address");
    assert.ok(!token.toLowerCase().includes("b-10"), "the address does not spell the HR id");
    assert.ok(!Buffer.from(token, "base64url").toString("utf8").includes("B-10"), "nor does it carry the id in the clear");
    assert.match(token, /^[A-Za-z0-9_-]+$/, "the address is URL-safe, so it can sit in a path");

    const flipped = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
    assert.equal(openSignatureToken(flipped), null, "an altered address opens nobody");
    assert.equal(openSignatureToken(token.slice(0, 20)), null, "a cut address opens nobody");
    assert.equal(openSignatureToken(""), null, "an empty address opens nobody");
    assert.equal(openSignatureToken(null), null, "a missing address opens nobody");
    assert.equal(openSignatureToken("x".repeat(500)), null, "an absurdly long address is refused before it is decoded");

    process.env.PHOENIX_AUTH_SECRET = "a-different-secret-entirely-0123456789abcdef0123456789";
    assert.equal(openSignatureToken(token), null, "an address sealed under another secret opens nobody");
    process.env.PHOENIX_AUTH_SECRET = "test-secret-for-the-email-signature-address-0123456789abcdef";

    // ── THE WORDS: only characters the picture's font can print ────────────────────────────────
    assert.deepEqual(printableLine("  Omar   Gawish "), { dropped: false, text: "Omar Gawish" });
    assert.deepEqual(printableLine("O’Brien"), { dropped: false, text: "O’Brien" }, "a typographic apostrophe prints");
    const arabic = printableLine("Omar عمر Gawish");
    assert.equal(arabic.text, "Omar Gawish", "letters the font cannot draw are left out, never printed as boxes");
    assert.equal(arabic.dropped, true, "and the page is told something was left out");

    const { dropped, lines } = signatureLinesFor({
      email: "someone@satopharma.com",
      lineArea: "Pedia · CAIRO",
      mobile: "+20 10 1234 5678",
      name: "Someone Example",
      title: "Medical Representative",
    });
    assert.equal(dropped, false);
    assert.equal(lines.office, "Sheraton El Matar, Cairo");
    assert.equal(lines.web, "satopharma.com");

    // ── THE ALT TEXT: what a mail app that blocks pictures still shows ─────────────────────────
    const alt = signatureAltText(lines);
    for (const part of ["Someone Example", "Medical Representative", "Pedia", "+20 10 1234 5678", "someone@satopharma.com", "satopharma.com", "Sheraton El Matar, Cairo", "Phoenix Workforce"]) {
      assert.ok(alt.includes(part), `the alternative text carries "${part}"`);
    }

    // ── THE PICTURE: drawn from the lines, and nothing else ────────────────────────────────────
    const texts: string[] = [];
    const images: string[] = [];
    walk(buildSignatureElement(lines, { emblem: "data:image/png;base64,EMBLEM", sato: "data:image/png;base64,SATO" }), (t) => texts.push(t), (s) => images.push(s));
    const drawn = texts.join(" | ");
    for (const part of ["Someone Example", "Medical Representative", "Pedia", "+20 10 1234 5678", "someone@satopharma.com", "satopharma.com", "PHOENIX", "WORKFORCE"]) {
      assert.ok(drawn.includes(part), `the picture draws "${part}"`);
    }
    assert.deepEqual(images.sort(), ["data:image/png;base64,EMBLEM", "data:image/png;base64,SATO"], "both logos are drawn INTO the one picture");

    // The picture is twice as sharp as it is shown.
    assert.equal(SIGNATURE_PIXEL_WIDTH, SIGNATURE_SHOWN_WIDTH * SIGNATURE_SCALE);
    assert.equal(SIGNATURE_PIXEL_HEIGHT, SIGNATURE_SHOWN_HEIGHT * SIGNATURE_SCALE);
    assert.ok(SIGNATURE_SHOWN_HEIGHT <= 180, "the signature stays short — the old one was too tall (owner, 2026-10-17)");

    // A long name or address shrinks to fit; it is never allowed to run off the picture, nor to vanish.
    assert.equal(fittedSize("Omar Gawish", 308, 18, 11.5), 18, "a short name keeps the design size");
    const long = fittedSize("A".repeat(40), 308, 18, 11.5);
    assert.ok(long < 18 && long >= 11.5, `a long name is set smaller, not cut (got ${long})`);
    assert.equal(fittedSize("A".repeat(400), 308, 18, 11.5), 11.5, "even an absurd one is never set below the readable floor");

    // ── THE PAGE: one picture, one link, reachable by every employee ───────────────────────────
    const maker = read("src/components/email-signature/email-signature-maker.tsx");
    assert.equal(maker.split("<img ").length - 1, 2, "the maker holds the picture twice at most: once on the clipboard, once on screen");
    assert.ok(!maker.includes("<table"), "the copied signature is not a table of parts that can be taken apart");
    assert.ok(maker.includes("`<a href="), "what is copied is one link around one picture");

    const page = read("app/employee-portals/email-signature/page.tsx");
    assert.ok(page.includes('assertPermission(access, "employee_profile", "read")'), "the page is gated by employee_profile:read, which every employee holds");
    assert.ok(page.includes("const hrId = access.hrId;") && page.includes("sealSignatureToken(hrId)"), "the address is sealed from the signed-in person's own id");
    assert.ok(read("app/employee-portals/email-signature/loading.tsx").includes("PortalRouteSkeleton"), "the route has its loading skeleton");

    const route = read("app/api/email-signature/[token]/signature.png/route.ts");
    assert.ok(route.includes("export async function GET"), "the picture is served on GET");
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.ok(!route.includes(`export async function ${verb}`), `the public picture route has no ${verb}`);
    }
    assert.ok(!route.includes("searchParams") && !route.includes("request.url"), "the route reads nothing from the request but the sealed address");
    assert.ok(route.includes("openSignatureToken(token)"), "the route opens the sealed address before it reads anybody");

    assert.ok(
      read("src/lib/security/access-registry.ts").includes('pattern: "/api/email-signature/:token/signature.png"'),
      "the public picture route is declared in the access registry",
    );

    // ── REACHABLE: the sidebar, the bottom bar and the module directory all carry it ───────────
    const href = '"/employee-portals/email-signature"';
    assert.ok(read("src/components/employee-portal/employee-portal-layout.tsx").includes(href), "the sidebar carries the page");
    const registry = read("src/components/employee-portal/employee-portal-nav-registry.ts");
    assert.ok(registry.includes(href), "the bottom bar and profile grid carry the page");
    assert.ok(
      registry.includes(`href: ${href}, icon: Mail, permission: { resource: "employee_profile", action: "read" }`),
      "the registry gate matches the page's own gate",
    );
    assert.ok(read("src/lib/employee-portal/native-module-directory.ts").includes(href), "the module directory files the page");
  } finally {
    if (previousSecret === undefined) delete process.env.PHOENIX_AUTH_SECRET;
    else process.env.PHOENIX_AUTH_SECRET = previousSecret;
  }
}
