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

## Modules

A module is a folder in `modules/<id>/`: `core.ts` declares it (`ModuleSpec` in `src/core/module.ts`: its file
kinds, settings, commands), `web.tsx` and its CSS are its part of the page, and its tests live next to them.
The core and the page reach a module only through the registries, `src/core/modules.ts` and `web/modules.tsx`,
which read the import lists `src/modules.gen.ts` and `web/modules.gen.ts`. Markdown is a kind of file of the
core, in every build: `src/core/kinds.ts` declares it and `web/markdown.tsx` is its viewer, which the page asks
through the same registry as a module's.

What a module writes outlives it: threads on an area of an image stay in the store, and `thread show`, `export`
and the skill describe them in a build without the module or with it off.

The committed lists have every module. `bun scripts/modules.ts` writes them again after you add a module; a
repository switches one off with `stet config set modules.<id> off`. To build or test without one:

```bash
bun run build -- --without images   # dist/stet without the module; the lists are put back afterwards
bun scripts/modules.ts --without images && bun run typecheck && bun test   # the tree without it...
bun scripts/modules.ts                                                     # ...and back
```

A module's tests take `describe` and `test` from `forModule(id)` (`test/helpers/modules.ts`): they are skipped
in a build without the module. A module's CSS comes after the core's in the bundle, so its classes carry its own
prefix and no rule relies on the order.

## Guide screenshots

The screenshots in [docs/guide](docs/guide/README.md) are taken by scripts in `scripts/guide/` on demo
repositories, in headless Firefox. After a UI change, retake the sections it touches:

```bash
bun run guide              # all of them
bun run guide images       # one section: check-claim, tests, commits, conversation, order, navigation,
                           # versions, images, markdown, live, viewed
```

## Releases

Bump `version` in `package.json`, commit, tag the commit `vX.Y.Z` and push the tag: the release workflow
runs the checks and publishes the binaries in a GitHub release. `NOTICE` lists what the binary bundles;
`bun test` fails when a bundled package is missing from it. The Bun runtime part is kept by hand: update
it when the Bun version changes.

## Conventions

- A change comes with tests; a UI change also keeps `bun run ui-check` green and retakes its guide shots.
- Dependencies are pinned to exact versions (`bun run check` verifies it).
- Code explains itself; a comment is for a constraint or a gotcha that the code cannot show.
- Docs, messages and comments are in plain English.
