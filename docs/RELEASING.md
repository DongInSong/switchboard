# Releasing

Every release page carries the install steps for Linux, WSL and macOS. They come from [INSTALL.md](INSTALL.md); keep that file current and the notes follow.

1. Bump the version in `apps/daemon/src/config.ts` (`VERSION`), `apps/daemon/package.json` and `apps/extension/package.json`.
2. Check and build:
   ```bash
   pnpm check
   pnpm build:daemon                                            # dist/switchboard.mjs
   pnpm --filter @switchboard/extension exec wxt zip -b edge    # .output/switchboard-<v>-edge.zip
   pnpm --filter @switchboard/extension exec wxt zip -b chrome
   E2E_CLI=dist/switchboard.mjs pnpm e2e                        # end to end with the release daemon
   ```
3. Write what changed in `changes.md`, then build the notes (changes + install guide with this version's files and links):
   ```bash
   node scripts/release-notes.mjs <v> changes.md > notes.md
   ```
4. `sha256sum` the three files into `SHA256SUMS.txt`, commit, `git tag -a v<v>`, push, and
   `gh release create v<v> --notes-file notes.md switchboard.mjs switchboard-<v>-edge.zip switchboard-<v>-chrome.zip SHA256SUMS.txt`
   (add `--prerelease` while macOS or a new transport is unverified).
