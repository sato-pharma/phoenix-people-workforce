// HR Reminders — the shapes shared by the service, the API and the board.
//
// Client-safe on purpose: nothing here imports a server module, so the board can use the types and
// the pure rules in ./logic.ts without pulling the database client into the browser bundle.

/** The Phoenix palette an author can tag an item with. Matches the table's CHECK constraint. */
export const REMINDER_COLORS = ["ink", "ember", "orange", "amber", "slate"] as const;
export type ReminderColor = (typeof REMINDER_COLORS)[number];

export type ReminderStatus = "open" | "done";

export const REMINDER_TITLE_MAX = 200;
export const REMINDER_BODY_MAX = 4000;
export const REMINDER_COMMENT_MAX = 2000;

/** One row of `hr_reminders`, in the app's own spelling. Dates are Cairo calendar days. */
export type ReminderRecord = {
  body: string;
  color: ReminderColor;
  createdAt: string;
  doneAt: string | null;
  doneByHrId: string | null;
  /** Cairo wall-clock "HH:MM", only ever set together with `remindOn`. */
  endsAt: string | null;
  id: string;
  ownerHrId: string;
  /** Cairo calendar day "YYYY-MM-DD", or null for a plain note. */
  remindOn: string | null;
  shareWithTeam: boolean;
  sharedWithHrIds: string[];
  startsAt: string | null;
  status: ReminderStatus;
  title: string;
  updatedAt: string;
};

/** What the board draws: the row, plus the names and counts a card needs. */
export type ReminderView = ReminderRecord & {
  /** True when the viewer wrote it — the only person who may edit, finish or remove it. */
  canChange: boolean;
  commentCount: number;
  lastCommentAt: string | null;
  ownerName: string;
};

/** A person on the HR team, resolved to the name the company uses. */
export type TeamMember = {
  hrId: string;
  /** The HR Manager's seat — the one person who reads every item. Named in the sharing help text. */
  isOverseer: boolean;
  name: string;
};

export type ReminderViewerInfo = {
  hrId: string;
  /** The HR Manager's oversight: sees every item, whatever its sharing. */
  isOverseer: boolean;
  name: string;
};

export type ReminderBoardData = {
  /** False while the tables are not there yet (deploy landed before the migration). */
  schemaReady: boolean;
  team: TeamMember[];
  /** Today in Cairo, "YYYY-MM-DD". Sent from the server so the browser's clock never decides it. */
  today: string;
  reminders: ReminderView[];
  viewer: ReminderViewerInfo;
};

export type ReminderCommentView = {
  authorHrId: string;
  authorName: string;
  body: string;
  createdAt: string;
  id: string;
  /** True when the viewer wrote it. */
  mine: boolean;
  reminderId: string;
  replyToId: string | null;
};

/** What an author types when they create or edit an item. */
export type ReminderDraft = {
  body: string;
  color: ReminderColor;
  endsAt: string | null;
  remindOn: string | null;
  shareWithTeam: boolean;
  sharedWithHrIds: string[];
  startsAt: string | null;
  title: string;
};

export type SharingKind = "private" | "people" | "team";
