#!/usr/bin/env bun
import { flushOutput, main, reportError } from "./cli/commands.ts";

const argv = process.argv.slice(2);
try {
  process.exitCode = await main(argv);
} catch (e) {
  process.exitCode = reportError(e, argv.includes("--json"));
}
await flushOutput();
