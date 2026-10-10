import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function holder(lock: string): string | null {
  try {
    return readFileSync(lock, "utf8");
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Waits until no other process on the machine holds `name`, then holds it until this process exits. The lock is a
 * file in the OS temp dir with the holder's pid; the lock of a pid that is gone is taken over.
 */
export async function takeTurn(name: string, opts: { poll?: number; say?: (line: string) => void } = {}): Promise<() => void> {
  const lock = join(tmpdir(), `${name}.lock`);
  const mine = `${lock}.${process.pid}`;
  // the pid goes into a file of its own first and is linked in whole, so a waiter never reads a half-written lock
  writeFileSync(mine, String(process.pid));
  let told = false;
  try {
    for (;;) {
      try {
        linkSync(mine, lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const held = holder(lock);
      if (held === null) continue;
      const pid = Number(held);
      if (!alive(pid)) {
        if (holder(lock) === held) rmSync(lock, { force: true });
        continue;
      }
      if (!told) (opts.say ?? console.log)(`waiting for ${name} pid ${pid}`);
      told = true;
      await Bun.sleep(opts.poll ?? 500);
    }
  } finally {
    rmSync(mine, { force: true });
  }
  const release = () => {
    if (holder(lock) === String(process.pid)) rmSync(lock, { force: true });
  };
  process.on("exit", release);
  return release;
}
