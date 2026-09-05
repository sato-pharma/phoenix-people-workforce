// Which repository file belongs in which Google Apps Script project.
//
// Three live Google Sheets pull from Phoenix, and each is driven by an Apps Script that lives in
// Google rather than here. Until now the repository copy was only a REVIEW copy: merging an
// improvement to it changed nothing on the sheet, because somebody still had to paste ~2,000 lines
// into the Apps Script editor by hand. This manifest is what makes the repository copy the real
// one — `scripts/push-apps-script.mjs` writes it into Google on merge.
//
// A target whose script-id variable is unset is SKIPPED, loudly and successfully. That mirrors how
// the sheet-token rotation is already wired (docs/environment.md): each sheet can be connected on
// its own, and an unconnected one must never fail the run for the others.

/**
 * @typedef {object} AppsScriptTarget
 * @property {string} key           Stable name used by `--only` and in log lines.
 * @property {string} localPath     Repo-relative path of the file that is the source of truth.
 * @property {string} remoteFile    The file's name INSIDE the Apps Script project, without the
 *                                  `.gs` extension — Apps Script stores a name plus a type, not a
 *                                  filename. `Code` is the default an empty project starts with.
 * @property {string} scriptIdEnv   Environment variable holding that project's script id.
 * @property {string} sheet         Human name, for the messages the owner actually reads.
 */

/** @type {readonly AppsScriptTarget[]} */
export const APPS_SCRIPT_TARGETS = [
  {
    key: "cv-lifecycle",
    localPath: "docs/cv-lifecycle-live-sheet.gs",
    remoteFile: "Code",
    scriptIdEnv: "CV_LIFECYCLE_APPS_SCRIPT_ID",
    sheet: "CV Lifecycle",
  },
  {
    key: "direct-orders",
    localPath: "docs/direct-orders-live-sheet.gs",
    remoteFile: "Code",
    scriptIdEnv: "DIRECT_ORDERS_APPS_SCRIPT_ID",
    sheet: "Direct Orders",
  },
  {
    key: "marketing-requests",
    localPath: "docs/marketing-request-live-sheet.gs",
    remoteFile: "Code",
    scriptIdEnv: "MARKETING_REQUESTS_APPS_SCRIPT_ID",
    sheet: "Marketing Requests",
  },
];

/** The OAuth scope `projects.updateContent` needs. Nothing broader is requested. */
export const APPS_SCRIPT_SCOPE = "https://www.googleapis.com/auth/script.projects";

/** The three credentials, named once so the pusher, the authorizer and the docs cannot drift. */
export const OAUTH_ENV = {
  clientId: "GOOGLE_APPS_SCRIPT_CLIENT_ID",
  clientSecret: "GOOGLE_APPS_SCRIPT_CLIENT_SECRET",
  refreshToken: "GOOGLE_APPS_SCRIPT_REFRESH_TOKEN",
};
