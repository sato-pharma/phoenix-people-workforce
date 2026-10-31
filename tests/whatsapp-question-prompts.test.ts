import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  areaMenu,
  backgroundMenu,
  classifyRowId,
  experienceMenu,
  isOfferedRoleFamily,
  jobTitleMenu,
  jobTitleMenuAllFamilies,
  menuViolations,
  parseClassifyRowId,
  regionMenu,
  salaryPromptText,
  WHATSAPP_BODY_MAX,
  WHATSAPP_LIST_BUTTON_MAX,
  WHATSAPP_LIST_MAX_ROWS,
  WHATSAPP_ROW_DESCRIPTION_MAX,
  WHATSAPP_ROW_TITLE_MAX,
  WHATSAPP_SECTION_TITLE_MAX,
  type ClassifyRow,
} from "../src/lib/recruitment/inbound/whatsapp-classify-menus.ts";
import {
  answerConfigViolations,
  applyAnswerConfig,
  applyOptionLabels,
  applyPromptOverride,
  AREA_PROMPT_DEFAULT,
  builtInPromptKeys,
  builtInPrompts,
  isBuiltInPromptKey,
  menuChromeViolations,
  optionLabelViolations,
  promptViolations,
  REGION_TOKEN,
  resolveMenuChrome,
  resolvePromptBody,
  type PromptOverride,
} from "../src/lib/recruitment/inbound/whatsapp-question-prompts.ts";
import { sendClassifyMenu } from "../src/lib/recruitment/inbound/whatsapp-interactive.ts";
import {
  buildExtraQuestionMenu,
  EXTRA_QUESTION_BUTTON_DEFAULT,
  EXTRA_QUESTION_SECTION_DEFAULT,
  screeningQuestionViolations,
} from "../src/lib/recruitment/inbound/whatsapp-screening-questions.ts";

/**
 * Owner-editable WORDING and ANSWER LABELS for the six built-in WhatsApp screening questions.
 *
 * The property everything here serves: rewording a question — or relabelling one of its answers —
 * can never change the CODE the applicant's tap sends back, and can never produce a message Meta
 * refuses. Either failure is invisible from this repo. The first silently mis-files a real
 * candidate; the second shows up only as a conversation that stops dead.
 */

/** Convenience: the override shape the store hands the bot, for one question. */
function override(
  body: string | null,
  optionLabels: PromptOverride["optionLabels"] = {},
  answers: { hiddenOptions?: string[]; optionOrder?: string[] } = {},
  chrome: { buttonLabel?: string | null; sectionTitle?: string | null } = {},
): PromptOverride {
  return {
    // `undefined` is "no audience configured", which is what every wording fixture here means: these
    // tests are about the words, and the question keeps whichever audience its code default gives it.
    appliesToRoleFamilies: undefined,
    body,
    // Null in both is "keep the code's own button and heading", so every fixture that does not
    // mention them asserts the untouched path — which is the one every applicant is on today.
    buttonLabel: chrome.buttonLabel ?? null,
    hiddenOptions: answers.hiddenOptions ?? [],
    optionLabels,
    optionOrder: answers.optionOrder ?? [],
    sectionTitle: chrome.sectionTitle ?? null,
  };
}

/**
 * The shape Meta is actually sent for a list message. Written out here rather than imported because
 * there is no exported type for it: the payload is an object literal built inside sendClassifyMenu,
 * and naming its shape in the test is what makes a silent change to that literal fail here.
 */
type GraphListPayload = {
  interactive: {
    action: {
      button: string;
      sections: Array<{ rows: Array<{ description?: string; id: string; title: string }>; title: string }>;
    };
    body: { text: string };
  };
};

/** The answer codes a menu offers, in order — what every assertion below compares against. */
function valuesOf(rows: readonly ClassifyRow[]): string[] {
  return rows.map((row) => parseClassifyRowId(row.id)!.value);
}

