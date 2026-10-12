import type { ReactNode } from "react";

/**
 * The small slice of Markdown Fin is told to write: paragraphs, `- ` and `1. `
 * lists, and **bold**. Replies used to render as plain text, so an answer that
 * used a list arrived with its asterisks showing.
 *
 * Built from React elements, never from an HTML string — model output is
 * untrusted text, and nothing in it can become markup. Anything outside this
 * slice (headings, links, tables) simply shows as the characters it is.
 */

type Block = { kind: "p"; lines: string[] } | { kind: "ul" | "ol"; items: string[] };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

function parseChatBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(BULLET);
    const numbered = bullet ? null : line.match(NUMBERED);
    const last = blocks.at(-1);
    if (bullet || numbered) {
      const kind = bullet ? "ul" : "ol";
      const item = (bullet ?? numbered)![1]!;
      if (last && last.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
    } else if (line.trim() === "") {
      // A blank line ends whatever was open; the next text starts fresh.
      if (last && last.kind === "p" && last.lines.length > 0) blocks.push({ kind: "p", lines: [] });
    } else if (last && last.kind === "p") {
      last.lines.push(line);
    } else {
      blocks.push({ kind: "p", lines: [line] });
    }
  }
  return blocks.filter((b) => (b.kind === "p" ? b.lines.length > 0 : b.items.length > 0));
}

/** `**bold**` only. An unmatched pair of asterisks is left as typed. */
function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*\n]+\*\*)/g);
  return parts
    .filter((part) => part !== "")
    .map((part, i) =>
      part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
        <strong key={i} className="font-semibold text-ink-900">
          {part.slice(2, -2)}
        </strong>
      ) : (
        part
      ),
    );
}

export function ChatMarkdown({ text }: { text: string }) {
  const blocks = parseChatBlocks(text);
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, i) => {
        if (block.kind === "p") {
          return (
            <p key={i} className="whitespace-pre-wrap">
              {block.lines.map((line, j) => (
                <span key={j}>
                  {j > 0 ? "\n" : null}
                  {renderInline(line)}
                </span>
              ))}
            </p>
          );
        }
        const List = block.kind === "ul" ? "ul" : "ol";
        return (
          <List key={i} className={`flex flex-col gap-1 pl-5 ${block.kind === "ul" ? "list-disc" : "list-decimal"}`}>
            {block.items.map((item, j) => (
              <li key={j}>{renderInline(item)}</li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
