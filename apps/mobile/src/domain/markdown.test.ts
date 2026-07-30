import { describe, expect, it } from "vitest";

import { parseInlineMarkdown, parseMarkdownBlocks } from "./markdown";

describe("message markdown", () => {
  it("parses authored and bare links with common inline formatting", () => {
    expect(
      parseInlineMarkdown(
        "**bold** _italic_ ~~gone~~ `code` [Buzz](https://buzz.example) https://openai.com",
      ).map(({ id: _id, ...token }) => token),
    ).toEqual([
      { text: "bold", type: "strong" },
      { text: " ", type: "text" },
      { text: "italic", type: "emphasis" },
      { text: " ", type: "text" },
      { text: "gone", type: "strike" },
      { text: " ", type: "text" },
      { text: "code", type: "code" },
      { text: " ", type: "text" },
      { text: "Buzz", type: "link", url: "https://buzz.example" },
      { text: " ", type: "text" },
      { text: "https://openai.com", type: "link", url: "https://openai.com" },
    ]);
  });

  it("separates fenced code blocks and preserves their language", () => {
    expect(
      parseMarkdownBlocks("Before\n```ts\nconst ready = true;\n```\nAfter").map(
        ({ id: _id, ...block }) => block,
      ),
    ).toEqual([
      { content: "Before", type: "text" },
      { content: "const ready = true;", language: "ts", type: "code" },
      { content: "After", type: "text" },
    ]);
  });
});