export async function runWhatsAppQuestionPromptsTests() {
  const prompts = builtInPrompts();

  // ── The catalogue is exactly the six steps, in the order an applicant meets them ────────────────
  assert.deepEqual(
    prompts.map((p) => p.key),
    ["job_title", "background", "region", "area", "experience", "salary"],
    "the screen lists the six built-in questions in the order the bot asks them",
  );
  assert.deepEqual([...builtInPromptKeys], prompts.map((p) => p.key));

  // ── Defaults are READ FROM THE CODE, never re-typed ─────────────────────────────────────────────
  // This is the drift guard: a later reword in whatsapp-classify-menus.ts must show up on the admin
  // screen automatically, and "reset to default" must never restore text the code no longer uses.
  const byKey = new Map(prompts.map((p) => [p.key, p]));
  assert.equal(byKey.get("job_title")?.defaultBody, jobTitleMenu().body);
  assert.equal(byKey.get("background")?.defaultBody, backgroundMenu().body);
  assert.equal(byKey.get("region")?.defaultBody, regionMenu().body);
  assert.equal(byKey.get("experience")?.defaultBody, experienceMenu().body);
  assert.equal(byKey.get("salary")?.defaultBody, salaryPromptText());

  // The AREA default is the one that cannot be read from its builder — areaMenu interpolates a real
  // region name, not a token — so it is written out as a template and pinned against the builder
  // here. A reword of areaMenu's body that forgets AREA_PROMPT_DEFAULT goes red on this line.
  assert.equal(
    areaMenu("CA", []).body,
    AREA_PROMPT_DEFAULT.split(REGION_TOKEN).join("Cairo"),
    "the area prompt template must stay in step with areaMenu's own wording",
  );
  assert.equal(byKey.get("area")?.defaultBody, AREA_PROMPT_DEFAULT);
  assert.equal(byKey.get("area")?.supportsRegionToken, true, "area is the one prompt carrying a token");
  for (const prompt of prompts) {
    if (prompt.key !== "area") {
      assert.equal(prompt.supportsRegionToken, false, `${prompt.key} must not advertise a region token`);
    }
  }

  // ── The ANSWERS shown on the screen are the answers the bot actually sends ──────────────────────
  // Read from the real menu builders, so an answer added or removed in code appears or disappears on
  // the admin screen with no edit to the catalogue. And the "code" the screen prints beside each
  // answer must be the value the tap really sends back, or the one field an admin is told not to
  // touch would be telling them something untrue.
  const answerChecks: [(typeof builtInPromptKeys)[number], ReturnType<typeof regionMenu>][] = [
    ["job_title", jobTitleMenu()],
    ["background", backgroundMenu()],
    ["region", regionMenu()],
    ["experience", experienceMenu()],
  ];
  for (const [key, menu] of answerChecks) {
    const options = byKey.get(key)?.options ?? [];
    const offered = options.filter((o) => o.offeredByDefault);
    assert.deepEqual(
      offered.map((o) => o.defaultTitle),
      menu.rows.map((r) => r.title),
      `${key}: the screen must list the answers the bot actually sends, in the same order`,
    );
    assert.deepEqual(
      offered.map((o) => o.value),
      valuesOf(menu.rows),
      `${key}: the code shown beside each answer must be the value its tap sends back`,
    );
  }

  // ── Which answers are OFFERED, and which merely exist ──────────────────────────────────────────
  // "Adding an answer" means switching on one the code already understands. Job title is the only
  // question with any: the owner named his eight on 2026-08-28 and left `sales` and `pharmacist`
  // off. Both are still real families the reply handler accepts, which is exactly why offering one
  // is safe — and an answer the handler did NOT accept could not be added at all, because its tap
  // would be dropped in silence.
  const jobTitleOptions = byKey.get("job_title")?.options ?? [];
  assert.deepEqual(
    jobTitleOptions.map((o) => o.value),
    valuesOf(jobTitleMenuAllFamilies().rows),
    "the job-title screen must list every answer the system understands, offered or not",
  );
  assert.deepEqual(
    jobTitleOptions.filter((o) => !o.offeredByDefault).map((o) => o.value),
    ["sales", "pharmacist", "human_resources", "finance"],
    "sales, pharmacist, human_resources and finance exist but are not offered — finance gave up its row to HR Section Head on 2026-10-06, and the owner had the Human Resources row removed the same day; both stay addable",
  );
  for (const value of ["sales", "pharmacist", "finance"]) {
    assert.equal(
      isOfferedRoleFamily(value),
      true,
      `${value}: the reply handler must already accept this, or switching it on would drop a real applicant's answer`,
    );
  }
  assert.equal(
    isOfferedRoleFamily("marketing_manager"),
    false,
    "an invented code is refused by the reply handler — which is why the screen cannot offer one",
  );
  for (const prompt of prompts) {
    if (prompt.key === "job_title") continue;
    assert.ok(
      prompt.options.every((o) => o.offeredByDefault),
      `${prompt.key}: every answer this question knows about is already offered, so it has nothing to add`,
    );
  }

  // Salary is free text: no answers to show, and nothing to relabel.
  assert.deepEqual(byKey.get("salary")?.options, [], "the salary question has nothing to tap");

  // Area is the partial case — its real answers are the live areas of whichever region was chosen,
  // so the only relabellable row is the escape. Pinned so a future change that starts advertising
  // fixed areas here (which would go stale the moment an area is added) goes red.
  assert.equal(byKey.get("area")?.options.length, 1, "only the area escape row is relabellable");
  assert.equal(byKey.get("area")?.options[0]?.value, "other");

  // ── isBuiltInPromptKey ──────────────────────────────────────────────────────────────────────────
  assert.equal(isBuiltInPromptKey("background"), true);
  assert.equal(isBuiltInPromptKey("extra"), false, "an admin-defined extra question is not a built-in prompt");
  assert.equal(isBuiltInPromptKey("job_title_other"), false, "the typed follow-up is not editable here");

  // ── promptViolations ────────────────────────────────────────────────────────────────────────────
  assert.deepEqual(promptViolations({ bodyText: "Which region suits you?", key: "region" }), []);
  assert.equal(promptViolations({ bodyText: "hello", key: "not_a_step" }).length, 1);
  assert.equal(promptViolations({ bodyText: "   ", key: "region" }).length, 1, "an empty prompt is refused");
  assert.equal(
    promptViolations({ bodyText: "x".repeat(WHATSAPP_BODY_MAX + 1), key: "region" }).length,
    1,
    "an over-long prompt is refused — Meta rejects the whole message rather than truncating it",
  );
  assert.deepEqual(
    promptViolations({ bodyText: "x".repeat(WHATSAPP_BODY_MAX), key: "region" }),
    [],
    "exactly at the ceiling is still valid",
  );

  // ── optionLabelViolations ───────────────────────────────────────────────────────────────────────
  const regionValues = (byKey.get("region")?.options ?? []).map((o) => o.value);
  assert.deepEqual(
    optionLabelViolations({
      allowedValues: regionValues,
      key: "region",
      optionLabels: { [regionValues[0]!]: { title: "Greater Cairo" } },
    }),
    [],
  );
  assert.equal(
    optionLabelViolations({
      allowedValues: regionValues,
      key: "region",
      optionLabels: { not_an_answer: { title: "Hello" } },
    }).length,
    1,
    "a label for an answer this question does not offer is refused — it would override nothing while looking saved",
  );
  assert.equal(
    optionLabelViolations({
      allowedValues: regionValues,
      key: "region",
      optionLabels: { [regionValues[0]!]: { title: "x".repeat(WHATSAPP_ROW_TITLE_MAX + 1) } },
    }).length,
    1,
    "an over-long answer title is refused — Meta 400s the WHOLE message on it, so it would not truncate",
  );
  assert.deepEqual(
    optionLabelViolations({
      allowedValues: regionValues,
      key: "region",
      optionLabels: { [regionValues[0]!]: { title: "x".repeat(WHATSAPP_ROW_TITLE_MAX) } },
    }),
    [],
    "exactly at the answer ceiling is still valid",
  );
  assert.equal(
    optionLabelViolations({
      allowedValues: regionValues,
      key: "region",
      optionLabels: {
        [regionValues[0]!]: { description: "x".repeat(WHATSAPP_ROW_DESCRIPTION_MAX + 1), title: "Cairo" },
      },
    }).length,
    1,
    "an over-long second line is refused for the same reason",
  );

  // ── resolvePromptBody ───────────────────────────────────────────────────────────────────────────
  const noOverrides = new Map<string, PromptOverride>();
  assert.equal(
    resolvePromptBody({ defaultBody: "Default?", key: "region", overrides: noOverrides }),
    "Default?",
    "nothing saved means the code default",
  );
  assert.equal(
    resolvePromptBody({
      defaultBody: "Default?",
      key: "region",
      overrides: new Map([["region", override("   ")]]),
    }),
    "Default?",
    "a blank override falls back — a half-finished edit must never send an empty question",
  );
  assert.equal(
    resolvePromptBody({
      defaultBody: "Default?",
      key: "region",
      overrides: new Map([["region", override(null, { CA: { title: "Cairo" } })]]),
    }),
    "Default?",
    "relabelling only the answers leaves the question on its code default",
  );
  assert.equal(
    resolvePromptBody({
      defaultBody: "Default?",
      key: "region",
      overrides: new Map([["region", override("Mine?")]]),
    }),
    "Mine?",
  );
  assert.equal(
    resolvePromptBody({
      defaultBody: AREA_PROMPT_DEFAULT,
      key: "area",
      overrides: new Map([["area", override(`Which area in ${REGION_TOKEN} do you want?`)]]),
      regionLabel: "Delta (2)",
    }),
    "Which area in Delta (2) do you want?",
    "the region token is replaced with the region the applicant just chose",
  );
  assert.equal(
    resolvePromptBody({
      defaultBody: AREA_PROMPT_DEFAULT,
      key: "area",
      overrides: new Map([["area", override("Which area do you want?")]]),
      regionLabel: "Cairo",
    }),
    "Which area do you want?",
    "an override that drops the token is the admin's call, not an error",
  );

  // ── applyOptionLabels — THE ROW ID MUST SURVIVE UNCHANGED ───────────────────────────────────────
  // This is the assertion the whole feature rests on. The id carries `phx:<step>:<value>`, and
  // <value> is what the CV pool filters, the candidate folders and the manager routing read. New
  // words in front of an applicant must not change one byte of it.
  const region = regionMenu();
  const firstValue = parseClassifyRowId(region.rows[0]!.id)!.value;
  const relabelled = applyOptionLabels(region.rows, {
    [firstValue]: { description: "The capital", title: "Greater Cairo" },
  });
  assert.deepEqual(
    relabelled.map((r) => r.id),
    region.rows.map((r) => r.id),
    "RELABELLING MUST NEVER CHANGE A ROW ID — that id is the code every downstream reader keys on",
  );
  assert.equal(relabelled[0]!.title, "Greater Cairo");
  assert.equal(relabelled[0]!.description, "The capital");
  assert.deepEqual(
    relabelled.slice(1).map((r) => r.title),
    region.rows.slice(1).map((r) => r.title),
    "relabelling one answer leaves every other answer exactly as it was",
  );
  assert.equal(parseClassifyRowId(relabelled[0]!.id)?.value, firstValue, "the tap still sends the same code back");

  // Swept over EVERY answer of EVERY menu, in both shapes — a title alone, and a title with a second
  // line. Relabelling builds a row two different ways depending on whether a description survives,
  // and an id rebuilt in only one of those branches passed a single hand-picked example: this loop
  // is what caught that, so it stays a sweep rather than a sample. `background` and `experience`
  // carry no descriptions at all, which is what exercises the other branch.
  for (const menu of [jobTitleMenu(), backgroundMenu(), regionMenu(), experienceMenu(), areaMenu("CA", ["Nasr City"])]) {
    for (const row of menu.rows) {
      const value = parseClassifyRowId(row.id)!.value;
      for (const label of [{ title: "Reworded" }, { description: "A second line", title: "Reworded" }]) {
        const out = applyOptionLabels(menu.rows, { [value]: label });
        assert.deepEqual(
          out.map((r) => r.id),
          menu.rows.map((r) => r.id),
          `${menu.step}/${value}: relabelling must not change ANY row id, whichever shape the row takes`,
        );
        const touched = out.find((r) => r.id === row.id)!;
        assert.equal(touched.title, "Reworded", `${menu.step}/${value}: the new words must actually appear`);
      }
    }
  }

  assert.equal(applyOptionLabels(region.rows, {}), region.rows, "no labels returns the identical array");
  assert.equal(applyOptionLabels(region.rows, undefined), region.rows);
  assert.equal(
    applyOptionLabels(region.rows, { [firstValue]: { title: "   " } }),
    region.rows,
    "a blank title is treated as no override — an answer with no words on it must never be sent",
  );
  assert.equal(
    applyOptionLabels(region.rows, { [firstValue]: { title: region.rows[0]!.title } }),
    region.rows,
    "a label identical to the code's own is not a change",
  );
  assert.equal(
    applyOptionLabels(region.rows, { not_an_answer: { title: "Hello" } }),
    region.rows,
    "a label for a value this menu does not offer changes nothing",
  );

  // ── applyPromptOverride ─────────────────────────────────────────────────────────────────────────
  // With nothing saved the UNTOUCHED path must be byte-for-byte the pre-feature path: the very same
  // object, so no behaviour anywhere downstream can depend on this feature existing.
  assert.equal(applyPromptOverride(region, noOverrides), region, "no override returns the identical menu object");

  const reworded = applyPromptOverride(region, new Map([["region", override("Where would you like to work?")]]));
  assert.notEqual(reworded, region, "an override produces a new object, never a mutation of the original");
  assert.equal(reworded.body, "Where would you like to work?");
  assert.deepEqual(
    reworded.rows.map((r) => r.id),
    region.rows.map((r) => r.id),
    "REWORDING THE QUESTION MUST NEVER CHANGE THE ANSWER CODES",
  );
  assert.deepEqual(reworded.rows, region.rows, "rewording the question alone leaves the answers untouched");
  assert.equal(reworded.step, region.step);
  assert.equal(reworded.buttonLabel, region.buttonLabel);
  assert.equal(reworded.sectionTitle, region.sectionTitle);

  // Both halves at once, which is what a real save looks like.
  const both = applyPromptOverride(
    region,
    new Map([["region", override("Where would you like to work?", { [firstValue]: { title: "Greater Cairo" } })]]),
  );
  assert.equal(both.body, "Where would you like to work?");
  assert.equal(both.rows[0]!.title, "Greater Cairo");
  assert.deepEqual(
    both.rows.map((r) => r.id),
    region.rows.map((r) => r.id),
    "changing the question AND the answers still leaves every code exactly as it was",
  );

  // Relabelling alone must still produce a real change, with the question left on its default.
  const labelsOnly = applyPromptOverride(
    region,
    new Map([["region", override(null, { [firstValue]: { title: "Greater Cairo" } })]]),
  );
  assert.equal(labelsOnly.body, region.body, "no reword means the question keeps its code wording");
  assert.equal(labelsOnly.rows[0]!.title, "Greater Cairo");

  // ── HIDING, ADDING AND REORDERING ANSWERS ──────────────────────────────────────────────────────
  // Same property as relabelling, and for the same reason: an answer that IS shown must carry the
  // identical `phx:<step>:<value>` it would have carried anyway. Nothing here builds a row — rows are
  // filtered and moved, never constructed — so a shown answer's code cannot drift.
  const jobs = jobTitleMenu();
  const jobValues = valuesOf(jobs.rows);

  // Deleting an answer = hiding it.
  const hidden = applyPromptOverride(jobs, new Map([["job_title", override(null, {}, { hiddenOptions: ["product_manager"] })]]));
  assert.deepEqual(
    valuesOf(hidden.rows),
    jobValues.filter((v) => v !== "product_manager"),
    "hiding one answer removes exactly that answer and leaves the rest in their order",
  );
  assert.ok(
    hidden.rows.every((row) => jobs.rows.includes(row)),
    "every surviving row is the SAME OBJECT the code built — nothing is reconstructed, so no code can drift",
  );
  assert.deepEqual(menuViolations(hidden), [], "a menu with an answer hidden must still be sendable");

  // Adding an answer = switching on one the code already understands. The offered menu is now full at
  // the ten-row cap (talent_acquisition took the last slot on 2026-09-22), so this save switches
  // `product_manager` OFF and `sales` ON together — the net stays ten and sendable, while still proving a
  // not-offered answer is emitted the moment the saved order names it, carrying the code's own id.
  const withoutProductManager = jobValues.filter((v) => v !== "product_manager");
  const added = applyPromptOverride(
    jobs,
    new Map([["job_title", override(null, {}, { hiddenOptions: ["product_manager"], optionOrder: [...withoutProductManager, "sales"] })]]),
  );
  assert.deepEqual(
    valuesOf(added.rows),
    [...withoutProductManager, "sales"],
    "an answer the code understands but does not offer appears only when the saved order names it",
  );
  assert.equal(
    added.rows[added.rows.length - 1]!.id,
    classifyRowId("job_title", "sales"),
    "THE ADDED ANSWER'S ROW ID IS THE CODE'S OWN — a tap on it lands in the same vocabulary as every other",
  );
  assert.deepEqual(
    menuViolations(added),
    [],
    "the added answer must not break the send-time check — the menu is full, so switching product_manager off makes room for sales",
  );

  // An answer NOT offered by default stays off while nothing names it, even with other config saved.
  const stillOff = applyPromptOverride(
    jobs,
    new Map([["job_title", override(null, {}, { hiddenOptions: ["product_manager"] })]]),
  );
  assert.ok(
    !valuesOf(stillOff.rows).includes("sales"),
    "hiding something else must not switch on an answer the owner deliberately left off",
  );

  // Reordering moves the same rows.
  const reordered = applyPromptOverride(
    jobs,
    new Map([["job_title", override(null, {}, { optionOrder: [...jobValues].reverse() })]]),
  );
  assert.deepEqual(valuesOf(reordered.rows), [...jobValues].reverse(), "the saved order is the order sent");
  assert.deepEqual(
    [...valuesOf(reordered.rows)].sort(),
    [...jobValues].sort(),
    "reordering changes the order and nothing else — no answer gained, none lost",
  );

  // A PARTIAL order keeps the unnamed answers, after the named ones. This is what stops a stale
  // client silently deleting an answer it did not know about.
  const partial = applyPromptOverride(
    jobs,
    new Map([["job_title", override(null, {}, { optionOrder: ["product_manager"] })]]),
  );
  assert.deepEqual(
    valuesOf(partial.rows),
    ["product_manager", ...jobValues.filter((v) => v !== "product_manager")],
    "an order naming one answer promotes it and keeps every other in its code order",
  );

  // Labels still apply to a reordered menu, and a label saved for a hidden answer is simply moot.
  const hiddenPlusLabel = applyPromptOverride(
    jobs,
    new Map([
      [
        "job_title",
        override(null, { product_manager: { title: "Product team" }, medical_rep: { title: "Medical Rep" } }, { hiddenOptions: ["product_manager"] }),
      ],
    ]),
  );
  assert.ok(!valuesOf(hiddenPlusLabel.rows).includes("product_manager"), "a label cannot resurrect a hidden answer");
  assert.equal(
    hiddenPlusLabel.rows.find((r) => parseClassifyRowId(r.id)!.value === "medical_rep")!.title,
    "Medical Rep",
    "labels still apply to the answers that remain",
  );

  // ── The fail-safes ─────────────────────────────────────────────────────────────────────────────
  // A configuration that could not be sent falls back to the code's own menu rather than stopping an
  // applicant's conversation. Saving one is refused by answerConfigViolations; this is the second
  // line, for a row written before a code change moved the ground under it.
  assert.equal(
    applyPromptOverride(jobs, new Map([["job_title", override(null, {}, { hiddenOptions: jobValues })]])).rows,
    jobs.rows,
    "hiding EVERY answer falls back to the code's menu — a list with nothing to tap is not a question",
  );

  const synthetic: ClassifyRow[] = Array.from({ length: WHATSAPP_LIST_MAX_ROWS + 1 }, (_, i) => ({
    id: classifyRowId("region", `v${i}`),
    title: `Row ${i}`,
  }));
  const threeOfThem = synthetic.slice(0, 3);
  assert.equal(
    applyAnswerConfig({
      hiddenOptions: [],
      optionOrder: synthetic.map((row) => parseClassifyRowId(row.id)!.value),
      pool: synthetic,
      rows: threeOfThem,
    }),
    threeOfThem,
    `more than ${WHATSAPP_LIST_MAX_ROWS} answers falls back — Meta refuses the WHOLE message over the limit, so honouring it would stop the conversation dead`,
  );
  assert.equal(
    applyAnswerConfig({ hiddenOptions: [], optionOrder: [], pool: synthetic, rows: threeOfThem }),
    threeOfThem,
    "no configuration returns the identical array",
  );

  // ── answerConfigViolations — the same rules, at save time ──────────────────────────────────────
  const jobAllowed = jobTitleOptions.map((o) => o.value);
  const jobDefault = jobTitleOptions.filter((o) => o.offeredByDefault).map((o) => o.value);
  const configCheck = (hiddenOptions: string[], optionOrder: string[]) =>
    answerConfigViolations({
      allowedValues: jobAllowed,
      defaultOfferedValues: jobDefault,
      hiddenOptions,
      key: "job_title",
      optionOrder,
    });
  assert.deepEqual(configCheck(["product_manager"], []), [], "hiding one answer is saveable");
  assert.deepEqual(
    configCheck(["product_manager"], ["sales"]),
    [],
    "switching a known answer on is saveable — the offered menu is full at the ten-row cap, so this hides product_manager to make room for sales",
  );
  assert.equal(
    configCheck([], ["marketing_manager"]).length,
    1,
    "an answer the system does not understand is refused — its tap would be dropped in silence",
  );
  assert.equal(configCheck(["not_an_answer"], []).length, 1, "hiding something that does not exist is refused");
  assert.equal(
    configCheck(["product_manager"], ["product_manager"]).length,
    1,
    "an answer cannot be both switched off and placed in the order",
  );
  assert.equal(
    configCheck(jobAllowed, []).length,
    1,
    "switching every answer off is refused at save time, not merely ignored at send time",
  );
  assert.equal(configCheck([], []).length, 0, "no change is not a violation");
  // Job title's answer POOL sits PAST Meta's ten-row list. office_coordinator made it eleven on
  // 2026-09-02 (the Sheraton opening); talent_acquisition made it twelve on 2026-09-22 (the paid TA
  // campaign), and unlike the earlier extras it is OFFERED, so jobTitleMenu() then sent exactly ten
  // rows — full at the ceiling. hr_section_head made it thirteen on 2026-10-06 and took the slot the
  // Finance row held; the Human Resources row was then taken off the menu the same day, so the menu
  // sends nine and `human_resources`, `finance`, `sales` and `pharmacist` are the four still off it.
  // personnel made it fourteen on 2026-10-31 and is OFFERED, so the menu sends ten again — full at the
  // ceiling — with the same four still off it.
  // The pool stays fourteen, because a removed row is still an answer the system understands. A pool
  // is allowed to be larger than a list, because a pool is not a message: what is pinned is the
  // count, not the ceiling.
  //
  // What must hold is that the save-time check is the thing standing between an admin and a 400:
  // switching on all fourteen is refused, and any ten still save.
  assert.equal(jobAllowed.length, WHATSAPP_LIST_MAX_ROWS + 4, "fourteen answers exist; one list holds ten");
  assert.ok(
    configCheck([], jobAllowed).some((problem) => problem.includes(String(WHATSAPP_LIST_MAX_ROWS))),
    "switching on all fourteen answers must be refused at save time — the message would 400",
  );
  assert.deepEqual(
    configCheck([], jobAllowed.slice(0, WHATSAPP_LIST_MAX_ROWS)),
    [],
    "any ten of them sits exactly on the ceiling, and is saveable",
  );
  const overCeiling = answerConfigViolations({
    allowedValues: [...jobAllowed, "one_too_many"],
    defaultOfferedValues: [...jobAllowed, "one_too_many"],
    hiddenOptions: [],
    key: "job_title",
    optionOrder: [...jobAllowed, "one_too_many"],
  });
  assert.ok(
    overCeiling.some((problem) => problem.includes(String(WHATSAPP_LIST_MAX_ROWS))),
    `one answer past Meta's ${WHATSAPP_LIST_MAX_ROWS}-row list must be refused at save time — it would 400 the whole message`,
  );

  // An admin-defined extra question rides the same menu shape but is NOT one of the six — its
  // wording lives in the other table and must pass through here untouched.
  const extraMenu = { ...regionMenu(), step: "extra" as const };
  assert.equal(
    applyPromptOverride(extraMenu, new Map([["region", override("should not apply")]])),
    extraMenu,
    "an extra question is never reworded by a built-in override",
  );

  // ── A reworded, relabelled menu must still be SENDABLE ──────────────────────────────────────────
  // menuViolations is what whatsapp-interactive.ts runs before every network call; a menu that fails
  // it is refused rather than sent, which for an applicant is a conversation that simply stops.
  for (const menu of [jobTitleMenu(), backgroundMenu(), regionMenu(), experienceMenu(), areaMenu("CA", ["Nasr City"])]) {
    const value = parseClassifyRowId(menu.rows[0]!.id)!.value;
    const overridden = applyPromptOverride(
      menu,
      new Map([[menu.step, override("A perfectly ordinary question?", { [value]: { title: "Fine answer" } })]]),
      "Cairo",
    );
    assert.deepEqual(
      menuViolations(overridden),
      [],
      `${menu.step}: a reworded, relabelled menu must still pass the same send-time check the bot runs`,
    );
  }
  // And the ceilings hold where they matter: at the limit passes, over it is caught before Meta.
  const atLimit = applyPromptOverride(regionMenu(), new Map([["region", override("x".repeat(WHATSAPP_BODY_MAX))]]));
  assert.deepEqual(menuViolations(atLimit), []);
  const overLimit = applyPromptOverride(
    regionMenu(),
    new Map([["region", override("x".repeat(WHATSAPP_BODY_MAX + 1))]]),
  );
  assert.equal(menuViolations(overLimit).length, 1, "an over-long body is caught at send time too, not only at save");
  const overLongAnswer = applyPromptOverride(
    regionMenu(),
    new Map([["region", override(null, { [firstValue]: { title: "x".repeat(WHATSAPP_ROW_TITLE_MAX + 1) } })]]),
  );
  assert.ok(
    menuViolations(overLongAnswer).length > 0,
    "an over-long ANSWER is caught at send time too — save-time validation is not the only gate",
  );

  // ── The two stores must stay separate — this is the double-ask guard ────────────────────────────
  // The six built-in prompts live in ats_whatsapp_question_prompts. The EXTRA questions live in
  // ats_whatsapp_screening_questions and are asked AFTER the six. If the built-in wording were ever
  // written into the extra table instead, every applicant would be asked all six a SECOND time.
  const store = readFileSync(
    new URL("../src/lib/recruitment/inbound/whatsapp-question-prompts-store.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    store.includes('const PROMPTS_TABLE = "ats_whatsapp_question_prompts"'),
    "the built-in wording must be stored in its own table",
  );
  assert.ok(
    !store.includes("ats_whatsapp_screening_questions"),
    "the built-in wording must NEVER be written into the extra-question table — that table is asked after the six, so a row there is a second ask",
  );
  assert.ok(
    /logError\(/.test(store) && /return new Map\(\)/.test(store),
    "a failed read must fall back to an empty override map, so every question keeps its default rather than stopping the conversation",
  );

  // The route must decide for itself which answers may be relabelled. Taking that list from the
  // request body would let a client relabel a value this question does not offer.
  const route = readFileSync(
    new URL("../app/api/admin/question-prompts/route.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    /const options = builtInPrompts\(\)/.test(route) && /allowedValues = options\.map/.test(route),
    "the allowed answer values must come from the code catalogue on the server, never from the request",
  );
  assert.ok(
    /defaultOfferedValues = options[\s\S]{0,120}offeredByDefault/.test(route),
    "which answers are offered BY DEFAULT must also be decided server-side — a client that could claim its own defaults could switch on an answer nothing understands",
  );

  // ── The seam is applied where every menu passes through ────────────────────────────────────────
  // One choke point (sendStep) means an override cannot reach one prompt and silently miss another.
  const session = readFileSync(
    new URL("../src/lib/recruitment/inbound/whatsapp-classify-session.ts", import.meta.url),
    "utf8",
  );
  const sendStepStart = session.indexOf("async function sendStep(");
  assert.ok(sendStepStart !== -1, "sendStep is the seam the override depends on");
  const sendStepBody = session.slice(sendStepStart, session.indexOf("\n}", sendStepStart));
  assert.ok(
    /applyPromptOverride\(/.test(sendStepBody) && /loadQuestionPromptOverrides\(\)/.test(sendStepBody),
    "every tappable built-in question must get its wording through sendStep, or a reword would reach some prompts and not others",
  );
  assert.ok(
    /sendClassifyMenu\(\{\s*menu: worded/.test(sendStepBody),
    "sendStep must send the REWORDED menu, not the original it was handed",
  );
  // The salary question is plain text, so it cannot ride sendStep and resolves its own wording.
  assert.ok(
    /async function salaryPromptWithOverride\(\)/.test(session) && /await salaryPromptWithOverride\(\)/.test(session),
    "the salary question is sent as text, so it must resolve its own override rather than being left on the default forever",
  );

  // ── The migration's constraints hold the same six keys and the same shape ──────────────────────
  const migration = readFileSync(
    new URL("../supabase/migrations/20260831183000_ats_whatsapp_question_prompts.sql", import.meta.url),
    "utf8",
  );
  for (const key of builtInPromptKeys) {
    assert.ok(
      migration.includes(`'${key}'`),
      `the migration's key CHECK must list ${key}, or saving that question's wording fails at the database`,
    );
  }
  assert.ok(
    /char_length\(body_text\) between 1 and 1024/.test(migration),
    "the database must refuse an over-long body too — the app check is not the only writer that could exist",
  );
  assert.ok(
    /option_labels jsonb not null default '\{\}'::jsonb/.test(migration),
    "answer labels default to none, so the feature stays inert until somebody edits something",
  );
  assert.ok(
    /jsonb_typeof\(option_labels\) = 'object'/.test(migration),
    "option_labels is indexed by answer value, so the database must refuse an array or a scalar",
  );
  for (const column of ["hidden_options", "option_order"]) {
    assert.ok(
      new RegExp(`${column} jsonb not null default '\\[\\]'::jsonb`).test(migration),
      `${column} must default to none, so a question with no row keeps exactly the answers the code offers`,
    );
    assert.ok(
      new RegExp(`jsonb_typeof\\(${column}\\) = 'array'`).test(migration),
      `${column} is iterated as a list of answer values, so the database must refuse an object or a scalar`,
    );
  }
  assert.ok(
    /body_text is not null[\s\S]{0,200}option_labels <> '\{\}'::jsonb[\s\S]{0,200}hidden_options <> '\[\]'::jsonb[\s\S]{0,200}option_order <> '\[\]'::jsonb/.test(
      migration,
    ),
    "the not-empty CHECK must count all FOUR kinds of override, or a row that only reorders answers would be refused by the database",
  );

  // -- THE TWO WORDS AROUND THE LIST - the button, and the heading above the answers --------------
  //
  // WhatsApp does not draw these inside the message. The button is the tap target underneath it and
  // the heading sits above the answers once the list opens, so neither is reachable by rewording the
  // prompt - which is exactly how a question translated into Arabic ended up under an English
  // "Choose a role". Both are Meta ceilings that refuse the WHOLE message rather than truncating, so
  // every path here fails toward the code's own words.

  // The catalogue reads them from the real menu builders, like every other default on that screen.
  assert.equal(
    byKey.get("job_title")?.defaultButtonLabel,
    jobTitleMenu().buttonLabel,
    "the screen must show the button the bot really sends, read from the menu builder and never re-typed",
  );
  assert.equal(
    byKey.get("job_title")?.defaultSectionTitle,
    jobTitleMenu().sectionTitle,
    "the screen must show the answer heading the bot really sends, read from the menu builder",
  );
  assert.equal(byKey.get("area")?.defaultButtonLabel, areaMenu("CA", []).buttonLabel);
  assert.equal(byKey.get("experience")?.defaultSectionTitle, experienceMenu().sectionTitle);
  assert.equal(
    byKey.get("salary")?.defaultButtonLabel,
    null,
    "the free-text question has no list, so offering a button box would save words that reach nobody",
  );
  assert.equal(
    byKey.get("salary")?.defaultSectionTitle,
    null,
    "the free-text question has no answer heading either",
  );

  // menuChromeViolations - blank is the "keep the code's own" gesture, not a violation.
  assert.deepEqual(menuChromeViolations({}), [], "nothing typed is nothing wrong");
  assert.deepEqual(menuChromeViolations({ buttonLabel: "   ", sectionTitle: null }), []);
  assert.deepEqual(menuChromeViolations({ buttonLabel: "اختر الوظيفة", sectionTitle: "الوظائف" }), []);
  assert.deepEqual(
    menuChromeViolations({ buttonLabel: "x".repeat(WHATSAPP_LIST_BUTTON_MAX) }),
    [],
    "exactly at the ceiling is sendable - an off-by-one here would refuse a legal button",
  );
  assert.equal(
    menuChromeViolations({ buttonLabel: "x".repeat(WHATSAPP_LIST_BUTTON_MAX + 1) }).length,
    1,
    "one character over the button ceiling must be refused at save time - Meta answers 400 for the whole message, not a clipped button",
  );
  assert.equal(
    menuChromeViolations({ sectionTitle: "x".repeat(WHATSAPP_SECTION_TITLE_MAX + 1) }).length,
    1,
    "one character over the heading ceiling must be refused at save time",
  );

  // resolveMenuChrome - every fallback lands on the code's own words.
  const chromeDefaults = { defaultButtonLabel: "Choose a role", defaultSectionTitle: "Roles" };
  assert.deepEqual(
    resolveMenuChrome({ ...chromeDefaults, saved: null }),
    { buttonLabel: "Choose a role", sectionTitle: "Roles" },
    "no saved row means the code's own button and heading, byte for byte",
  );
  assert.deepEqual(
    resolveMenuChrome({ ...chromeDefaults, saved: { buttonLabel: "   ", sectionTitle: null } }),
    { buttonLabel: "Choose a role", sectionTitle: "Roles" },
    "a blank saved value must fall back, never send a list with no words on its button",
  );
  assert.deepEqual(
    resolveMenuChrome({ ...chromeDefaults, saved: { buttonLabel: "اختر", sectionTitle: "الوظائف" } }),
    { buttonLabel: "اختر", sectionTitle: "الوظائف" },
    "the saved words are what gets sent",
  );
  assert.deepEqual(
    resolveMenuChrome({
      ...chromeDefaults,
      saved: { buttonLabel: "x".repeat(WHATSAPP_LIST_BUTTON_MAX + 1), sectionTitle: null },
    }),
    { buttonLabel: "Choose a role", sectionTitle: "Roles" },
    "an over-long row written before a ceiling moved must fall back rather than stop the conversation dead",
  );

  // applyPromptOverride carries them, and a chrome edit moves no answer CODE.
  const chromeOnly = applyPromptOverride(
    jobTitleMenu(),
    new Map([["job_title", override(null, {}, {}, { buttonLabel: "اختر", sectionTitle: "الوظائف" })]]),
  );
  assert.equal(chromeOnly.buttonLabel, "اختر", "a chrome-only save must reach the menu the bot sends");
  assert.equal(chromeOnly.sectionTitle, "الوظائف", "the saved heading must reach the menu the bot sends");
  assert.equal(
    chromeOnly.body,
    jobTitleMenu().body,
    "wording the button must not touch the question - they are separate boxes and separate columns",
  );
  assert.deepEqual(
    valuesOf(chromeOnly.rows),
    valuesOf(jobTitleMenu().rows),
    "wording the button must not move a single answer code - that is what routes the CV",
  );
  assert.deepEqual(
    menuViolations(chromeOnly),
    [],
    "the reworded menu must still pass the same send-time validator every menu goes through",
  );
  assert.equal(
    applyPromptOverride(jobTitleMenu(), new Map([["job_title", override(null)]])).buttonLabel,
    jobTitleMenu().buttonLabel,
    "an override that words neither keeps the code's own button - the untouched path must be unchanged",
  );

  // -- The admin's OWN extra questions get the same two words ------------------------------------
  const extraBase = {
    appliesToRoleFamilies: null,
    bodyText: "Do you drive?",
    kind: "tappable" as const,
    options: [{ description: null, title: "Yes", value: "yes" }],
    questionKey: "do_you_drive",
  };
  assert.equal(
    buildExtraQuestionMenu(extraBase).buttonLabel,
    EXTRA_QUESTION_BUTTON_DEFAULT,
    "an extra question nobody has worded keeps the generic default, which is what it said before this feature",
  );
  assert.equal(
    buildExtraQuestionMenu(extraBase).sectionTitle,
    EXTRA_QUESTION_SECTION_DEFAULT,
    "the same for its answer heading",
  );
  assert.equal(
    buildExtraQuestionMenu({ ...extraBase, buttonLabel: "اختر", sectionTitle: "الإجابات" }).buttonLabel,
    "اختر",
    "the owner's own question must send the button HE worded",
  );
  assert.equal(
    buildExtraQuestionMenu({ ...extraBase, sectionTitle: "الإجابات" }).sectionTitle,
    "الإجابات",
    "and the heading HE worded",
  );
  assert.equal(
    buildExtraQuestionMenu({ ...extraBase, buttonLabel: "   " }).buttonLabel,
    EXTRA_QUESTION_BUTTON_DEFAULT,
    "a blank falls back here too - one rule for both halves of the screen",
  );
  assert.deepEqual(
    screeningQuestionViolations({ ...extraBase, buttonLabel: "اختر", sectionTitle: "الإجابات" }),
    [],
    "a worded list is saveable",
  );
  assert.equal(
    screeningQuestionViolations({
      ...extraBase,
      buttonLabel: "x".repeat(WHATSAPP_LIST_BUTTON_MAX + 1),
    }).length,
    1,
    "an over-long button on an extra question must be refused by the same menuViolations every send runs",
  );
  assert.equal(
    screeningQuestionViolations({
      ...extraBase,
      buttonLabel: "اختر",
      kind: "free_text",
      options: null,
    }).length,
    1,
    "a free-text question has no list, so wording its button must be refused rather than stored and ignored",
  );

  // -- Both migrations hold the same two ceilings the code does -----------------------------------
  for (const file of [
    "20261003233639_ats_question_prompts_list_chrome.sql",
    "20261003234030_ats_screening_questions_list_chrome.sql",
  ] as const) {
    const sql = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8");
    for (const column of ["button_label", "section_title"] as const) {
      assert.ok(
        new RegExp(`add column if not exists ${column} text`).test(sql),
        `${file} must add ${column}, or the save fails at the database with the app believing it worked`,
      );
    }
    assert.ok(
      new RegExp(
        `button_label is null or char_length\\(btrim\\(button_label\\)\\) between 1 and ${WHATSAPP_LIST_BUTTON_MAX}`,
      ).test(sql),
      `${file} must refuse an over-long button at the database too - the app is not the only writer that could exist`,
    );
    assert.ok(
      new RegExp(
        `section_title is null or char_length\\(btrim\\(section_title\\)\\) between 1 and ${WHATSAPP_SECTION_TITLE_MAX}`,
      ).test(sql),
      `${file} must refuse an over-long answer heading at the database too`,
    );
    assert.ok(
      /_free_text_chrome_check/.test(sql),
      `${file} must refuse a button or heading on the question that has no list`,
    );
    assert.ok(
      !/insert into/i.test(sql),
      `${file} must seed nothing - a stored copy of a default goes stale the day the code's own words improve`,
    );
  }

  // The prompts table's not-empty CHECK is the one that would otherwise refuse the common case: an
  // owner who translates the button and leaves the question itself alone writes a row with nothing
  // else in it. The audience column hit exactly this on 2026-09-05.
  const chromeMigration = readFileSync(
    new URL("../supabase/migrations/20261003233639_ats_question_prompts_list_chrome.sql", import.meta.url),
    "utf8",
  );
  assert.ok(
    /not_empty_check[\s\S]*button_label is not null[\s\S]{0,160}section_title is not null/.test(chromeMigration),
    "the not-empty CHECK must be extended to both new columns, or saving only a button label is refused by the database",
  );

  // ── The message ON THE WIRE, not the object in memory ──────────────────────────────────────────
  //
  // Everything above proves `applyPromptOverride` returns the right menu. This proves the applicant
  // actually RECEIVES it: `sendClassifyMenu` is called for real, with `fetch` stubbed, and the
  // literal JSON body that would reach Meta's Graph API is read back and asserted on.
  //
  // WHY that last hop is worth its own test. The menu object and the wire payload are two different
  // shapes — the payload is rebuilt field by field inside `sendClassifyMenu`, and an edit there
  // (dropping `description`, reading a stale variable, hard-coding a row) would leave every
  // assertion above green while applicants saw the old question. Nothing else in this suite looks
  // at the payload at all.
  //
  // The stub REFUSES any URL that is not the Graph endpoint, so this test cannot write an outbound
  // audit row, cannot reach a database, and sends no network request of any kind. That matters more
  // than usual here: this suite runs with production credentials, and `recordOutboundMessage` runs
  // on every send. Its own catch swallows the refusal, which is exactly what it is built to do.
  const realFetch = globalThis.fetch;
  const realToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const realPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  try {
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token-not-a-credential";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "000000000000000";

    let sentBody: GraphListPayload | null = null;
    globalThis.fetch = (async (url: unknown, init: { body?: string } = {}) => {
      const href = String(url);
      if (!href.startsWith("https://graph.facebook.com/")) {
        throw new Error(`this test must reach nothing but the Graph API; refused ${href}`);
      }
      sentBody = JSON.parse(init.body ?? "null") as GraphListPayload;
      return { json: async () => ({ messages: [{ id: "wamid.TEST" }] }), ok: true, status: 200 };
    }) as unknown as typeof fetch;

    const send = async (menu: Parameters<typeof sendClassifyMenu>[0]["menu"]) => {
      sentBody = null;
      const result = await sendClassifyMenu({ menu, phoneNumberId: null, toWaId: "201000000000" });
      assert.equal(result.ok, true, "the stub accepts, so a not-ok result means the menu was refused before the network call");
      assert.ok(sentBody, "sendClassifyMenu must actually post — a menu that is never sent is a question nobody is asked");
      return sentBody as GraphListPayload;
    };

    const rowsOf = (payload: GraphListPayload) => payload.interactive.action.sections[0].rows;

    // Reword the prompt, relabel one answer, hide another, and switch on an answer the menu has
    // never offered — the four gestures the screen exposes, in one save, exactly as it stores them.
    const edited = new Map<string, PromptOverride>([
      [
        "job_title",
        {
          appliesToRoleFamilies: undefined,
          body: "Ahlan! Which job are you applying for at Sato Pharma?",
          // The fifth and sixth gestures, added 2026-10-03: the button WhatsApp draws under the
          // message and the heading it prints above the answers.
          buttonLabel: "اختر الوظيفة",
          // `personnel` (offered by default since 2026-10-31) is hidden by this admin: naming `sales`
          // in its place keeps the saved order at ten, and an offered answer left out of the order
          // would be APPENDED after "other" as an eleventh row.
          hiddenOptions: ["human_resources", "pharmacist", "personnel"],
          optionLabels: { medical_rep: { description: "Field force", title: "Medical Rep" } },
          optionOrder: [
            "medical_rep",
            "district_manager",
            "area_regional_manager",
            "product_manager",
            "national_sales_manager",
            // hr_section_head (2026-10-06) and talent_acquisition (2026-09-22) are named here for the
            // same reason office_coordinator is: they are offered by default, so leaving one out
            // would not drop it from the wire — it would be APPENDED after "other", a different
            // assertion than this fixture makes. The fixture is an admin's saved order, so it names
            // every answer it covers. `finance` is NOT named: it left the default menu on 2026-10-06,
            // and naming it would make an eleventh row, which the send-time check refuses.
            "hr_section_head",
            "talent_acquisition",
            "sales",
            // Added to this saved order on 2026-09-02 with the office_coordinator family. It is
            // offered by default, so leaving it out would not have dropped it from the wire — it
            // would have been APPENDED after "other", which is a different assertion than the one
            // this fixture is making. The fixture is an admin's saved order, so it names every
            // answer that order covers.
            "office_coordinator",
            "other",
          ],
          sectionTitle: "الوظائف",
        },
      ],
    ]);

    const plain = await send(jobTitleMenu());
    const custom = await send(applyPromptOverride(jobTitleMenu(), edited));

    // THE TWO WORDS WHATSAPP DRAWS AROUND THE LIST, read off the wire rather than the menu object.
    // They live in `action.button` and `sections[0].title`, both rebuilt field by field inside
    // sendClassifyMenu — so an edit there that dropped either would leave the applicant reading an
    // Arabic question under an English button, and nothing in memory would look wrong.
    assert.equal(
      plain.interactive.action.button,
      jobTitleMenu().buttonLabel,
      "with nothing saved the wire must carry the code's own button — the untouched path is unchanged",
    );
    assert.equal(
      custom.interactive.action.button,
      "اختر الوظيفة",
      "the saved button label is what WhatsApp draws under the message — this is the half-translated message this feature exists to fix",
    );
    assert.equal(
      plain.interactive.action.sections[0].title,
      jobTitleMenu().sectionTitle,
      "with nothing saved the wire must carry the code's own answer heading",
    );
    assert.equal(
      custom.interactive.action.sections[0].title,
      "الوظائف",
      "the saved heading is what WhatsApp prints above the answers once the list opens",
    );

    assert.equal(
      plain.interactive.body.text,
      jobTitleMenu().body,
      "with nothing saved the wire must carry the code's own words — the feature has to be inert until somebody edits something",
    );
    assert.equal(
      custom.interactive.body.text,
      "Ahlan! Which job are you applying for at Sato Pharma?",
      "the reworded prompt must reach the wire, or the edit changed a screen and not a conversation",
    );
    assert.equal(
      rowsOf(custom)[0].title,
      "Medical Rep",
      "the relabelled answer must reach the wire as the words the owner typed",
    );
    assert.deepEqual(
      rowsOf(custom).map((row) => row.id),
      [
        "phx:job_title:medical_rep",
        "phx:job_title:district_manager",
        "phx:job_title:area_regional_manager",
        "phx:job_title:product_manager",
        "phx:job_title:national_sales_manager",
        "phx:job_title:hr_section_head",
        "phx:job_title:talent_acquisition",
        "phx:job_title:sales",
        "phx:job_title:office_coordinator",
        "phx:job_title:other",
      ],
      "the wire must carry the hidden answer gone, the added answer present, and the saved order — each row still identified by its CODE",
    );

    // The whole safety story in one assertion. Whatever the owner types, the id Meta sends back is
    // the code, so the pool filters, the candidate folders and the manager routing keep reading the
    // same vocabulary they always did. A relabelled row that changed its id would be a silent
    // misfile, invisible until somebody noticed a candidate in the wrong folder.
    for (const row of [...rowsOf(plain), ...rowsOf(custom)]) {
      const parsed = parseClassifyRowId(row.id);
      assert.ok(parsed, `every row id on the wire must parse back to a code; ${row.id} does not`);
      assert.equal(parsed.step, "job_title", "a row id must name the question it answers");
      assert.ok(
        isOfferedRoleFamily(parsed.value),
        `the reply handler must already accept ${parsed.value}, or tapping that row is dropped in silence`,
      );
    }
  } finally {
    globalThis.fetch = realFetch;
    // Restored as UNSET when that is what it was: assigning `undefined` to process.env stores the
    // four-letter string, which would leave every later test believing a token exists.
    if (realToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
    else process.env.WHATSAPP_ACCESS_TOKEN = realToken;
    if (realPhoneNumberId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = realPhoneNumberId;
  }

}
