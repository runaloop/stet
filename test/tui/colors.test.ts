import { expect, test } from "bun:test";
import { blend, colorMode, nearest256 } from "../../src/tui/diff/colors.ts";
import { paintOf } from "../../src/tui/screen.ts";

test("24-bit colours where the terminal says so, else the 256-colour palette", () => {
  expect(colorMode({ TERM: "xterm-256color", COLORTERM: "truecolor" })).toBe("truecolor");
  expect(colorMode({ TERM: "screen-256color" })).toBe("256");
  expect(colorMode({ TERM: "tmux-256color", COLORTERM: "24bit" })).toBe("truecolor");
  expect(colorMode({ TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" })).toBe("256");
  expect(colorMode({ TERM: "xterm-kitty" })).toBe("truecolor");
  expect(colorMode({ TERM: "xterm-256color" })).toBe("256");
  expect(colorMode({ TERM: "screen-256color", STET_TUI_COLORS: "truecolor" })).toBe("truecolor");
  expect(colorMode({ TERM: "xterm-kitty", STET_TUI_COLORS: "256" })).toBe("256");
});

test("a colour becomes the nearest of the cube or the greys", () => {
  expect(nearest256("#000000")).toBe(16);
  expect(nearest256("#ffffff")).toBe(231);
  expect(nearest256("#ff0000")).toBe(196);
  expect(nearest256("#808080")).toBe(244);
  expect(nearest256("#0f1412")).toBe(233);
  expect(nearest256("#5fd3b2")).toBe(79);
});

test("blend lays a colour over another", () => {
  expect(blend("#ffffff", "#000000", 0.5)).toBe("#808080");
  expect(blend("#07c480", "#0f1412", 0)).toBe("#0f1412");
});

test("a span paints with indexed colours in 256-colour mode and with its syntax colour over its class", () => {
  const p = paintOf({ c: ["add"], fg: "#ff0000", fs: 2 }, "256");
  expect(p.fg.intent).toBe("indexed");
  expect(p.fg.slot).toBe(196);
  expect(p.bg.intent).toBe("indexed");
  const t = paintOf({ c: ["add"], fg: "#ff0000" }, "truecolor");
  expect(t.fg.intent).toBe("rgb");
  expect(t.fg.toInts().slice(0, 3)).toEqual([255, 0, 0]);
  expect(p.attrs).not.toBe(t.attrs);
});
