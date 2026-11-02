# Testing on macOS

macOS support is new and hasn't run on a real Mac yet. On Linux the macOS code paths (`ps` for processes, `lsof` for the dev server) pass the full end-to-end run with `SWITCHBOARD_PROC_SOURCE=ps SWITCHBOARD_PORT_OWNER=lsof`; this checklist is for the real thing.

## Setup

```bash
brew install tmux node@24          # or nvm install 24
corepack enable pnpm
git clone https://github.com/DongInSong/switchboard && cd switchboard
pnpm install
npx playwright install chromium    # for the automated run
```

Claude Code must be installed and logged in (`claude --version`, `claude agents --json`).

## 1. Automated (about 3 minutes)

```bash
pnpm check     # typecheck + unit tests
pnpm e2e       # headless Chromium, fake Claude session on an isolated tmux server; touches nothing of yours
```

Expected: `E2E 통과` at the end (the run prints Korean labels). If something fails, send the full output.

## 2. Real sessions

```bash
scripts/switchboard doctor         # all ok; "native host" may say not installed
cd ~/some/project && ~/path/to/switchboard/scripts/switchboard claude   # Claude Code inside tmux
scripts/switchboard sessions       # that session shows a PANE like claude-project:%0, not "view only"
```

## 3. Browser

```bash
pnpm --filter @switchboard/extension build:chrome   # → apps/extension/.output/chrome-mv3 (Edge: pnpm ext:build → edge-mv3)
scripts/switchboard native install                  # preview
scripts/switchboard native install --apply          # register for Chrome/Edge/Brave/Chromium
```

Load the folder at `chrome://extensions` → Developer mode → Load unpacked. Then on a page from a local dev server (Vite, Next, …) in that project:

- [ ] `⌥⇧S` starts picking; clicking an element opens the popover with the component and file
- [ ] The session from step 2 is suggested with `dev server` / `source match`
- [ ] `opt+a` adds a second element; `opt+p` shows the prompt; `⌘⏎` sends
- [ ] The prompt appears in the tmux session and Claude runs it; the chip goes `working` → `done` with the full answer
- [ ] Side panel `3 settings` shows `● connected … · native` (no `switchboard start`, no pairing)
- [ ] Optional: a Claude Code panel in VS Code shows up with a `VS Code` tag; sending copies the prompt and brings up that tab

## What to send back

- Output of `scripts/switchboard doctor` and `scripts/switchboard sessions`
- `~/.local/state/switchboard/daemon.log` if the daemon was started by the browser
- Screenshots of anything that looks wrong
