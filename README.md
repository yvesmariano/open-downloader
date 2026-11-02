# Open Downloader

A minimal, open-source (MIT) Chrome/Chromium extension that detects video and audio on web pages and lets you download them.

- **No build step, no dependencies**: plain JavaScript (ES modules) and Manifest V3.
- **No servers, accounts or telemetry**: nothing leaves your browser except the requests for the media itself.
- **Localized** in English, Portuguese and Spanish, picked automatically from the browser language (falls back to English).

## Features

| Type | Support |
|---|---|
| Direct files (`video/*`, `audio/*`, `.mp4`, `.webm`, `.mp3`…) | ✅ via `chrome.downloads` |
| HLS with MPEG-TS segments | ✅ concatenated into a `.ts` file |
| HLS with fMP4 (`EXT-X-MAP`) | ✅ init + segments, saved as `.mp4` |
| AES-128 encrypted HLS | ✅ decrypted with WebCrypto |
| Master playlists (multiple qualities) | ✅ quality picker in the popup |
| Separate audio rendition (`EXT-X-MEDIA`) | ⚠️ video and audio saved as two files |
| Live HLS | ⚠️ only the current playlist window |
| DASH (`.mpd`), DRM (SAMPLE-AES, Widevine), `blob:`/MSE | ❌ out of scope |
| YouTube | ❌ deliberately ignored (Chrome Web Store policy) |

`.ts` files play in VLC/mpv. To convert without re-encoding:

```sh
ffmpeg -i video.ts -c copy video.mp4
# merge video + separate audio:
ffmpeg -i video.mp4 -i "video (audio).mp4" -c copy final.mp4
```

## Installation (developer mode)

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Open a page with a video, press play and click the extension icon.

## How it works

```
webRequest.onResponseStarted ──► background.js ──► storage.session (media per tab, badge)
                                     │
popup.js ──── messages ─────────────►│── direct media ──► chrome.downloads
                                     │── HLS ──► offscreen.js
                                                   ├─ fetches playlist and segments (6 in parallel, 3 retries)
                                                   ├─ decrypts AES-128 (WebCrypto)
                                                   └─ builds a Blob ──► chrome.downloads
```

- `src/lib/media.js`: classifies HTTP responses and ignores segments and DASH manifests.
- `src/lib/hls.js`: HLS parser (master/media, `BYTERANGE`, `MAP`, `KEY`, sequence-number IVs).
- `src/offscreen.js`: MV3 service workers can't create `Blob` URLs, so the file is assembled in an offscreen document.
- HLS downloads resend the page's `Referer`/`Origin` through a `declarativeNetRequest` session rule, which some CDNs require.

The file is assembled in memory before saving, so very long videos use RAM proportional to their size.

## Translations

UI strings live in `_locales/<lang>/messages.json` (`en`, `pt_BR`, `pt_PT`, `es`). Chrome selects the locale matching the browser language. To add a language, copy `_locales/en/messages.json` into a new folder named with a [supported locale code](https://developer.chrome.com/docs/extensions/reference/api/i18n#locales) and translate the `message` values.

## Development

```sh
npm test         # unit tests (node:test, no dependencies)
npm run icons    # regenerate the PNG icons
npm run zip      # package for publishing
```

## Responsible use

Only download content you have the right to download. This extension does not circumvent DRM.
