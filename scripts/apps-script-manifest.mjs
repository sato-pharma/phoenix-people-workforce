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
 * @property {boolean} [moveWebApp] False when the project belongs to a Google account OTHER than
 *                                  the one the grant is from. Then the push never moves its web
 *                                  app: an editor's deployment update turns the /exec URL into
 *                                  "Access denied" for every caller (measured on Direct Orders,
 *                                  22 Oct 2026), and only the owning account can put it right. The
 *                                  push still reads it and FAILS when it serves an old version.
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
    // Owned by another Google account and only SHARED with the grant's account. Moving its web
    // app as that editor broke the /exec URL outright on 22 Oct 2026 (HTTP 403 "Access denied",
    // right secret or wrong), and moving it back to version 5 did not restore it. Only the owner's
    // own Deploy → Manage deployments → Edit → New version keeps it working.
    moveWebApp: false,
  },
  {
    key: "marketing-requests",
    localPath: "docs/marketing-request-live-sheet.gs",
    remoteFile: "Code",
    scriptIdEnv: "MARKETING_REQUESTS_APPS_SCRIPT_ID",
    sheet: "Marketing Requests",
  },
];

/** `projects.updateContent` and `projects.versions.create` need this one. */
export const APPS_SCRIPT_PROJECTS_SCOPE = "https://www.googleapis.com/auth/script.projects";

/**
 * `projects.deployments.list` and `projects.deployments.update` need this one. Without it the push
 * writes the project's HEAD and the sheet's web app keeps serving whatever VERSION it was deployed
 * at — which is how the Direct Orders `/exec` URL sat on version 5 of 5 Aug 2026 for eleven weeks
 * while every push since went to HEAD only (found 22 Oct 2026).
 */
export const APPS_SCRIPT_DEPLOYMENTS_SCOPE = "https://www.googleapis.com/auth/script.deployments";

/** What the consent asks for, space-separated as OAuth wants it. Nothing broader is requested. */
export const APPS_SCRIPT_SCOPE = [APPS_SCRIPT_PROJECTS_SCOPE, APPS_SCRIPT_DEPLOYMENTS_SCOPE].join(" ");

/** The three credentials, named once so the pusher, the authorizer and the docs cannot drift. */
export const OAUTH_ENV = {
  clientId: "GOOGLE_APPS_SCRIPT_CLIENT_ID",
  clientSecret: "GOOGLE_APPS_SCRIPT_CLIENT_SECRET",
  refreshToken: "GOOGLE_APPS_SCRIPT_REFRESH_TOKEN",
};
