/**
 * PV Training Evidence — the signed pharmacovigilance training sheets, for the QPPV only.
 *
 * CLIENT-SAFE: no Supabase import and no server-only module, so the page, the search box and the
 * tests all read the same list and the same gate.
 *
 * ── What the owner asked for (2026-11-09) ───────────────────────────────────────────────────────
 *
 *   "In Dr. Sama account, the QPPV, only in Dr. Sama account. Those are evidence of training …
 *    She types a name, any name from this PDF, then the full sheet appear … The photo itself will
 *    appear … and a table will render with the person details … Don't make it over engineer."
 *
 * And, asked how to show the people the employee record cannot place: "don't put status beside
 * anyone. Don't put status. She has a combo box. She type a name, a drop list appear. She choose
 * the name, the page render, only." So the page carries NO employment status for anyone.
 *
 * The source is the 30-page CamScanner scan he sent ("CamScanner 09-11-2026 22.39.pdf"). Each page
 * is one sheet (PV-FM-008); the scans live in `assets/pv-training-sheets/sheet-NN.jpg`, NOT in
 * `public/`, because every page carries real signatures — the server reads a page only for the
 * QPPV and only when one of its names is chosen.
 *
 * ── How a name is tied to a person ──────────────────────────────────────────────────────────────
 *
 * `hrId` was matched by hand against the employee master on 2026-11-09, one row at a time, and is
 * used for one thing only: two spellings on two sheets ("Nahed Hatab", "Nahed Hattab") are one person
 * with two sheets. `null` means the sheet's name matched nobody on the master.
 * A crossed-out row on a sheet (Wegdan Wagdy, serial 01/2026) did not attend and is left out.
 */

export { canOpenPvTrainingEvidence, PV_TRAINING_EVIDENCE_HR_IDS } from "@/lib/pv-training/access";

export type PvTrainingAttendee = {
  /** The name exactly as the sheet prints it — what the QPPV types. */
  readonly name: string;
  /** The title as the sheet prints it. */
  readonly title: string;
  /** The employee master's HR id, or null when the name matched nobody on the master. */
  readonly hrId: string | null;
};

export type PvTrainingSheet = {
  /** The page of the scan, 1-based — also the image file `sheet-NN.jpg`. */
  readonly page: number;
  readonly serial: string;
  /** The date as the sheet prints it. */
  readonly date: string;
  readonly time: string;
  readonly title: string;
  readonly location: string;
  readonly attendees: readonly PvTrainingAttendee[];
};

const MR = "Medical Representative";
const SMR = "Senior Medical Representative";
const DSM = "District Sales Manager";

const ALL_DEPARTMENTS = {
  serial: "01/2026",
  date: "Wednesday, 25 February 2026",
  time: "2:00 to 3:00 PM",
  title: "PV training for all departments",
  location: "Concorde El Salam Hotel",
} as const;

