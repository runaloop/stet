import { isMarkdown } from "../src/ui/markdown.ts";
import { changeReveal, compareFiles, compareHandle, drawnFiles, isWhole, markdownView, setFileView } from "./compare.ts";
import { MarkdownView, RenderedMarkdown } from "./components/MarkdownView.tsx";
import type { FileViewer } from "./modules.tsx";

function Toggle({ rendered, onClick }: { rendered: boolean; onClick: () => void }) {
  return (
    <button class="btn ghost small md-toggle" title="Markdown: show it rendered or as code" onClick={onClick}>
      {rendered ? "‹/› code" : "¶ rendered"}
    </button>
  );
}

function Header({ path }: { path: string }) {
  const fd = compareFiles.value?.find((f) => f.name === path);
  const drawn = drawnFiles.value.has(path);
  return (
    <>
      <Toggle rendered={drawn} onClick={() => (compareHandle.current?.switchView ?? setFileView)(path, drawn ? "code" : "rendered")} />
      {fd && fd.type !== "new" && fd.type !== "deleted" ? (
        <button
          class={`btn ghost small md-whole${isWhole(path) ? " on" : ""}`}
          title={isWhole(path) ? "show only the changes and the lines opened around them, rendered and as code" : "show the whole file, rendered and as code"}
          onClick={() => (compareHandle.current?.wholeFile ?? ((p: string, on: boolean) => void changeReveal(p, (r) => ({ ...r, full: on }))))(path, !isWhole(path))}
        >
          full file
        </button>
      ) : null}
    </>
  );
}

/** Markdown, a kind of file of the core: rendered unless `compare.markdown` is `code` or the reader picked its code. */
export const markdownViewer: FileViewer = {
  kind: "markdown",
  match: isMarkdown,
  cssClass: "md-anno",
  wants: (fd, _placed, view) => isMarkdown(fd.name) && (view ?? markdownView.value) === "rendered",
  switchable: isMarkdown,
  header: (path) => (isMarkdown(path) ? <Header path={path} /> : null),
  render: (path) => <MarkdownView file={path} />,
  text: {
    view: () => markdownView.value,
    draw: (p) => <RenderedMarkdown {...p} />,
    toggle: (p) => <Toggle {...p} />,
  },
};
