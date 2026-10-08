import type { FileKind } from "./module.ts";

/** Markdown: the UIs show it rendered, or as its code when `compare.markdown` is `code` or the reader switches it. */
export const MARKDOWN: FileKind = { id: "markdown", match: (path) => /\.(md|markdown)$/i.test(path) };

/** The kinds of file the core knows in every build, before those of the modules. */
export const CORE_KINDS: readonly FileKind[] = [MARKDOWN];
