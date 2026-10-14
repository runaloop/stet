import { linesText, type FileRef } from "../../src/ui/filerefs.ts";
import { branchRoute, chooseFile, openFileRef, targetsOf, type MessageCode } from "../filerefs.ts";
import { plainClick } from "../lib/route.ts";
import { link } from "../state.ts";

/** A file a message names, as a link once it names files of the review: one opens over the code, several in the finder. */
export function FileRefLink({ r, from }: { r: FileRef; from: MessageCode }) {
  const paths = targetsOf(r);
  if (!paths?.length) return <>{r.text}</>;
  const lines = linesText(r);
  const where = `${lines ? ` · ${r.start === r.end ? "line" : "lines"} ${lines}` : ""}${r.column ? `, column ${r.column}` : ""}`;
  if (paths.length > 1) {
    const pick = (e: MouseEvent) => {
      if (!plainClick(e)) return;
      e.preventDefault();
      chooseFile(paths, r, from);
    };
    return (
      <span class="fref">
        <a href="#" onClick={pick}>{r.text}</a>
        <span class="tref-card" role="tooltip">
          <span><b>{r.path}</b>{where}</span>
          <span class="tref-title">{paths.length} files have this name: a click lets you pick one</span>
          {paths.slice(0, 5).map((p) => <span class="fref-path">{p}</span>)}
          {paths.length > 5 ? <span class="fref-path">…</span> : null}
        </span>
      </span>
    );
  }
  const path = paths[0]!;
  const open = () => void openFileRef(path, r, from);
  const target = branchRoute(path, r);
  return (
    <span class="fref">
      <a {...(target ? link(target, open) : { href: "#", onClick: (e: MouseEvent) => plainClick(e) && (e.preventDefault(), open()) })}>{r.text}</a>
      <span class="tref-card" role="tooltip">
        <span><b>{path}</b>{where}</span>
        <span class="tref-title">opens over the thread's code, as it was when this was written</span>
      </span>
    </span>
  );
}
