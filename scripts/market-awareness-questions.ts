/**
 * Market Awareness module — the owner's specification decisions, as one sheet.
 *
 * WHY THIS IS A SHEET AND NOT A QUESTION IN CHAT. Owner rule: a business-fact question with one row
 * per item goes out as an xlsx with a locked dropdown, carrying the context that makes the call
 * easy. Forty-odd build decisions asked one at a time in chat is how a specification takes a week.
 *
 * NOTHING HERE BUILDS ANYTHING. Every row is a decision that changes the design, and the design is
 * not written until the sheet comes back. The recommendation column exists so a row can be answered
 * by agreeing with it — a sheet that needs original thought on all 44 rows does not get filled in.
 *
 * THE FACTS SHEET IS NOT DECORATION. Three of these questions (the brick source, the region
 * cascade, the vacant areas) were re-shaped by what production actually holds, and the owner cannot
 * check a recommendation whose basis he cannot see. Every figure on that sheet was measured against
 * the production project ozucdzovmcqvepbozvqf on 2026-09-06, not remembered.
 *
 * EXCELJS REPAIR TRAPS AVOIDED BY CONSTRUCTION (docs/agents-session-traps.md): no outline group
 * beside pageSetup.fitToPage — that pair makes ExcelJS write <pageSetUpPr/> before <outlinePr/> and
 * Excel discards the whole sheet part — and no images, because ExcelJS writes editAs="oneCell" on
 * every anchor whether asked to or not. Neither is used here, so the zip needs no post-processing.
 *
 * Each answer cell gets its OWN single-cell validation range. The overlapping-sqref repair comes
 * from setting `cell.dataValidation` per row, which ExcelJS coalesces into overlapping ranges;
 * distinct single-cell ranges passed to `dataValidations.add` cannot overlap by construction.
 * Verified structurally against the written zip afterwards, never by looking at a render.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ExcelJS from "exceljs";

const HEADER_FILL = "FF0F172A";
const ACCENT_FILL = "FF0A6BA6";
const ANSWER_FILL = "FFEFF6FF";
const WARN_FILL = "FFFEF3C7";

type SheetWithValidations = ExcelJS.Worksheet & {
  dataValidations: { add: (range: string, rule: Record<string, unknown>) => void };
};

type Question = {
  section: string;
  question: string;
  why: string;
  recommendation: string;
  options: string[];
  /** Set when the row only applies if an earlier answer went a particular way. */
  onlyIf?: string;
};

const OTHER = "Other — see my note";

