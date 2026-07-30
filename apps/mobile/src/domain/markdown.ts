export type MarkdownInline = {
  readonly id: string;
  readonly type: "text" | "strong" | "emphasis" | "strike" | "code" | "link";
  readonly text: string;
  readonly url?: string;
};

export type MarkdownBlock =
  | {
      readonly id: string;
      readonly type: "text";
      readonly content: string;
    }
  | {
      readonly id: string;
      readonly type: "code";
      readonly content: string;
      readonly language?: string;
    };

const INLINE_PATTERN =
  /(\[([^\]\n]{1,1024})\]\((https?:\/\/[^\s)<>]{1,2048})\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_|https?:\/\/[^\s<>{}[\]]+)/g;

export function parseMarkdownBlocks(content: string): readonly MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = content.split("\n");
  let text: string[] = [];
  let code: string[] | undefined;
  let language: string | undefined;
  let sequence = 0;
  const flushText = () => {
    if (!text.length) return;
    blocks.push({
      content: text.join("\n"),
      id: `text:${sequence}`,
      type: "text",
    });
    sequence += 1;
    text = [];
  };
  const flushCode = () => {
    if (!code) return;
    blocks.push({
      content: code.join("\n"),
      id: `code:${sequence}`,
      type: "code",
      ...(language ? { language } : {}),
    });
    sequence += 1;
    code = undefined;
    language = undefined;
  };
  for (const line of lines) {
    if (code) {
      if (line.trim() === "```") flushCode();
      else code.push(line);
      continue;
    }
    const fence = /^```([A-Za-z0-9_+.-]{0,32})\s*$/.exec(line);
    if (fence) {
      flushText();
      code = [];
      language = fence[1] || undefined;
    } else {
      text.push(line);
    }
  }
  if (code) flushCode();
  flushText();
  return blocks;
}

export function parseInlineMarkdown(
  content: string,
): readonly MarkdownInline[] {
  const result: MarkdownInline[] = [];
  let cursor = 0;
  for (const match of content.matchAll(INLINE_PATTERN)) {
    const index = match.index;
    if (index > cursor) {
      result.push({
        id: `text:${cursor}`,
        text: content.slice(cursor, index),
        type: "text",
      });
    }
    const raw = match[0];
    if (match[2] && match[3]) {
      result.push({
        id: `link:${index}`,
        text: match[2],
        type: "link",
        url: match[3],
      });
    } else if (match[4]) {
      result.push({ id: `code:${index}`, text: match[4], type: "code" });
    } else if (match[5] || match[6]) {
      result.push({
        id: `strong:${index}`,
        text: (match[5] ?? match[6]) as string,
        type: "strong",
      });
    } else if (match[7]) {
      result.push({ id: `strike:${index}`, text: match[7], type: "strike" });
    } else if (match[8] || match[9]) {
      result.push({
        id: `emphasis:${index}`,
        text: (match[8] ?? match[9]) as string,
        type: "emphasis",
      });
    } else {
      result.push({
        id: `link:${index}`,
        text: raw,
        type: "link",
        url: raw,
      });
    }
    cursor = index + raw.length;
  }
  if (cursor < content.length) {
    result.push({
      id: `text:${cursor}`,
      text: content.slice(cursor),
      type: "text",
    });
  }
  return result;
}
