import { StetError, type Ctx } from "../core/context.ts";
import { readServerInfo, type RunningServer } from "../server/info.ts";

/** Where a client sends its requests: the server's port on 127.0.0.1 and the token it takes. */
export type Address = Pick<RunningServer, "port" | "token">;

/** The repository's server when one runs and answers, of whatever build. */
export function findServer(ctx: Ctx): Promise<RunningServer | null> {
  return readServerInfo(ctx.repo.commonDir);
}

/**
 * The repository's server of this build: the running one, or one started on its own after stopping a server of
 * another build. The server module is loaded only here, as it brings the page with it.
 */
export async function connect(ctx: Ctx): Promise<RunningServer> {
  const { ensureServer } = await import("../server/server.ts");
  const info = await ensureServer(ctx);
  if (!info) throw new StetError("the server did not start; run `stet serve` to see why", 1, "no_server");
  return info;
}

/** Stops the repository's server; false when none ran. */
export async function stop(ctx: Ctx): Promise<boolean> {
  const { stopServer } = await import("../server/server.ts");
  return stopServer(ctx);
}
