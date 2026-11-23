// Recruitment — the limits on a picture the person brings to the Publish press. Shared by the dialog
// (a quick check before sending) and the server (own-picture.ts, the real check). No server imports here.

/** The drawn post at twice its 1080 x 1350 box is about 3.5 MB; this leaves room and keeps the press quick. */
export const OWN_PICTURE_MAX_BYTES = 8 * 1024 * 1024;
