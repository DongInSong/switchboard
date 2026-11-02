# Install

Two files from the release: `switchboard.mjs` (daemon + CLI in one file) and the browser extension zip.

Switchboard sends to Claude Code sessions you already have open. Use either kind, or both:

| You run Claude Code in | Needs | How requests arrive |
| --- | --- | --- |
| a terminal | tmux 3.2+ (start sessions with `switchboard claude`) | pasted into the session like typing |
| the VS Code extension | nothing extra | prompt is copied and the session's tab comes up; you press paste, enter |

## Linux · Windows (WSL2)

On Windows, run every command inside WSL; the browser stays on Windows.

**Needs:** Node.js 24+, Claude Code (logged in, in the same Linux/WSL), Edge or Chrome. For terminal sessions also tmux 3.2+.

```bash
nvm install 24            # if node -v is below 24
sudo apt install tmux     # only for terminal sessions
```

1. Get the daemon:
   ```bash
   curl -L -o ~/switchboard.mjs https://github.com/DongInSong/switchboard/releases/latest/download/switchboard.mjs
   ```
   (or download `switchboard.mjs` from the release page and put it in your home folder)
2. Get the extension: download `switchboard-<version>-edge.zip` (Chrome: `-chrome.zip`) and unzip it. On WSL, unzip it on the Windows side, e.g. in Downloads.
3. Load it: `edge://extensions` (or `chrome://extensions`) → turn on **Developer mode** → **Load unpacked** → the unzipped folder.
4. Register it so the browser starts Switchboard by itself:
   ```bash
   node ~/switchboard.mjs doctor                  # node and claude ok (tmux only matters for terminal sessions)
   node ~/switchboard.mjs native install --apply  # WSL: registers for Windows Edge and Chrome
   ```
5. Open Claude Code the way you like:
   - **Terminal**: inside tmux. `cd ~/your-project && node ~/switchboard.mjs claude` does that for you (skip if you already work in tmux).
   - **VS Code**: open the Claude Code panel in your project. On Windows the VS Code window must be connected to WSL (Remote - WSL, the window shows `WSL: <distro>`), so the extension runs inside WSL where Switchboard can see it. A plain Windows folder won't show up.
6. On your dev page press `Alt+Shift+S`, click an element, write the request, `Ctrl+Enter`. The side panel's `3 settings` should say `● connected … · native`.

## macOS

macOS support is new. If something is off, please open an issue with the output of `node ~/switchboard.mjs doctor`.

**Needs:** Node.js 24+, Claude Code (logged in), Chrome, Edge or Brave. For terminal sessions also tmux 3.2+.

```bash
brew install node@24                               # and tmux, for terminal sessions
export PATH="$(brew --prefix node@24)/bin:$PATH"   # node@24 is keg-only; add this line to ~/.zshrc
```

1. Get the daemon:
   ```bash
   curl -L -o ~/switchboard.mjs https://github.com/DongInSong/switchboard/releases/latest/download/switchboard.mjs
   ```
2. Get the extension: download `switchboard-<version>-chrome.zip` (Edge: `-edge.zip`) and unzip it.
3. Load it: `chrome://extensions` → **Developer mode** → **Load unpacked** → the unzipped folder.
4. Register it:
   ```bash
   node ~/switchboard.mjs doctor
   node ~/switchboard.mjs native install --apply  # writes to ~/Library/Application Support/<browser>/NativeMessagingHosts
   ```
5. Open Claude Code: in a terminal inside tmux (`cd ~/your-project && node ~/switchboard.mjs claude`), or the Claude Code panel in VS Code.
6. Press `⌥⇧S` (Option+Shift+S), click an element, write the request, `⌘⏎`.

## Upgrade

1. Replace `~/switchboard.mjs` with the new one.
2. Unzip the new extension and load it (or press reload on the existing one if you unzipped over the same folder). Coming from 0.1.x: remove the old extension first, its ID changed.
3. Run `node ~/switchboard.mjs native install --apply` again. It remembers where `switchboard.mjs` and Node are, so run it again whenever you move the file or change Node versions.

## If it asks for a 6-digit code

That means the browser couldn't start Switchboard and fell back to HTTP. The side panel's `3 settings` shows why. Check with `node ~/switchboard.mjs native status`, fix, and it reconnects on its own. To use HTTP mode anyway: keep `node ~/switchboard.mjs start` running and type the code from `node ~/switchboard.mjs pair`.

## Uninstall

```bash
node ~/switchboard.mjs native uninstall --apply
node ~/switchboard.mjs stop
rm -rf ~/.local/share/switchboard ~/.local/state/switchboard ~/.config/switchboard ~/switchboard.mjs
```

Then remove the extension from the browser.

<details>
<summary>한국어</summary>

릴리즈에서 파일 두 개를 받는다: `switchboard.mjs`(데몬·CLI 단일 파일)와 브라우저 확장 zip.

