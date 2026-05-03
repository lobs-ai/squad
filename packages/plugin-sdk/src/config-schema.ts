import { z, type ZodTypeAny } from "zod";

/**
 * JSON-friendly description of one config field. Generated from a Zod
 * schema by {@link describeConfigSchema}, shipped over the wire by
 * `plugins.describe`, and rendered as a form by the dashboard / CLI.
 *
 * `kind` is a coarse hint — clients render it however makes sense. We keep
 * the set small so the form generator stays trivial. Anything more exotic
 * (json blobs, nested objects) ships as `kind: "json"` and clients fall
 * back to a textarea + JSON.parse.
 */
export interface PluginConfigField {
  name: string;
  kind: "string" | "number" | "boolean" | "enum" | "array" | "json";
  required: boolean;
  /** Display description — pulled from `.describe()` on the Zod schema. */
  description?: string;
  /** Default value when the user doesn't fill anything in. */
  default?: unknown;
  /** Allowed values when `kind === "enum"`. */
  options?: string[];
  /**
   * True when this field carries a secret. The dashboard hides the value
   * by default and offers an "auto-generate" button; the gateway generates
   * a random token on install when the user leaves it blank.
   */
  secret?: boolean;
  /**
   * Hint that this field stores the *name* of an env var to read (e.g.
   * `bot_token_env: "DISCORD_BOT_TOKEN"`). The form labels accordingly so
   * the user knows they're typing the variable name, not the value.
   */
  envRef?: boolean;
}

const SECRET_KEY = "__pluginConfigMeta";

interface FieldMeta {
  secret?: boolean;
  envRef?: boolean;
  /** When `true`, generate a 32-byte hex token if the user supplies nothing. */
  autoGenerate?: boolean;
}

/**
 * Tag a Zod field with plugin-config metadata. Stored in the schema's
 * `_def.description` JSON via a sentinel prefix so we can read it back out
 * without subclassing Zod. Use as:
 *
 *   pluginField(z.string(), { secret: true, autoGenerate: true })
 */
export function pluginField<T extends ZodTypeAny>(schema: T, meta: FieldMeta): T {
  // Stash the meta on the schema's `_def` directly so we can read it back
  // out from `describeConfigSchema` without round-tripping through JSON.
  // Zod doesn't care about extra properties on `_def`.
  const def = schema._def as Record<string, unknown>;
  def[SECRET_KEY] = { ...(def[SECRET_KEY] as object | undefined), ...meta };
  return schema;
}

function readMeta(schema: ZodTypeAny): FieldMeta {
  const def = schema._def as Record<string, unknown>;
  return (def[SECRET_KEY] as FieldMeta | undefined) ?? {};
}

function unwrapOptional(s: ZodTypeAny): { inner: ZodTypeAny; required: boolean } {
  if (s instanceof z.ZodOptional) return { inner: s.unwrap() as ZodTypeAny, required: false };
  if (s instanceof z.ZodDefault) return { inner: s.removeDefault() as ZodTypeAny, required: false };
  if (s instanceof z.ZodNullable) return { inner: s.unwrap() as ZodTypeAny, required: false };
  return { inner: s, required: true };
}

function defaultValue(s: ZodTypeAny): unknown {
  if (s instanceof z.ZodDefault) {
    const def = s._def as { defaultValue: () => unknown };
    try {
      return def.defaultValue();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function fieldKind(s: ZodTypeAny): PluginConfigField["kind"] {
  if (s instanceof z.ZodString) return "string";
  if (s instanceof z.ZodNumber) return "number";
  if (s instanceof z.ZodBoolean) return "boolean";
  if (s instanceof z.ZodEnum) return "enum";
  if (s instanceof z.ZodArray) return "array";
  return "json";
}

function enumOptions(s: ZodTypeAny): string[] | undefined {
  if (s instanceof z.ZodEnum) {
    const def = s._def as { values: readonly string[] };
    return [...def.values];
  }
  return undefined;
}

/**
 * Convert a Zod object schema into a flat list of {@link PluginConfigField}.
 * Top-level fields only — nested objects are reported as `kind: "json"` and
 * the form falls back to a textarea. That's a fine v1 trade-off; nothing
 * in the catalog needs nesting today.
 *
 * Returns an empty array (not throws) when the schema is anything other
 * than an object — keeps the calling site's "schema is optional" branching
 * trivial.
 */
export function describeConfigSchema(schema: unknown): PluginConfigField[] {
  if (!(schema instanceof z.ZodObject)) return [];
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
  const out: PluginConfigField[] = [];
  for (const [name, raw] of Object.entries(shape)) {
    const wrapper = raw as ZodTypeAny;
    const meta = readMeta(wrapper);
    const dflt = defaultValue(wrapper);
    const { inner, required } = unwrapOptional(wrapper);
    const innerMeta = readMeta(inner);
    const merged: FieldMeta = { ...innerMeta, ...meta };
    const kind = fieldKind(inner);
    const description = (inner._def as { description?: string }).description;
    const options = enumOptions(inner);
    out.push({
      name,
      kind,
      required: required && dflt === undefined,
      ...(description ? { description } : {}),
      ...(dflt !== undefined ? { default: dflt } : {}),
      ...(options ? { options } : {}),
      ...(merged.secret ? { secret: true } : {}),
      ...(merged.envRef ? { envRef: true } : {}),
    });
  }
  return out;
}

/**
 * Walk an object schema and pull out the metadata keyed by field name —
 * mainly so the install path can find which fields want auto-generation
 * without re-parsing the field list.
 */
export function readSchemaMeta(
  schema: unknown,
): Record<string, FieldMeta> {
  if (!(schema instanceof z.ZodObject)) return {};
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
  const out: Record<string, FieldMeta> = {};
  for (const [name, raw] of Object.entries(shape)) {
    const wrapper = raw as ZodTypeAny;
    const meta = readMeta(wrapper);
    const { inner } = unwrapOptional(wrapper);
    const innerMeta = readMeta(inner);
    out[name] = { ...innerMeta, ...meta };
  }
  return out;
}
