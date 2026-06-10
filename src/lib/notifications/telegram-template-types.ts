// Single source of truth for the redacted payroll/payslip Telegram body. Sensitive
// payroll content must never reach Telegram in full; every redaction site (live send,
// both retry workers, and the payslip template default) references this constant.
export const GENERIC_PAYSLIP_MESSAGE = "Your payslip is available.";
// Generic-only governance must strip the TITLE too - {{message}} is now a legal
// placeholder in title templates, so a content-bearing title would bypass the control.
export const GENERIC_NOTIFICATION_TITLE = "Phoenix Workforce update";

export class TelegramTemplateError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TelegramTemplateError";
    this.code = code;
  }
}
