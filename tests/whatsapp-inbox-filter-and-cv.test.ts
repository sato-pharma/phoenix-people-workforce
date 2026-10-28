import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pickInboxCvs, type InboxDocumentMessage } from "../src/lib/whatsapp-inbox/cv-pick.ts";
import { parseInboxReadState } from "../src/lib/whatsapp-inbox/read-state.ts";
import {
  addInboxPositionRecord,
  INBOX_NO_POSITION,
  inboxAreaOptions,
  inboxPlaceText,
  inboxPositionHasArea,
  inboxPositionHasRegion,
  inboxPositionRecord,
  matchesInboxPlaceFilter,
  parseInboxPlaceFilter,
  parseInboxPositionFilter,
  type InboxPositionFact,
  type InboxPositionRecord,
} from "../src/lib/whatsapp-inbox/position-filter.ts";

// The WhatsApp Inbox's chat list (owner, 2026-09-15). What this suite pins:
//
//   · the filters CASCADE: a District Manager is hired for a region, so Position offers Region; a
//     Medical Representative is hired for an area, so Position offers Region and then that region's
//     Area — and a filter the one before it does not allow is dropped, never silently matching nothing;
//   · job, region and area must all belong to ONE application — two applications never combine;
//   · the place shows beside the position as "Region · Area";
//   · "Open CV" opens the NEWEST document the person sent and counts the rest, whatever order the
//     rows arrive in, and sits outside the row's button as a link that opens a new tab;
//   · Read and Unread (owner, 2026-10-28): the list filters All · Unread · Read, and any chat can be
//     marked read or unread from its row, or unread from the open chat — Phoenix only, no blue ticks.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

function fact(family: InboxPositionFact["family"], regionCode: InboxPositionFact["regionCode"] = null, areaName: string | null = null): InboxPositionFact {
  return { areaName, family, regionCode };
}

function runCascadeTests() {
  assert.equal(inboxPositionHasRegion("district_manager"), true);
  assert.equal(inboxPositionHasRegion("medical_rep"), true);
  assert.equal(inboxPositionHasRegion("pharmacist"), false, "a job not hired by place offers no Region filter");
  assert.equal(inboxPositionHasRegion(INBOX_NO_POSITION), false);
  assert.equal(inboxPositionHasArea("medical_rep"), true);
  assert.equal(inboxPositionHasArea("district_manager"), false, "a District Manager is hired for a region, never an area");

  assert.equal(parseInboxPositionFilter(" medical_rep "), "medical_rep");
  assert.equal(parseInboxPositionFilter("none"), INBOX_NO_POSITION);
  assert.equal(parseInboxPositionFilter("chief_wizard"), null, "an unknown position is no filter at all");

  assert.deepEqual(
    parseInboxPlaceFilter({ area: "Qena 1", position: "district_manager", region: "UE" }),
    { area: null, position: "district_manager", region: "UE" },
    "a District Manager keeps the region and drops an area",
  );
  assert.deepEqual(
    parseInboxPlaceFilter({ area: "  Qena   1 ", position: "medical_rep", region: "UE" }),
    { area: "Qena 1", position: "medical_rep", region: "UE" },
    "a Medical Representative keeps region and area, spacing tidied",
  );
  assert.deepEqual(
    parseInboxPlaceFilter({ area: "Qena 1", position: "medical_rep", region: "" }),
    { area: null, position: "medical_rep", region: null },
    "an area without a region is dropped",
  );
  assert.deepEqual(
    parseInboxPlaceFilter({ area: "Qena 1", position: "pharmacist", region: "UE" }),
    { area: null, position: "pharmacist", region: null },
    "a region is dropped for a job not hired by place",
  );
  assert.deepEqual(parseInboxPlaceFilter({ position: "medical_rep", region: "XX" }).region, null, "a region the company does not use is dropped");
  assert.deepEqual(parseInboxPlaceFilter({ region: "UE" }), { area: null, position: null, region: null }, "a region with no position is no filter");
  assert.equal(parseInboxPlaceFilter({ area: "x".repeat(200), position: "medical_rep", region: "CA" }).area!.length, 80);
}

