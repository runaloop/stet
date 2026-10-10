import { BUILD } from "../core/build.ts";
import type { ChangeKind, EventType, GitStateDto, NowStateDto, Role } from "../core/types.ts";
import type { Address } from "./server.ts";
import { sseMessages, type SseMessage } from "./sse.ts";

/** A row of the review's event log, as the stream sends it. */
export interface StreamEvent {
  seq: number;
  type: EventType;
  role: Role;
  thread_id: number | null;
}

/** What the server's event stream tells a client; the same signals the page gets. */
export interface Live {
  /** The server's build, each time the stream opens. */
  hello?(build: string): void;
  /** The stream opened on a server of another build than this client, whose API may differ: the caller reconnects or stops. */
  otherBuild?(build: string): void;
  change?(seq: number, events: StreamEvent[]): void;
  /** Read marks, viewed files, the last pass or settings changed, by this client or any other writer. */
  store?(kinds: ChangeKind[]): void;
  /** "now" as the worktree is, against the one the server pinned. */
  now?(n: NowStateDto): void;
  git?(g: GitStateDto): void;
  /** The stream broke and has not come back for a few seconds, or it is back. */
  connection?(up: boolean): void;
}

export interface Subscription {
  /** Ends the stream and its retries; resolves once nothing of it runs. */
  close(): Promise<void>;
}

const LOST_AFTER_MS = 3000;
const RETRY_MS = 250;
const RETRY_MAX_MS = 10_000;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

/**
 * The server's event stream for a review from `since` on, kept open across server restarts: a refused or broken
 * stream is opened again on the same port, with a backoff, from the last change it gave.
 */
export function subscribe(server: Address, review: number, since: number, live: Live): Subscription {
  const abort = new AbortController();
  let last = since;
  let lost = false;
  let lostTimer: ReturnType<typeof setTimeout> | undefined;

  const dispatch = (m: SseMessage) => {
    const data = <T>() => JSON.parse(m.data) as T;
    if (m.event === "hello") {
      const { build } = data<{ build: string }>();
      live.hello?.(build);
      if (build !== BUILD) live.otherBuild?.(build);
    } else if (m.event === "change") {
      const d = data<{ seq: number; events: StreamEvent[] }>();
      last = Math.max(last, d.seq);
      live.change?.(d.seq, d.events);
    } else if (m.event === "store") live.store?.(data<{ kinds: ChangeKind[] }>().kinds);
    else if (m.event === "now") live.now?.(data<NowStateDto>());
    else if (m.event === "git") live.git?.(data<GitStateDto>());
  };

  const run = async () => {
    for (let retries = 0; !abort.signal.aborted; ) {
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/events?review=${review}&since=${last}`, {
          headers: { "x-stet-token": server.token, accept: "text/event-stream" },
          signal: abort.signal,
        });
        if (res.ok && res.body) {
          retries = 0;
          clearTimeout(lostTimer);
          lostTimer = undefined;
          if (lost) {
            lost = false;
            live.connection?.(true);
          }
          for await (const m of sseMessages(res.body)) dispatch(m);
        } else {
          await res.body?.cancel();
        }
      } catch {
        // Refused, broken or aborted: the loop decides.
      }
      if (abort.signal.aborted) break;
      lostTimer ??= setTimeout(() => {
        lost = true;
        live.connection?.(false);
      }, LOST_AFTER_MS);
      await pause(Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** retries++), abort.signal);
    }
    clearTimeout(lostTimer);
  };

  const running = run();
  return {
    close() {
      abort.abort();
      return running;
    },
  };
}
