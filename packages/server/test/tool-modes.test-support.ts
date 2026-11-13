/** JSON schema of a tool's input, as tools/list has it. */
export interface InputSchema { properties?: Record<string, Record<string, unknown>>; required?: string[] }

/** A value no property of this schema accepts, or undefined when the property takes anything. */
function wrongValue(prop: Record<string, unknown>): unknown {
  if (Array.isArray(prop.enum)) return '\u0000 not one of them';
  if ('const' in prop) return '\u0000 not it';
  switch (prop.type) {
    case 'string': return 12345;
    case 'number': case 'integer': case 'boolean': case 'array': case 'object': return '\u0000 wrong type';
  }
  const options = (prop.anyOf ?? prop.oneOf) as Record<string, unknown>[] | undefined;
  if (options?.length && options.every((o) => ['number', 'integer', 'boolean', 'array', 'object'].includes(String(o.type)))) return '\u0000 wrong type';
  return undefined;
}

/**
 * Arguments that fail a tool's own validation, so a call reaches the tool without running it: none at all when it
 * needs some, else a wrong value for every property that has a type. Null when no such arguments exist.
 */
export function invalidArguments(schema: InputSchema): Record<string, unknown> | null {
  if (schema.required?.length) return {};
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const value = wrongValue(prop);
    if (value !== undefined) out[name] = value;
  }
  return Object.keys(out).length ? out : null;
}
