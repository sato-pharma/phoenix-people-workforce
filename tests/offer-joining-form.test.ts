import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";

/**
 * The offer joining form (owner, 2026-10-08).
 *
 * The offer email carries ONE button — "Accept the offer — complete your joining form" — and one
 * line telling him to reply to decline. The button opens /join/[token], a Sato-branded public page
 * with no login: he sees his position and pay, types his own personal details, and Submit IS his
 * acceptance — it creates his Employee Master record, seated in the AU organogram, through the same
 * chain HR's Add Employee runs.
 *
 * PURE: the suite runs with production credentials, so this file calls only modules that do no I/O,
 * hands the two service reads it calls a fake database, and reads the rest as source. Each section
 * names the failure it stops.
 */

const root = process.cwd();
const code = (relative: string) => stripComments(readFileSync(path.join(root, relative), "utf8"));
const flat = (relative: string) => code(relative).replace(/\s+/g, " ");

/**
 * A stand-in for `db.from("employees")` that behaves like PostgREST where these checks depend on it:
 * rows come back in the order given, `limit` cuts them, `range` returns one window of them (the shared
 * pager walks the table with it, ordering by a tiebreak column the stand-in leaves alone), and only the
 * selected columns come back, so a read that forgets `employment_status` or keeps `limit(1)` fails here
 * as it would on production.
 */
function fakeEmployeesDb(rows: Array<Record<string, unknown>>, failing?: "identity" | "recent") {
  const orFilters: string[] = [];
  const from = () => {
    let columns: string[] = [];
    let cut: number | null = null;
    let offset = 0;
    let kept = [...rows];
    let isFailing = false;
    const builder = {
      eq(column: string, value: unknown) {
        kept = kept.filter((row) => row[column] === value);
        return builder;
      },
      gte(column: string, value: string) {
        if (failing === "recent") isFailing = true;
        kept = kept.filter((row) => String(row[column]) >= value);
        return builder;
      },
      limit(count: number) {
        cut = count;
        return builder;
      },
      order() {
        return builder;
      },
      range(start: number, end: number) {
        offset = start;
        cut = end - start + 1;
        return builder;
      },
      or(filter: string) {
        orFilters.push(filter);
        if (failing === "identity") isFailing = true;
        kept = kept.filter(
          (row) => filter.includes(`national_id.eq."${String(row.national_id)}"`) || filter.includes(`mobile_number.eq."${String(row.mobile_number)}"`),
        );
        return builder;
      },
      select(list: string) {
        columns = list.split(",");
        return builder;
      },
      then(resolve: (value: { data: unknown; error: unknown }) => void) {
        if (isFailing) return resolve({ data: null, error: { message: "read failed" } });
        const shown = (cut === null ? kept.slice(offset) : kept.slice(offset, offset + cut)).map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
        return resolve({ data: shown, error: null });
      },
    };
    return builder;
  };
  return { from, orFilters };
}

export async function runOfferJoiningFormTests() {
  const previousSecret = process.env.PHOENIX_AUTH_SECRET;
  if (!previousSecret) process.env.PHOENIX_AUTH_SECRET = "offer-joining-form-test-secret";
  try {
    await run();
  } finally {
    if (!previousSecret) delete process.env.PHOENIX_AUTH_SECRET;
  }
}

