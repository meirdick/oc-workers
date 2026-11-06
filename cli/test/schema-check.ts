// Validate a value against a JSON Schema (draft-07 subset as OpenClaw's generated channel schemas use it):
// type, enum, const, pattern, min/max, properties, additionalProperties, anyOf, oneOf, allOf, items.
// `required` is skipped: the generated schema marks keys with defaults as required (output shape), but a config
// file may leave them out. Returns a list of "path: problem" lines; empty = valid.
type S = Record<string, any>;

export function check(schema: S, v: unknown, path = "$"): string[] {
  const errs: string[] = [];
  if (schema.const !== undefined && v !== schema.const)
    return [`${path}: expected ${JSON.stringify(schema.const)}`];
  if (schema.enum && !schema.enum.includes(v)) return [`${path}: ${JSON.stringify(v)} not in enum`];
  if (schema.allOf) for (const s of schema.allOf) errs.push(...check(s, v, path));
  if (schema.anyOf && !schema.anyOf.some((s: S) => check(s, v, path).length === 0))
    errs.push(`${path}: matches none of anyOf`);
  if (schema.oneOf && schema.oneOf.filter((s: S) => check(s, v, path).length === 0).length !== 1)
    errs.push(`${path}: does not match exactly one of oneOf`);
  const types: string[] =
    schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length) {
    const t =
      v === null
        ? "null"
        : Array.isArray(v)
          ? "array"
          : typeof v === "number" && Number.isInteger(v)
            ? "integer"
            : typeof v;
    const ok = types.some((x) => x === t || (x === "number" && t === "integer"));
    if (!ok) return [...errs, `${path}: expected ${types.join("|")}, got ${t}`];
  }
  if (typeof v === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(v))
      errs.push(`${path}: does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && v.length < schema.minLength) errs.push(`${path}: too short`);
    if (schema.format === "uri" && !URL.canParse(v)) errs.push(`${path}: not a uri`);
  }
  if (typeof v === "number") {
    if (schema.minimum !== undefined && v < schema.minimum) errs.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && v > schema.maximum) errs.push(`${path}: above maximum`);
  }
  if (Array.isArray(v) && schema.items)
    for (const [i, x] of v.entries()) errs.push(...check(schema.items, x, `${path}[${i}]`));
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const props: S = schema.properties ?? {};
    for (const [k, x] of Object.entries(v)) {
      if (props[k]) errs.push(...check(props[k], x, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: unknown key`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        errs.push(...check(schema.additionalProperties, x, `${path}.${k}`));
    }
  }
  return errs;
}
