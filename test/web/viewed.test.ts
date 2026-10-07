import { describe, expect, test } from "bun:test";
import type { FileDiffMetadata } from "@pierre/diffs";
import { isViewedIn, unviewKeys, viewedIndex, viewedKey } from "../../web/lib/viewed.ts";

const NONE = "0000000";
const fd = (old: string, now: string, name = "src/A.kt"): FileDiffMetadata =>
  ({ name, type: old === NONE ? "new" : now === NONE ? "deleted" : "change", prevObjectId: old, newObjectId: now }) as FileDiffMetadata;
const viewed = (keys: string[], f: FileDiffMetadata) => isViewedIn(viewedIndex(keys), f);

describe("viewed", () => {
  test("a tick is on the change: its old and its new side", () => {
    expect(viewedKey(fd("aaaaaaa", "bbbbbbb"))).toBe("src/A.kt@aaaaaaa..bbbbbbb");
    expect(viewed([viewedKey(fd("aaaaaaa", "bbbbbbb"))], fd("aaaaaaa", "bbbbbbb"))).toBe(true);
    expect(viewed([viewedKey(fd("aaaaaaa", "bbbbbbb"))], fd("aaaaaaa", "bbbbbbb", "src/B.kt"))).toBe(false);
  });

  test("deleting a file you viewed is a change you have not seen", () => {
    const ticked = [viewedKey(fd("aaaaaaa", "bbbbbbb"))];
    expect(viewed(ticked, fd("bbbbbbb", NONE))).toBe(false);
    expect(viewed([...ticked, viewedKey(fd("bbbbbbb", NONE))], fd("bbbbbbb", NONE))).toBe(true);
  });

  test("a revert to content you viewed is not viewed: you never saw what it reverts", () => {
    const ticked = [viewedKey(fd("aaaaaaa", "bbbbbbb"))];
    expect(viewed(ticked, fd("ccccccc", "bbbbbbb"))).toBe(false);
  });

  test("changes ticked one after another make the range across them viewed, a gap does not", () => {
    const steps = [viewedKey(fd("aaaaaaa", "bbbbbbb")), viewedKey(fd("bbbbbbb", "ccccccc"))];
    expect(viewed(steps, fd("aaaaaaa", "ccccccc"))).toBe(true);
    expect(viewed([steps[1]!], fd("aaaaaaa", "ccccccc"))).toBe(false);
    expect(viewed([steps[0]!], fd("aaaaaaa", "ccccccc"))).toBe(false);
    expect(viewed([viewedKey(fd(NONE, "aaaaaaa")), ...steps], fd(NONE, "ccccccc"))).toBe(true);
  });

  test("a blob id abbreviated to another length is the same blob", () => {
    expect(viewed(["src/A.kt@aaaaaaa..bbbbbbb"], fd("aaaaaaa1", "bbbbbbb12"))).toBe(true);
  });

  test("a change without blob ids (a pure rename) is viewed by its own tick only", () => {
    const rename = { name: "src/B.kt", prevName: "src/A.kt", type: "rename-pure" } as FileDiffMetadata;
    expect(viewedKey(rename)).toBe("src/B.kt@..");
    expect(viewed([], rename)).toBe(false);
    expect(viewed([viewedKey(rename)], rename)).toBe(true);
  });

  test("ticks of the old form keep meaning the new side's content, but not for a deleted file", () => {
    expect(viewed(["src/A.kt@bbbbbbb"], fd("aaaaaaa", "bbbbbbb"))).toBe(true);
    expect(viewed(["src/A.kt@bbbbbbb"], fd("ccccccc", "bbbbbbb"))).toBe(true);
    expect(viewed(["src/A.kt@bbbbbbb"], fd("bbbbbbb", NONE))).toBe(false);
    expect(viewed(["src/A.kt@undefined"], { name: "src/A.kt", prevName: "src/Z.kt", type: "rename-pure" } as FileDiffMetadata)).toBe(true);
  });

  test("a path with @ in it", () => {
    const f = fd("aaaaaaa", "bbbbbbb", "web/@types/x.ts");
    expect(viewed([viewedKey(f)], f)).toBe(true);
    expect(viewed(["web/@types/x.ts@bbbbbbb"], f)).toBe(true);
  });

  test("unticking drops every tick that makes the change viewed, the old form too, and leaves the rest", () => {
    const a = viewedKey(fd("aaaaaaa", "bbbbbbb"));
    const b = viewedKey(fd("bbbbbbb", "ccccccc"));
    const direct = viewedKey(fd("aaaaaaa", "ccccccc"));
    const other = viewedKey(fd("aaaaaaa", "bbbbbbb", "src/B.kt"));
    const keys = [a, b, direct, other, "src/A.kt@ccccccc", "src/A.kt@ddddddd"];
    const drop = unviewKeys(viewedIndex(keys), fd("aaaaaaa", "ccccccc"));
    expect(drop.sort()).toEqual([a, b, direct, "src/A.kt@ccccccc"].sort());
    const left = keys.filter((k) => !drop.includes(k));
    expect(viewed(left, fd("aaaaaaa", "ccccccc"))).toBe(false);
    expect(left).toContain(other);
  });
});
