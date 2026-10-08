import { api } from "./api.ts";
import { notify, replyQuote, route } from "./state.ts";
import { quote, type QuoteSpec } from "../src/ui/quote.ts";

export function canQuote(): boolean {
  return route.value.name === "thread";
}

export async function quoteLines(q: QuoteSpec): Promise<void> {
  const blob = await api.blob(q.sha, q.path).catch(() => null);
  const { where, text } = quote(q, blob?.contents ?? "");
  replyQuote.value = { seq: (replyQuote.peek()?.seq ?? 0) + 1, text };
  notify(`quoted ${where} into your reply`);
}
