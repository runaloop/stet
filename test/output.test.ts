import { afterAll, expect, test } from "bun:test";
import { closeSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_TEXT } from "../src/core/skill.ts";
import { Fixture, GIT_ENV } from "./helpers/fixture.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const env = { ...process.env, ...GIT_ENV, STET_ROLE: "agent", STET_AUTHOR: "claude" };

const outDir = mkdtempSync(join(tmpdir(), "stet-output-"));
let outFiles = 0;
const fixtures: Fixture[] = [];
afterAll(() => {
  fixtures.forEach((f) => f.cleanup());
  rmSync(outDir, { recursive: true, force: true });
});
const repo = () => {
  const f = new Fixture();
  fixtures.push(f);
  f.write("a.txt", "a\n").commit("init");
  return f;
};

// The reader sleeps first, so the pipe fills up and the CLI's write comes back short.
async function piped(args: string[], cwd: string, from: "stdout" | "stderr" | "both" = "stdout"): Promise<string> {
  const redirect = { stdout: "", stderr: "2>&1 >/dev/null", both: "2>&1" }[from];
  const script = `bun "$0" "$@" ${redirect} | { sleep 0.3; cat; }`;
  const proc = Bun.spawn(["sh", "-c", script, CLI, ...args], { cwd, env, stdout: "pipe", stderr: "ignore" });
  const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return text;
}

async function toFile(args: string[], cwd: string, from: "stdout" | "stderr" = "stdout"): Promise<string> {
  const path = join(outDir, `${from}-${++outFiles}`);
  const proc = Bun.spawn(["bun", CLI, ...args], { cwd, env, stdin: "ignore", [from]: Bun.file(path) });
  await proc.exited;
  return readFileSync(path, "utf8");
}

const configJson = (value: string) => JSON.stringify({ key: "snapshot.exclude", value }, null, 2) + "\n";
const valueFor = (size: number) => {
  const value = Array.from({ length: size }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
  return value.slice(0, size - configJson("").length);
};
const SIZES = [4000, 8191, 8192, 8193, 8624, 16384, 65535, 65536, 65537, 100_000, 130_000];

test("output piped to a slow reader arrives once, byte for byte, at every size", async () => {
  const f = repo();
  for (const size of SIZES) {
    const value = valueFor(size);
    const got = await piped(["config", "set", "snapshot.exclude", value, "--json"], f.root);
    expect({ size, bytes: got.length }).toEqual({ size, bytes: size });
    expect(got === configJson(value)).toBe(true);
  }
  expect(await piped(["skill", "show"], f.root)).toBe(SKILL_TEXT.endsWith("\n") ? SKILL_TEXT : SKILL_TEXT + "\n");
});

test("a megabyte of JSON through a pipe parses and matches the same output written to a file", async () => {
  const f = repo();
  const body = valueFor(1_000_000);
  f.write("body.txt", body);
  await toFile(["version", "create", "--json"], f.root);
  const t = JSON.parse(await toFile(["comment", "add", "--file", "a.txt", "--range", "1-1", "--body-file", f.path("body.txt"), "--json"], f.root));
  const args = ["thread", "show", String(t.id), "--json"];
  const viaFile = await toFile(args, f.root);
  const viaPipe = await piped(args, f.root);
  expect(viaPipe.length).toBe(viaFile.length);
  expect(viaPipe === viaFile).toBe(true);
  expect(JSON.parse(viaPipe).comments[0].body === body).toBe(true);
});

test("a large error on stderr arrives once through a pipe, alone or merged with stdout, and matches the file", async () => {
  const f = repo();
  for (const json of [true, false])
    for (const from of ["stderr", "both"] as const)
      for (const size of [9000, 70_000, 100_000]) {
        const args = ["config", "get", valueFor(size), ...(json ? ["--json"] : [])];
        const viaFile = await toFile(args, f.root, "stderr");
        const viaPipe = await piped(args, f.root, from);
        expect(viaFile.length).toBeGreaterThan(size);
        expect({ json, from, size, bytes: viaPipe.length }).toEqual({ json, from, size, bytes: viaFile.length });
        expect(viaPipe === viaFile).toBe(true);
        expect(JSON.parse(viaPipe).error.code).toBe("usage");
      }
});

test("a reader that stops early ends the output without a trace or a failing exit", async () => {
  const f = repo();
  const script = `bun "$0" "$@" 2>"$STET_ERR"; echo "exit=$?" >"$STET_CODE"`;
  const [err, code] = [join(outDir, "early-err"), join(outDir, "early-code")];
  const proc = Bun.spawn(["sh", "-c", `{ ${script}; } | head -c 20 >/dev/null`, CLI, "config", "set", "snapshot.exclude", valueFor(130_000), "--json"], {
    cwd: f.root, env: { ...env, STET_ERR: err, STET_CODE: code }, stdout: "ignore", stderr: "ignore",
  });
  await proc.exited;
  expect(readFileSync(err, "utf8")).toBe("");
  expect(readFileSync(code, "utf8")).toBe("exit=0\n");
});

test("output written to a file is exact at every size", async () => {
  const f = repo();
  for (const size of [8193, 65537, 130_000]) {
    const value = valueFor(size);
    expect(await toFile(["config", "set", "snapshot.exclude", value, "--json"], f.root) === configJson(value)).toBe(true);
  }
});

// Linux shrinks new pipes to 8 KiB once a user holds more than fs.pipe-user-pages-soft of them,
// which is how the bug first showed up: anything past 8192 bytes came out twice.
test.skipIf(process.platform !== "linux")("an 8 KiB pipe carries larger output whole", async () => {
  const { dlopen, FFIType } = await import("bun:ffi");
  const libc = dlopen("libc.so.6", {
    pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
    fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const F_SETPIPE_SZ = 1031;
  const f = repo();
  try {
    for (const size of [8191, 8192, 8193, 8624, 20_000, 70_000]) {
      const fds = new Int32Array(2);
      expect(libc.symbols.pipe(fds)).toBe(0);
      const [r, w] = [fds[0]!, fds[1]!];
      expect(libc.symbols.fcntl(w, F_SETPIPE_SZ, 8192)).toBe(8192);
      const value = valueFor(size);
      const proc = Bun.spawn(["bun", CLI, "config", "set", "snapshot.exclude", value, "--json"], {
        cwd: f.root, env, stdio: ["ignore", w, "ignore"],
      });
      closeSync(w);
      await Bun.sleep(300);
      const [got] = await Promise.all([new Response(Bun.file(r).stream()).text(), proc.exited]);
      closeSync(r);
      expect({ size, bytes: got.length }).toEqual({ size, bytes: size });
      expect(got === configJson(value)).toBe(true);
    }
  } finally {
    libc.close();
  }
});
