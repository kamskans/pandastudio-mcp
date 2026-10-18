# PandaStudio MCP Server

[![npm](https://img.shields.io/npm/v/@writepanda/mcp)](https://www.npmjs.com/package/@writepanda/mcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[Model Context Protocol](https://modelcontextprotocol.io) server for **[PandaStudio](https://www.writepanda.ai)** — a local-first desktop video editor. It exposes the editor's full automation surface (**329 tools**) to Claude, ChatGPT/Codex, Cursor, Cline, Continue, and any MCP-compliant client.

Most video MCP servers wrap FFmpeg or call a cloud rendering API. This one drives a **real desktop editor** running on your machine: transcript-based cutting, filler-word removal, motion graphics, captions, background removal, thumbnails, and publishing to YouTube/Instagram. Your footage never leaves your computer.

```
"Transcribe the recording, cut the filler words and dead air, add captions,
 punch in a zoom whenever I click something, and export it."
```

…and the agent actually does it, end to end.

## What PandaStudio is

PandaStudio is a desktop video and podcast editor for macOS and Windows. Recording, transcription and editing run on your computer, and it is sold as a one-time license (from $99) or $19/month, with a free trial of 10 exports.

- **Edit by transcript:** delete words to cut, remove fillers and silences, captions with highlighted words, zooms, motion graphics, color, background removal.
- **Make clips:** turn a long video into captioned 9:16 Shorts on your own machine, with no per-minute credits. Measured on an Apple M4 Pro MacBook Pro: an 11-minute camera recording became 4 clips in 78 seconds.
- **Record:** screen, camera, or a remote podcast with up to 3 guests, each recorded locally.
- **Agents:** the built-in agent, or Claude Code, Claude Desktop, Codex and any MCP client through this server.

Comparisons: [OpusClip alternatives](https://www.writepanda.ai/alternatives/best-opus-clip-alternatives/) · [Submagic alternatives](https://www.writepanda.ai/alternatives/best-submagic-alternatives/) · [VEED alternatives](https://www.writepanda.ai/alternatives/best-veed-alternatives/) · [Riverside alternatives](https://www.writepanda.ai/alternatives/best-riverside-alternatives/) · [Descript alternatives](https://www.writepanda.ai/alternatives/best-descript-alternatives/)

## Requirements

- **[PandaStudio](https://www.writepanda.ai)** installed (macOS or Windows). This server is a thin translator between MCP and PandaStudio's loopback automation API — it needs the app.
- Node.js ≥ 18.

## Install

Runs on demand via `npx`; no global install.

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "pandastudio": {
      "command": "npx",
      "args": ["-y", "@writepanda/mcp"]
    }
  }
}
```

**Cursor** — `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "pandastudio": {
      "command": "npx",
      "args": ["-y", "@writepanda/mcp"]
    }
  }
}
```

**Cline / Continue / Codex / others** — same shape in their MCP config.

Restart the client afterwards. The server auto-launches PandaStudio if it isn't running and waits for its local API (~5s).

## What the agent gets

**329 tools**, full parity with the desktop UI — anything you can do by clicking, an agent can do by asking.

| Category | Tools | What it covers |
|---|--:|---|
| `project_*` | 60 | Project lifecycle, clips, trims, zooms, speed, motion graphics, FX, lower thirds, background removal, spotlight, crop, layouts, aspect ratio, wallpaper, focal point, shorts layouts, podcast composites |
| `export_*` | 13 | Render to MP4, export library, AI thumbnails (generate/edit/revert), publish to YouTube + Instagram, find shots for shorts |
| `workspace_*` | 11 | Multi-client workspaces, brand kit, per-workspace project defaults |
| `transcript_*` | 10 | Transcribe (local, word-level), edit by transcript, remove fillers, remove silences, find bad takes, find/replace, insert/restore words |
| `system_*` | 9 | Status, command discovery, transcription language, local model management |
| `motion_*` | 8 | Motion-graphic templates, multi-scene storyboards, custom HTML compositions, frame verification |
| `youtube_*` / `instagram_*` | 9 | Account connection, channel listing, publishing |
| `asset_*` | 5 | Bundled music, sound effects, LUTs, transitions, FX |
| `llm_*` | 4 | Generate titles, descriptions, chapter timestamps from the transcript |
| `caption_*` | 3 | Toggle, templates, per-style overrides |
| `media_*` | 3 | Generate images, music, narration |
| `preview_*` / `job_*` / `agent_*` / `audio_*` / `timeline_*` | 14 | Live preview overlay, async job polling, agent sessions, audio cleanup, time-base conversion |

Plus `pandastudio_call` — a raw `verb.noun` escape hatch for anything not yet a first-class tool.

## Example

> Edit the two clips in `~/Downloads/raw/` — transcribe them, remove filler words,
> add a "How I Built This" intro card, turn on bold captions, and export the MP4.

The agent chains `project_new` → `transcript_transcribe` → `transcript_remove_fillers` → `motion_generate` → `project_add_motion_graphic` → `caption_toggle` → `caption_set_template` → `export_start`. Roughly a dozen tool calls, unattended.

## How it works

```
MCP client (Claude Desktop / Cursor / Cline / Codex)
    ↓ JSON-RPC over stdio
@writepanda/mcp  (this server)
    ↓ HTTP POST 127.0.0.1:7878/v1/call
PandaStudio desktop app
    ↓ in-process calls
Editorial engine (transcript, motion graphics, render, publish)
```

Every call is bearer-authenticated against the per-launch token PandaStudio writes to `~/.config/pandastudio/token` (macOS/Linux) or `%APPDATA%\pandastudio\token` (Windows). **Loopback only — nothing leaves your machine.** Credentials are discovered automatically from your local install; there is no token to paste.

## Licensing

The server honours the same license gate as the desktop app. With an expired trial and no license, diagnostic tools still work and editorial tools return `{ ok: false, details: { code: "trial_expired" } }`. Activate in the app under **Settings → License**.

## Companions

- **[`@writepanda/cli`](https://www.npmjs.com/package/@writepanda/cli)** — the same surface as a shell command (`pandastudio system.status`). Better for bash/CI scripting, and cheaper on context than 329 tool schemas.
- **[PandaStudio Agent Skill](https://github.com/kamskans/pandastudio-skills)** — `npx skills add kamskans/pandastudio-skills`. The authoritative playbook: which verbs to call, in what order, with what defaults per destination.

## Documentation

- Full surface + recipes: **[writepanda.ai/cli](https://www.writepanda.ai/cli)**
- Desktop app: **[writepanda.ai](https://www.writepanda.ai)**

## Note on this repository

This repo mirrors the published `@writepanda/mcp` package (the server, its README, and license) so the package has a public home for issues and MCP registries. The desktop app's source is private; the MCP server is MIT and published in full here and on npm.

## License

MIT