function runMatchTests() {
  const dmUpperEgypt = fact("district_manager", "UE");
  const repCairo = fact("medical_rep", "CA", "Nasr City");
  const twoApplications = [dmUpperEgypt, repCairo];
  const match = (facts: InboxPositionFact[], input: Parameters<typeof parseInboxPlaceFilter>[0]) =>
    matchesInboxPlaceFilter(facts, parseInboxPlaceFilter(input));

  assert.equal(match([], {}), true, "no filter shows every chat");
  assert.equal(match([], { position: "none" }), true, "a chat with no known position is under None");
  assert.equal(match([repCairo], { position: "none" }), false);

  assert.equal(match(twoApplications, { position: "district_manager" }), true);
  assert.equal(match(twoApplications, { position: "district_manager", region: "UE" }), true);
  assert.equal(match(twoApplications, { position: "medical_rep", region: "CA", area: "Nasr City" }), true);
  assert.equal(
    match(twoApplications, { position: "medical_rep", region: "UE" }),
    false,
    "one application's job never combines with another application's region",
  );
  assert.equal(match(twoApplications, { position: "district_manager", region: "CA" }), false);

  assert.equal(match([repCairo], { area: "  NASR   city ", position: "medical_rep", region: "CA" }), true, "case and spacing do not make a different area");
  assert.equal(match([repCairo], { area: "Heliopolis", position: "medical_rep", region: "CA" }), false);
  assert.equal(match([fact("medical_rep", "CA")], { area: "Nasr City", position: "medical_rep", region: "CA" }), false, "no area chosen never matches an area filter");
}

function runAreaOptionTests() {
  const chats: InboxPositionFact[][] = [
    [fact("medical_rep", "UE", "Qena 10")],
    [fact("medical_rep", "UE", "Qena 2"), fact("district_manager", "UE", "Aswan")],
    [fact("medical_rep", "UE", "  qena   2 ")],
    [fact("medical_rep", "CA", "Nasr City")],
    [fact("medical_rep", "UE", null)],
  ];
  assert.deepEqual(
    inboxAreaOptions(chats, parseInboxPlaceFilter({ position: "medical_rep", region: "UE" })),
    ["Qena 2", "Qena 10"],
    "the Area menu lists each area once, for that job and region only, in the order people count",
  );
  assert.deepEqual(
    inboxAreaOptions(chats, parseInboxPlaceFilter({ area: "Qena 2", position: "medical_rep", region: "UE" })),
    ["Qena 2", "Qena 10"],
    "picking an area still offers the others",
  );
  assert.deepEqual(inboxAreaOptions(chats, parseInboxPlaceFilter({ position: "medical_rep" })), [], "no Area menu before a region");
  assert.deepEqual(inboxAreaOptions(chats, parseInboxPlaceFilter({ position: "district_manager", region: "UE" })), []);
}

function runRecordTests() {
  const upper = inboxPositionRecord("medical_rep", "UE", null, "  Qena   1 ");
  assert.deepEqual(upper, { areaName: "Qena 1", family: "medical_rep", regionCode: "UE", regionLabel: "Upper Egypt" }, "a region is shown by its name, never its code");
  const typed = inboxPositionRecord("medical_rep", "ZZ", "  Red Sea ", " ");
  assert.equal(typed.regionCode, null, "a region code the company does not use never filters as one");
  assert.equal(typed.regionLabel, "Red Sea", "what the person typed is shown instead");
  assert.equal(typed.areaName, null);

  const list: InboxPositionRecord[] = [];
  addInboxPositionRecord(list, upper);
  addInboxPositionRecord(list, inboxPositionRecord("medical_rep", "UE", null, "Qena 1"));
  addInboxPositionRecord(list, inboxPositionRecord("medical_rep", "UE", null, "Qena 2"));
  addInboxPositionRecord(list, inboxPositionRecord("district_manager", "UE", null, null));
  assert.equal(list.length, 3, "the same job, region and area twice is one chip");

  assert.equal(inboxPlaceText(upper), "Upper Egypt · Qena 1", "the place beside the position reads Region · Area");
  assert.equal(inboxPlaceText({ areaName: null, regionLabel: "Giza" }), "Giza");
  assert.equal(inboxPlaceText({ areaName: null, regionLabel: null }), "", "no place, no chip");
}

