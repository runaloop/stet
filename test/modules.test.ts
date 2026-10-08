import { afterAll, describe, expect, test } from "bun:test";
import { help, main } from "../src/cli/commands.ts";
import { builtConfig, configKeys, configValue, switchOf } from "../src/core/config.ts";
import { openContext, type Ctx } from "../src/core/context.ts";
import type { ModuleSpec } from "../src/core/module.ts";
import { commandsOf, enabled, kindOf, orderPresets } from "../src/core/modules.ts";
import { lists, withoutArg } from "../scripts/modules.ts";
import { ok, stet } from "./helpers/cli.ts";
import { Fixture } from "./helpers/fixture.ts";

const ctxWith = (meta: Record<string, string>) => ({ store: { meta: (k: string) => meta[k] ?? null } }) as unknown as Ctx;

let ran: string[] = [];
const notes: ModuleSpec = {
  id: "notes",
  label: "notes on files",
  default: "on",
  cli: [{ name: "notes list", section: "Threads", usage: "  notes list                                    the notes of the review", options: {}, run: async () => void ran.push("notes list") }],
  config: [{ key: "notes.style", values: ["short", "long"], help: "short or long", ui: "read", scope: "repo" }],
};
const lab: ModuleSpec = { id: "lab", label: "trials", default: "off", experimental: true };
const pins: ModuleSpec = { id: "pins", label: "pinned notes", default: "on", needs: ["notes"] };
const orphan: ModuleSpec = { id: "orphan", label: "needs a module the build lacks", default: "on", needs: ["gone"] };

describe("which modules are on", () => {
  test("a module is on by its default until the repository sets modules.<id>", () => {
    expect(enabled(ctxWith({}), [notes, lab]).map((m) => m.id)).toEqual(["notes"]);
    expect(enabled(ctxWith({ "modules.notes": "off", "modules.lab": "on" }), [notes, lab]).map((m) => m.id)).toEqual(["lab"]);
  });

  test("a module is on only while every module it needs is built and on", () => {
    expect(enabled(ctxWith({}), [notes, pins, orphan]).map((m) => m.id)).toEqual(["notes", "pins"]);
    expect(enabled(ctxWith({ "modules.notes": "off" }), [notes, pins]).map((m) => m.id)).toEqual([]);
  });
});

describe("kinds of file", () => {
  test("Markdown is the core's in every build; a module's kind is known while the module is on", () => {
    expect(kindOf(ctxWith({}), "docs/README.md")?.id).toBe("markdown");
    expect(kindOf(ctxWith({ "modules.images": "off" }), "notes.MARKDOWN")?.id).toBe("markdown");
    expect(kindOf(ctxWith({ "modules.images": "off" }), "res/card.png")).toBeNull();
    expect(kindOf(ctxWith({}), "src/a.ts")).toBeNull();
  });
});

describe("orders of files", () => {
  const repo = new Fixture();
  repo.write("a.txt", "x\n").commit("init");
  afterAll(() => repo.cleanup());
  const lanes: ModuleSpec = { id: "lanes", label: "lanes", default: "on", orderPresets: [{ id: "lanes", label: "By lane", describe: "a lane per folder", groups: "web: web/**; code" }] };
  const order = builtConfig([]).find((k) => k.key === "compare.order")!;

  test("a module's preset is listed while the module is on, and compare.order refuses it while it is off", () => {
    const on = ctxWith({});
    const off = ctxWith({ "modules.lanes": "off" });
    expect(orderPresets(on, [lanes]).map((p) => p.id)).toEqual(["kinds", "lanes"]);
    expect(orderPresets(off, [lanes]).map((p) => p.id)).toEqual(["kinds"]);
    expect(configValue(order, "lanes", on, [lanes])).toBe("lanes");
    expect(() => configValue(order, "lanes", off, [lanes])).toThrow("no order preset 'lanes'; known: kinds;");
    expect(() => configValue(order, "lane", on, [lanes])).toThrow("no order preset 'lane'; known: kinds, lanes;");
  });

  test("compare.order takes the core's preset, groups of one's own, or no value", () => {
    const ctx = ctxWith({});
    expect(configValue(order, "kinds", ctx, [])).toBe("kinds");
    expect(configValue(order, "docs: **/*.md; code", ctx, [])).toBe("docs: **/*.md; code");
    expect(configValue(order, null, ctx, [])).toBeNull();
  });

  test("stet config set compare.order takes a preset of the build and refuses an id none has", async () => {
    expect((await ok(stet(["config", "set", "compare.order", "kinds"], { cwd: repo.root }))).value).toBe("kinds");
    const bad = await stet(["config", "set", "compare.order", "by-path"], { cwd: repo.root });
    expect(bad.code).not.toBe(0);
    expect(bad.stderr + bad.stdout).toContain("no order preset 'by-path'; known: kinds;");
    expect((await ok(stet(["config", "get", "compare.order"], { cwd: repo.root }))).value).toBe("kinds");
  });
});

