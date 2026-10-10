import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeTurn } from "./queue.ts";

const QUEUE = join(import.meta.dir, "queue.ts");
const lockOf = (name: string) => join(tmpdir(), `${name}.lock`);
const fresh = () => `stet-queue-test-${process.pid}-${Math.random().toString(36).slice(2)}`;

function waiter(name: string) {
  const proc = Bun.spawn(["bun", "-e", `import { takeTurn } from ${JSON.stringify(QUEUE)}; await takeTurn(${JSON.stringify(name)}, { poll: 50 }); console.log("got it");`], { stdout: "pipe" });
  let out = "";
  void (async () => {
    for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk);
  })();
  const said = async (text: string, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!out.includes(text) && Date.now() < end) await Bun.sleep(20);
    return out;
  };
  return { proc, said, out: () => out };
}

describe("ui-check queue", () => {
  test("a second run waits for the first, says for which pid once, and goes when the first lets go", async () => {
    const name = fresh();
    const release = await takeTurn(name);
    expect(readFileSync(lockOf(name), "utf8")).toBe(String(process.pid));
    const second = waiter(name);
    await second.said("waiting for");
    await Bun.sleep(300);
    expect(second.out()).toBe(`waiting for ${name} pid ${process.pid}\n`);
    release();
    expect(await second.said("got it")).toBe(`waiting for ${name} pid ${process.pid}\ngot it\n`);
    expect(await second.proc.exited).toBe(0);
    expect(existsSync(lockOf(name))).toBe(false);
  });

  test("the lock of a run that is gone is taken over", async () => {
    const name = fresh();
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    writeFileSync(lockOf(name), String(gone.pid));
    const release = await takeTurn(name, { say: (line) => expect(line).toBeUndefined() });
    expect(readFileSync(lockOf(name), "utf8")).toBe(String(process.pid));
    release();
    expect(existsSync(lockOf(name))).toBe(false);
  });

  test("letting go leaves a lock another run holds", async () => {
    const name = fresh();
    const release = await takeTurn(name);
    writeFileSync(lockOf(name), "1");
    release();
    expect(readFileSync(lockOf(name), "utf8")).toBe("1");
    writeFileSync(lockOf(name), String(process.pid));
    release();
  });
});