const QUESTIONS: Question[] = [
  // ------------------------------------------------------------------ module and access
  {
    section: "Module and access",
    question: "What is the module called in the sidebar?",
    why: "You said Awareness, maybe Market Awareness. This is the label every user sees and it becomes the web address, so it is awkward to change later.",
    recommendation: "Market Awareness",
    options: ["Market Awareness", "Awareness", "Market Awareness Activities", OTHER],
  },
  {
    section: "Module and access",
    question: "Who can CREATE an activity request?",
    why: "You said the Group Product Manager and the Product Managers. Today that is exactly three people: Rasha Sabry (GPM), Nahed Tarek (PM) and Ahmed SharafEldeen (PM).",
    recommendation: "GPM and Product Managers only",
    options: ["GPM and Product Managers only", "Also the Marketing Manager", "Also Super Admin", OTHER],
  },
  {
    section: "Module and access",
    question: "Can a Product Manager see another Product Manager's activities?",
    why: "Decides whether the list is private to each person or shared across the marketing team. Both are defensible; it is your call, not a technical one.",
    recommendation: "Own only — GPM and Marketing Manager see all",
    options: ["Own only — GPM and Marketing Manager see all", "Everyone in the module sees all", "Own only — nobody else sees them", OTHER],
  },
  {
    section: "Module and access",
    question: "Who can open the Tracking tab?",
    why: "Tracking shows brick and area sales for the targeted products. That is sales data, so the audience is a permission decision rather than a screen-layout one.",
    recommendation: "Same as the request plus CEO NSM and SFE",
    options: ["Same as the request plus CEO NSM and SFE", "Only the requester and his manager", "Anyone who can already see sales", OTHER],
  },
  {
    section: "Module and access",
    question: "Where does the module live?",
    why: "Product Managers work in the employee portal. The admin shell is the other shell in the system and is where Super Admin work happens.",
    recommendation: "Employee portal only",
    options: ["Employee portal only", "Admin shell only", "Both", OTHER],
  },

  // ------------------------------------------------------------------ the activity
  {
    section: "The activity",
    question: "Confirm the catalogue: Round Table · Symposium · Workshop · Speaker Program · Sponsorship · Ad Board · Conference",
    why: "These are the seven you listed. Worth knowing: Conference already exists as a type inside Marketing Requests and has been used once since launch.",
    recommendation: "The seven as listed",
    options: ["The seven as listed", "The seven plus more — see my note", "Fewer than seven — see my note", OTHER],
  },
  {
    section: "The activity",
    question: "Should the activity list be editable later without a code change?",
    why: "Marketing Requests keeps its types in a table an admin can edit. A table costs a little more now and saves a release every time you add a type.",
    recommendation: "Yes — a table Super Admin can edit",
    options: ["Yes — a table Super Admin can edit", "No — fixed in code", OTHER],
  },
  {
    section: "The activity",
    question: "Retire Conference from Marketing Requests once this module ships?",
    why: "Otherwise the same activity can be raised in two places and neither report is complete. One conference request already exists there from 2026-08-22.",
    recommendation: "Yes — deactivate it there and keep the existing one readable",
    options: ["Yes — deactivate it there", "No — leave both open", "Move the existing one across", OTHER],
  },
  {
    section: "The activity",
    question: "Can one activity target more than one LINE?",
    why: "The region list is not one list — it differs by line. Anti-Infective has 9 regions; CNS and Pedia have 7. Products from two lines make the region cascade ambiguous.",
    recommendation: "One line per activity",
    options: ["One line per activity", "Allow several lines", OTHER],
  },
  {
    section: "The activity",
    question: "Can one activity target more than one BRICK?",
    why: "You said one brick. A large conference may in practice draw doctors from several bricks in the area, and tracking only one would understate it.",
    recommendation: "One brick",
    options: ["One brick", "Allow several bricks", "One main brick plus optional others", OTHER],
  },
  {
    section: "The activity",
    question: "Does the activity need a title of its own?",
    why: "Without one a list reads Round Table · B12 · September three times over. A short title is what makes an activity findable a year later.",
    recommendation: "Yes — a short title, required",
    options: ["Yes — required", "Yes — optional", "No title", OTHER],
  },
  {
    section: "The activity",
    question: "Capture venue, city, expected attendee count and speaker names?",
    why: "All four are cheap to add and each is a thing an auditor asks about a pharmaceutical event. None of them affect the sales tracking either way.",
    recommendation: "All four as optional fields",
    options: ["All four as optional fields", "All four and all required", "None of them", "Only some — see my note"],
  },
  {
    section: "The activity",
    question: "One date or a date range?",
    why: "A conference runs several days; a round table is one evening. The date also decides when the measurement window starts counting.",
    recommendation: "Start date required and end date optional",
    options: ["Start date required and end date optional", "A single date only", "Both dates required", OTHER],
  },

  // ------------------------------------------------------------------ cost and finance
  {
    section: "Cost and finance",
    question: "Cost — one number, or itemised?",
    why: "Itemised (venue · catering · speaker fee · printing · travel) gives Finance something to check against the invoice. One number is faster for the PM to fill in.",
    recommendation: "One total plus an optional breakdown",
    options: ["One total only", "Itemised breakdown required", "One total plus an optional breakdown", OTHER],
  },
  {
    section: "Cost and finance",
    question: "Which currency?",
    why: "Everything else in Phoenix is EGP. An overseas conference would be the exception, and supporting one means storing a rate and the date it was taken.",
    recommendation: "EGP only",
    options: ["EGP only", "EGP and foreign currency", OTHER],
  },
  {
    section: "Cost and finance",
    question: "Is there a budget envelope these activities draw down?",
    why: "Nothing like this exists anywhere in Phoenix today. If yes it is the single most useful thing in the module — a live remaining figure per line. If no we skip it and the build is much smaller.",
    recommendation: "No budget in version one",
    options: ["No budget — skip it", "Yes — per line per year", "Yes — per line per quarter", "Yes — per product", OTHER],
  },
  {
    section: "Cost and finance",
    question: "Who sets the budget figure?",
    why: "Whoever sets it is the only person who can raise it, so this is an access decision as much as a process one.",
    recommendation: "CEO",
    options: ["CEO", "Marketing Manager", "Finance", "Not applicable", OTHER],
    onlyIf: "ONLY IF the budget question above was answered yes",
  },
  {
    section: "Cost and finance",
    question: "What does Finance actually DO when it is informed?",
    why: "You said informed for execution. In Marketing Requests, Finance carries a real obligation — invoice due, finance hold, overdue nudge. That is a considerably bigger build than a notification.",
    recommendation: "Informed only in version one",
    options: ["Informed only", "Full invoice obligation like marketing requests", "Informed plus a paid or not-paid mark", OTHER],
  },
  {
    section: "Cost and finance",
    question: "Record the ACTUAL cost after the activity?",
    why: "Without it every report shows the estimate for ever, and the estimate is what was approved rather than what was spent.",
    recommendation: "Yes — optional actual cost at closure",
    options: ["Yes — required at closure", "Yes — optional at closure", "No", OTHER],
  },
  {
    section: "Cost and finance",
    question: "Who records the actual cost?",
    why: "Finance holds the invoice; the Product Manager holds the context. Whoever it is needs write access to an already-approved record.",
    recommendation: "The Product Manager who raised it",
    options: ["The requesting Product Manager", "Finance", "Either of them", "Not applicable", OTHER],
  },

  // ------------------------------------------------------------------ tracking
  {
    section: "Tracking and measurement",
    question: "The duration you enter — what unit?",
    why: "You said the duration over which you expect awareness and then sales to increase. Months line up with the Monthly Closing, which is the only sales truth in this system.",
    recommendation: "Months",
    options: ["Months", "Weeks", "Quarters", OTHER],
  },
  {
    section: "Tracking and measurement",
    question: "Any limit on that duration?",
    why: "An unlimited window means an activity never finishes being measured and the tracking list grows for ever.",
    recommendation: "1 to 12 months",
    options: ["1 to 12 months", "1 to 6 months", "No limit", OTHER],
  },
  {
    section: "Tracking and measurement",
    question: "How many months BEFORE the activity should the baseline cover?",
    why: "To prove a lift you need something to be up against. Without a baseline the sentence sales went up has no meaning — this is the difference between a report and a number.",
    recommendation: "3 months before",
    options: ["3 months before", "1 month before", "6 months before", "The same months last year", OTHER],
  },
  {
    section: "Tracking and measurement",
    question: "Measure by value or by units?",
    why: "Standing rule: units of different products are never added. As soon as an activity targets more than one product, value is the only valid total.",
    recommendation: "Value always; units too when only one product is targeted",
    options: ["Value always", "Value plus units when one product", "Units only", OTHER],
  },
  {
    section: "Tracking and measurement",
    question: "🔴 The BRICK sales figure — where should it come from?",
    why: "The most important row on this sheet. The published closing stops at AREA and has no brick. The brick functions have no product. Only the raw import rows hold brick and product together, and a raw figure will not tie to the closing.",
    recommendation: "Build one reconciled brick rollup whose bricks sum to the closing's area figure",
    options: ["Build a reconciled brick rollup", "Use raw rows and label them unofficial", "Drop the brick figure — track area only", OTHER],
  },
  {
    section: "Tracking and measurement",
    question: "Include direct orders in the tracking figure?",
    why: "A closing is two halves — distributor invoices plus direct orders folded onto the area. Quoting one half understates the month; that mistake has been made and delivered before.",
    recommendation: "Yes — both halves, exactly as the closing composes them",
    options: ["Yes — both halves", "Distributor invoices only", "Direct orders only", OTHER],
  },
  {
    section: "Tracking and measurement",
    question: "Should the PM set an expected uplift to be judged against?",
    why: "Turns sales went up 4 percent into target was 10 percent and 4 was achieved. It also makes the activity answerable rather than merely reported.",
    recommendation: "Yes — an optional expected uplift percentage",
    options: ["Yes — required", "Yes — optional", "No — show the movement only", OTHER],
  },
  {
    section: "Tracking and measurement",
    question: "Who decides an activity was successful?",
    why: "The system can mark it against the expected uplift, or it can show the numbers and leave the judgement to a person who knows what else was happening in that brick.",
    recommendation: "Show the numbers; the PM writes the verdict; nothing automatic",
    options: ["The PM writes the verdict", "The system marks it automatically", "System suggests and the PM confirms", OTHER],
  },
  {
    section: "Tracking and measurement",
    question: "What if a targeted product is a Head Office product?",
    why: "Head Office is absent from monthly closing tracking by golden rule — those products can never produce a tracking figure, and a permanent zero on screen reads as a broken report.",
    recommendation: "Block them in the picker and say why",
    options: ["Block them and explain why", "Allow but warn that no tracking is possible", "Allow silently", OTHER],
  },

  // ------------------------------------------------------------------ geography and people
  {
    section: "Geography and people",
    question: "Hide the non-territory areas from the picker?",
    why: "37 of the 147 area-and-line combinations are Office, Main Store and similar buckets rather than places. You cannot hold a round table in Office.",
    recommendation: "Hide them",
    options: ["Hide them", "Show them", "Show them greyed out", OTHER],
  },
  {
    section: "Geography and people",
    question: "What should a vacant area show where the rep name goes?",
    why: "41 of 147 area-and-line rows are vacant — the seat exists, nobody is in it. An empty box beside Medical Rep reads as a bug rather than as a fact.",
    recommendation: "Vacant — will hire",
    options: ["Vacant — will hire", "Vacant", "No rep assigned", OTHER],
  },
  {
    section: "Geography and people",
    question: "Which District Manager is informed?",
    why: "You said the DM of this region. A region holds several districts, so region alone does not resolve to one person — the chosen AREA does, and every area has a DM seat.",
    recommendation: "The District Manager of the chosen area",
    options: ["The DM of the chosen area", "Every DM in the region", "The Regional Manager instead", OTHER],
  },
  {
    section: "Geography and people",
    question: "Freeze the rep and DM as they were at approval, or always show today's holder?",
    why: "If the rep changes during a six-month tracking window the report quietly changes meaning. Freezing keeps the record of who it was actually run for.",
    recommendation: "Freeze at approval and show today's holder beside it",
    options: ["Freeze at approval", "Always show today's holder", "Freeze and show today's beside it", OTHER],
  },

  // ------------------------------------------------------------------ workflow
  {
    section: "Workflow",
    question: "If the GROUP PRODUCT MANAGER raises an activity herself, who is the manager step?",
    why: "Rasha reports to Hossam, so her own request would go to the Marketing Manager. Your direct-manager rule already answers this — worth confirming it is what you meant.",
    recommendation: "Her own manager — the Marketing Manager",
    options: ["Her manager the Marketing Manager", "Skip straight to the CEO", OTHER],
  },
  {
    section: "Workflow",
    question: "If the MARKETING MANAGER raises one himself?",
    why: "He reports to the CEO, so there is no manager step underneath. Without a rule the request has nowhere to go and would sit in draft for ever.",
    recommendation: "Skip the manager step — straight to the CEO",
    options: ["Straight to the CEO", "He cannot raise one", OTHER],
  },
  {
    section: "Workflow",
    question: "Is there a cost below which the CEO step is skipped?",
    why: "If every small round table needs the CEO he becomes the bottleneck and the module gets worked around. If every one genuinely needs him, that is a decision and not an oversight.",
    recommendation: "No threshold — the CEO sees all of them",
    options: ["No threshold — CEO sees all", "Yes — a threshold — see my note", OTHER],
  },
  {
    section: "Workflow",
    question: "Can the CEO approve at a REDUCED cost?",
    why: "The common real case is yes but 50,000 not 80,000. Without it he has to return the request and wait for the PM to retype it.",
    recommendation: "Yes — approve with an amended amount, recorded as his",
    options: ["Yes — approve with an amended amount", "No — he returns it instead", OTHER],
  },
  {
    section: "Workflow",
    question: "After a return with comment, where does it go?",
    why: "Either the PM edits and the chain starts again from the manager, or it resumes at the step that returned it. The first is safer; the second is faster.",
    recommendation: "Back to the PM and restart from the manager step",
    options: ["Back to the PM — restart from the manager", "Back to the PM — resume where it stopped", OTHER],
  },
  {
    section: "Workflow",
    question: "Can the PM withdraw his own request?",
    why: "Without it a request raised by mistake sits in the CEO's queue until he rejects it, which puts a rejection on the record for a typing error.",
    recommendation: "Yes — any time before it is approved",
    options: ["Yes — before the CEO decides", "Yes — any time before approval", "No", OTHER],
  },
  {
    section: "Workflow",
    question: "Can an APPROVED activity still be edited?",
    why: "Editing the cost or the brick after approval changes the thing that was approved, and the approval record then describes something that never happened.",
    recommendation: "No — locked after approval; withdraw and raise a new one",
    options: ["No — locked after approval", "Yes — but it re-enters approval", "Yes — freely", OTHER],
  },
  {
    section: "Workflow",
    question: "How many days does each approval step get?",
    why: "Marketing Requests uses 2 days per step. The number only drives the overdue marker and the reminder — it never blocks a decision.",
    recommendation: "2 days, the same as marketing requests",
    options: ["2 days", "3 days", "5 days", "No time limit", OTHER],
  },

  // ------------------------------------------------------------------ notifications
  {
    section: "Notifications",
    question: "On CEO approval the DM, NSM and SFE are informed. Through which channel?",
    why: "The standing pattern in this system is in-app plus Telegram, with email where you have asked for it. You did ask for email on conversations specifically.",
    recommendation: "In-app plus Telegram plus email",
    options: ["In-app plus Telegram plus email", "In-app plus Telegram only", "Email only", OTHER],
  },
  {
    section: "Notifications",
    question: "Can the informed people (DM, NSM, SFE, Finance) reply in the conversation?",
    why: "As described they are read-only. Letting them reply turns the activity into a working thread — useful, but it also means the PM gets messages he has to answer.",
    recommendation: "Yes — they can comment but never approve",
    options: ["Yes — comment only", "No — read only", OTHER],
  },
  {
    section: "Notifications",
    question: "Should the Medical Rep of the area be informed too?",
    why: "He is the person who will meet those doctors afterwards, so he is arguably the one who most needs to know. But 41 of 147 areas have no rep at all.",
    recommendation: "Yes — informed, never an approver",
    options: ["Yes — informed", "No", "Only when the area has a rep", OTHER],
  },

  // ------------------------------------------------------------------ closure
  {
    section: "After the activity",
    question: "Is there a closure step after the activity happens?",
    why: "Something has to move it from approved to done. Without it, approved and already-held look identical for ever and the tracking window has no honest start.",
    recommendation: "Yes — the PM marks it executed with the real date",
    options: ["Yes — the PM marks it executed", "No — approval is the end", "Automatic on the activity date", OTHER],
  },
  {
    section: "After the activity",
    question: "Require evidence at closure?",
    why: "Photographs and an attendance sheet are what an audit asks for on a pharmaceutical event. Requiring them is also the thing most likely to make a PM avoid the module.",
    recommendation: "Optional photos in version one",
    options: ["Optional photos", "Photos required", "Photos and attendance sheet required", "No evidence"],
  },
  {
    section: "After the activity",
    question: "Require a short outcome note at closure?",
    why: "The numbers say what happened to sales. Only the PM can say what happened at the event, and in six months nobody will remember.",
    recommendation: "Yes — required, short free text",
    options: ["Yes — required", "Yes — optional", "No", OTHER],
  },
];

