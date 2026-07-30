export function parseStrictJson(value: string): unknown {
  let position = 0;

  function whitespace(): void {
    while (/\s/.test(value[position] ?? "")) position += 1;
  }

  function parseValue(): unknown {
    whitespace();
    const character = value[position];
    if (character === "{") return object();
    if (character === "[") return array();
    if (character === '"') return string();
    for (const [literal, output] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (value.startsWith(literal, position)) {
        position += literal.length;
        return output;
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      value.slice(position),
    );
    if (!match) throw new Error("invalid JSON value");
    position += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) throw new Error("invalid JSON number");
    return number;
  }

  function object(): Record<string, unknown> {
    position += 1;
    whitespace();
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    if (value[position] === "}") {
      position += 1;
      return result;
    }
    for (;;) {
      whitespace();
      if (value[position] !== '"') throw new Error("invalid JSON object key");
      const key = string();
      if (keys.has(key)) throw new Error("duplicate JSON object key");
      keys.add(key);
      whitespace();
      if (value[position] !== ":") throw new Error("invalid JSON object");
      position += 1;
      result[key] = parseValue();
      whitespace();
      if (value[position] === "}") {
        position += 1;
        return result;
      }
      if (value[position] !== ",") throw new Error("invalid JSON object");
      position += 1;
    }
  }

  function array(): unknown[] {
    position += 1;
    whitespace();
    const result: unknown[] = [];
    if (value[position] === "]") {
      position += 1;
      return result;
    }
    for (;;) {
      result.push(parseValue());
      whitespace();
      if (value[position] === "]") {
        position += 1;
        return result;
      }
      if (value[position] !== ",") throw new Error("invalid JSON array");
      position += 1;
    }
  }

  function string(): string {
    const start = position;
    position += 1;
    let escaped = false;
    while (position < value.length) {
      const code = value.charCodeAt(position);
      if (!escaped && code === 0x22) {
        position += 1;
        return JSON.parse(value.slice(start, position)) as string;
      }
      if (!escaped && code === 0x5c) escaped = true;
      else escaped = false;
      position += 1;
    }
    throw new Error("unterminated JSON string");
  }

  const output = parseValue();
  whitespace();
  if (position !== value.length) throw new Error("trailing JSON data");
  return output;
}