function runCvPickTests() {
  const doc = (id: string, conversation: string, sentAt: string | null, fileName: string | null = `${id}.pdf`): InboxDocumentMessage => ({
    conversation_id: conversation,
    id,
    media_file_name: fileName,
    sent_at: sentAt,
  });
  const cvs = pickInboxCvs([
    doc("old", "chat-a", "2026-09-10T08:00:00.000Z"),
    doc("new", "chat-a", "2026-09-15T08:00:00.000Z", "Mona CV 2026.pdf"),
    doc("middle", "chat-a", "2026-09-12T08:00:00.000Z"),
    doc("undated", "chat-a", null),
    doc("only", "chat-b", "2026-09-01T08:00:00.000Z", null),
  ]);
  assert.deepEqual(
    cvs.get("chat-a"),
    { count: 4, fileName: "Mona CV 2026.pdf", messageId: "new" },
    "the newest document opens, whatever order the rows arrive in, and every file is counted",
  );
  assert.deepEqual(cvs.get("chat-b"), { count: 1, fileName: null, messageId: "only" });
  assert.equal(cvs.has("chat-c"), false, "a chat with no document has no Open CV button");
  assert.equal(pickInboxCvs([doc("undated", "chat-d", null), doc("dated", "chat-d", "2026-09-01T00:00:00.000Z")]).get("chat-d")!.messageId, "dated");
}