export const PV_TRAINING_SHEETS: readonly PvTrainingSheet[] = [
  { page: 1, ...ALL_DEPARTMENTS, attendees: [
    { name: "Anwar Ibrahim Gawish", title: "CEO", hrId: "AA" },
    { name: "Sahar Khalil Kamel", title: "R&D Manager", hrId: "AB" },
    { name: "Ahmed El Kawass", title: "Training Manager", hrId: "A-7" },
    { name: "Khaled Bedair", title: "SFE Manager", hrId: "A-2" },
    { name: "Omar Anwar", title: "QA Specialist", hrId: "B-10" },
    { name: "Nahed Hatab", title: "Product Manager", hrId: "A-10" },
  ] },
  { page: 2, ...ALL_DEPARTMENTS, attendees: [
    { name: "Yasmine Samy", title: MR, hrId: "B-130" },
    { name: "Mahmoud El Husseinin", title: DSM, hrId: "B-120" },
    { name: "Mohamed Salem", title: MR, hrId: "B-100" },
    { name: "Nermeen Salah", title: DSM, hrId: "B-154" },
    { name: "Mostafa Saied", title: MR, hrId: "B-177" },
    { name: "Beshoy Isaac", title: MR, hrId: null },
  ] },
  { page: 3, ...ALL_DEPARTMENTS, attendees: [
    { name: "Mariam Mohamed", title: MR, hrId: "B-144" },
    { name: "Mohamed Hamed", title: MR, hrId: "B-169" },
    { name: "Ragaa Mohamed", title: MR, hrId: "B-107" },
    { name: "Omnia Nader Ismael", title: MR, hrId: "B-14" },
    { name: "Saad Salama", title: DSM, hrId: "B-119" },
    { name: "Amr Gbr", title: MR, hrId: "B-125" },
  ] },
  { page: 4, ...ALL_DEPARTMENTS, attendees: [
    { name: "Belal El Naggar", title: SMR, hrId: "B-67" },
    { name: "Mohamed ElMenshawy", title: MR, hrId: "B-148" },
    { name: "Ahmed Heikal", title: DSM, hrId: "B-5" },
    { name: "Hagar Hashim", title: MR, hrId: "B-92" },
  ] },
  { page: 5, ...ALL_DEPARTMENTS, attendees: [
    { name: "Amr Osama", title: MR, hrId: "B-153" },
    { name: "Ahmed Hemdan El Sayed", title: MR, hrId: "B-58" },
    { name: "Mustafa El Kabbani", title: MR, hrId: "B-114" },
    { name: "Esraa Ahmed", title: MR, hrId: "B-40" },
    { name: "Mohamed Nasr", title: MR, hrId: "B-115" },
    { name: "Nahla Mahmoud", title: MR, hrId: "B-108" },
  ] },
  { page: 6, ...ALL_DEPARTMENTS, attendees: [
    { name: "Sherif Medhat Abdelwahed", title: MR, hrId: "B-161" },
    { name: "Tayseer Khaled", title: MR, hrId: "B-85" },
    { name: "Kareem Gamal", title: DSM, hrId: "B-101" },
    { name: "Ali Mohamed Shehata", title: MR, hrId: "B-146" },
    { name: "Aya Adel Abdelwahab", title: MR, hrId: "B-99" },
    { name: "Ahmed Mahmoud", title: MR, hrId: "B-109" },
  ] },
  { page: 7, ...ALL_DEPARTMENTS, attendees: [
    { name: "Ayman ElSalhy", title: SMR, hrId: "B-96" },
    { name: "Mahmoud AlSlamony", title: MR, hrId: "B-43" },
    { name: "Aml Mohamed", title: MR, hrId: "B-15" },
    { name: "Ahmed Helal", title: SMR, hrId: "B-3" },
    { name: "Ahmed Soliman", title: MR, hrId: "B-134" },
    { name: "Salim Gomaa", title: DSM, hrId: "B-76" },
  ] },
  { page: 8, ...ALL_DEPARTMENTS, attendees: [
    { name: "Nada Ali", title: "Office Co-ordinator", hrId: "A-13" },
    { name: "Youmna Kotb", title: "HR Talent Acquisition", hrId: "A-16" },
    { name: "Ahmed El Maraghy", title: "Financial and Administrative Manager", hrId: "B-185" },
    { name: "Ali Mohamed Ali", title: "Head of Pharmaceutical", hrId: "A-12" },
    { name: "Ahmed Kaoud", title: "Admin Assistant", hrId: "A-15" },
    { name: "Mahmoud Ibrahim", title: "Admin Assistant", hrId: "A-1" },
  ] },
  { page: 9, ...ALL_DEPARTMENTS, attendees: [
    { name: "Ahmed Ashraf", title: MR, hrId: "B-143" },
    { name: "Mirna Marcos", title: MR, hrId: "B-33" },
    { name: "Ahmed Abdallah", title: DSM, hrId: "B-74" },
    { name: "Yassin Samir", title: MR, hrId: "B-132" },
    { name: "Mostafa Mamdouh", title: MR, hrId: "B-82" },
  ] },
  { page: 10, ...ALL_DEPARTMENTS, attendees: [
    { name: "Nada Osama", title: MR, hrId: "B-152" },
    { name: "Gehad Ahmed", title: MR, hrId: null },
    { name: "Hayam Mohamed", title: SMR, hrId: "B-25" },
    { name: "Amgad Ibrahim", title: DSM, hrId: "B-118" },
    { name: "Ahmed Abdelazeem", title: DSM, hrId: "B-159" },
  ] },
  { page: 11, ...ALL_DEPARTMENTS, attendees: [
    { name: "Rana Adel", title: MR, hrId: "B-13" },
    { name: "Mina Khaled", title: MR, hrId: "B-140" },
    { name: "Bishoy Bahaa", title: MR, hrId: "B-141" },
    { name: "Amany Wasiem", title: MR, hrId: "B-111" },
    { name: "Yehya Kamal", title: DSM, hrId: "B-23" },
  ] },
  { page: 12, ...ALL_DEPARTMENTS, attendees: [
    { name: "Youssef Hesham", title: MR, hrId: "B-113" },
    { name: "Nada Abdullah", title: MR, hrId: "B-91" },
    { name: "Nada Saed", title: MR, hrId: "B-129" },
    { name: "Sara Mohy", title: MR, hrId: "B-126" },
    { name: "Warda Farhat Abdelsalam", title: MR, hrId: "B-55" },
    { name: "Aya Ibrahim", title: SMR, hrId: "B-7" },
  ] },
  { page: 13, ...ALL_DEPARTMENTS, attendees: [
    { name: "Hana Ghoniem", title: MR, hrId: null },
    { name: "Samir Saad", title: MR, hrId: "B-137" },
    { name: "Hadeer Abdelnaser", title: MR, hrId: "B-95" },
    { name: "GannaTallah Amer", title: MR, hrId: "PD-0008" },
    { name: "Fatma Momen", title: MR, hrId: "B-147" },
    { name: "Sameh El Hoseiny", title: DSM, hrId: "B-117" },
  ] },
  { page: 14, ...ALL_DEPARTMENTS, attendees: [
    { name: "Veronica Ashraf", title: MR, hrId: "B-162" },
    { name: "Mary Magdy", title: MR, hrId: "B-17" },
    { name: "Hagar Noureldeen", title: MR, hrId: "B-135" },
    { name: "Nesma Yousry", title: MR, hrId: "B-49" },
    { name: "Sara Samir", title: DSM, hrId: null },
  ] },
  { page: 15, ...ALL_DEPARTMENTS, attendees: [
    { name: "Dina Fadel", title: DSM, hrId: "B-12" },
    { name: "Mayar El Morsy", title: MR, hrId: "B-77" },
    { name: "Radwa Ahmed", title: MR, hrId: "B-145" },
    { name: "Yomna Salah", title: MR, hrId: "B-128" },
    { name: "Nada Mohammed", title: MR, hrId: "B-97" },
    { name: "Hassan Mohamed", title: MR, hrId: "B-158" },
  ] },
  { page: 16, ...ALL_DEPARTMENTS, attendees: [
    { name: "Essam Youssef", title: MR, hrId: null },
    { name: "Mahmoud Hosny", title: MR, hrId: "B-102" },
    { name: "Haitham Abdelkarim Afifi", title: DSM, hrId: "A-6" },
    { name: "Mina Farouk", title: DSM, hrId: "B-116" },
    { name: "Tasneem Mohamed", title: MR, hrId: "B-127" },
    { name: "Heba Abdelbaset", title: DSM, hrId: "B-28" },
  ] },
  { page: 17, ...ALL_DEPARTMENTS, attendees: [
    { name: "Beshoy Wagih", title: MR, hrId: "B-149" },
    { name: "Taha Mohamed", title: DSM, hrId: "B-94" },
    { name: "Sameh El Hoseiny", title: DSM, hrId: "B-117" },
    { name: "Fiby Wagdy Luka", title: MR, hrId: "B-52" },
    { name: "Fatma Gharib", title: MR, hrId: "B-136" },
    { name: "Eman Ahmed Fathy", title: MR, hrId: "B-104" },
  ] },
  { page: 18, ...ALL_DEPARTMENTS, attendees: [
    { name: "Rasha Sabry", title: "Group Product Manager", hrId: "A-8" },
    { name: "Ahmed Sharaf", title: "Product Manager", hrId: "B-155" },
    { name: "Hossam Reda", title: "Marketing Manager", hrId: "A-9" },
    { name: "Adel El Sayed", title: "Financial Advisor", hrId: "OF-0002" },
    { name: "Amr Naguib", title: "National Sales Manager", hrId: "B-122" },
    { name: "Sameh Ezzat", title: "National Sales Manager", hrId: "B-157" },
  ] },
  { page: 19, ...ALL_DEPARTMENTS, attendees: [
    { name: "Mostafa Khaled", title: MR, hrId: "B-150" },
    { name: "Maria Sobhy", title: MR, hrId: "B-151" },
    { name: "Gerges Sameh", title: MR, hrId: "B-112" },
    { name: "Marian Samir", title: MR, hrId: "B-142" },
    { name: "Mina Masoud", title: MR, hrId: "B-124" },
  ] },
  { page: 20, ...ALL_DEPARTMENTS, attendees: [
    { name: "Mostafa Galal", title: MR, hrId: "B-59" },
    { name: "Ibrahim SalahEldeen", title: MR, hrId: "B-138" },
    { name: "Mariem Ezzat", title: MR, hrId: "B-105" },
    { name: "Nourhan Fawzy", title: MR, hrId: "B-65" },
  ] },
  { page: 21, ...ALL_DEPARTMENTS, attendees: [
    { name: "Aisha Ehab", title: MR, hrId: "B-79" },
    { name: "Sherouk Wael", title: MR, hrId: "B-34" },
    { name: "Karen George", title: MR, hrId: "B-133" },
    { name: "Aya Ashraf", title: MR, hrId: "B-139" },
    { name: "Nosiba Salah Moussa", title: SMR, hrId: "B-1" },
    { name: "Abanoub Ehab", title: MR, hrId: "B-106" },
  ] },
  {
    page: 22,
    serial: "09/2026",
    date: "Wednesday, 14 October 2026",
    time: "12:00 to 12:30 PM",
    title: "Pharmacovigilance (PV) orientation for newly hired medical reps",
    location: "302 labs coworking space",
    attendees: [
      { name: "Jonia Wageh", title: MR, hrId: "PD-0016" },
      { name: "Norhan Samir", title: MR, hrId: "PD-0021" },
      { name: "Shahd Ghooniem", title: MR, hrId: "PD-0026" },
      { name: "Esraa Awad", title: MR, hrId: "PD-0017" },
      { name: "Ebtisam Alaa", title: MR, hrId: "PD-0013" },
      { name: "Ganat Ragab", title: MR, hrId: "PD-0024" },
      { name: "Mostafa Ahmed", title: SMR, hrId: "PD-0025" },
      { name: "Taha Sheeba", title: MR, hrId: "PD-0018" },
      { name: "Mostafa Saied", title: SMR, hrId: "B-177" },
      { name: "Mohamed Ramadan", title: "District Manager", hrId: "PD-0015" },
      { name: "Mohamed Alaa", title: "District Manager", hrId: "PD-0012" },
      { name: "Osama Mohamed", title: "District Manager", hrId: "PD-0014" },
      { name: "Mai Abdel Samee", title: MR, hrId: "AI-0027" },
    ],
  },
  {
    page: 23,
    serial: "05/2026",
    date: "Sunday, 13 September 2026",
    time: "1:00 to 1:30 PM",
    title: "Office services – Pharmacovigilance (PV) Interaction Training",
    location: "Scientific office",
    attendees: [
      { name: "Mahmoud Ibrahim", title: "Admin Assistant", hrId: "A-1" },
      { name: "Mohamed Zain", title: "Buffet Manager", hrId: "A-4" },
    ],
  },
  {
    page: 24,
    serial: "04/2026",
    date: "Sunday, 13 September 2026",
    time: "12:00 to 12:30 PM",
    title: "Legal and financial – Pharmacovigilance (PV) Interaction Training",
    location: "Scientific office",
    attendees: [
      { name: "Adel Sayed", title: "Financial Department Manager", hrId: "OF-0002" },
      { name: "Ahmed El Maraghy", title: "Legal Department Manager", hrId: "B-185" },
    ],
  },
  {
    page: 25,
    serial: "03/2026",
    date: "Thursday, 10 September 2026",
    time: "1:30 to 2:00 PM",
    title: "Sales & Marketing – Pharmacovigilance (PV) Interaction Training",
    location: "Scientific office",
    attendees: [
      { name: "Hossam Reda", title: "Marketing Manager", hrId: "A-9" },
      { name: "Nahed Hattab", title: "Product Manager", hrId: "A-10" },
      { name: "Rasha Sabry", title: "Group Product Manager", hrId: "A-8" },
      { name: "Ahmed Sharaf", title: "Product Manager", hrId: "B-155" },
      { name: "Ahmed El Kawas", title: "Training Manager", hrId: "A-7" },
      { name: "Khaled Bedear", title: "CRM Manager", hrId: "A-2" },
      { name: "Ali Mohamed", title: "Sales Manager", hrId: "A-12" },
      { name: "Magdy El Senosey", title: "Sales Manager", hrId: "AI-0008" },
      { name: "Amr Naguib", title: "Sales Manager", hrId: "B-122" },
    ],
  },
  {
    page: 26,
    serial: "02/2026",
    date: "Monday, 04 May 2026",
    time: "10:30 to 11:00 AM",
    title: "PV training for newly hired medical representatives",
    location: "Scientific office",
    attendees: [
      { name: "Nada Essameldin Zahran", title: MR, hrId: "B-174" },
      { name: "Eman Essam Arafa", title: MR, hrId: "B-176" },
      { name: "Ghada Mohamed", title: MR, hrId: "B-189" },
      { name: "Mostafa Saied Basuny", title: SMR, hrId: "B-177" },
      { name: "Fathy Fawzy", title: SMR, hrId: "B-178" },
      { name: "Ashraf Radwan", title: MR, hrId: "B-179" },
      { name: "Atef Sherif", title: MR, hrId: "B-187" },
      { name: "Ahmed Nashaat", title: "District Manager", hrId: "B-175" },
      { name: "Abdel Rahman Nour", title: MR, hrId: null },
    ],
  },
  {
    page: 27,
    serial: "08/2026",
    date: "Monday, 28 September 2026",
    time: "2:00 to 3:00 PM",
    title: "Pharmacovigilance (PV) and HR department interaction",
    location: "Scientific office",
    attendees: [{ name: "Reham Mohamed", title: "Regulatory Affairs Supervisor", hrId: "OF-0004" }],
  },
  {
    page: 28,
    serial: "07/2026",
    date: "Sunday, 23 September 2026",
    time: "2:00 to 3:00 PM",
    title: "Pharmacovigilance (PV) and HR department interaction",
    location: "Scientific office",
    attendees: [
      { name: "Yasmeena ElSafoury", title: "HR Manager", hrId: "HR-009" },
      { name: "Omar Anwar", title: "QA Specialist", hrId: "B-10" },
    ],
  },
  {
    page: 29,
    serial: "06/2026",
    date: "Sunday, 16 September 2026",
    time: "10:45 to 11:30 AM",
    title: "Pharmacovigilance (PV) Interaction Training for newly hired",
    location: "Scientific office",
    attendees: [
      { name: "Mohammed Khaled", title: MR, hrId: "AI-0011" },
      { name: "Mohamed Hamed", title: MR, hrId: "AI-0016" },
      { name: "Ahmed Farag", title: MR, hrId: "AI-0020" },
      { name: "Hanan Safwat", title: MR, hrId: "AI-0012" },
      { name: "Weaam Gweed", title: "District Manager", hrId: "AI-0013" },
      { name: "Sama Shalaby", title: "District Manager", hrId: "AI-0014" },
      { name: "Samah Ashraf", title: MR, hrId: "AI-0018" },
      { name: "Omayma Wael", title: MR, hrId: "PD-0039" },
      { name: "Esraa Fotouh", title: MR, hrId: "AI-0021" },
      { name: "Mahmoud Abd Elrheem", title: MR, hrId: "AI-0005" },
    ],
  },
  {
    page: 30,
    serial: "10/2026",
    date: "Wednesday, 04 November 2026",
    time: "10:00 to 11:30 AM",
    title: "Pharmacovigilance (PV) orientation",
    location: "Scientific office",
    attendees: [
      { name: "Salma Labib", title: "Training Manager", hrId: "OF-0006" },
      { name: "Yomna Gamal", title: "Talent Acquisition", hrId: "HR-011" },
      { name: "Aya Tarek", title: "Office Coordinator", hrId: "OF-0005" },
    ],
  },
];