/**
 * Measured against the production project on 2026-09-06. These are the readings the recommendations
 * rest on; a recommendation whose basis the owner cannot see is one he has to take on trust.
 */
const FACTS: [string, string][] = [
  [
    "Brick data is complete enough to track",
    "May to August 2026: brick_id is filled on 100 percent of source rows and 98.2 to 100 percent of value. Brick-level measurement is real, not aspirational — this was the thing most likely to sink the Tracking tab, and it did not.",
  ],
  [
    "🔴 But the published closing has NO brick",
    "phx_closing_distributor_product returns distributor, region, AREA and product. phx_monthly_closing_direct returns region, AREA and product. Neither carries a brick. So the area figure can come from the published closing; the brick figure cannot.",
  ],
  [
    "🔴 And the brick functions have NO product",
    "phx_closing_brick returns distributor, region, area and brick — no product. au.f_sales_brick_detail returns line, area, brick and the rep and DM seats — no product. Brick and product exist together only in source_of_sales_import_rows, which is the raw import before corrections, Office allocation, price revaluation and the unmapped exclusion.",
  ],
  [
    "What that means for the Tracking tab",
    "Built naively, the brick figure and the area figure sitting side by side come from two different sources, will not add up, and the brick number would quietly contradict the Monthly Closing. The recommendation is one reconciled rollup whose bricks sum to the closing's area figure, with that check visible on the screen.",
  ],
  [
    "The region list differs by line",
    "Anti-Infective spans 9 regions. CNS and Pedia span 7 each. All three cover 49 areas. So the region dropdown depends on which line the targeted products belong to — which is why one line per activity is the recommendation.",
  ],
  [
    "Vacant areas are common, not an edge case",
    "Of 147 area-and-line rows: 69 occupied, 41 vacant_will_hire (the seat exists, nobody is in it), 26 other_permanent and 11 other_line_specific. Your instruction to include vacant areas covers 41 real rows — about 28 percent of the list.",
  ],
  [
    "Every area resolves to a District Manager",
    "au.line_area_map carries the area, its region, the rep seat and the DM seat, dated. Not one row is missing a DM seat, so the notification on CEO approval will always find somebody. That same table also drives the region cascade and the rep auto-populate.",
  ],
  [
    "The conversation with email already exists",
    "src/lib/conversations/notify.ts is your own rule from 2026-09-03 — email to the submitter, CC the sender and every participant, in-app and Telegram to everyone except the author. Market Awareness plugs into it rather than rebuilding it.",
  ],
  [
    "Conference already exists in Marketing Requests",
    "It is request type 5, active since launch, used exactly once on 2026-08-22. For scale there have been 32 marketing requests in total across all types. That is why one row on the Questions sheet asks whether to retire it there.",
  ],
  [
    "Why a conference never fitted Marketing Requests",
    "marketing_requests.customer_id is NOT NULL — every request is anchored to exactly one validated customer, and a conference has a venue and many doctors. The live chain also runs Manager, then SFE Validation, then Marketing Review, then CEO, then Finance — two of those steps exist only because the requester is field force.",
  ],
];

