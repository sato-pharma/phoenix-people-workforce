// Weekly Sales — why the pre-upload column check did or did not use AI, and the badge the verify panel
// shows for it. Client-safe: weekly-upload-workspace.tsx imports it, so it must never import a server module.
//
// The badge used to read "AI unavailable — manual review" whenever aiUsed was false. That is also the
// answer for a Direct file (matched by header name, so nothing positional to check) and for a file with no
// filled pinned column, neither of which calls AI at all. On 18 Oct 2026 a check on production read that
// way while AI was answering every other call, and was taken for AI being down.

export type WeeklyVerifyAiState =
  /** AI judged the columns. */
  | "checked"
  /** The distributor is matched by header NAME (Direct), so there is no fixed layout to judge. */
  | "header_name_file"
  /** AI is on, but no pinned column had a header to send. */
  | "nothing_to_check"
  /** No AI key is set in this environment. */
  | "not_configured"
  /** AI was asked and every provider failed. */
  | "failed";

export function weeklyVerifyAiBadge(state: WeeklyVerifyAiState): string {
  switch (state) {
    case "checked":
      return "AI checked";
    case "header_name_file":
      return "Matched by header name — manual review";
    case "nothing_to_check":
      return "No filled columns — manual review";
    case "failed":
      return "AI check failed — manual review";
    case "not_configured":
    default:
      return "AI unavailable — manual review";
  }
}
