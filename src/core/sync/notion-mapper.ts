import crypto from "node:crypto";
import { slugifyAlias } from "../../shared/text.js";
import type {
  CachedDataSource,
  CachedProperty,
  CachedRelationEdge,
  NotionDataSource,
  NotionFormulaValue,
  NotionPage,
  NotionPropertyValue,
  NotionRichText,
  NotionRollupValue,
} from "../../shared/types.js";

const READ_ONLY_PROPERTY_TYPES = new Set([
  "formula",
  "rollup",
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
  "button",
  "auto_increment_id",
  "unique_id",
]);

export function richTextToPlain(items?: NotionRichText[]): string {
  if (!items || items.length === 0) return "";
  return items.map((t) => t.plain_text).join("").trim();
}

export function extractPageTitle(page: NotionPage): string {
  for (const val of Object.values(page.properties)) {
    if (val.type === "title") {
      return richTextToPlain(val.title);
    }
  }
  return "Untitled";
}

/**
 * Generates a unique slug for `title` against `usedSet`, registering it in `usedSet`.
 */
export function makeUniqueSlug(title: string, usedSet: Set<string>): string {
  const base = slugifyAlias(title);
  let slug = base;
  let suffix = 2;
  while (usedSet.has(slug)) {
    slug = `${base}_${suffix++}`;
  }
  usedSet.add(slug);
  return slug;
}

