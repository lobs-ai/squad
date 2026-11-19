/**
 * JSON Schema → Zod raw shape.
 *
 * Squad's tool registry describes inputs as JSON Schema (`input_schema`). The
 * Claude Agent SDK's in-process `tool()` helper takes a Zod *raw shape*
 * (`{ field: z.string() }`). This bridges the two so squad primitives can be
 * registered as in-process MCP tools with their real schemas — no subprocess,
 * no catalog tax.
 *
 * Deliberately permissive: anything it can't model maps to `z.any()` so the
 * model is never blocked from calling a tool by a schema we failed to convert.
 * Squad's own executor remains the authoritative validator.
 */

import { z } from "zod";

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  nullable?: boolean;
  [k: string]: unknown;
}

export type ZodRawShape = Record<string, z.ZodType>;

/** Convert a top-level object schema into the raw shape `tool()` expects. */
export function jsonSchemaToZodShape(schema: JsonSchema | undefined): ZodRawShape {
  const props = schema?.properties;
  if (!props || typeof props !== "object") return {};
  const required = new Set(Array.isArray(schema?.required) ? schema!.required : []);
  const shape: ZodRawShape = {};
  for (const [key, propSchema] of Object.entries(props)) {
    let field = jsonSchemaToZodType(propSchema);
    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }
  return shape;
}

/** Convert a single JSON Schema node into a Zod type. */
export function jsonSchemaToZodType(schema: JsonSchema | undefined): z.ZodType {
  if (!schema || typeof schema !== "object") return z.any();

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const nullable = schema.nullable === true || types.includes("null");
  const primary = types.find((t) => t !== "null");

  let base = buildBase(primary, schema);

  if (schema.description) base = base.describe(schema.description);
  if (nullable) base = base.nullable();

  return base;
}

function buildBase(type: string | undefined, schema: JsonSchema): z.ZodType {
  // String enums map to z.enum; everything else falls through to the type.
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum.filter((v): v is string => typeof v === "string");
    if (values.length === schema.enum.length && values.length > 0) {
      return z.enum(values as [string, ...string[]]);
    }
    // Mixed / non-string enum — accept anything the model offers.
    return z.any();
  }

  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(jsonSchemaToZodType(schema.items));
    case "object":
      // Nested object: model declared properties → typed shape (unknown keys
      // are stripped, never rejected); otherwise an open record.
      return schema.properties
        ? z.object(jsonSchemaToZodShape(schema))
        : z.record(z.string(), z.any());
    default:
      return z.any();
  }
}
