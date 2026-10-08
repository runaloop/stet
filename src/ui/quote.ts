export interface QuoteSpec {
  path: string;
  start: number;
  end: number;
  sha: string;
  label: string;
}

/** Lines of a file quoted into a reply, from the file's `contents`, and where they are, as `path:start-end`. */
export function quote(q: QuoteSpec, contents: string): { where: string; text: string } {
  const lines = contents.split("\n").slice(q.start - 1, q.end);
  const lang = /\.([a-z0-9]+)$/i.exec(q.path)?.[1] ?? "";
  const where = q.start === q.end ? `${q.path}:${q.start}` : `${q.path}:${q.start}-${q.end}`;
  return { where, text: `\`${where}\` at ${q.label}:\n\`\`\`${lang}\n${lines.join("\n")}\n\`\`\`\n` };
}