function addTitle(sheet: ExcelJS.Worksheet, columns: number, title: string, subtitle: string): void {
  sheet.mergeCells(1, 1, 1, columns);
  const titleCell = sheet.getCell("A1");
  titleCell.value = title;
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT_FILL } };
  titleCell.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
  titleCell.alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(1).height = 30;

  sheet.mergeCells(2, 1, 2, columns);
  const subtitleCell = sheet.getCell("A2");
  subtitleCell.value = subtitle;
  subtitleCell.font = { size: 10, color: { argb: "FF475569" } };
  subtitleCell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  sheet.getRow(2).height = 46;
}

function addLabelledRows(sheet: ExcelJS.Worksheet, startRow: number, rows: [string, string][], height: number): void {
  rows.forEach(([label, body], index) => {
    const row = sheet.getRow(startRow + index);
    row.getCell(1).value = label;
    row.getCell(1).font = { bold: true, size: 10, color: { argb: HEADER_FILL } };
    row.getCell(1).alignment = { vertical: "top", wrapText: true };
    row.getCell(2).value = body;
    row.getCell(2).font = { size: 10 };
    row.getCell(2).alignment = { vertical: "top", wrapText: true };
    row.height = height;

    if (label.startsWith("🔴")) {
      row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: WARN_FILL } };
      row.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: WARN_FILL } };
    }
  });
}

