function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(object[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value)!;
}

/** FNV-1a over the UTF-8 bytes of JSON with recursively sorted object keys. */
export function contentHash(value: unknown): string {
  // Normalize JSON values first (including omitted properties and null array slots),
  // and let JSON.stringify reject cycles and other unsupported values.
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError('Value is not JSON serializable');
  }
  const bytes = new TextEncoder().encode(stableJson(JSON.parse(json)));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}
