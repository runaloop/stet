import { DEFAULT_THEMES, getSharedHighlighter, type DiffsHighlighter } from "@pierre/diffs";
import { useEffect, useMemo, useState } from "preact/hooks";
import { rawUrl } from "../api.ts";
import { compareData, compareFiles, compareNav, peek } from "../compare.ts";
import { changesOf, renderMarkdown } from "../lib/markdown.ts";
import { diffRows } from "../lib/search.ts";
import { useBlob } from "./useBlob.ts";

type Highlight = (code: string, lang: string) => string | null;

/** Code blocks in the colors of the diff, for the languages shiki knows. */
async function highlighter(langs: string[]): Promise<Highlight> {
  const themes = [DEFAULT_THEMES.light, DEFAULT_THEMES.dark];
  let h: DiffsHighlighter = await getSharedHighlighter({ themes, langs: [] });
  for (const lang of langs) h = await getSharedHighlighter({ themes, langs: [lang] }).catch(() => h);
  return (code, lang) => {
    try {
      return h.codeToHtml(code, {
        lang,
        themes: DEFAULT_THEMES,
        defaultColor: "light-dark()",
        transformers: [
          {
            pre(node) {
              delete node.properties.style;
            },
          },
        ],
      });
    } catch {
      return null;
    }
  };
}

/** A Markdown file of the diff as its "to" side renders, with the blocks the diff changed marked. */
export function MarkdownView({ file }: { file: string }) {
  const d = compareData.value;
  const fd = compareFiles.value?.find((f) => f.name === file);
  const sha = d?.to.sha ?? null;
  const blob = useBlob(sha, file);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const text = blob && blob !== "loading" ? blob.contents : null;
  const changes = useMemo(() => (fd ? changesOf(fd) : null), [fd]);
  const out = useMemo(
    () => (text !== null && sha ? renderMarkdown(text, { path: file, imageUrl: (p) => rawUrl(sha, p), changes, highlight }) : null),
    [text, sha, file, changes, highlight],
  );
  const langs = out?.langs.join(" ") ?? "";
  useEffect(() => {
    if (!langs) return;
    let live = true;
    highlighter(langs.split(" ")).then(
      (h) => live && setHighlight(() => h),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [langs]);
  if (!d) return null;
  if (blob === "loading") return <div class="note">loading…</div>;
  if (!out) return <div class="note">{file} is not a text file at {d.to.label}.</div>;

  const jump = (e: MouseEvent) => {
    const el = e.target as Element;
    const link = el.closest("a");
    if (link) {
      e.preventDefault();
      const path = link.getAttribute("data-path");
      if (path) peek.value = { path, sha: d.to.sha, label: d.to.label, line: Number(link.getAttribute("data-line")) || 1 };
      return;
    }
    if (!(window.getSelection()?.isCollapsed ?? true)) return;
    const removed = el.closest("[data-old]");
    if (removed) {
      compareNav.current?.openLine(file, "deletions", Number(removed.getAttribute("data-old")));
      return;
    }
    const block = el.closest("[data-start]");
    if (!block || !fd) return;
    const start = Number(block.getAttribute("data-start"));
    const end = Number(block.getAttribute("data-end"));
    const shown = new Set(diffRows(fd).map((r) => r.new));
    let line = start;
    while (line < end && !shown.has(line)) line++;
    compareNav.current?.openLine(file, "additions", shown.has(line) ? line : start);
  };

  const missing = (e: Event) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const note = document.createElement("span");
    note.className = "md-image-off";
    note.textContent = `▧ ${img.alt ? `${img.alt} · ` : ""}${img.dataset.path ?? ""} is not in the repository at ${d.to.label}`;
    img.replaceWith(note);
  };

  return (
    <div class="md-view" data-file={file}>
      <div class="md-bar">
        <span class="md-caption">rendered at {d.to.label}</span>
        <span class="hint">changed blocks are marked · click a block to see its lines in the code and comment there</span>
      </div>
      <div class="md" onClick={jump} onErrorCapture={missing} dangerouslySetInnerHTML={{ __html: out.html }} />
    </div>
  );
}
