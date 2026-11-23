export type AxiErrorCode =
  | "PROFILE_REQUIRED"
  | "SCOPE_LOCKED"
  | "SCOPE_DENIED"
  | "OUT_OF_ROOT_SCOPE"
  | "DUPLICATE_INJECTION_MODE"
  | "NOT_FOUND"
  | "TOKEN_MISSING"
  | "INVALID_ARGUMENT"
  | "NOTION_API_ERROR"
  | "RATE_LIMITED"
  | "AMBIGUOUS_WRITE_OUTCOME"
  | "CONFLICT_STALE_TARGET"
  | "VALIDATION_ERROR"
  | "BUDGET_EXCEEDED"
  | "CONFIG_INVALID";

export class AxiError extends Error {
  readonly code: AxiErrorCode;
  readonly help: string[];
  readonly httpStatus?: number;

  constructor(
    code: AxiErrorCode,
    message: string,
    help: string[] = [],
    httpStatus?: number,
  ) {
    super(message);
    this.name = "AxiError";
    this.code = code;
    this.help = help;
    this.httpStatus = httpStatus;
  }

  toCompactString(): string {
    const lines = [`ERROR [${this.code}]: ${this.message}`];
    for (const hint of this.help) {
      lines.push(`  hint: ${hint}`);
    }
    return lines.join("\n");
  }
}