async function run() {
  const token = await import("../src/lib/offers/accept-token.ts");
  const form = await import("../src/lib/offers/joining-form.ts");
  const email = await import("../src/lib/offers/render-email.ts");
  const { OFFER_BUILTIN_TEMPLATES } = await import("../src/lib/offers/builtin-templates.ts");

  // 1. 🔴 THE LINK IS A CAPABILITY — a forged, edited, expired or re-shaped token opens nothing.
  const now = Math.floor(Date.parse("2026-10-08T10:00:00Z") / 1000);
  const issued = token.issueOfferAcceptToken({ nowSeconds: now, offerId: "offer-1", validUntil: "15 October 2026" });
  assert.equal(token.readOfferAcceptToken(issued, now), "offer-1", "a genuine link names its offer");
  const [encoded, signature] = issued.split(".");
  const forged = Buffer.from(JSON.stringify({ exp: now + 999_999, o: "offer-2", v: 1 }), "utf8").toString("base64url");
  assert.equal(token.readOfferAcceptToken(`${forged}.${signature}`, now), null, "another offer's id under this signature is refused");
  assert.equal(token.readOfferAcceptToken(`${encoded}.${signature.slice(0, -2)}xx`, now), null, "an edited signature is refused");
  assert.equal(token.readOfferAcceptToken(`${issued}.extra`, now), null, "a three-part token is refused");
  assert.equal(token.readOfferAcceptToken("", now), null);
  //    Expiry: the letter's own validity date plus the grace, never forever.
  const validEnd = Math.floor(Date.parse("2026-10-15T23:59:59Z") / 1000);
  assert.equal(token.offerAcceptExpiry("15 October 2026", now), validEnd + token.OFFER_ACCEPT_GRACE_DAYS * 86_400);
  assert.equal(token.readOfferAcceptToken(issued, validEnd + token.OFFER_ACCEPT_GRACE_DAYS * 86_400 + 1), null, "past the grace the link is dead");
  assert.equal(token.offerAcceptExpiry("not a date", now), now + token.OFFER_ACCEPT_FALLBACK_DAYS * 86_400, "an unreadable date falls back, never to no expiry");
  assert.match(token.offerAcceptUrl(issued), /^https:\/\/[^/]+\/join\//, "the button opens the public /join page over https");

  // 2. 🔴 THE OFFER ROW, NOT THE TOKEN, DECIDES WHETHER THE FORM OPENS.
  const state = (over: Partial<Parameters<typeof form.joiningFormState>[0]>) =>
    form.joiningFormState({ employeeHrId: null, requiresSeat: false, seatOpen: false, status: "sent", ...over });
  assert.equal(state({}), "open");
  assert.equal(state({ status: "accepted" }), "open", "HR marking it accepted by hand still lets him fill the form");
  assert.equal(state({ employeeHrId: "B-99" }), "submitted", "once a record exists the form never opens again — no second employee");
  assert.equal(state({ status: "withdrawn" }), "withdrawn");
  assert.equal(state({ status: "declined" }), "declined");
  assert.equal(state({ status: "draft" }), "not_sent");
  assert.equal(state({ requiresSeat: true, seatOpen: false }), "seat_unavailable", "a sales offer whose seat filled since cannot seat him");
  assert.equal(state({ requiresSeat: true, seatOpen: true }), "open");

  // 3. 🔴 A SEAT IS REQUIRED FOR SALES OFFERS ONLY (owner: "only for sales team, medical reps or district managers").
  assert.equal(form.offerRequiresSeat("Medical Representative"), true);
  assert.equal(form.offerRequiresSeat("District Sales Manager"), true);
  assert.equal(form.offerRequiresSeat("District Manager"), true);
  assert.equal(form.offerRequiresSeat("HR Specialist"), false);
  assert.equal(form.offerRequiresSeat("Accountant"), false);
  assert.equal(form.offerRequiresSeat(""), false);
  const send = flat("src/lib/offers/send.ts");
  assert.match(send, /if \(offerRequiresSeat\(offer\.title\) && !offer\.vacancyId\) \{? ?throw new Error\(OFFER_SEAT_REQUIRED_MESSAGE\)/, "Send refuses a sales offer with no seat");
  //    That refusal is HR's to fix, so it answers 400 and never a 500 that reads as a server fault, and
  //    the screen says it before asking at all. The seat one reached the System Audit (1 Nov 2026).
  assert.match(
    flat("src/lib/offers/http.ts"),
    /if \(message === OFFER_SEAT_REQUIRED_MESSAGE \|\| message === OFFER_START_DATE_REQUIRED_MESSAGE\) \{ return NextResponse\.json\(\{ message, success: false \}, \{ status: 400 \}\)/,
    "a missing seat or start date is a 400 refusal",
  );
  assert.match(
    flat("src/components/offers/offer-composer.tsx"),
    /if \(offerRequiresSeat\(draft\.title\) && !draft\.vacancyId\) \{ onReport\(OFFER_SEAT_REQUIRED_MESSAGE, "error"\); return; \}/,
    "the composer stops a sales letter with no seat before it asks the server",
  );

  // 4. THE NATIONAL ID FILLS AND CHECKS DATE OF BIRTH AND GENDER.
  assert.deepEqual(form.readEgyptianNationalId("29501150101234"), { birthDate: "1995-01-15", gender: "male" });
  assert.deepEqual(form.readEgyptianNationalId("30302280101222"), { birthDate: "2003-02-28", gender: "female" });
  assert.deepEqual(form.readEgyptianNationalId("٢٩٥٠١١٥٠١٠١٢٣٤"), { birthDate: "1995-01-15", gender: "male" }, "Arabic digits read");
  assert.equal(form.readEgyptianNationalId("29502300101234"), null, "30 February is not a date");
  assert.equal(form.readEgyptianNationalId("1950115010123"), null, "13 digits is not an ID");
  assert.equal(form.normalizeEgyptianMobile("+20 100 123 4567"), "01001234567");
  assert.equal(form.normalizeEgyptianMobile("٠١١٢٣٤٥٦٧٨٩"), "01123456789");
  assert.equal(form.normalizeEgyptianMobile("0131234567"), null, "013 is not a mobile prefix");

  const good = {
    birthDate: "1995-01-15",
    education: "Pharmacy",
    educationOther: "",
    fullName: "Mona Adel Hassan",
    gender: "male",
    mobileNumber: "01001234567",
    nationalId: "29501150101234",
    personalEmail: "Mona@Example.com",
    residenceAddress: "12 Tahrir Street",
    residenceArea: "المعادي",
    residenceAreaOther: "",
    residenceCity: form.JOINING_FORM_GOVERNORATES[0].value,
  };
  const context = { residenceAreaOptions: ["المعادي"], todayIso: "2026-10-08" };
  const ok = form.validateJoiningForm(good, context);
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.value?.personalEmail, "mona@example.com");
  assert.equal(ok.value?.residenceArea, "المعادي");
  const wrongGender = form.validateJoiningForm({ ...good, gender: "female" }, context);
  assert.ok(wrongGender.errors.gender, "a gender that contradicts the national ID is refused");
  assert.ok(form.validateJoiningForm({ ...good, birthDate: "1995-01-16" }, context).errors.birthDate, "so is a birth date");
  assert.ok(form.validateJoiningForm({ ...good, personalEmail: "mona.adel@satopharma.com" }, context).errors.personalEmail, "a company address is not his private email");
  assert.ok(form.validateJoiningForm({ ...good, residenceArea: "Somewhere" }, context).errors.residenceArea, "the area must be one of the seat's own");
  const other = form.validateJoiningForm({ ...good, residenceArea: form.JOINING_FORM_OTHER_AREA, residenceAreaOther: "Zahraa El Maadi" }, context);
  assert.equal(other.value?.residenceArea, "Zahraa El Maadi", "or typed, when he chose 'not listed'");
  const noBricks = form.validateJoiningForm({ ...good, residenceArea: "Nasr City" }, { ...context, residenceAreaOptions: [] });
  assert.equal(noBricks.value?.residenceArea, "Nasr City", "a seat with no bricks (a district manager's) takes a typed area");
  assert.ok(form.validateJoiningForm({ ...good, residenceCity: "Atlantis" }, context).errors.residenceCity, "the city must be a governorate");
  assert.ok(form.validateJoiningForm({ ...good, education: "Other" }, context).errors.educationOther, "Other needs the faculty written");

  // 5. 🔴 THE EMAIL: ONE ACCEPT BUTTON, A REPLY TO DECLINE — and the frozen design keeps its rules.
  const SAMPLE = {
    candidateEmail: "samaa@example.com",
    candidateName: "SAMAA SHALABY",
    contractTerm: "One year, renewable",
    costOfLiving: 3500,
    dateOfIssue: "27-Aug-26",
    reference: "SP-HR-DSM-2026-019",
    reportsTo: "National Sales Manager",
    roleSummary: "",
    salutationName: "Dr SAMAA SHALABY",
    startDate: "1 September 2026",
    territory: "Delta (3)",
    title: "District Sales Manager",
    totalMonthly: 30000,
    validUntil: "1 September 2026",
  };
  const acceptUrl = "https://phoenix-hr.satopharma.com/join/abc.def";
  for (const builtin of OFFER_BUILTIN_TEMPLATES) {
    const withButton = email.renderOfferEmail({ blocks: builtin.blocks(), theme: builtin.theme }, SAMPLE, { acceptUrl });
    assert.ok(withButton.html.includes(`href="${acceptUrl}"`), `${builtin.name}: the Accept button links to the joining form`);
    assert.ok(withButton.html.includes(email.OFFER_ACCEPT_BUTTON_LABEL), `${builtin.name}: with its words`);
    assert.ok(withButton.html.includes(email.OFFER_DECLINE_LINE), `${builtin.name}: and the reply-to-decline line`);
    assert.ok(!/decline[^<]{0,40}<\/a>/i.test(withButton.html), `${builtin.name}: there is NO decline button`);
    assert.ok(withButton.text.includes(acceptUrl) && withButton.text.includes(email.OFFER_DECLINE_LINE), `${builtin.name}: the plain-text part says the same`);
    const presentation = (withButton.html.match(/role="presentation"/g) ?? []).length;
    const tables = (withButton.html.match(/<table/g) ?? []).length;
    assert.equal(presentation, tables, `${builtin.name}: the answer block keeps every table role="presentation"`);
    assert.ok(!/\d\s*pt\b/i.test(withButton.html), `${builtin.name}: no pt units`);

    //    ONE way to accept (owner, 2026-10-08, "button only"; again 2026-10-15, "drop the
    //    sign-and-return wording from the offer email, button only"): the email no longer also asks
    //    him to sign and return the letter. The PDF keeps its signature page — only the email
    //    changes.
    //
    //    The first three patterns are the letters' own three sign-and-return instructions, and the
    //    third is why this list is not just `signing below`: the closing sentence was caught from
    //    the day the button shipped, while the FIRST of the next steps — "Sign the acceptance below
    //    and return a scanned copy … shown on page 1" — went out in every offer email for a week,
    //    unasserted, telling the candidate to print the letter two panels above the button that
    //    replaced it (measured on the live Corporate letter, 15 Oct 2026). `page 1` goes with it:
    //    a page number belongs to the attachment, never to a scrolling message.
    for (const part of [withButton.html, withButton.text]) {
      assert.ok(!/signing below/i.test(part), `${builtin.name}: the email no longer asks him to sign and return`);
      assert.ok(!/Print it, sign it/i.test(part), `${builtin.name}: nor to print and scan the signature page`);
      assert.ok(!/sign the acceptance/i.test(part), `${builtin.name}: nor to sign the acceptance in the steps`);
      assert.ok(!/scanned copy/i.test(part), `${builtin.name}: nor to return a scanned copy`);
      assert.ok(!/page 1\b/i.test(part), `${builtin.name}: and no step points at a page of the PDF`);
      assert.ok(part.includes(email.OFFER_ACCEPT_STEP_TEXT), `${builtin.name}: that step is the button's step instead`);
    }

    //    The plain-text part is read as TEXT: the blocks are stored as HTML, so `Sign &amp; return`
    //    and `Medical Rep &middot; Alexandria North` printed their entities literally in any client
    //    that shows the text alternative (measured on the live Corporate letter, 15 Oct 2026).
    const ENTITY = /&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i;
    assert.ok(!ENTITY.test(withButton.text), `${builtin.name}: the plain-text part carries no HTML entity (${withButton.text.match(ENTITY)?.[0]})`);
    assert.ok(
      !ENTITY.test(email.renderOfferEmail({ blocks: builtin.blocks(), theme: builtin.theme }, SAMPLE).text),
      `${builtin.name}: nor does the one sent with no button`,
    );

    //    And it is said ONCE. The closing sentence used to be rewritten into a second "press the
    //    Accept button" line, which then sat directly above the answer panel's own lead.
    const leadInHtml = withButton.html.split(email.OFFER_ACCEPT_LEAD).length - 1;
    assert.equal(leadInHtml, 1, `${builtin.name}: the accept lead is in the email exactly once`);
    assert.ok(
      !/press the Accept button below/i.test(withButton.html),
      `${builtin.name}: and the letter's own prose no longer repeats it`,
    );

    const without = email.renderOfferEmail({ blocks: builtin.blocks(), theme: builtin.theme }, SAMPLE);
    assert.ok(!without.html.includes(email.OFFER_ACCEPT_BUTTON_LABEL), `${builtin.name}: no link, no button — a send that could not mint one still goes out`);
    assert.ok(
      !/signing below/i.test(builtin.blocks().map((b: { props?: { html?: unknown } }) => String(b.props?.html ?? "")).join(" ")) ||
        /signing below/i.test(without.html),
      `${builtin.name}: with no button, the letter's own sign-and-return wording stands`,
    );
  }
  const deliver = flat("src/lib/offers/send.ts");
  assert.match(deliver, /issueOfferAcceptToken\(/, "the send mints the link");
  assert.match(deliver, /renderOfferEmail\([^)]*\{[^}]*acceptUrl/, "and hands it to the email renderer");

  // 6. 🔴 OPENING THE LINK CHANGES NOTHING — a mail scanner follows every link. Only POST accepts.
  const page = code("app/join/[token]/page.tsx");
  assert.ok(!/submitJoiningForm|upsertEmployee|\.insert\(|\.update\(/.test(page), "the page only reads");
  const route = code("app/api/public/offer-acceptance/[token]/route.ts");
  assert.ok(/export async function POST/.test(route) && !/export async function GET/.test(route), "the accepting route is POST only");
  assert.match(route, /assertApiRateLimit\(/, "and rate-limited");
  const registry = flat("src/lib/security/access-registry.ts");
  assert.match(registry, /tokenApi\(\{ authMode: "public-token", methods: \["POST"\], pattern: "\/api\/public\/offer-acceptance\/:token"/, "registered as a public-token POST");

  // 7. 🔴 THE HIRE GOES THROUGH HR'S OWN CHAIN, IN ITS ORDER — so a joiner lands exactly where HR's
  //    Add Employee would have put him (HR ID, seat, vacancy closed, login, CRM, mailbox).
  const service = code("src/lib/offers/joining-form-service.ts");
  const hr = code("app/api/employees/route.ts");
  const chain = ["upsertEmployee(", "provisionNewHireAccess(", "openAndAnnounceCrmAccountSetup(", "openAndAnnounceNewHireMailboxes("];
  for (const call of chain) {
    assert.ok(hr.includes(call), `HR's Add Employee still calls ${call}`);
    assert.ok(service.includes(call), `the joining form calls ${call} too`);
  }
  const at = chain.map((call) => service.indexOf(call));
  assert.deepEqual([...at].sort((a, b) => a - b), at, "in the same order");
  //    The claim comes BEFORE the record, so two presses of Submit make one employee.
  assert.ok(service.indexOf("claimOfferForJoiningForm(") < service.indexOf("upsertEmployee("), "claim before create");
  const claim = flat("src/lib/offers/service.ts");
  assert.match(claim, /\.is\("employee_hr_id", null\) \.in\("status", \["sent", "accepted"\]\)/, "the claim is conditional on no record yet");
  //    Only HIS fields come from the body — job, seat and pay come from the offer.
  assert.ok(!/answers\.(jobTitle|lineId|areaId|managerHrId|netSalary|hireDate)/.test(service), "the body never sets the job, seat or pay");
  //    🔴 Pay is the Employee Master's chain from the offer's net, fed PAYROLL's allowances — the
  //    title table falls back to 1,500 and would have paid a District Manager over the agreed net.
  const flatService = flat("src/lib/offers/joining-form-service.ts");
  assert.match(flatService, /const payroll = resolveStandardSalaryAllowances\(\{/, "payroll's own allowance resolver sets the allowances");
  assert.match(
    flatService,
    /deriveSalaryFromNet\(\{ extraCostOfLiving: payroll\.extraCostOfLiving, fuelAllowance: payroll\.fuelAllowance, jobTitle, netSalary: offer\.totalMonthly, \}\)/,
    "and they feed the Employee Master's chain from the offer's net",
  );

  // 8. 🔴 HR EDITS NEVER WIPE THE PERSONAL EMAIL — the field is written only when it is sent.
  assert.match(
    flat("src/lib/employees/employee-directory.ts"),
    /\.\.\.\(input\.personalEmail !== undefined \? \{ personal_email:/,
    "personal_email is an optional field written only when present",
  );

  // 9. 🔴 NO RECORD WITHOUT A START DATE — an offer with no readable hire date neither opens nor submits.
  assert.match(flatService, /if \(!draft\.hireDate\) return \{ \.\.\.JOINING_FORM_STATE_MESSAGE\.start_date_pending/, "the page closes, naming the start date");
  assert.match(form.JOINING_FORM_STATE_MESSAGE.start_date_pending.title, /start date/, "and says so — never \"your position is being confirmed\"");
  //    🔴 AND NO OFFER LEAVES WITHOUT ONE (owner, 2026-10-08): one did, and its button could never work.
  const sendSource = flat("src/lib/offers/send.ts");
  assert.match(sendSource, /if \(!offerHireDate\(offer\.startDate\)\) \{ throw new Error\(OFFER_START_DATE_REQUIRED_MESSAGE\)/, "the send refuses a dateless offer");
  assert.ok(sendSource.indexOf("OFFER_START_DATE_REQUIRED_MESSAGE)") < sendSource.indexOf("sendPhoenixEmail("), "before any mail leaves");
  assert.match(
    flat("src/components/offers/offer-composer.tsx"),
    /if \(!draft\.startDate\) \{ onReport\(OFFER_START_DATE_REQUIRED_MESSAGE, "error"\); return; \}/,
    "and the composer says why before saving",
  );
  assert.match(flatService, /if \(!draft\.hireDate\) \{ await announceJoiningFormBlocked\(/, "the submit refuses and tells HR");

  // 10. 🔴 A JOINER HR ALREADY HIRED IS NOT HIRED TWICE — Add Employee never stamps the offer, so the
  //     check is the national ID or mobile on a current record, or the name on a record made since sending.
  assert.match(flatService, /\.or\( \[ quotedOrClause\("national_id", "eq", answers\.nationalId\), quotedOrClause\("mobile_number", "eq", answers\.mobileNumber\), \]\.join\(","\), \)/, "ID or mobile on file");
  assert.match(flatService, /\.gte\("created_at", since\)/, "records made since the offer went out");
  assert.match(flatService, /if \(existing\.kind === "unknown"\) \{ return \{ message: "We could not complete/, "a failed read blocks, never passes");
  assert.ok(flatService.indexOf("findExistingHire(offer, value)") < flatService.indexOf("claimOfferForJoiningForm(offer.id)"), "checked before the claim");
  assert.equal(form.sameJoinerName("Mona Ahmed Hassan", "mona ahmed hassan ali"), true, "a fuller name is the same person");
  assert.equal(form.sameJoinerName("منى أحمد حسن", "منى أحمد"), true, "Arabic names match too");
  assert.equal(form.sameJoinerName("Mona Ahmed", "Mona Hassan"), false, "a different second name is someone else");
  assert.equal(form.sameJoinerName("Mona", "Mona Ahmed"), false, "one word is never enough");

  // 10b. 🔴 A RETURNING LEAVER IS A NEW EMPLOYEE (owner, 2026-11-01) — a record whose employment has
  //      ended does not block, and a current one still does however the rows happen to come back.
  const joiningService = await import("../src/lib/offers/joining-form-service.ts");
  const nationalId = "29001011234567";
  const mobileNumber = "01012345678";
  const answers = { fullName: "Ahmed Helal", mobileNumber, nationalId };
  const offerSent = { candidateName: "Ahmed Helal", sentAt: "2026-10-20T10:00:00.000Z" };
  const onFile = (hrId: string, status: string | null, over: Record<string, unknown> = {}) => ({
    created_at: "2023-03-04T10:00:00.000Z",
    employment_status: status,
    full_name: "Someone Else",
    hr_id: hrId,
    mobile_number: "01000000000",
    national_id: "29900000000000",
    ...over,
  });
  const leaver = (hrId: string, status: string) => onFile(hrId, status, { full_name: "Ahmed Helal", mobile_number: mobileNumber, national_id: nationalId });
  const hire = (rows: Array<Record<string, unknown>>, failing?: "identity" | "recent") =>
    joiningService.findExistingHire(offerSent, answers, fakeEmployeesDb(rows, failing) as never);

  for (const status of ["resigned", "terminated", "inactive", "declined_offer"]) {
    assert.deepEqual(await hire([leaver("B-3", status)]), { kind: "none" }, `a ${status} record's ID and mobile do not block`);
  }
  assert.deepEqual(await hire([onFile("B-3", "resigned", { national_id: nationalId })]), { kind: "none" }, "nor its national ID alone");
  assert.deepEqual(await hire([onFile("B-3", "resigned", { mobile_number: mobileNumber })]), { kind: "none" }, "nor its mobile alone");
  for (const status of ["active", "on_leave", null]) {
    assert.equal((await hire([onFile("A-1", status, { national_id: nationalId })])).kind, "found", `a current record (${status}) blocks on the ID`);
    assert.equal((await hire([onFile("A-1", status, { mobile_number: mobileNumber })])).kind, "found", `a current record (${status}) blocks on the mobile`);
  }
  assert.equal(
    (await hire([leaver("B-3", "resigned"), onFile("A-1", "active", { national_id: nationalId })])).kind,
    "found",
    "the leaver's row coming back first never hides the current employee behind it",
  );
  const rehired = await hire([leaver("B-3", "resigned"), onFile("CN-0013", "active", { created_at: "2026-11-01T10:00:00.000Z", full_name: "Ahmed Helal" })]);
  assert.match(rehired.kind === "found" ? rehired.reason : "", /record with this candidate's name was created after the offer/, "the same-name check still catches a re-hire whose ID was left blank");
  assert.equal(
    (await hire([onFile("B-9", "resigned", { created_at: "2026-11-01T10:00:00.000Z", full_name: "Ahmed Helal" })])).kind,
    "found",
    "and it does not look at status",
  );
  assert.deepEqual(await hire([], "identity"), { kind: "unknown" }, "a failed ID and mobile read blocks");
  assert.deepEqual(await hire([leaver("B-3", "resigned")], "recent"), { kind: "unknown" }, "a failed same-name read blocks");
  const quoted = fakeEmployeesDb([]);
  await joiningService.findExistingHire(offerSent, { ...answers, nationalId: "1,mobile_number.neq.0" }, quoted as never);
  assert.equal(quoted.orFilters[0], `national_id.eq."1,mobile_number.neq.0",mobile_number.eq."${mobileNumber}"`, "both values stay quoted");

  // 10c. 🔴 A PARTLY WRITTEN HIRE IS THE RECORD JUST WRITTEN, NEVER THE LEAVER'S OLD ONE.
  const partly = [leaver("B-3", "resigned"), onFile("CN-0014", "active", { national_id: nationalId })];
  assert.equal(await joiningService.findRecordJustWritten("CN-0014", nationalId, fakeEmployeesDb(partly) as never), "CN-0014", "the row this submit wrote");
  assert.equal(await joiningService.findRecordJustWritten("CN-0015", nationalId, fakeEmployeesDb(partly) as never), "", "no row was written: nothing is found, not the old record");
  assert.equal(await joiningService.findRecordJustWritten("A-1", nationalId, fakeEmployeesDb([onFile("A-1", "active")]) as never), "", "an HR ID somebody else took is not his");
  assert.match(flatService, /upsertEmployee\(\{ \.\.\.employee, hrId: mintedHrId \}/, "the write carries the HR ID the fallback asks by");
  assert.match(flatService, /const found = mintedHrId \? await findRecordJustWritten\(mintedHrId, value\.nationalId, db\) : "";/, "and the fallback asks by it");

  // 11. 🔴 HR IS TOLD WHEN THE RECORD HAS NO SEAT — a non-sales offer sent without one.
  const alert = await import("../src/lib/offers/accepted-offer-alert.ts");
  const joiner = { candidateName: "Mona Ahmed", startDate: "2026-11-01", title: "Accountant" };
  assert.match(alert.joinedOfferMessage(joiner, { hrId: "A-1", seated: false, workEmail: null }), /WITHOUT a seat — set the department, line and manager/);
  assert.match(alert.joinedOfferMessage(joiner, { hrId: "A-1", seated: true, workEmail: null }), /is created and seated\./);
  assert.match(flatService, /seated: Boolean\(seat\?\.lineId \|\| seat\?\.departmentId\)/, "the service says which");

  // 12. 🔴 PAYMENT MODE IS FIXED BY TITLE (owner, 2026-10-08) — field force two parts, office one.
  for (const title of ["Medical Representative", "Senior Medical Representative", "District Sales Manager", "Senior District Manager"]) {
    assert.equal(form.joiningFormPaymentMode(title), "two_parts", `${title} is paid in two parts`);
  }
  for (const title of ["Accountant", "Product Manager", "HR Generalist", "National Sales Manager", "Regional Sales Manager"]) {
    assert.equal(form.joiningFormPaymentMode(title), "one_part", `${title} is paid in one part`);
  }
  assert.match(flatService, /salaryPaymentMode: joiningFormPaymentMode\(draft\.jobTitle\)/, "the record carries it, never Add Employee's default");

  // 13. 🔴 THE NATIONAL ID PHOTOS ARE REQUIRED, AND FILED ON HIRING DOCUMENTS (owner, 2026-10-08) —
  //     front and back, judged before the claim, filed after the record into the slot the column marks.
  const MB = 1024 * 1024;
  const jpeg = (size: number) => ({ contentType: "image/jpeg", size });
  assert.deepEqual(Object.keys(form.validateJoiningIdPhotos({})).sort(), ["idBack", "idFront"], "both sides are required");
  assert.match(form.validateJoiningIdPhotos({ idBack: jpeg(MB) }).idFront ?? "", /front of your national ID/, "a missing front is named");
  assert.deepEqual(form.validateJoiningIdPhotos({ idBack: jpeg(MB), idFront: jpeg(MB) }), {}, "two photos pass");
  assert.match(
    form.validateJoiningIdPhotos({ idBack: jpeg(MB), idFront: { contentType: "application/pdf", size: MB } }).idFront ?? "",
    /JPG, PNG or WEBP/,
    "a PDF is refused",
  );
  assert.match(form.validateJoiningIdPhotos({ idBack: jpeg(3.5 * MB), idFront: jpeg(MB) }).idBack ?? "", /too large/, "a photo over 3 MB is refused");
  assert.ok(3 * form.JOINING_FORM_PHOTO_MAX_BYTES < 10 * MB, "three photos at the cap still fit the proxy's 10 MB body");
  const flatRoute = flat("app/api/public/offer-acceptance/[token]/route.ts");
  assert.match(flatRoute, /await request\.formData\(\)/, "the route reads a multipart body");
  assert.match(
    flatRoute,
    /photos = \{ idBack: await readPhoto\(form\.get\("idBack"\)\), idFront: await readPhoto\(form\.get\("idFront"\)\), photo: await readPhoto\(form\.get\("photo"\)\), \}/,
    "with both ID photos and the optional photo",
  );
  assert.match(flatRoute, /PROXY_BODY_LIMIT = 10 \* 1024 \* 1024/, "and refuses a body the proxy would cut");
  const judged = service.indexOf("validateJoiningIdPhotos(");
  assert.ok(judged > 0 && judged < service.indexOf("claimOfferForJoiningForm(offer.id)"), "photos are judged before the claim");
  const filing = service.indexOf("fileJoiningIdPhotos(hrId, idPhotos)");
  assert.ok(filing > service.indexOf("upsertEmployee(") && filing < service.indexOf("stampOfferAcceptedByJoiningForm(offer.id"), "filed after the record, before the stamp");
  const filer = flatService.slice(flatService.indexOf("async function fileJoiningIdPhotos"), flatService.indexOf("export async function submitJoiningForm"));
  assert.match(filer, /\.eq\("joining_form_upload", "national_id"\)/, "the slot is the one the column marks");
  assert.ok(!/\.eq\("name"|ilike\(/.test(filer), "never matched on its admin-editable name");
  assert.match(filer, /attachHiringDocumentFiles\(/, "through the store's own attach");
  assert.match(filer, /catch \(error\) \{ logError\([\s\S]*return false; \}/, "and a refusal never fails the acceptance");
  assert.match(alert.joinedOfferMessage(joiner, { hrId: "A-1", idPhotosFiled: true, workEmail: null }), /national ID photos are filed on Hiring Documents\./);
  assert.match(
    alert.joinedOfferMessage(joiner, { hrId: "A-1", idPhotosFiled: false, workEmail: null }),
    /could NOT be filed — ask for them/,
    "HR is told when they did not land",
  );
  const migration = code("supabase/migrations/20261008230000_joining_form_national_id_slot.sql");
  assert.match(migration, /add column if not exists joining_form_upload text/, "the column exists");
  assert.match(migration, /name = 'National ID copy'/, "and marks the National ID copy slot once");
  const pageSource = flat("src/components/offers/joining-form-page.tsx");
  assert.match(pageSource, /"birthDate", \.\.\.JOINING_FORM_PHOTO_FIELDS, "mobileNumber"/, "the page requires both photos, in page order");
  assert.match(pageSource, /body\.append\("idFront", photos\.idFront\.file\)/, "and sends them");
  assert.ok(!/content-type/i.test(pageSource.slice(pageSource.indexOf("new FormData()"))), "with no content-type header, so the browser writes the boundary");
  //    A HEIC photo is decoded on the phone (6 Nov 2026: a gallery photo of a card's back reached the page
  //    as a broken tile and was refused) — by heic-to's CSP build, loaded only when a HEIC is picked.
  assert.match(pageSource, /await import\("heic-to\/csp"\)/, "a HEIC photo is decoded by heic-to's CSP build");
  assert.ok(!/from "heic-to/.test(pageSource), "loaded on the first HEIC alone, never with the page");
  assert.match(pageSource, /const bitmap = await decodePhoto\(file\);\s*if \(!bitmap\) return \{ unreadable: true \};/, "a photo nothing opens is unreadable");
  assert.match(
    pageSource,
    /const kept = "file" in prepared \? .+? : null;.+?\[field\]: kept \? undefined : JOINING_FORM_PHOTO_UNREADABLE/,
    "and is never kept: the tile stays empty and names the camera",
  );

  // 14. 🔴 EVERY MESSAGE THE CANDIDATE CAN READ HAS ITS ARABIC (owner, 2026-10-08: "change language
  //     between English and Arabic") — a new or reworded message cannot ship English-only.
  const copy = await import("../src/components/offers/joining-form-copy.ts");
  const said = new Set<string>();
  for (const match of code("src/lib/offers/joining-form.ts").matchAll(/(?:errors(?:\.\w+|\[field\])\s*=|\bid(?:Back|Front):)\s*"([^"]+)"/g)) {
    said.add(match[1]);
  }
  for (const match of code("src/lib/offers/joining-form.ts").matchAll(/return "([^"]+\.)";/g)) said.add(match[1]);
  assert.ok(said.has("This photo is too large. Please take it again, or choose a smaller one."), "a returned message is swept too");
  said.add(form.JOINING_FORM_PHOTO_UNREADABLE);
  for (const message of Object.values(form.JOINING_FORM_STATE_MESSAGE) as Array<{ body: string; title: string }>) {
    said.add(message.title);
    said.add(message.body);
  }
  const hrWillContact = /const HR_WILL_CONTACT = "([^"]+)"/.exec(service)?.[1] ?? "";
  assert.ok(hrWillContact, "the service's shared sentence is found");
  for (const match of flatService.matchAll(/message: (?:"([^"]+)"|`([^`]+)`)/g)) {
    said.add((match[1] ?? match[2]).replace("${HR_WILL_CONTACT}", hrWillContact));
  }
  for (const match of flatRoute.matchAll(/message: "([^"]+)"/g)) said.add(match[1]);
  for (const match of flat("app/join/[token]/page.tsx").matchAll(/view\.kind === "invalid" \? "([^"]+)"/g)) said.add(match[1]);
  assert.ok(said.size >= 40, `the sweep found the messages (${said.size})`);
  const untranslated = [...said].filter((message) => !copy.AR_MESSAGES[message]);
  assert.deepEqual(untranslated, [], "every message has its Arabic in joining-form-copy.ts");
  assert.equal(copy.translateMessage("ar", "Please choose your gender."), "يُرجى اختيار النوع.", "and the page reads it");
  assert.equal(copy.translateMessage("en", "Please choose your gender."), "Please choose your gender.", "English passes through");
  //    The Arabic never assumes the reader is a man or a woman: no command addressed to one gender.
  const arabic = code("src/components/offers/joining-form-copy.ts");
  assert.ok(
    !/(?:^|[\s«("])(?:اكتب|اختر|اضغط|راجع|أدخل|ارفع|التقط|اكتبي|اختاري|اضغطي|راجعي|أدخلي|ارفعي|التقطي)(?=[\s.،"]|$)/m.test(arabic),
    "no imperative addressed to one gender",
  );

  // 15. 🔴 THE PHOTO IS OPTIONAL, BECOMES THE PROFILE PHOTO, AND IS FILED WITHOUT TICKING "(6) PERSONAL
  //     PHOTOS" (owner, 2026-10-08: "upload a photo for him"; optional, profile + Hiring Documents, and
  //     HR still collects the six prints — his three answers). Labelled just "Photo".
  assert.equal(form.validateJoiningFacePhoto(null), undefined, "no photo is fine");
  assert.equal(form.validateJoiningFacePhoto(jpeg(MB)), undefined, "a photo passes");
  assert.match(form.validateJoiningFacePhoto({ contentType: "application/pdf", size: MB }) ?? "", /JPG, PNG or WEBP/, "a PDF is refused");
  assert.match(form.validateJoiningFacePhoto(jpeg(3.5 * MB)) ?? "", /too large/, "and so is one over the cap");
  const faceJudged = service.indexOf("validateJoiningFacePhoto(");
  assert.ok(faceJudged > 0 && faceJudged < service.indexOf("claimOfferForJoiningForm(offer.id)"), "the photo is judged before the claim");
  const faceFiling = service.indexOf("fileJoiningFacePhoto(hrId, facePhoto)");
  assert.ok(faceFiling > service.indexOf("upsertEmployee(") && faceFiling < service.indexOf("stampOfferAcceptedByJoiningForm(offer.id"), "filed after the record");
  assert.match(flatService, /const facePhotoOutcome = facePhoto \? await fileJoiningFacePhoto\(hrId, facePhoto\) : null;/, "only when one was sent");
  const faceFiler = flatService.slice(flatService.indexOf("async function fileJoiningFacePhoto"), flatService.indexOf("export async function submitJoiningForm"));
  assert.match(faceFiler, /await uploadEmployeePhoto\(hrId, photo\.bytes, photo\.contentType\)/, "it becomes the profile photo");
  assert.match(faceFiler, /\.eq\("joining_form_upload", "photo"\)/, "it is filed into the slot the column marks");
  assert.match(faceFiler, /markSubmitted: false,/, "WITHOUT ticking it");
  assert.ok(!/\.eq\("name"|ilike\(/.test(faceFiler), "never matched on the slot's name");
  assert.equal((faceFiler.match(/catch \(error\) \{ logError\(/g) ?? []).length, 2, "and neither half can fail the acceptance");
  const attach = flat("src/lib/hiring-documents/service.ts");
  assert.match(
    attach,
    /const markedSubmitted = input\.markSubmitted !== false; if \(markedSubmitted\) await markHiringDocumentSubmitted\(employeeHrId, documentId\);/,
    "the store ticks by default, and skips it only when told",
  );
  const photoMigration = code("supabase/migrations/20261009001000_joining_form_photo_slot.sql");
  assert.match(photoMigration, /joining_form_upload in \('national_id', 'photo'\)/, "the column accepts the photo");
  assert.match(photoMigration, /name = '\(6\) personal photos'/, "and marks the personal photos slot once");
  const requiredSource = pageSource.slice(pageSource.indexOf("function requiredFields("), pageSource.indexOf("function requiredFields(") + 600);
  assert.ok(!/FACE_PHOTO|"photo"/.test(requiredSource), "the page does not require it");
  assert.match(pageSource, /body\.append\("photo", photos\.photo\.file\)/, "and sends it when chosen");
  const enCopy = copy.JOINING_COPY.en;
  assert.equal(enCopy.facePhoto.label, "Photo", "called just Photo");
  assert.ok(!/personal/i.test(JSON.stringify(enCopy.facePhoto)), "never \"personal photo\"");
}
