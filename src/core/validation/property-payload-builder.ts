import { AxiError } from "../../shared/errors.js";
import { extractNotionUuid, normalizeNfd } from "../../shared/text.js";
import type {
  CachedProperty,
  NotionPropertyValue,
  OntologyConfig,
} from "../../shared/types.js";
import type { ScopeGuard } from "../scope/scope-guard.js";

export type MutationOp = "set" | "add" | "remove" | "clear";

export type NotionWritePropertyPayload =
  | { title: Array<{ type: "text"; text: { content: string } }> }
  | { rich_text: Array<{ type: "text"; text: { content: string } }> }
  | { status: { name: string } | null }
  | { select: { name: string } | null }
  | { multi_select: Array<{ name: string }> }
  | { relation: Array<{ id: string }> }
  | { number: number | null }
  | { checkbox: boolean }
  | { date: { start: string; end?: string } | null }
  | { url: string | null }
  | { email: string | null }
  | { phone_number: string | null }
  | {
      verification: {
        state: "verified" | "unverified";
        date?: { start: string; end?: string };
      };
    };

export interface ValidatedPropertyChange {
  op: MutationOp;
  schema: CachedProperty;
  rawInputValue?: string;
  notionPayload: NotionWritePropertyPayload;
  /** For relation / multi_select: exact item lists before and after mutation. */
  previousItems?: string[];
  nextItems?: string[];
  previousFormatted?: string;
  nextFormatted?: string;
}

/**
 * Internal marker error for validation failures that could be caused by stale
 * cached schemas (unknown property or unknown/missing select/status option),
 * triggering at most one reactive refresh of that single data_source_id.
 */
export class SchemaDriftError extends AxiError {}

/**
 * Validation error thrown when a select/multi_select option is still unknown
 * after schema refresh, enabling `--propose-new-option` auto-routing.
 */
export class UnknownOptionError extends AxiError {
  constructor(
    public readonly propertyName: string,
    public readonly propertyType: "select" | "multi_select",
    public readonly optionValue: string,
    message: string,
    help: string[],
  ) {
    super("VALIDATION_ERROR", message, help);
  }
}

export function extractCurrentList(prop: NotionPropertyValue | undefined): string[] {
  if (!prop) return [];
  if (prop.type === "multi_select") {
    return (prop.multi_select ?? []).map((o) => o.name);
  }
  if (prop.type === "relation") {
    return (prop.relation ?? []).map((r) => r.id);
  }
  return [];
}

export function parseRelationUuid(propName: string, input: string): string {
  const uuid = extractNotionUuid(input);
  if (!uuid) {
    throw new AxiError(
      "VALIDATION_ERROR",
      `Relation property "${propName}" requires valid Notion page UUIDs (got "${input}").`,
    );
  }
  return uuid;
}

export function snapValidOption(
  alias: string,
  schema: CachedProperty,
  rawVal: string,
  allowDriftRetry: boolean,
): string {
  const options = schema.options ?? [];
  if (options.length === 0) {
    const msg = `Field "${schema.name}" (${schema.type}) has no known options in schema for "${alias}".`;
    const help = [
      `Run \`wiki sync\` or propose a new option via \`wiki schema propose-option ${alias} "${schema.name}" "${rawVal}"\`.`,
    ];
    if (allowDriftRetry) {
      throw new SchemaDriftError("VALIDATION_ERROR", msg, help);
    }
    if (schema.type === "select" || schema.type === "multi_select") {
      throw new UnknownOptionError(schema.name, schema.type, rawVal, msg, help);
    }
    throw new AxiError("VALIDATION_ERROR", msg, help);
  }

  const norm = normalizeNfd(rawVal);
  const matched = options.find((o) => normalizeNfd(o) === norm);
  if (!matched) {
    const hints = [`Valid options for "${schema.name}": ${options.join(", ")}`];
    if (schema.type === "select" || schema.type === "multi_select") {
      hints.push(
        `To add a new option safely, run \`wiki schema propose-option ${alias} "${schema.name}" "${rawVal}"\`.`,
      );
    }
    const msg = `Invalid ${schema.type} value "${rawVal}" for field "${schema.name}".`;
    if (allowDriftRetry) {
      throw new SchemaDriftError("VALIDATION_ERROR", msg, hints);
    }
    if (schema.type === "select" || schema.type === "multi_select") {
      throw new UnknownOptionError(schema.name, schema.type, rawVal, msg, hints);
    }
    throw new AxiError("VALIDATION_ERROR", msg, hints);
  }
  return matched;
}

function assertIsoDateOnly(propName: string, raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) {
    throw new AxiError(
      "VALIDATION_ERROR",
      `Property "${propName}" requires ISO-8601 date YYYY-MM-DD (got "${raw}").`,
    );
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new AxiError(
      "VALIDATION_ERROR",
      `Property "${propName}" has invalid calendar date "${raw}".`,
    );
  }
  return raw;
}

