// Recruitment settings — the parts a browser component may import (no database client here). The
// reads and writes are recruitment-settings-db.ts.

export const WHATSAPP_REASK_ENABLED_KEY = "whatsapp_reask_enabled";
export const REJECTION_MESSAGE_TEXT_KEY = "rejection_message_text";

/** What a candidate is sent when HR asks for the rejection message and nobody has edited the text. */
export const DEFAULT_REJECTION_MESSAGE_TEXT =
  "Thank you for applying to Sato Pharma. We have reviewed your application and will not be moving forward at this time. We wish you every success.";

export type RecruitmentSettingsView = {
  whatsAppReaskEnabled: boolean;
  rejectionMessageText: string;
  rejectionMessageIsDefault: boolean;
};