function runWiringTests() {
  const store = read("src/lib/whatsapp-inbox/store.ts");
  const cvsAt = store.indexOf("async function cvsFor(");
  const cvsBody = store.slice(cvsAt, store.indexOf("\n}\n", cvsAt));
  assert.match(cvsBody, /\.eq\("direction", "inbound"\)/, "only files the PERSON sent count as a CV, never ones Phoenix sent them");
  assert.match(cvsBody, /\.eq\("message_type", "document"\)/, "photos are mostly certificates, so only documents are offered as the CV");
  assert.match(cvsBody, /return pickInboxCvs\(/);
  assert.match(store, /matchesInboxPlaceFilter\(positions\.get\(row\.id\) \?\? \[\], place\)/, "the server narrows the list with the same rule the tests pin");
  assert.match(store, /const place = parseInboxPlaceFilter\(input\)/);

  const route = read("app/api/whatsapp-inbox/conversations/route.ts");
  assert.match(route, /region: url\.searchParams\.get\("region"\)/);
  assert.match(route, /area: url\.searchParams\.get\("area"\)/);

  const screen = read("src/components/whatsapp-inbox/whatsapp-inbox.tsx");
  assert.match(screen, /\{inboxPositionHasRegion\(filters\.position\) \? \(\s*<FilterSelect[\s\S]{0,400}?label="Region"/, "Region shows only for a job hired by region");
  assert.match(screen, /\{inboxPositionHasArea\(filters\.position\) && filters\.region \? \(\s*<FilterSelect[\s\S]{0,400}?label="Area"/, "Area shows only for a Medical Representative with a region chosen");
  assert.match(screen, /area: inboxPositionHasArea\(position\) \? filters\.area : ""/, "changing the position clears an area it does not allow");
  assert.match(screen, /region: inboxPositionHasRegion\(position\) \? filters\.region : ""/, "changing the position clears a region it does not allow");
  assert.match(screen, /onChange=\{\(region\) => applyFilters\(\{ \.\.\.filters, area: "", region \}\)\}/, "changing the region clears the area");
  assert.match(screen, /const place = inboxPlaceText\(position\);/, "the place chip reads the shared label");

  const buttonEnd = screen.indexOf("</button>", screen.indexOf("const place = inboxPlaceText(position);"));
  const linkAt = screen.indexOf("{item.cv ? (", buttonEnd);
  const liEnd = screen.indexOf("</li>", buttonEnd);
  assert.ok(buttonEnd > 0 && linkAt > buttonEnd && linkAt < liEnd, "Open CV sits after the row's button, inside the same row — a link cannot nest in a button");
  const link = screen.slice(linkAt, liEnd);
  assert.match(link, /<a\b/);
  assert.match(link, /href=\{`\/api\/whatsapp-inbox\/media\/\$\{encodeURIComponent\(item\.cv\.messageId\)\}`\}/, "it opens the file through the Super Admin media route");
  assert.match(link, /target="_blank"/, "it opens in a new tab and leaves the chat list where it was");
  assert.match(link, /Open CV/);
}

function runReadStateTests() {
  assert.equal(parseInboxReadState("unread"), "unread");
  assert.equal(parseInboxReadState("read"), "read");
  assert.equal(parseInboxReadState(null), null, "no filter shows every chat");
  assert.equal(parseInboxReadState("1"), null, "an unknown value shows every chat, never an empty list");

  const has = (source: string, text: string, message?: string) => assert.ok(source.includes(text), message ?? `expected: ${text}`);

  const store = read("src/lib/whatsapp-inbox/store.ts");
  has(store, `if (input.readState === "unread") query = query.gt("unread_count", 0);`, "Unread keeps the chats with something unread");
  has(store, `if (input.readState === "read") query = query.eq("unread_count", 0);`, "Read keeps the chats with nothing unread");
  const unreadAt = store.indexOf("export async function markInboxConversationUnread(");
  assert.ok(unreadAt > 0, "a chat can be marked unread");
  const unreadBody = store.slice(unreadAt, store.indexOf("\n}", unreadAt));
  has(unreadBody, "if (row.unread_count > 0) return", "a chat already unread keeps its own count");
  has(unreadBody, ".update({ unread_count: 1,", "a read chat marked unread counts one");

  has(read("app/api/whatsapp-inbox/conversations/route.ts"), `readState: parseInboxReadState(url.searchParams.get("state")),`);
  const readRoute = read("app/api/whatsapp-inbox/conversations/[id]/read/route.ts");
  const fenceAt = readRoute.indexOf("await assertInboxConversationVisibleTo(access, id);");
  assert.ok(fenceAt > 0 && fenceAt < readRoute.indexOf("markInboxConversationUnread(id)"), "the Talent Acquisition fence runs before marking");
  has(readRoute, "if (body.unread === true) {");
  assert.doesNotMatch(readRoute, /sendWhatsApp|graph/i, "marking a chat sends nothing to WhatsApp");

  const screen = read("src/components/whatsapp-inbox/whatsapp-inbox.tsx");
  has(screen, `if (filters.readState) params.set("state", filters.readState);`);
  for (const state of [`""`, `"unread"`, `"read"`]) {
    has(screen, `<Segment active={filters.readState === ${state}} onClick={() => applyFilters({ ...filters, readState: ${state} })}>`, `the ${state} segment filters the list`);
  }
  has(screen, "onClick={() => void markChat(item.id, unread)}", "every row toggles read and unread");
  has(screen, "read ? {} : { unread: true }");
  has(screen, "if (!read && selectedRef.current === conversationId) closeConversation();", "marking the open chat unread closes it, or the next refresh would read it again");
  has(screen, "onMarkUnread={() => void markChat(thread.conversation.id, false)}");
  const thread = read("src/components/whatsapp-inbox/inbox-thread.tsx");
  const markAt = thread.indexOf("onClick={onMarkUnread}");
  assert.ok(markAt > 0 && thread.indexOf("Mark as unread", markAt) - markAt < 200, "the open chat offers Mark as unread");
}

export async function runWhatsAppInboxFilterAndCvTests() {
  runCascadeTests();
  runMatchTests();
  runAreaOptionTests();
  runRecordTests();
  runCvPickTests();
  runWiringTests();
  runReadStateTests();
}