/** One person the QPPV can pick, with every sheet that carries them. */
export type PvTrainingPerson = {
  /** Stable key for the URL: the HR id when there is one, else the folded name. */
  readonly key: string;
  /** The sheet's spelling — the first one met, in sheet order. */
  readonly name: string;
  readonly hrId: string | null;
  readonly appearances: readonly { readonly sheet: PvTrainingSheet; readonly attendee: PvTrainingAttendee }[];
};

function foldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
}

/** Every person on every sheet, one entry each — a name on two sheets is one person with two sheets. */
export function listPvTrainingPeople(sheets: readonly PvTrainingSheet[] = PV_TRAINING_SHEETS): PvTrainingPerson[] {
  const byKey = new Map<string, { name: string; hrId: string | null; appearances: PvTrainingPerson["appearances"][number][] }>();
  for (const sheet of sheets) {
    for (const attendee of sheet.attendees) {
      const key = attendee.hrId ? attendee.hrId.toUpperCase() : foldName(attendee.name);
      const existing = byKey.get(key);
      if (existing) {
        existing.appearances.push({ sheet, attendee });
      } else {
        byKey.set(key, { name: attendee.name, hrId: attendee.hrId, appearances: [{ sheet, attendee }] });
      }
    }
  }
  return Array.from(byKey, ([key, value]) => ({ key, ...value })).sort((a, b) => a.name.localeCompare(b.name));
}

export function findPvTrainingPerson(key: string | null | undefined): PvTrainingPerson | null {
  const wanted = String(key ?? "").trim();
  if (!wanted) return null;
  return listPvTrainingPeople().find((person) => person.key.toLowerCase() === wanted.toLowerCase()) ?? null;
}

/** The scan's file name for a page — `sheet-07.jpg`. */
export function pvTrainingSheetFileName(page: number): string {
  return `sheet-${String(page).padStart(2, "0")}.jpg`;
}