function buildReadMe(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet("Read me", { properties: { tabColor: { argb: ACCENT_FILL } } });
  sheet.columns = [{ width: 34 }, { width: 110 }];

  addTitle(
    sheet,
    2,
    "Market Awareness — the decisions before anything is built",
    "Every row on the Questions sheet changes the design. Nothing has been built yet and nothing will be until this comes back. "
      + "Answer by picking from the dropdown; if the recommendation is right, pick the same option.",
  );

  addLabelledRows(sheet, 4, [
    [
      "How to fill this in",
      "Go to the Questions sheet. Read the recommendation, pick an answer from the dropdown in the blue column, and write anything extra in the Note column. "
        + "If none of the options fit, pick 'Other — see my note' and say what you want in the note.",
    ],
    [
      "A half-finished sheet is fine",
      "Send it back with whatever you have answered. Nothing here runs anything and nothing is destructive. The rows you leave blank simply stay open.",
    ],
    [
      "🔴 The one row that matters most",
      "'The BRICK sales figure — where should it come from?' in the Tracking section. The published Monthly Closing has no brick in it, so the brick number cannot "
        + "come from the same place as the area number without new work. The What I checked sheet sets it out with the actual table names.",
    ],
    [
      "Rows where a wrong answer is expensive",
      "The brick source, the budget envelope, and what Finance actually does. Each of those three changes the size of the build by a large amount, not by a detail.",
    ],
    [
      "Rows you can answer in one second",
      "Most of them. The recommendation column is there so that agreeing is a complete answer — a sheet needing original thought on all 44 rows does not get filled in.",
    ],
    [
      "What is NOT being asked here",
      "Anything I can decide without changing the outcome — field order, column widths, label wording, which icon. Those follow the sibling pages in the portal and the "
        + "golden rules: no horizontal scroll at desktop or mobile, square corners, no text cut off with dots, names never codes, Cairo time.",
    ],
    [
      "What happens when it comes back",
      "I write the table design and the reconciliation rule for the brick rollup, show you both, and only then start building. One production deployment for the whole module, not one per phase.",
    ],
    [
      "Where the numbers come from",
      "Everything on the What I checked sheet was measured against the production database on 2026-09-06. None of it is remembered or assumed. If a figure there looks "
        + "wrong to you, say so — it changes the recommendation resting on it.",
    ],
  ], 48);
}