describe("settings and help from the modules", () => {
  test("each built module has an on/off switch, and its own keys are listed", () => {
    expect(switchOf(lab)).toEqual({ key: "modules.lab", values: ["on", "off"], default: "off", help: "on or off: trials (experimental); default off", ui: false, scope: "repo" });
    const keys = builtConfig([notes, lab]).map((k) => k.key);
    expect(keys).toContain("compare.markdown");
    expect(keys.slice(-3)).toEqual(["modules.notes", "modules.lab", "notes.style"]);
    expect(() => configValue(switchOf(notes), "maybe")).toThrow("modules.notes takes on or off");
    expect(configValue(switchOf(notes), null)).toBeNull();
  });

  test("a module's own keys are known while it is on; its switch always is", () => {
    expect(configKeys(ctxWith({}), [notes]).map((k) => k.key).slice(-2)).toEqual(["modules.notes", "notes.style"]);
    expect(configKeys(ctxWith({ "modules.notes": "off" }), [notes]).map((k) => k.key).at(-1)).toBe("modules.notes");
  });

  test("the core decides which keys the page reads and which it writes", () => {
    const ui = Object.fromEntries(builtConfig([]).filter((k) => k.ui).map((k) => [k.key, k.ui]));
    expect(ui).toEqual({ "compare.tests": "read", "compare.skip_markers": "read", "compare.collapse": "read", "compare.order": "read", "compare.markdown": "read", "agent.guide": "write" });
  });

  test("help lists a module's commands in their section and its settings with the core's", () => {
    const text = help([notes]);
    const threads = text.slice(text.indexOf("\nThreads\n"), text.indexOf("\nAgent loop\n"));
    expect(threads).toContain("  notes list                                    the notes of the review\n");
    expect(threads.indexOf("notes list")).toBeGreaterThan(threads.indexOf("read <id> | read --all"));
    expect(text.replace(/\s+/g, " ")).toContain("modules.notes (on or off: notes on files; default on), notes.style (short or long)");
    expect(help([])).not.toContain("modules.");
    const area: ModuleSpec = { id: "area", label: "areas", default: "on", fileKinds: [{ id: "picture", match: () => true, size: () => ({ w: 1, h: 1 }) }] };
    expect(help([area])).toContain("  comment add --file <path> --range <a-b> --body <text|-> [--at <ref>] [--side new|old] [--draft]\n              --region <x,y,w,h> in place of --range: an area of an image, in pixels\n  reply ");
    expect(help([])).toContain("[--draft]\n  reply ");
    expect(commandsOf([notes, lab]).map((c) => `${c.module.id}: ${c.command.name}`)).toEqual(["notes: notes list"]);
  });
});

describe("a module's command", () => {
  const f = new Fixture();
  f.write("a.txt", "x\n").commit("init");
  afterAll(() => f.cleanup());

  test("runs while its module is on, and is refused while it is off", async () => {
    ran = [];
    expect(await main(["notes", "list", "-C", f.root], [notes])).toBe(0);
    expect(ran).toEqual(["notes list"]);
    (await openContext({ cwd: f.root })).store.setMeta("modules.notes", "off");
    await expect(main(["notes", "list", "-C", f.root], [notes])).rejects.toThrow("stet notes list belongs to the notes module, which is off in this repository: stet config set modules.notes on");
    expect(ran).toEqual(["notes list"]);
  });
});

describe("the generated import lists", () => {
  test("list every module in modules/ by default, and leave out the ones asked", async () => {
    const all = await lists([]);
    expect(all.core).toContain('import images from "../modules/images/core.ts";');
    expect(all.web).toContain('import images from "../modules/images/web.tsx";');
    const none = await lists(["images"]);
    expect(none.core).toContain("export const MODULES: ModuleSpec[] = [];");
    expect(none.web).not.toContain("images");
    await expect(lists(["imgaes"])).rejects.toThrow("no module 'imgaes' in modules/");
  });

  test("--without takes ids separated by commas, once or more", () => {
    expect(withoutArg(["--without", "images,guide", "--target=bun-linux-x64", "--without=blame"])).toEqual(["images", "guide", "blame"]);
  });
});
