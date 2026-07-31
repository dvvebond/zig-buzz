import type { TriggerContext } from "./types.js";

type Value = string | number | boolean | null;
type Token =
  | {
      readonly type: "identifier" | "operator" | "punctuation";
      readonly value: string;
    }
  | { readonly type: "string"; readonly value: string }
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "eof"; readonly value: "" };

export function evaluateCondition(
  expression: string,
  trigger: TriggerContext,
  stepOutputs: Readonly<Record<string, unknown>>,
): boolean {
  if (Buffer.byteLength(expression, "utf8") > 4_096) {
    throw new ConditionEvaluationError("condition exceeds 4096 bytes");
  }
  const context = conditionContext(trigger, stepOutputs);
  const parser = new ConditionParser(tokenize(expression), context);
  const value = parser.parse();
  if (typeof value !== "boolean") {
    throw new ConditionEvaluationError("condition must evaluate to boolean");
  }
  return value;
}

function conditionContext(
  trigger: TriggerContext,
  stepOutputs: Readonly<Record<string, unknown>>,
): Readonly<Record<string, Value>> {
  const context: Record<string, Value> = {};
  for (const [key, value] of Object.entries(trigger.webhookFields)) {
    if (!key.startsWith("trigger_") && !key.startsWith("steps_")) {
      context[`trigger_${key}`] = value;
    }
  }
  Object.assign(context, {
    trigger_author: trigger.author,
    trigger_channel_id: trigger.channelId,
    trigger_emoji: trigger.emoji,
    trigger_message_id: trigger.messageId,
    trigger_text: trigger.text,
    trigger_timestamp: String(trigger.timestamp),
  });
  for (const [stepId, rawOutput] of Object.entries(stepOutputs)) {
    if (
      typeof rawOutput !== "object" ||
      rawOutput === null ||
      Array.isArray(rawOutput)
    ) {
      continue;
    }
    for (const [field, rawValue] of Object.entries(
      rawOutput as Record<string, unknown>,
    )) {
      const value = scalarValue(rawValue);
      if (value !== undefined) {
        context[`steps_${stepId}_output_${field}`] = value;
      }
    }
  }
  return context;
}

class ConditionParser {
  #index = 0;

  public constructor(
    private readonly tokens: readonly Token[],
    private readonly context: Readonly<Record<string, Value>>,
  ) {}

  public parse(): Value {
    const value = this.#parseOr();
    if (this.#peek().type !== "eof") {
      throw this.#error(`unexpected token '${this.#peek().value}'`);
    }
    return value;
  }

