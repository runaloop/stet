import { api } from "./api.ts";
import { notify, replyQuote, route } from "./state.ts";

export interface QuoteSpec {
  path: string;
  start: number;
  end: number;
  sha: string;
  label: string;
}

export function canQuote(): boolean {
  return route.value.name === "thread";
}

export async function quoteLines(q: QuoteSpec): Promise<void> {
  const blob = await api.blob(q.sha, q.path).catch(() => null);
  const lines = (blob?.contents ?? "").split("\n").slice(q.start - 1, q.end);
  const lang = /\.([a-z0-9]+)$/i.exec(q.path)?.[1] ?? "";
  const where = q.start === q.end ? `${q.path}:${q.start}` : `${q.path}:${q.start}-${q.end}`;
  const text = `\`${where}\` at ${q.label}:\n\`\`\`${lang}\n${lines.join("\n")}\n\`\`\`\n`;
  replyQuote.value = { seq: (replyQuote.peek()?.seq ?? 0) + 1, text };
  notify(`quoted ${where} into your reply`);
}
