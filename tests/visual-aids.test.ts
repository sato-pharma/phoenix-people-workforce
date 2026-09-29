import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { permissionMatrix, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import {
  buildVisualAidUploadPath,
  canReaderOpenVisualAid,
  isOwnVisualAidUploadPath,
  parseVisualAidDraft,
  sniffVisualAidMimeType,
  VISUAL_AID_LINES,
  VISUAL_AIDS_MANAGER_ROLES,
  VISUAL_AIDS_PORTAL_ROLES,
  visualAidLinesForReader,
  VisualAidInputError,
  visualAidUploaderKey,
} from "../src/lib/visual-aids/rules.ts";

/**
 * Visual Aids (owner, 2026-09-18): Marketing uploads flyers against a product line; a rep and his
 * DM, RM and NSM open only the ACTIVE aids of their OWN line, and nothing is ever hard-deleted.
 *
 * What this pins:
 *  · the line list the code derives equals the migration's CHECK list;
 *  · a reader's lines fail CLOSED — an unresolved line reads nothing, never every line;
 *  · a retired aid, or another line's, is never opened by a reader;
 *  · a file is judged by its BYTES, not by its name or declared type;
 *  · an upload path names its uploader and nobody else can hand it back;
 *  · who uploads and who reads is the same in the matrix, the rules and the portal link;
 *  · every route is registered with its real permission, CSRF on every POST, a required audit on
 *    every write, and the writes really call writeRequiredAuditLog.
 */

const MIGRATION = "supabase/migrations/20260918152921_visual_aids.sql";

function rolesHolding(action: string): PhoenixRole[] {
  return (Object.keys(permissionMatrix) as PhoenixRole[])
    .filter((role) => (permissionMatrix[role].visual_aids ?? []).includes(action as never))
    .sort();
}

function expectInputError(fn: () => unknown, label: string) {
  assert.throws(fn, (error: unknown) => error instanceof VisualAidInputError, label);
}

export function runVisualAidsTests() {
  // ── 1. The line list: derived in code, spelled in SQL, and the two must agree ─────────────────
  const sql = readFileSync(MIGRATION, "utf8");
  const check = sql.match(/visual_aids_line_check check \(line_name = any \(array\[([^\]]+)\]\)\)/);
  assert.ok(check, "the migration must carry the visual_aids_line_check constraint");
  const sqlLines = Array.from(check[1].matchAll(/'([^']+)'::text/g)).map((match) => match[1]).sort();
  assert.deepEqual([...VISUAL_AID_LINES].sort(), sqlLines, "the code's visual-aid lines must equal the migration's CHECK list");
  assert.deepEqual([...VISUAL_AID_LINES].sort(), ["Anti Infective", "CNS", "Pedia"], "the three product lines, never Head Office");
  assert.match(sql, /'visual-aids',\s*'visual-aids',\s*false,/, "the bucket is created PRIVATE");
  assert.doesNotMatch(sql, /^\s*grant [^;]*\bto\s+(public|anon|authenticated)\b/im, "no browser role is granted the table");

  // ── 2. Reader lines fail closed ───────────────────────────────────────────────────────────────
  assert.deepEqual(visualAidLinesForReader(null), [...VISUAL_AID_LINES], "a company-wide viewer reads every line");
  assert.deepEqual(visualAidLinesForReader(new Set(["CNS"])), ["CNS"], "a CNS rep reads CNS only");
  assert.deepEqual(visualAidLinesForReader(new Set(["Pedia"])), ["Pedia"], "a Pedia rep reads Pedia only");
  assert.deepEqual(visualAidLinesForReader(new Set()), [], "an unresolved line reads NOTHING, never every line");
  assert.deepEqual(visualAidLinesForReader(new Set(["Head Office"])), [], "Head Office holds no visual aids");
  assert.deepEqual(visualAidLinesForReader(new Set(["Not A Line"])), [], "an unknown line reads nothing");

  // ── 3. What a reader may open ─────────────────────────────────────────────────────────────────
  assert.equal(canReaderOpenVisualAid({ lineName: "CNS", status: "active" }, ["CNS"]), true);
  assert.equal(canReaderOpenVisualAid({ lineName: "CNS", status: "retired" }, ["CNS"]), false, "a retired aid never reaches the field");
  assert.equal(canReaderOpenVisualAid({ lineName: "Pedia", status: "active" }, ["CNS"]), false, "another line's aid is never opened");
  assert.equal(canReaderOpenVisualAid({ lineName: "CNS", status: "active" }, []), false, "no lines, no aids");

  // ── 4. Bytes decide the type ──────────────────────────────────────────────────────────────────
  assert.equal(sniffVisualAidMimeType(new TextEncoder().encode("%PDF-1.7\n")), "application/pdf");
  assert.equal(sniffVisualAidMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image/jpeg");
  assert.equal(sniffVisualAidMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(sniffVisualAidMimeType(new TextEncoder().encode("<html><script>")), null, "an HTML file renamed .pdf is refused");
  assert.equal(sniffVisualAidMimeType(new TextEncoder().encode("PK")), null, "a zip/office file is refused");

  // ── 5. An upload path names its uploader ──────────────────────────────────────────────────────
  const key = visualAidUploaderKey("B-10");
  assert.equal(key, "b-10");
  const path = buildVisualAidUploadPath({ mimeType: "application/pdf", uploadId: "3F2504E0-4F89-41D3-9A0C-0305E82C3301", uploaderKey: key as string });
  assert.equal(path, "uploads/b-10/3f2504e0-4f89-41d3-9a0c-0305e82c3301.pdf");
  assert.equal(isOwnVisualAidUploadPath(path, "b-10"), true);
  assert.equal(isOwnVisualAidUploadPath(path, "b-1"), false, "another uploader cannot hand back this path");
  assert.equal(isOwnVisualAidUploadPath(path, null), false, "no identity, no upload");
  assert.equal(isOwnVisualAidUploadPath("uploads/b-10/../b-11/3f2504e0-4f89-41d3-9a0c-0305e82c3301.pdf", "b-10"), false, "no traversal");
  assert.equal(isOwnVisualAidUploadPath("uploads/b-10/3f2504e0-4f89-41d3-9a0c-0305e82c3301.html", "b-10"), false, "only pdf, jpg, png");

  // ── 6. What the uploader typed ────────────────────────────────────────────────────────────────
  assert.deepEqual(
    parseVisualAidDraft({ lineName: "CNS", pageCount: 4, productName: "  ", title: "  Brand   leaflet " }),
    { lineName: "CNS", pageCount: 4, productName: null, title: "Brand leaflet" },
  );
  expectInputError(() => parseVisualAidDraft({ lineName: "CNS", title: "  " }), "a title is required");
  expectInputError(() => parseVisualAidDraft({ lineName: "Head Office", title: "x" }), "Head Office is not a visual-aid line");
  expectInputError(() => parseVisualAidDraft({ lineName: "CNS", pageCount: 0, title: "x" }), "a zero page count is refused");
  expectInputError(() => parseVisualAidDraft({ lineName: "CNS", pageCount: 501, title: "x" }), "over 500 pages is refused");

  // ── 7. Who uploads and who reads — matrix and rules agree ────────────────────────────────────
  // The SIDEBAR LINK is gone (owner, 2026-09-29): Visual Aids is one of the five rows he moved to
  // "Remove from sidebar" on his own placement sheet. The page, its routes and every permission
  // below are untouched — reps still open it from their command-centre card and the admin twin —
  // so what this section proves is the access model, and separately that the row stays off.
  // `VISUAL_AIDS_PORTAL_ROLES` is now the set the FLAG serves, not the set shown a sidebar row.
  assert.deepEqual(rolesHolding("create"), [...VISUAL_AIDS_MANAGER_ROLES].sort(), "create is held by exactly the three uploaders");
  assert.deepEqual(rolesHolding("update"), [...VISUAL_AIDS_MANAGER_ROLES].sort(), "update (retire, replace) is held by exactly the three uploaders");
  assert.deepEqual(rolesHolding("delete"), [], "nobody may delete a visual aid");
  const readers = rolesHolding("read");
  for (const role of VISUAL_AIDS_PORTAL_ROLES) {
    assert.ok(readers.includes(role), `${role} holds the portal flag, so must hold visual_aids:read`);
  }
  assert.deepEqual(
    readers.filter((role) => !VISUAL_AIDS_PORTAL_ROLES.includes(role)),
    ["Super Admin"],
    "every reader except the admin-shell Super Admin holds the portal flag",
  );
  for (const role of ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager"] as PhoenixRole[]) {
    assert.ok(readers.includes(role), `${role} reads visual aids`);
    assert.ok(!rolesHolding("create").includes(role), `${role} never uploads`);
  }
  // The flag still resolves per role — it is what the page and its command-centre card read.
  assert.equal(resolveEmployeePortalNavVisibility("Medical Rep", "Medical Rep").showVisualAidsTab, true, "a rep holds the flag");
  assert.equal(resolveEmployeePortalNavVisibility("Employee", "Employee").showVisualAidsTab, false, "a plain employee does not");
  // And the sidebar row STAYS OFF. Restoring it would be undoing his sheet, so this asserts the
  // absence rather than leaving it to nobody noticing.
  const layout = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  assert.doesNotMatch(
    layout,
    /href: "\/employee-portals\/visual-aids"/,
    "Visual Aids has NO sidebar row — the owner moved it to 'Remove from sidebar' on 2026-09-29. " +
      "The page, its permissions and its routes are unchanged; do not restore the row.",
  );

  // ── 8. Routes: registered, gated, CSRF on writes, audited ─────────────────────────────────────
  const expected: Array<[string, "GET" | "POST", string, boolean]> = [
    ["/api/visual-aids", "GET", "read", false],
    ["/api/visual-aids", "POST", "create", true],
    ["/api/visual-aids/upload-url", "POST", "create", false],
    ["/api/visual-aids/:id/retire", "POST", "update", true],
    ["/api/visual-aids/:id/replace", "POST", "update", true],
    ["/api/visual-aids/:id/file", "GET", "read", false],
  ];
  for (const [route, method, action, audited] of expected) {
    const entry = findAccessRegistryEntry(route.replace(":id", "3f2504e0-4f89-41d3-9a0c-0305e82c3301"), method);
    assert.ok(entry && entry.pattern.startsWith("/api/visual-aids"), `${method} ${route} must have its own registry entry`);
    assert.deepEqual(entry.permission, { action, resource: "visual_aids" }, `${method} ${route} declares visual_aids:${action}`);
    if (method === "POST") assert.equal(entry.csrf.required, true, `${method} ${route} requires CSRF`);
    if (audited) assert.equal(entry.audit.required, true, `${method} ${route} requires an audit row`);

    const file = `app${route.replace(":id", "[id]")}/route.ts`;
    const source = readFileSync(file, "utf8");
    assert.match(source, new RegExp(`assertPermission\\(access, "visual_aids", "${action}"\\)`), `${file} asserts visual_aids:${action}`);
    if (method === "POST") assert.match(source, /assertSameOriginMutation\(request\)/, `${file} checks the origin`);
  }
  const fileRoute = readFileSync("app/api/visual-aids/[id]/file/route.ts", "utf8");
  assert.match(fileRoute, /"content-disposition": "inline"/, "the file route answers inline");
  assert.doesNotMatch(fileRoute, /"content-disposition": "attachment/, "the file route never offers a download");
  assert.match(fileRoute, /"cache-control": "private, no-store"/, "the file is never cached");

  const service = readFileSync("src/lib/visual-aids/service.ts", "utf8");
  assert.equal((service.match(/writeRequiredAuditLog\(\{/g) ?? []).length, 3, "create, retire and replace each write a required audit row");
  assert.match(service, /base\.eq\("status", "active"\)/, "a reader's list holds active aids only");
  assert.doesNotMatch(service, /\.from\(TABLE\)\s*\.delete\(\)\s*\.eq\("id", (row|old)\.id\)/, "a published aid is never deleted");
}