/**
 * Parse Notion Wiki verification input.
 * Supported formats:
 * - "verified" or "unverified"
 * - "verified@YYYY-MM-DD" or "verified|YYYY-MM-DD"
 * - "verified@YYYY-MM-DD..YYYY-MM-DD" or "verified|YYYY-MM-DD..YYYY-MM-DD"
 * Always strips Notion-managed `verified_by`.
 */
export function parseVerificationInput(
  propName: string,
  rawVal: string,
): { state: "verified" | "unverified"; date?: { start: string; end?: string } } {
  const trimmed = rawVal.trim();
  const match = /^(verified|unverified)(?:[@|](.+))?$/i.exec(trimmed);
  if (!match) {
    throw new AxiError(
      "VALIDATION_ERROR",
      `Wiki verification "${propName}" accepts "verified", "unverified", "verified@YYYY-MM-DD", or "verified|YYYY-MM-DD..YYYY-MM-DD" (got "${rawVal}").`,
    );
  }
  const state = match[1]!.toLowerCase() as "verified" | "unverified";
  const rawDatePart = match[2]?.trim();
  if (!rawDatePart) {
    return { state };
  }
  if (state === "unverified") {
    throw new AxiError(
      "VALIDATION_ERROR",
      `Wiki verification "${propName}" cannot include a date when state is "unverified".`,
    );
  }
  const rangeParts = rawDatePart.split("..").map((s) => s.trim());
  if (rangeParts.length > 2 || !rangeParts[0]) {
    throw new AxiError(
      "VALIDATION_ERROR",
      `Wiki verification "${propName}" date must be YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD (got "${rawDatePart}").`,
    );
  }
  const start = assertIsoDateOnly(propName, rangeParts[0]);
  if (rangeParts[1] !== undefined) {
    if (!rangeParts[1]) {
      throw new AxiError(
        "VALIDATION_ERROR",
        `Wiki verification "${propName}" date range end cannot be empty (got "${rawDatePart}").`,
      );
    }
    const end = assertIsoDateOnly(propName, rangeParts[1]);
    return { state, date: { start, end } };
  }
  return { state, date: { start } };
}

export function buildClearPayload(schema: CachedProperty): NotionWritePropertyPayload {
  switch (schema.type) {
    case "title":
      return { title: [] };
    case "rich_text":
      return { rich_text: [] };
    case "status":
      return { status: null };
    case "select":
      return { select: null };
    case "multi_select":
      return { multi_select: [] };
    case "number":
      return { number: null };
    case "date":
      return { date: null };
    case "url":
      return { url: null };
    case "email":
      return { email: null };
    case "phone_number":
      return { phone_number: null };
    case "relation":
      return { relation: [] };
    case "checkbox":
      return { checkbox: false };
    default:
      throw new AxiError(
        "VALIDATION_ERROR",
        `Clearing property "${schema.name}" of type "${schema.type}" is not supported.`,
      );
  }
}

export function assertRelationTargetAllowed(
  scopeGuard: ScopeGuard,
  ontology: OntologyConfig,
  profileName: string,
  schema: CachedProperty,
): void {
  if (!schema.relation_target_data_source_id) {
    throw new AxiError(
      "VALIDATION_ERROR",
      `Relation property "${schema.name}" has no known target data_source_id in cache.`,
      ["Run `wiki sync` to refresh database schemas."],
    );
  }
  scopeGuard.assertDataSourceAccess(
    ontology,
    profileName,
    schema.relation_target_data_source_id,
  );
}

