import { Terminal as XTerm } from "@xterm/headless";

export interface TermState {
  altScreen: boolean;
  cursorHidden: boolean;
  kittyDepth: number;
  kittyPushes: number;
  mouse: boolean;
  bracketedPaste: boolean;
  modifyOtherKeys: number;
}

/** The private modes and the kitty keyboard stack from the raw bytes, whichever of them @xterm/headless implements. */
export class ModeTracker {
  state: TermState = { altScreen: false, cursorHidden: false, kittyDepth: 0, kittyPushes: 0, mouse: false, bracketedPaste: false, modifyOtherKeys: 0 };
  private tail = "";

  feed(chunk: string): void {
    const text = this.tail + chunk;
    const re = /\x1b\[\?([\d;]+)([hl])|\x1b\[>(\d*)u|\x1b\[<(\d*)u|\x1b\[=(\d+)(?:;\d+)?u|\x1b\[>4;?(\d*)m/g;
    let m: RegExpExecArray | null;
    let end = 0;
    while ((m = re.exec(text))) {
      end = re.lastIndex;
      if (m[1] !== undefined) {
        const on = m[2] === "h";
        for (const n of m[1].split(";")) {
          if (n === "1049" || n === "47" || n === "1047") this.state.altScreen = on;
          else if (n === "25") this.state.cursorHidden = !on;
          else if (n === "1000" || n === "1002" || n === "1003" || n === "1006") this.state.mouse = on;
          else if (n === "2004") this.state.bracketedPaste = on;
        }
      } else if (m[3] !== undefined) {
        this.state.kittyDepth++;
        this.state.kittyPushes++;
      } else if (m[4] !== undefined) {
        this.state.kittyDepth = Math.max(0, this.state.kittyDepth - Number(m[4] || 1));
      } else if (m[6] !== undefined) {
        this.state.modifyOtherKeys = Number(m[6] || 0);
      }
    }
    const lastEsc = text.lastIndexOf("\x1b");
    this.tail = lastEsc >= end && text.length - lastEsc < 32 ? text.slice(lastEsc) : "";
  }
}

export interface PtyRun {
  xt: XTerm;
  modes: ModeTracker;
  raw: () => string;
  screen: () => string;
  waitFor: (pred: (screen: string) => boolean, ms?: number) => Promise<number>;
  write: (s: string) => void;
  resize: (cols: number, rows: number) => void;
  pid: number;
  exited: Promise<number>;
  close: () => void;
}

/** A program in a pseudo-terminal drawn by a headless xterm, which answers its queries as a terminal would. */
export function startPty(argv: string[], opts: { cols?: number; rows?: number; env?: Record<string, string | undefined>; cwd?: string; kitty?: boolean } = {}): PtyRun {
  const cols = opts.cols ?? 100;
  const rows = opts.rows ?? 30;
  const xt = new XTerm({ cols, rows, allowProposedApi: true });
  const modes = new ModeTracker();
  const decoder = new TextDecoder();
  let raw = "";
  let changed: (() => void) | null = null;
  const term = new Bun.Terminal({
    cols,
    rows,
    data(_t, d) {
      const s = decoder.decode(d, { stream: true });
      raw += s;
      modes.feed(s);
      // @xterm/headless 6.0.0 does not implement the kitty keyboard protocol; answer its query like kitty does.
      if (opts.kitty && s.includes("\x1b[?u")) term.write(`\x1b[?${modes.state.kittyDepth > 0 ? 1 : 0}u`);
      xt.write(d, () => changed?.());
    },
  });
  xt.onData((reply) => term.write(reply));
  const proc = Bun.spawn(argv, { terminal: term, cwd: opts.cwd, env: { TERM: "xterm-256color", ...process.env, ...opts.env } });
  const screen = () => {
    const b = xt.buffer.active;
    return Array.from({ length: xt.rows }, (_, y) => b.getLine(y)?.translateToString(true, 0, xt.cols) ?? "").join("\n");
  };
  const t0 = performance.now();
  const waitFor = (pred: (s: string) => boolean, ms = 10_000) =>
    new Promise<number>((resolve, reject) => {
      const check = () => {
        if (pred(screen())) {
          clearTimeout(timer);
          changed = null;
          resolve(performance.now() - t0);
        }
      };
      const timer = setTimeout(() => {
        changed = null;
        reject(new Error(`timed out after ${ms} ms; screen:\n${screen()}\nraw tail: ${JSON.stringify(raw.slice(-400))}`));
      }, ms);
      changed = check;
      check();
    });
  return {
    xt,
    modes,
    raw: () => raw,
    screen,
    waitFor,
    write: (s) => term.write(s),
    resize: (c, r) => {
      term.resize(c, r);
      xt.resize(c, r);
      // the child does not lead the pty's process group, so the kernel does not tell it; a terminal would
      proc.kill("SIGWINCH");
    },
    pid: proc.pid,
    exited: proc.exited,
    close: () => {
      proc.kill();
      term.close();
      xt.dispose();
    },
  };
}