function hashObject(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export function toCachedDataSource(
  ds: NotionDataSource,
  parentNodeId: string | null,
): CachedDataSource {
  const properties: Record<string, CachedProperty> = {};
  for (const [propName, schema] of Object.entries(ds.properties)) {
    let options: string[] | undefined;
    let relationTargetDataSourceId: string | undefined;
    let rollupRelationPropertyName: string | undefined;
    let formulaExpression: string | undefined;

    switch (schema.type) {
      case "select":
        options = schema.select.options.map((o) => o.name);
        break;
      case "multi_select":
        options = schema.multi_select.options.map((o) => o.name);
        break;
      case "status":
        options = schema.status.options.map((o) => o.name);
        break;
      case "relation":
        relationTargetDataSourceId = schema.relation.data_source_id;
        break;
      case "rollup":
        rollupRelationPropertyName = schema.rollup.relation_property_name;
        break;
      case "formula":
        formulaExpression = schema.formula.expression;
        break;
      default:
        break;
    }

    properties[schema.id] = {
      id: schema.id,
      name: schema.name ?? propName,
      type: schema.type,
      read_only: READ_ONLY_PROPERTY_TYPES.has(schema.type),
      ...(options ? { options } : {}),
      ...(relationTargetDataSourceId
        ? { relation_target_data_source_id: relationTargetDataSourceId }
        : {}),
      ...(rollupRelationPropertyName
        ? { rollup_relation_property_name: rollupRelationPropertyName }
        : {}),
      ...(formulaExpression ? { formula_expression: formulaExpression } : {}),
    };
  }

  const databaseId = ds.parent.type === "database_id" ? ds.parent.database_id : ds.id;
  const title = richTextToPlain(ds.title) || ds.name || "Untitled Database";

  return {
    data_source_id: ds.id,
    database_id: databaseId,
    title,
    parent_node_id: parentNodeId,
    last_edited_time: ds.last_edited_time,
    schema_hash: hashObject(properties),
    properties,
  };
}

export function buildRelationEdges(
  dataSources: Record<string, CachedDataSource>,
): CachedRelationEdge[] {
  const edges: CachedRelationEdge[] = [];
  for (const ds of Object.values(dataSources)) {
    for (const prop of Object.values(ds.properties)) {
      if (prop.type === "relation" && prop.relation_target_data_source_id) {
        edges.push({
          from_data_source_id: ds.data_source_id,
          property_id: prop.id,
          property_name: prop.name,
          to_data_source_id: prop.relation_target_data_source_id,
        });
      }
    }
  }
  return edges;
}

function formatDateRange(d: { start: string; end?: string | null } | null): string {
  if (!d?.start) return "";
  return d.end ? `${d.start}..${d.end}` : d.start;
}

function formatFormulaValue(f: NotionFormulaValue | null | undefined): string {
  if (!f) return "";
  switch (f.type) {
    case "string":
      return f.string ?? "";
    case "number":
      return f.number === null || f.number === undefined ? "" : String(f.number);
    case "boolean":
      return f.boolean === null || f.boolean === undefined ? "" : String(f.boolean);
    case "date":
      return formatDateRange(f.date);
    default:
      return "";
  }
}

function formatRollupValue(r: NotionRollupValue | null | undefined): string {
  if (!r) return "";
  switch (r.type) {
    case "number":
      return r.number === null || r.number === undefined ? "" : String(r.number);
    case "date":
      return formatDateRange(r.date);
    case "array":
      return Array.isArray(r.array)
        ? r.array.map((item) => formatNotionPropertyValue(item)).filter(Boolean).join(", ")
        : "";
    case "unsupported":
    case "incomplete":
    default:
      return "";
  }
}

export function formatNotionPropertyValue(
  raw: NotionPropertyValue | string | null | undefined,
): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw;
  switch (raw.type) {
    case "title":
      return richTextToPlain(raw.title);
    case "rich_text":
      return richTextToPlain(raw.rich_text);
    case "status":
      return raw.status?.name ?? "";
    case "select":
      return raw.select?.name ?? "";
    case "multi_select":
      return (raw.multi_select ?? []).map((o) => o.name).join(", ");
    case "number":
      return raw.number === null || raw.number === undefined ? "" : String(raw.number);
    case "checkbox":
      return raw.checkbox ? "true" : "false";
    case "url":
      return raw.url ?? "";
    case "email":
      return raw.email ?? "";
    case "phone_number":
      return raw.phone_number ?? "";
    case "date":
      return formatDateRange(raw.date);
    case "relation":
      return (raw.relation ?? []).map((r) => r.id).join(", ");
    case "formula":
      return formatFormulaValue(raw.formula);
    case "rollup":
      return formatRollupValue(raw.rollup);
    case "created_time":
      return raw.created_time ?? "";
    case "last_edited_time":
      return raw.last_edited_time ?? "";
    case "created_by":
      return raw.created_by?.name ?? raw.created_by?.id ?? "";
    case "last_edited_by":
      return raw.last_edited_by?.name ?? raw.last_edited_by?.id ?? "";
    case "people":
      return (raw.people ?? []).map((u) => u.name ?? u.id).filter(Boolean).join(", ");
    case "files":
      return (raw.files ?? []).map((f) => f.name).filter(Boolean).join(", ");
    case "unique_id": {
      const uid = raw.unique_id;
      if (!uid || uid.number === null || uid.number === undefined) return "";
      return uid.prefix ? `${uid.prefix}-${uid.number}` : String(uid.number);
    }
    case "auto_increment_id": {
      const aid = raw.auto_increment_id;
      if (aid === null || aid === undefined) return "";
      if (typeof aid === "number") return String(aid);
      if (aid.number === null || aid.number === undefined) return "";
      return aid.prefix ? `${aid.prefix}-${aid.number}` : String(aid.number);
    }
    case "button":
      return "";
    case "verification":
      if (!raw.verification) return "";
      return raw.verification.date?.start
        ? `${raw.verification.state} (${raw.verification.date.start})`
        : raw.verification.state;
    case "unsupported":
    default:
      return "";
  }
}

export function formatQueryRowLines(
  rows: Array<{ id: string; fields: Record<string, string> }>,
): string {
  return rows
    .map((row) => {
      const pairs = Object.entries(row.fields)
        .map(([k, v]) => `${k}=${v.replace(/\s+/g, " ").trim()}`)
        .join(" | ");
      return `  ${row.id} | ${pairs}`;
    })
    .join("\n");
}
