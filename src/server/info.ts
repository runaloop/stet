import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ServerInfo {
  pid: number;
  port: number;
  token: string;
  url: string;
  startedAt: string;
}

/**
 * One server serves every worktree of the repository, so the URL names the review: otherwise a tab opened
 * from another worktree would show the review of the worktree that started the server. The token stays last.
 */
export function reviewUrl(info: Pick<ServerInfo, "port" | "token">, review: number | null | undefined): string {
  return review ? `http://127.0.0.1:${info.port}/#/?review=${review}&token=${info.token}` : `http://127.0.0.1:${info.port}/#token=${info.token}`;
}

export function serverInfoPath(commonDir: string): string {
  return join(commonDir, "stet", "server.json");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readServerInfo(commonDir: string): Promise<ServerInfo | null> {
  const path = serverInfoPath(commonDir);
  if (!existsSync(path)) return null;
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as ServerInfo;
    if (!alive(info.pid)) return null;
    const res = await fetch(`http://127.0.0.1:${info.port}/api/ping`, {
      headers: { "x-stet-token": info.token },
      signal: AbortSignal.timeout(1000),
    }).catch(() => null);
    return res?.ok ? info : null;
  } catch {
    return null;
  }
}

export function writeServerInfo(commonDir: string, info: ServerInfo): void {
  writeFileSync(serverInfoPath(commonDir), JSON.stringify(info, null, 2), { mode: 0o600 });
}

export function removeServerInfo(commonDir: string, pid: number): void {
  const path = serverInfoPath(commonDir);
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as ServerInfo;
    if (info.pid === pid) rmSync(path, { force: true });
  } catch {
    return;
  }
}

export function savedPort(commonDir: string): number | null {
  try {
    const n = Number(readFileSync(join(commonDir, "stet", "serve-port"), "utf8").trim());
    return Number.isInteger(n) && n > 1024 && n < 65536 ? n : null;
  } catch {
    return null;
  }
}

export function savePort(commonDir: string, port: number): void {
  try {
    writeFileSync(join(commonDir, "stet", "serve-port"), `${port}\n`, { mode: 0o600 });
  } catch {
    return;
  }
}

export function serverToken(commonDir: string): string {
  const path = join(commonDir, "stet", "serve-token");
  try {
    const saved = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{32}$/.test(saved)) return saved;
  } catch {
    // first run
  }
  const token = crypto.randomUUID().replace(/-/g, "");
  writeFileSync(path, token + "\n", { mode: 0o600 });
  return token;
}