export function buildSetPayload(params: {
  scopeGuard: ScopeGuard;
  ontology: OntologyConfig;
  profileName: string;
  alias: string;
  dbOverlay: OntologyConfig["databases"][string];
  schema: CachedProperty;
  rawVal: string;
  previousItems?: string[];
  previousFormatted: string;
  allowDriftRetry: boolean;
}): ValidatedPropertyChange {
  const {
    scopeGuard,
    ontology,
    profileName,
    alias,
    dbOverlay,
    schema,
    rawVal,
    previousItems,
    previousFormatted,
    allowDriftRetry,
  } = params;

  switch (schema.type) {
    case "title":
      return {
        op: "set",
        schema,
        rawInputValue: rawVal,
        notionPayload: { title: [{ type: "text", text: { content: rawVal } }] },
        previousFormatted,
        nextFormatted: rawVal,
      };
    case "rich_text":
      return {
        op: "set",
        schema,
        rawInputValue: rawVal,
        notionPayload: { rich_text: [{ type: "text", text: { content: rawVal } }] },
        previousFormatted,
        nextFormatted: rawVal,
      };
    case "status": {
      const snapped = snapValidOption(alias, schema, rawVal, allowDriftRetry);
      return {
        op: "set",
        schema,
        rawInputValue: rawVal,
        notionPayload: { status: { name: snapped } },
        previousFormatted,
        nextFormatted: snapped,
      };
    }
    case "select": {
      const snapped = snapValidOption(alias, schema, rawVal, allowDriftRetry);
      return {
        op: "set",
        schema,
        rawInputValue: rawVal,
        notionPayload: { select: { name: snapped } },
        previousFormatted,
        nextFormatted: snapped,
      };
    }
    case "multi_select": {
      const prev = previousItems ?? [];
      const items = rawVal.split(",").map((s) => s.trim()).filter(Boolean);
      const snapped = [
        ...new Set(items.map((v) => snapValidOption(alias, schema, v, allowDriftRetry))),
      ];
      return {
        op: "set",
        schema,
        rawInputValue: rawVal,
        notionPayload: { multi_select: snapped.map((name) => ({ name })) },
        previousItems: prev,
        nextItems: snapped,
        previousFormatted,
        nextFormatted: snapped.join(", "),
      };
    }
    case "relation": {
      assertRelationTargetAllowed(scopeGuard, ontology, profileName, schema);
      const prev = previousItems ?? [];
      const items = rawVal.split(",").map((s) => s.trim()).filter(Boolean);
      const ids = [...new Set(items.map((v) => parseRelationUuid(schema.name, v)))];
      return {
        op: "set",
        schema,
        rawInputValue: rawVal,
        notionPayload: { relation: ids.map((id) => ({ id })) },
        previousItems: prev,
        nextItems: ids,
        previousFormatted,
        nextFormatted: ids.join(", "),
      };
    }
    case "number": {
      const num = Number(rawVal);
      if (!Number.isFinite(num)) {
        throw new AxiError(
          "VALIDATION_ERROR",
          `Property "${schema.name}" requires a valid number (got "${rawVal}").`,
        );
      }
      const bounds = dbOverlay.numeric_bounds[schema.id];
      if (bounds) {
        if (bounds.min !== undefined && num < bounds.min) {
          throw new AxiError(
            "VALIDATION_ERROR",
            `Property "${schema.name}" value ${num} is below configured minimum ${bounds.min}.`,
          );
        }
        if (bounds.max !== undefined && num > bounds.max) {
          throw new AxiError(
            "VALIDATION_ERROR",
            `Property "${schema.name}" value ${num} exceeds configured maximum ${bounds.max}.`,
          );
        }
      }
      return {
        op: "set",
        schema,
        rawInputValue: rawVal,
        notionPayload: { number: num },
        previousFormatted,
        nextFormatted: String(num),
      };
    }
    case "checkbox": {
      const lower = rawVal.toLowerCase();
      if (lower !== "true" && lower !== "false") {
        throw new AxiError(
          "VALIDATION_ERROR",
          `Property "${schema.name}" requires "true" or "false" (got "${rawVal}").`,
        );
      }
      const checked = lower === "true";
      return {
        op: "set",
        schema,
        rawInputValue: rawVal,
        notionPayload: { checkbox: checked },
        previousFormatted,
        nextFormatted: String(checked),
      };
    }
    case "date": {
      const parts = rawVal.split("..").map((s) => s.trim());
      const start = parts[0]!;
      const end = parts[1] || undefined;
      if (!/^\d{4}-\d{2}-\d{2}/.test(start)) {
        throw new AxiError(
          "VALIDATION_ERROR",
          `Property "${schema.name}" requires ISO-8601 date YYYY-MM-DD (got "${rawVal}").`,
        );
      }
      if (end && !/^\d{4}-\d{2}-\d{2}/.test(end)) {
        throw new AxiError(
          "VALIDATION_ERROR",
          `Property "${schema.name}" requires ISO-8601 end date YYYY-MM-DD (got "${rawVal}").`,
        );
      }
      return {
        op: "set",
        schema,
        rawInputValue: rawVal,
        notionPayload: { date: end ? { start, end } : { start } },
        previousFormatted,
        nextFormatted: rawVal,
      };
    }
    case "url": {
      try {
        const parsed = new URL(rawVal);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("invalid protocol");
        }
      } catch {
        throw new AxiError(
          "VALIDATION_ERROR",
          `Property "${schema.name}" requires a valid http(s) URL (got "${rawVal}").`,
        );
      }
      return {
        op: "set",
        schema,
        rawInputValue: rawVal,
        notionPayload: { url: rawVal },
        previousFormatted,
        nextFormatted: rawVal,
      };
    }
    case "email":
      return {
        op: "set",
        schema,
        rawInputValue: rawVal,
        notionPayload: { email: rawVal },
        previousFormatted,
        nextFormatted: rawVal,
      };
    case "phone_number":
      return {
        op: "set",
        schema,
        rawInputValue: rawVal,
        notionPayload: { phone_number: rawVal },
        previousFormatted,
        nextFormatted: rawVal,
      };
    case "verification": {
      const parsed = parseVerificationInput(schema.name, rawVal);
      const nextFormatted = parsed.date
        ? `${parsed.state}@${parsed.date.start}${parsed.date.end ? `..${parsed.date.end}` : ""}`
        : parsed.state;
      return {
        op: "set",
        schema,
        rawInputValue: rawVal,
        notionPayload: { verification: parsed },
        previousFormatted,
        nextFormatted,
      };
    }
    default:
      throw new AxiError(
        "VALIDATION_ERROR",
        `Writing property "${schema.name}" of type "${schema.type}" is not supported.`,
      );
  }
}