  #parseOr(): Value {
    let left = this.#parseAnd();
    while (this.#takeOperator("||")) {
      const right = this.#parseAnd();
      left = boolean(left, "||") || boolean(right, "||");
    }
    return left;
  }

  #parseAnd(): Value {
    let left = this.#parseEquality();
    while (this.#takeOperator("&&")) {
      const right = this.#parseEquality();
      left = boolean(left, "&&") && boolean(right, "&&");
    }
    return left;
  }

  #parseEquality(): Value {
    let left = this.#parseComparison();
    for (;;) {
      if (this.#takeOperator("==")) {
        left = left === this.#parseComparison();
      } else if (this.#takeOperator("!=")) {
        left = left !== this.#parseComparison();
      } else {
        return left;
      }
    }
  }

  #parseComparison(): Value {
    let left = this.#parseUnary();
    for (;;) {
      const operator = ["<=", ">=", "<", ">"].find((candidate) =>
        this.#takeOperator(candidate),
      );
      if (!operator) return left;
      const right = this.#parseUnary();
      if (
        !(
          (typeof left === "number" && typeof right === "number") ||
          (typeof left === "string" && typeof right === "string")
        )
      ) {
        throw this.#error(
          `${operator} operands must have matching scalar types`,
        );
      }
      left =
        operator === "<"
          ? left < right
          : operator === ">"
            ? left > right
            : operator === "<="
              ? left <= right
              : left >= right;
    }
  }

  #parseUnary(): Value {
    if (this.#takeOperator("!")) return !boolean(this.#parseUnary(), "!");
    return this.#parsePrimary();
  }

  #parsePrimary(): Value {
    const token = this.#peek();
    if (token.type === "string" || token.type === "number") {
      this.#index += 1;
      return token.value;
    }
    if (token.type === "identifier") {
      this.#index += 1;
      if (token.value === "true") return true;
      if (token.value === "false") return false;
      if (token.value === "null") return null;
      if (this.#takePunctuation("(")) {
        const args: Value[] = [];
        if (!this.#takePunctuation(")")) {
          do {
            if (args.length >= 16) {
              throw this.#error("condition function exceeds 16 arguments");
            }
            args.push(this.#parseOr());
          } while (this.#takePunctuation(","));
          this.#requirePunctuation(")");
        }
        return callFunction(token.value, args);
      }
      if (!(token.value in this.context)) {
        throw this.#error(`unknown condition variable: ${token.value}`);
      }
      return this.context[token.value] as Value;
    }
    if (this.#takePunctuation("(")) {
      const value = this.#parseOr();
      this.#requirePunctuation(")");
      return value;
    }
    throw this.#error(`unexpected token '${token.value}'`);
  }

  #peek(): Token {
    return this.tokens[this.#index] ?? { type: "eof", value: "" };
  }

  #takeOperator(value: string): boolean {
    const token = this.#peek();
    if (token.type !== "operator" || token.value !== value) return false;
    this.#index += 1;
    return true;
  }

  #takePunctuation(value: string): boolean {
    const token = this.#peek();
    if (token.type !== "punctuation" || token.value !== value) return false;
    this.#index += 1;
    return true;
  }

  #requirePunctuation(value: string): void {
    if (!this.#takePunctuation(value)) {
      throw this.#error(`expected '${value}'`);
    }
  }

  #error(message: string): ConditionEvaluationError {
    return new ConditionEvaluationError(message);
  }
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const add = (token: Token): void => {
    if (tokens.length >= 1_024) {
      throw new ConditionEvaluationError("condition exceeds 1024 tokens");
    }
    tokens.push(token);
  };
  while (index < expression.length) {
    const character = expression[index] as string;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    const pair = expression.slice(index, index + 2);
    if (["||", "&&", "==", "!=", "<=", ">="].includes(pair)) {
      add({ type: "operator", value: pair });
      index += 2;
      continue;
    }
    if (["!", "<", ">"].includes(character)) {
      add({ type: "operator", value: character });
      index += 1;
      continue;
    }
    if (["(", ")", ","].includes(character)) {
      add({ type: "punctuation", value: character });
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      const parsed = readString(expression, index, character);
      add({ type: "string", value: parsed.value });
      index = parsed.next;
      continue;
    }
    const number = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)/.exec(
      expression.slice(index),
    );
    if (number?.[0]) {
      add({ type: "number", value: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expression.slice(index));
    if (identifier?.[0]) {
      add({ type: "identifier", value: identifier[0] });
      index += identifier[0].length;
      continue;
    }
    throw new ConditionEvaluationError(
      `invalid condition character at offset ${index}`,
    );
  }
  add({ type: "eof", value: "" });
  return tokens;
}

function readString(
  expression: string,
  start: number,
  quote: string,
): { readonly value: string; readonly next: number } {
  let value = "";
  let index = start + 1;
  while (index < expression.length) {
    const character = expression[index] as string;
    if (character === quote) return { next: index + 1, value };
    if (character !== "\\") {
      value += character;
      index += 1;
      continue;
    }
    const escaped = expression[index + 1];
    if (escaped === undefined) break;
    const escapes: Readonly<Record<string, string>> = {
      "\\": "\\",
      '"': '"',
      "'": "'",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    if (!(escaped in escapes)) {
      throw new ConditionEvaluationError(`invalid string escape: \\${escaped}`);
    }
    value += escapes[escaped];
    index += 2;
  }
  throw new ConditionEvaluationError("unterminated condition string");
}

function callFunction(name: string, args: readonly Value[]): Value {
  if (name === "str_len") {
    requireArguments(name, args, 1);
    return string(args[0], name).length;
  }
  requireArguments(name, args, 2);
  const value = string(args[0], name);
  const search = string(args[1], name);
  if (name === "str_contains") return value.includes(search);
  if (name === "str_starts_with") return value.startsWith(search);
  if (name === "str_ends_with") return value.endsWith(search);
  throw new ConditionEvaluationError(`unknown condition function: ${name}`);
}

function requireArguments(
  name: string,
  args: readonly Value[],
  count: number,
): void {
  if (args.length !== count) {
    throw new ConditionEvaluationError(
      `${name} requires exactly ${count} argument${count === 1 ? "" : "s"}`,
    );
  }
}

function string(value: Value | undefined, operator: string): string {
  if (typeof value !== "string") {
    throw new ConditionEvaluationError(`${operator} requires string arguments`);
  }
  return value;
}

function boolean(value: Value, operator: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConditionEvaluationError(`${operator} requires boolean operands`);
  }
  return value;
}

function scalarValue(value: unknown): Value | undefined {
  return value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? value
    : undefined;
}

export class ConditionEvaluationError extends Error {
  public override readonly name = "ConditionEvaluationError";
}
