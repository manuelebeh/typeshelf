# Contributing to Typeshelf

Thanks for helping out. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue with:

- your operating system and its version,
- what you did, what you expected and what happened,
- for a plugin problem, the application and its version (Photoshop 2026, Sketch 2026.1…) and what the plugin showed,
- for a font that is read or activated wrongly, its PostScript name and where it comes from (Google Fonts, a foundry…).

Do not attach font files unless their license allows you to share them.

For a security problem, do not open a public issue: follow [SECURITY.md](SECURITY.md).

## Setting up

You need Node 20.19 or later, Rust stable and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your system.

```bash
git clone git@github.com:manuelebeh/typeshelf.git
cd typeshelf
npm ci
npm run tauri dev
```

`npm run dev` alone opens the interface in a regular browser with demo data (`src/dev/mock.ts`). It is handy for UI work and never ships in a build. With it running, `/plugins/shared/preview.html` shows the plugin panel with fake data.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Keep the change focused. One fix or feature per pull request.
3. Add or update tests in `src-tauri/src` when you change backend logic. Rules that decide what is shown, matched or activated should be functions that can be tested without touching the real system.
4. Run the checks below.
5. Open a pull request that explains what changed and why. Screenshots help for UI changes.

```bash
npm run build                                       # TypeScript check and frontend build
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The end-to-end test (import, duplicates, real activation, collections, tags) only runs when `TYPESHELF_TEST_FONTS` points to a folder with fonts, see the README.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary in the imperative>
```

Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `style`, `build`, `ci`, `chore`. Scopes in use: `ui`, `library`, `activation`, `google-fonts`, `plugin-api`, `photoshop`, `illustrator`, `after-effects`, `sketch`. Keep commits small and each one buildable. CI checks the messages of every pull request with commitlint.

## Code guidelines

- Match the style of the surrounding code: naming, comment density and idioms.
- `src-tauri/src` holds the Rust backend. Anything specific to an operating system lives in `activation/` behind the same functions for macOS, Windows and Linux.
- `src` holds the interface, in plain TypeScript without a framework. Text on screen is in French.
- Comments explain why, not what.
- Prefer commas, colons or parentheses to long dashes in text and comments.

## Plugins

The plugins live in `plugins/`, see [plugins/README.md](plugins/README.md) for how to install them while developing.

- `plugins/shared/` is the source of truth for the panel shared by Photoshop, Illustrator and After Effects. Edit it there, then run `npm run plugins:sync` to copy it into each plugin, which must stay self-contained to be installed. Commit the copies with the change.
- Try a plugin change in the real application before opening a pull request, and say which version you used.

## Safety rules

Typeshelf installs fonts on people's machines and answers requests from other applications, so these are not negotiable:

- The local API for plugins listens on the loopback interface only. Keep its checks: the `Host` header must name the loopback address, a request with a web `Origin` is refused, and activation needs the `X-Typeshelf-Client` header. Do not add CORS headers.
- Read-only routes stay read-only. A route that changes something must be one a plugin needs, and must be limited in size like the existing ones.
- Files removed from the library go to the Trash.
- Downloads come from Google Fonts over HTTPS only. Do not follow addresses found in a response to another host.
- Nothing about the user's fonts or documents leaves the machine. There is no telemetry.
- Tests must never touch real user files or the user's real library. Use a temporary directory, as the existing tests do.

## What not to include

- Code, binaries, images, icons, fonts or strings copied from other applications.
- Font files whose license does not allow redistribution.
- Anything you do not have the right to license under the [MIT license](LICENSE).

By contributing, you agree that your contribution is released under the same license.
