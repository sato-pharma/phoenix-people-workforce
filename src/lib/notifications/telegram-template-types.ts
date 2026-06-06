export class TelegramTemplateError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TelegramTemplateError";
    this.code = code;
  }
}
