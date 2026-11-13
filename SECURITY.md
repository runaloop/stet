# Security

stet runs a web server on your machine, and that server can read your repository. This page says what
protects it and what is out of scope.

## Publication permissions

The opt-in [publication workflow](docs/publication.md) provides **Local checks** for one exact unsigned
commit. Preparation and gate inspection do not update authored branch refs. After explicit reviewer
consent, the structured executor can update the named branch with its expected old SHA; it never
stages the user's files or runs repository hooks. No remote publication operation is implemented.

These local grants are not protected against another process running as the same OS user. That process
can read the server token, select the reviewer role, edit the database or bypass Stet through Git/API
commands. Neither the ordinary server token nor `--as reviewer` authenticates human presence. Protected
approval is unavailable until an isolated authority/executor and its enforcement tests are implemented.
Installing or using this increment does not install hooks, credentials, OS accounts or sandbox policy.

## What the server does

- It listens on 127.0.0.1 only, on a random port the first time and then on the same port while it is free.
- Every `/api` call needs a random token, in a header or as `?token=` in the URL (the event stream and images
  need that). It is compared in constant time and kept in `.git/stet/serve-token` (mode `0600`), so a
  restart does not break open tabs.
- The URL carries the token in the fragment (`#token=…`), so it never reaches a server log; the page moves it
  to `sessionStorage`.
- `Host` and `Origin` must be the server's own address, which stops DNS rebinding.
- A new tab of the same browser gets the token through an `HttpOnly`, `SameSite=Strict` cookie that only
  `/api/session` accepts, and only for the server's own `Host`. Links never carry the token.
- The page has a strict Content-Security-Policy.
- `.git/stet` is mode `0700` and the database `0600`.
- When `serve --open` runs the server as a systemd user unit, the unit's output is discarded, so the URL with
  the token does not reach the journal.
- Revisions that come from the API or the CLI never reach git as options.
- Untracked files that look like secrets (`.env`, `*.jks`, `*.keystore`, `*.pem`, `*.key`, `id_rsa`, …) are
  left out of snapshots and listed as excluded; files git ignores are never snapshotted.
- The editor command for the "Editor" button comes from `STET_EDITOR` in the server's environment, never from
  the repository: anything the agent can write there must not become a command that runs when you click.
  No shell is involved in running it.

## Out of scope

- Anyone who holds the token can read any commit of the repository through the API (`/api/blob`). The token
  is the boundary.
- A local user who can read your `.git` directory can read the reviews and the token anyway.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**), with steps to reproduce and the version (`stet --version`).
