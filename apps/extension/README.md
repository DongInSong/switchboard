# @switchboard/extension

Chromium MV3 extension built with WXT. Edge is the default target; Chrome uses the same build.

| Entry point | Runs in | Role |
| --- | --- | --- |
| `background.ts` | service worker | daemon client, `captureVisibleTab`, cropping, draft storage |
| `probe.ts` | MAIN world, injected on demand | finds source locations via `@switchboard/page-probe` |
| `overlay.ts` | ISOLATED world, injected on demand | picker, compose popovers, status chips (Shadow DOM, top layer) |
| `sidepanel/` | extension page | sessions, history, settings, pairing |

UI text lives in `src/i18n.ts` (English and Korean). Design notes (Korean): [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §5.1, [../../docs/UX.md](../../docs/UX.md).