Switchboard는 이미 열어 둔 Claude Code 세션으로 보낸다. 둘 중 편한 쪽(또는 둘 다):

| Claude Code를 쓰는 곳 | 필요한 것 | 요청이 들어가는 방식 |
| --- | --- | --- |
| 터미널 | tmux 3.2+ (`switchboard claude`로 띄움) | 세션에 직접 친 것처럼 붙여넣기 |
| VS Code 확장 | 따로 없음 | 프롬프트를 복사하고 그 세션 탭을 띄움 → 붙여넣기·Enter |

### Linux · Windows(WSL2)

Windows라면 명령은 전부 WSL 안에서, 브라우저는 Windows 그대로.

**준비:** Node.js 24+, Claude Code(같은 Linux/WSL에 로그인된 상태), Edge 또는 Chrome. 터미널 세션을 쓰면 tmux 3.2+도. 없으면 `nvm install 24`, `sudo apt install tmux`(터미널용).

1. 데몬: `curl -L -o ~/switchboard.mjs https://github.com/DongInSong/switchboard/releases/latest/download/switchboard.mjs` (또는 릴리즈 페이지에서 받아 홈 폴더에)
2. 확장: `switchboard-<버전>-edge.zip`(Chrome은 `-chrome.zip`)을 받아 압축 해제. WSL이면 Windows 쪽(예: 다운로드 폴더)에 푼다.
3. `edge://extensions`(또는 `chrome://extensions`) → **개발자 모드** 켜기 → **압축 풀린 확장 로드** → 푼 폴더.
4. 브라우저가 Switchboard를 직접 띄우게 등록:
   ```bash
   node ~/switchboard.mjs doctor
   node ~/switchboard.mjs native install --apply   # WSL이면 Windows의 Edge·Chrome에 등록
   ```
5. Claude Code를 편한 쪽으로 연다:
   - **터미널**: tmux 안에서. `cd ~/내프로젝트 && node ~/switchboard.mjs claude`가 대신 해 준다(이미 tmux를 쓰면 생략).
   - **VS Code**: 프로젝트에서 Claude Code 패널을 연다. Windows는 VS Code 창이 WSL에 연결돼 있어야 한다(Remote - WSL, 창에 `WSL: <배포판>` 표시). 그래야 확장이 WSL 안에서 돌아 Switchboard가 본다. Windows 폴더를 그냥 연 창은 안 보인다.
6. 개발 중인 페이지에서 `Alt+Shift+S` → 요소 클릭 → 요청 → `Ctrl+Enter`. 사이드 패널 `3 설정`에 `● 연결됨 … · 네이티브`면 정상.

### 맥

맥 지원은 새로 넣었다. 이상하면 `node ~/switchboard.mjs doctor` 출력과 함께 이슈로 알려 주세요.

**준비:** `brew install node@24`(터미널 세션을 쓰면 `tmux`도), `export PATH="$(brew --prefix node@24)/bin:$PATH"`(~/.zshrc에도), Claude Code, Chrome·Edge·Brave 중 하나.

1. 데몬: 위와 같은 `curl` 명령
2. 확장: `switchboard-<버전>-chrome.zip`(Edge는 `-edge.zip`) 압축 해제
3. `chrome://extensions` → **개발자 모드** → **압축 풀린 확장 로드**
4. `node ~/switchboard.mjs doctor` → `node ~/switchboard.mjs native install --apply`
5. 터미널이면 tmux 안에서(`cd ~/내프로젝트 && node ~/switchboard.mjs claude`), 아니면 VS Code의 Claude Code 패널
6. `⌥⇧S`(Option+Shift+S) → 요소 클릭 → 요청 → `⌘⏎`

### 올리기

`~/switchboard.mjs`를 새 파일로 바꾸고, 새 확장을 풀어 로드한 뒤(0.1.x에서 올리면 기존 확장을 먼저 제거 — ID가 바뀜) `native install --apply`를 다시 실행. 파일을 옮기거나 Node 버전을 바꿨을 때도 다시 실행.

### 6자리 코드를 물으면

브라우저가 Switchboard를 못 띄워 HTTP로 돌아간 것. 사이드 패널 `3 설정`에 이유가 보인다. `node ~/switchboard.mjs native status`로 확인하고 고치면 저절로 다시 연결된다. 그냥 HTTP로 쓰려면 `node ~/switchboard.mjs start`를 켜 두고 `node ~/switchboard.mjs pair`의 코드를 입력.

### 지우기

`node ~/switchboard.mjs native uninstall --apply`, `node ~/switchboard.mjs stop`, `rm -rf ~/.local/share/switchboard ~/.local/state/switchboard ~/.config/switchboard ~/switchboard.mjs`, 그리고 브라우저에서 확장 제거.

</details>
