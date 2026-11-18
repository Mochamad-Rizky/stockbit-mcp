export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Stockbit answers with long lists (running trade, order queue, broker rows). A tool result that
// floods the model's context is worse than a shorter one that says it was cut, so lists past the
// limit are cut and every cut is reported.
export function capArrays(
  value: JsonValue,
  maxItems: number,
  path = '$',
  cuts: string[] = [],
): { value: JsonValue; cuts: string[] } {
  if (Array.isArray(value)) {
    const kept = value.slice(0, maxItems);
    if (value.length > maxItems) {
      cuts.push(`${path}: kept ${maxItems} of ${value.length} items`);
    }
    return {
      value: kept.map((item, i) => capArrays(item, maxItems, `${path}[${i}]`, cuts).value),
      cuts,
    };
  }
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = capArrays(item, maxItems, `${path}.${key}`, cuts).value;
    }
    return { value: out, cuts };
  }
  return { value, cuts };
}

// JSON.parse output is JsonValue already; this narrows `unknown` from fetch without copying.
export function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}
