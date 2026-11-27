# Antigravity Office

[![Latest release](https://img.shields.io/github/v/release/ammarsufyan/Antigravity-Office)](https://github.com/ammarsufyan/Antigravity-Office/releases/latest) [![GitHub stars](https://img.shields.io/github/stars/ammarsufyan/Antigravity-Office?style=social)](https://github.com/ammarsufyan/Antigravity-Office)

A pixel art virtual office that visualizes your **Google Antigravity** sessions, subagents, MCP servers, tasks, and signals in real time — rendered in an isometric pixel art office with a Slack-inspired chat panel, Kanban whiteboard, multi-room layout, seasons, and optional Dunder Mifflin mode (`/the-office`).

Built for **Windows, macOS, and Linux** using pure Node.js (no `bash`, `python3`, or `curl` required).

## Features

- **Native Antigravity Hooks** — passive observation via `SessionStart`, `PreInvocation`, `PostInvocation`, `PostToolUse`, and `Stop` (`hooks/antigravity-relay.mjs`, HMAC-SHA256 authenticated over `127.0.0.1`). Never registers `PreToolUse`, so Antigravity tool execution is never blocked.
- **Multi-Session Support** — every open Antigravity conversation gets its own pill in the title bar, model badge, and character at a desk.
- **Live Subagents & MCP Workers** — watch `invoke_subagent` workers spawn and work at desks, and `call_mcp_tool` calls light up MCP characters.
- **Real-Time Task Board** — Antigravity's `update_steps` checklist syncs directly to the office Kanban whiteboard.
- **Live Memory Meter & Inspector** — parses Antigravity `PLANNER_RESPONSE` transcripts for Gemini context usage and tool history (never exposes thinking blocks).
- **Signals & Incidents** — shell commands (`run_command`) for builds, tests, pushes, and deploys trigger celebrations or incident mode (`Prod Is Down`).
- **Chat Prompts (`@project`) & Optional AI Watcher** — queue a follow-up prompt to a live Antigravity session on its next `Stop`, or run `npm run chat-watcher` to let `agy -p` reply to general chat in `#office-general`.
- **Rooms, Seasons & Dunder Mifflin Mode** — corridor, meeting room, server room, lunch room, calendar seasons, and `/the-office`.
- **Phone / LAN Companion** — `npm run lan` prints a QR code for a watch-only (or HTTPS full-mode) phone view.

![Office rooms](docs/images/rooms.png)

## Quick Start

Requires **Node.js 22+** (uses Node's built-in `node:sqlite` automatically if `better-sqlite3` is not compiled).

```bash
git clone https://github.com/ammarsufyan/Antigravity-Office.git
cd Antigravity-Office
npm install
npm run build
```

### 1. Connect Antigravity Hooks (once)

```bash
npm run install-antigravity
```

This adds an `antigravity-office` entry to `~/.gemini/config/hooks.json` pointing at `hooks/antigravity-relay.mjs`. Restart or open an Antigravity conversation so it picks up the hooks.

To remove the hooks later:

```bash
npm run uninstall-antigravity
```

> You can also load this repository directly as a native Antigravity plugin (`plugin.json` + `hooks.json` at the repo root).

### 2. Start the Office

```bash
npm run start:antigravity
```

This starts the local server on `http://127.0.0.1:3334`, builds/serves the UI, and opens it in your default browser with the auth token. Press `Ctrl+C` (or run `node cli/agent-office.mjs stop`) to shut down the office — closing Antigravity Office never stops your running Antigravity sessions.

### 3. Optional: Chat AI Watcher

By default, the office is visual + `@project` prompt queueing. If you also want `#office-general` chat messages to be answered by `agy -p` (headless flash model):

```bash
npm run chat-watcher
```

### 4. Diagnostics

If nothing appears in the office, run:

```bash
npm run doctor
```

## Useful Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Type-check and build the React UI into `dist/` |
| `npm run install-antigravity` | Register Antigravity hooks in `~/.gemini/config/hooks.json` |
| `npm run uninstall-antigravity` | Remove only Antigravity Office's entries from `hooks.json` |
| `npm run start:antigravity` | Start the office server and open it in your default browser |
| `node cli/agent-office.mjs start -d` | Start the office server in the background |
| `node cli/agent-office.mjs stop` | Stop the background server / watcher |
| `npm run open` | Re-open the office in your browser with the auth token |
| `npm run chat-watcher` | Optional: run the headless `agy -p` watcher for `#office-general` |
| `npm run doctor` | Check Node version, hooks, `agy`, server health, token, and build |
| `npm run lan` | Share the office on your local network with a QR code |
| `npm test` | Run the Vitest test suite |

## Desktop App (Electron)

```bash
npm run build:electron
```

Installers are built via `electron-builder` for Windows (NSIS), macOS (DMG/ZIP), and Linux (AppImage).

## Architecture

```text
Antigravity-Office/
├── plugin.json / hooks.json      # Native Antigravity plugin manifests
├── hooks/antigravity-relay.mjs   # Pure Node.js HMAC-signed hook relay
├── server/                       # Express + WebSocket event server, SQLite chat, transcript parser
│   └── tools/antigravity.js      # Antigravity hook -> office event translator
├── src/                          # React + TypeScript pixel-art office UI
├── cli/agent-office.mjs          # Cross-platform CLI (start, stop, open, install-hooks, doctor)
├── scripts/                      # Installer, doctor, chat-ai-watcher, browser opener, LAN helper
├── electron/                     # Optional desktop app wrapper
└── locales/                      # Multi-language UI catalogs
```

## Credits, Attribution & License

- **Original Project & Code Owner**: Created by **[W17ANT](https://github.com/W17ant)** in **[W17ant/Claude-Office](https://github.com/W17ant/Claude-Office)**, together with all upstream contributors listed in [CHANGELOG.md](CHANGELOG.md) and locale translators in `locales/*.json`. All original pixel art, isometric office architecture, rooms, seasons, chat/inspector/task-board mechanics, and core server design belong to the upstream project.
- **Antigravity Adaptation**: Ported and adapted for Google Antigravity and native Windows/macOS/Linux Node.js by **[Ammar Sufyan](https://github.com/ammarsufyan)**.
- **License**: Released under the [MIT License](LICENSE) preserving the original copyright notice. See [NOTICE.md](NOTICE.md) for third-party and fan-art notices.
