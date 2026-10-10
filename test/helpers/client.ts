// A stand-in for `stet tui`: connects to the server of the repository it runs in and prints it as JSON. The client
// starts a missing server as `<Bun.main> serve`, which in a test process would be the test file, so this script is
// Bun.main and passes `serve` on to the CLI.
if (process.argv[2] === "serve") {
  await import("../../src/cli.ts");
} else {
  const { openContext } = await import("../../src/core/context.ts");
  const { connect } = await import("../../src/client/server.ts");
  const ctx = await openContext({ cwd: process.cwd(), role: "reviewer" });
  console.log(JSON.stringify(await connect(ctx)));
  ctx.store.close();
}

export {};
