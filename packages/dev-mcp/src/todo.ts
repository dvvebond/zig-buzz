import { object } from "./files.js";

export interface TodoItem {
  readonly text: string;
  readonly done: boolean;
}

export class TodoState {
  #items: TodoItem[] = [];

  public handle(args: unknown): string {
    const value = object(args);
    if (value.todos === undefined || value.todos === null) return this.render();
    if (!Array.isArray(value.todos) || value.todos.length > 50) {
      throw new Error("todos must be an array with at most 50 items");
    }
    const next = value.todos.map((raw, index) => {
      const item = object(raw);
      if (
        typeof item.text !== "string" ||
        item.text.trim().length < 1 ||
        [...item.text.trim()].length > 200 ||
        containsUnsafeText(item.text)
      ) {
        throw new Error(`item ${index + 1}: invalid text`);
      }
      if (item.done !== undefined && typeof item.done !== "boolean") {
        throw new Error(`item ${index + 1}: done must be boolean`);
      }
      return { text: item.text.trim(), done: item.done === true };
    });
    if (new Set(next.map((item) => item.text)).size !== next.length) {
      throw new Error("duplicate todo text");
    }
    const nextText = new Set(next.map((item) => item.text));
    const removed = this.#items.filter(
      (item) => !item.done && !nextText.has(item.text),
    );
    this.#items = next;
    return `${this.render()}${removed.length > 0 ? `\nWarning: ${removed.length} open item(s) were removed without completion.` : ""}`;
  }

  public render(): string {
    if (this.#items.length === 0) return "(todo list is empty)";
    const next = this.#items.findIndex((item) => !item.done);
    return this.#items
      .map(
        (item, index) =>
          `[${item.done ? "x" : " "}] ${index + 1}. ${item.text}${index === next ? "  ← next" : ""}`,
      )
      .join("\n");
  }

  public stop(): string {
    return this.#items.some((item) => !item.done)
      ? `You have open todo items. Keep working.\n\n${this.render()}`
      : "";
  }

  public postCompact(): string {
    return this.#items.length === 0 ? "" : `# Todo List\n${this.render()}`;
  }
}

function containsUnsafeText(text: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u.test(
    text,
  );
}
