# Contributing

Bug reports and pull requests are welcome. For a larger change, open an issue first so we can agree on the
approach before you spend time on it.

## Setup

You need git 2.36+ and [Bun](https://bun.com) 1.4.2+.

```bash
bun install
bun src/cli.ts <command>   # the CLI from source
bun run dev                # the server with hot reload
bun test/fixtures/seed.ts  # a demo repository with three versions and threads; prints how to serve it
```

## Checks

```bash
bun run typecheck
bun test                   # unit, scenario, e2e, server, build smoke and happy-dom UI tests
bun run ui-check           # real mouse clicks in headless Firefox: comments, search, files, folding, CSP
bun run perf               # a 3,500-file branch in headless Firefox: timings and screenshots in perf-out/shots
bun run perf:scroll        # a wrapped 250-file diff: a fast mouse wheel does not jump
bun run check              # typecheck, tests, bun audit, exact versions, semgrep, gitleaks if installed
```

`bun test` needs nothing but git. The Firefox scripts need `firefox` on your `PATH` (any recent version:
they drive it over WebDriver BiDi). They keep the browser profile and screenshots in `perf-out/` inside the
repository rather than in `/tmp`, because a snap-packaged Firefox has a private `/tmp`.

`bun run check` needs the network for `bun audit` and the semgrep rules; it runs semgrep through `uvx`
when semgrep is not installed.

## Guide screenshots

The screenshots in [docs/guide](docs/guide/README.md) are taken by scripts in `scripts/guide/` on demo
repositories, in headless Firefox. After a UI change, retake the sections it touches:

```bash
bun run guide              # all of them
bun run guide images       # one section: check-claim, tests, commits, conversation, order, navigation,
                           # versions, images, live
```

## Releases

Bump `version` in `package.json`, commit, tag the commit `vX.Y.Z` and push the tag: the release workflow
runs the checks and publishes the binaries in a GitHub release. `NOTICE` lists what the binary bundles;
update it when a runtime dependency or the Bun version changes.

## Conventions

- A change comes with tests; a UI change also keeps `bun run ui-check` green and retakes its guide shots.
- Dependencies are pinned to exact versions (`bun run check` verifies it).
- Code explains itself; a comment is for a constraint or a gotcha that the code cannot show.
- Docs, messages and comments are in plain English.