function buildFacts(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet("What I checked", { properties: { tabColor: { argb: HEADER_FILL } } });
  sheet.columns = [{ width: 40 }, { width: 114 }];

  addTitle(
    sheet,
    2,
    "What I checked in production before recommending anything",
    "Measured against the production project ozucdzovmcqvepbozvqf on 2026-09-06. These readings are what the recommendations rest on.",
  );

  addLabelledRows(sheet, 4, FACTS, 58);
}

/**
 * Excel's inline list is a comma-separated string capped at 255 characters. A comma inside an option
 * silently splits it into two choices; a list over the cap is dropped entirely and the cell ends up
 * with no dropdown at all — which looks exactly like a sheet that was built without one. Both
 * failures are silent, so they are asserted here rather than hoped for.
 */
function inlineList(options: string[]): string {
  options.forEach((option) => {
    if (option.includes(",")) {
      throw new Error(`Option contains a comma and would split into two choices: ${option}`);
    }
  });
  const joined = options.join(",");
  if (joined.length > 253) {
    throw new Error(`Option list is ${joined.length} characters, over Excel's 255 cap: ${joined}`);
  }
  return `"${joined}"`;
}

function buildQuestions(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet("Questions", { properties: { tabColor: { argb: ACCENT_FILL } } });
  sheet.columns = [
    { width: 5 },
    { width: 22 },
    { width: 58 },
    { width: 74 },
    { width: 46 },
    { width: 44 },
    { width: 38 },
  ];

  addTitle(
    sheet,
    7,
    `Market Awareness — ${QUESTIONS.length} decisions`,
    "Pick an answer in the blue column. Agreeing with the recommendation is a complete answer. "
      + "If nothing fits, choose 'Other — see my note' and write it in the last column.",
  );

  const headerRow = 4;
  const header = sheet.getRow(headerRow);
  header.values = ["#", "Section", "Question", "Why it matters", "My recommendation", "YOUR ANSWER", "Your note"];
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  });
  header.height = 26;

  let previousSection = "";

  QUESTIONS.forEach((entry, index) => {
    const rowNumber = headerRow + 1 + index;
    const row = sheet.getRow(rowNumber);

    row.getCell(1).value = index + 1;
    row.getCell(2).value = entry.section === previousSection ? "" : entry.section;
    row.getCell(3).value = entry.question;
    row.getCell(4).value = entry.onlyIf ? `${entry.onlyIf}. ${entry.why}` : entry.why;
    row.getCell(5).value = entry.recommendation;

    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.alignment = { vertical: "top", wrapText: true };
      cell.font = { size: 10 };
    });

    // The section label is the only bold thing in the body, so the eye finds the group boundary
    // without a merged cell — a merged cell breaks the autofilter and any sort.
    if (entry.section !== previousSection) {
      row.getCell(2).font = { bold: true, size: 10, color: { argb: HEADER_FILL } };
      for (let column = 1; column <= 7; column += 1) {
        row.getCell(column).border = { top: { style: "thin", color: { argb: ACCENT_FILL } } };
      }
    }
    previousSection = entry.section;

    row.getCell(5).font = { size: 10, italic: true, color: { argb: "FF334155" } };
    row.getCell(6).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };
    row.getCell(7).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ANSWER_FILL } };

    if (entry.question.startsWith("🔴")) {
      for (let column = 1; column <= 5; column += 1) {
        row.getCell(column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: WARN_FILL } };
      }
    }

    row.height = 62;

    // One validation per answer cell, each with its own single-cell range. Every question has its
    // own option list, so a shared range is impossible here; distinct single-cell ranges are what
    // keeps the sqref list free of the overlaps that trigger Excel's repair dialog on open.
    (sheet as SheetWithValidations).dataValidations.add(`F${rowNumber}`, {
      type: "list",
      allowBlank: true,
      formulae: [inlineList(entry.options)],
      showErrorMessage: true,
      errorTitle: "Pick one from the list",
      error: "Choose an option, or pick 'Other — see my note' and write what you want in the Note column.",
    });
  });

  const lastRow = headerRow + QUESTIONS.length;
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: headerRow }];
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: lastRow, column: 7 } };
}

function nextFreePath(): string {
  // Africa/Cairo, not UTC. toISOString() would date the file a day early for the three hours after
  // Cairo midnight, which is exactly when this repository is often worked.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const base = resolve("xlsx", `market-awareness-questions-${today}`);
  const first = `${base}.xlsx`;
  if (!existsSync(first)) return first;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${base}-${attempt}.xlsx`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Too many Market Awareness question sheets written today — clear xlsx/ before rerunning.");
}

async function main(): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce — Market Awareness specification";
  workbook.created = new Date();

  buildReadMe(workbook);
  buildQuestions(workbook);
  buildFacts(workbook);

  const outputPath = nextFreePath();
  mkdirSync(dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);

  const sections = [...new Set(QUESTIONS.map((entry) => entry.section))];
  console.log(`Wrote ${outputPath}`);
  console.log(`${QUESTIONS.length} questions across ${sections.length} sections:`);
  for (const section of sections) {
    console.log(`  ${QUESTIONS.filter((entry) => entry.section === section).length}\t${section}`);
  }
}

await main();
