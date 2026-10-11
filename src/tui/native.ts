import { accessSync, constants, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REEXEC = "STET_TUI_REEXEC";

/**
 * Where Bun unpacks OpenTUI's embedded native library before it dlopens it: BUN_TMPDIR, else TMPDIR/TMP/TEMP, else
 * /tmp (/private/tmp on macOS). Bun reads them once at process start, so another directory takes a new process.
 */
export function bunTmpdir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.BUN_TMPDIR || env.TMPDIR || env.TMP || env.TEMP || (process.platform === "darwin" ? "/private/tmp" : "/tmp");
  return dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

export function fallbackTmpdir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "stet", "tmp");
}

/** A file can be created in `dir` and, on Linux, access(X_OK) allows it: the kernel answers EACCES on a noexec mount. */
export function canLoadFrom(dir: string): boolean {
  const probe = join(dir, `.stet-probe-${process.pid}`);
  try {
    writeFileSync(probe, "", { mode: 0o700 });
  } catch {
    return false;
  }
  try {
    accessSync(probe, constants.X_OK);
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      // gone already
    }
  }
}

function embedded(): boolean {
  return Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:\\~BUN\\");
}

export type NativeResult = { ok: true } | { ok: false; message: string };

/**
 * Called before the first import of @opentui/core. When the temp directory cannot hold an executable library, the
 * compiled binary runs itself again with BUN_TMPDIR in the cache directory and this never returns.
 */
export function prepareNative(): NativeResult {
  if (!embedded() || process.env.OTUI_ASSET_ROOT) return { ok: true };
  const dir = bunTmpdir();
  if (canLoadFrom(dir)) return { ok: true };
  if (process.env[REEXEC]) {
    return { ok: false, message: `stet tui cannot load its native library from ${dir} (not writable, or mounted noexec); set BUN_TMPDIR to a writable directory that allows executables` };
  }
  const fallback = fallbackTmpdir();
  try {
    mkdirSync(fallback, { recursive: true, mode: 0o700 });
  } catch {
    // the probe below tells
  }
  if (!canLoadFrom(fallback)) {
    return { ok: false, message: `stet tui cannot load its native library from ${dir} or ${fallback}; set BUN_TMPDIR to a writable directory that allows executables` };
  }
  if (typeof process.execve !== "function") {
    return { ok: false, message: `stet tui cannot load its native library from ${dir}; set BUN_TMPDIR=${fallback}` };
  }
  const env = { ...process.env, BUN_TMPDIR: fallback, [REEXEC]: "1" } as Record<string, string>;
  process.execve(process.execPath, [process.execPath, ...process.argv.slice(2)], env);
  return { ok: false, message: "unreachable" };
}
