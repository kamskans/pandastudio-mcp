#!/usr/bin/env node
// PandaStudio MCP server — translates Model Context Protocol tool
// calls into HTTP requests against the desktop app's localhost
// automation API.
//
// Architecture:
//
//   MCP client (Cursor / Continue / Cline / Claude Desktop)
//     ↓ JSON-RPC over stdio (MCP protocol)
//   this server (writepanda-mcp)
//     ↓ HTTP POST localhost:7878/v1/call
//   PandaStudio desktop app's automation server
//     ↓ in-process function calls
//   Editorial primitives (transcript, motion graphics, export, ...)
//
// Tool exposure strategy:
//   - 30+ STATIC tools mirror the high-value verbs (every editorial
//     primitive an agent needs for the canonical workflow). Static
//     because MCP clients cache tool schemas at connect time and
//     don't re-fetch them mid-session — a dynamic registry would go
//     stale in the client cache.
//   - One ESCAPE HATCH tool: `pandastudio_call` takes
//     `{ command: "verb.noun", args: {...} }` so agents can hit any
//     verb that lands in PandaStudio after this MCP version shipped.
//     Long tail covered without a re-publish.
//
// Naming convention: MCP tool names use underscores (snake_case);
// PandaStudio CLI uses verb.noun. Translation is verb_noun ↔ verb.noun.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// ── Credentials + transport ───────────────────────────────────────────

function configDir() {
	if (process.env.PANDASTUDIO_CONFIG_DIR) return process.env.PANDASTUDIO_CONFIG_DIR;
	if (process.platform === "win32") {
		const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
		return path.join(appData, "pandastudio");
	}
	return path.join(os.homedir(), ".config", "pandastudio");
}

const TOKEN_FILE = path.join(configDir(), "token");
const PORT_FILE = path.join(configDir(), "port");

async function readCredentials() {
	const port = Number((await fs.readFile(PORT_FILE, "utf-8")).trim());
	const token = (await fs.readFile(TOKEN_FILE, "utf-8")).trim();
	if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid port in ${PORT_FILE}`);
	if (!token) throw new Error(`empty token in ${TOKEN_FILE}`);
	return { port, token };
}

async function probeHealth(port, timeoutMs = 1500) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: ctrl.signal });
		clearTimeout(t);
		return res.ok;
	} catch {
		clearTimeout(t);
		return false;
	}
}

function findInstalledApp() {
	if (process.env.PANDASTUDIO_BIN) return process.env.PANDASTUDIO_BIN;
	if (process.platform === "darwin") {
		return "/Applications/PandaStudio.app/Contents/MacOS/PandaStudio";
	}
	if (process.platform === "win32") {
		const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
		return path.join(programFiles, "PandaStudio", "PandaStudio.exe");
	}
	return "/opt/PandaStudio/pandastudio";
}

async function autoLaunchAndWait(timeoutSec = 60) {
	// Try a fast probe in case the user already has it running.
	try {
		const c = await readCredentials();
		if (await probeHealth(c.port)) return c;
	} catch {
		/* not running */
	}

	const bin = findInstalledApp();
	try {
		const child = spawn(bin, [], { detached: true, stdio: "ignore", env: process.env });
		child.unref();
	} catch (err) {
		throw new Error(`failed to launch PandaStudio (${bin}): ${err?.message ?? err}`);
	}

	const deadline = Date.now() + timeoutSec * 1000;
	while (Date.now() < deadline) {
		try {
			const c = await readCredentials();
			if (await probeHealth(c.port, 2000)) return c;
		} catch {
			/* still booting */
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(
		`PandaStudio did not become ready within ${timeoutSec}s. Open the app and enable "Allow local automation" in Settings.`,
	);
}

async function callPandastudio(command, args = {}) {
	const creds = await autoLaunchAndWait();
	const res = await fetch(`http://127.0.0.1:${creds.port}/v1/call`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${creds.token}`,
		},
		body: JSON.stringify({ command, args }),
	});
	const text = await res.text();
	let body;
	try {
		body = text.length === 0 ? null : JSON.parse(text);
	} catch {
		body = { raw: text };
	}
	if (res.status >= 400) {
		throw new Error(`HTTP ${res.status}: ${body?.error ?? text.slice(0, 200)}`);
	}
	return body;
}

// ── Tool catalogue ────────────────────────────────────────────────────
//
// Static MCP tool schemas. Each tool name uses snake_case (MCP
// convention); the `command` field is the underlying verb.noun the
// HTTP server expects. Keep this list focused on the editorial
// workflow — the `pandastudio_call` escape hatch covers the long
// tail and any post-publish additions.

const TOOLS = [
	// ── system + discovery ──────────────────────────────────────────
	{
		name: "system_status",
		description:
			"Probe PandaStudio's automation server. Returns app version, license state, and `automationGated` (true if trial expired and no license — every other tool will fail). ALWAYS call this first.",
		inputSchema: { type: "object", properties: {} },
		command: "system.status",
	},
	{
		name: "agent_session_list",
		description:
			"List the embedded in-app agent's opencode sessions (id, title, created/updated timestamps). Observational only — never starts the agent server; returns running:false when it isn't up. Use before agent_session_stop to find the session to kill.",
		inputSchema: { type: "object", properties: {} },
		command: "agent.session-list",
	},
	{
		name: "agent_session_stop",
		description:
			"Abort an in-app agent session by id (from agent_session_list), or every session with all:true. Stops that session's tool execution immediately; the transcript survives for replay. The kill switch for a runaway/ghost in-app agent session.",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: { type: "string", description: "Session id to abort." },
				all: { type: "boolean", description: "Abort every session instead of one." },
			},
		},
		command: "agent.session-stop",
	},
	{
		name: "system_list_commands",
		description:
			"List every verb.noun command the desktop app's automation server exposes — including ones added after this MCP version shipped. Use the long-tail ones via the `pandastudio_call` escape hatch.",
		inputSchema: { type: "object", properties: {} },
		command: "system.list",
	},
	{
		name: "system_get_transcription_language",
		description:
			"Read the active transcription engine selection for the current workspace. Returns { language } where language is one of: 'auto' (Parakeet TDT v3, default — auto-detects English + 25 European languages including Russian/Ukrainian), or a Whisper Large-v3-turbo language: 'chinese' / 'japanese' / 'korean' / 'hindi' / 'arabic' / 'thai' / 'tamil' / 'telugu' / 'kannada' / 'malayalam' / 'bengali' / 'marathi' / 'gujarati' / 'punjabi'. Use this when surfacing the active engine to the user or before recommending a switch.",
		inputSchema: { type: "object", properties: {} },
		command: "system.getTranscriptionLanguage",
	},
	{
		name: "system_set_transcription_language",
		description:
			"Switch the transcription engine for the current workspace. Default 'auto' uses Parakeet (English + 25 European languages, auto-detected, word-level timestamps native). Non-'auto' values route to Whisper Large-v3-turbo with that language locked in. **Important**: non-'auto' choices require a one-time ~1.1 GB Whisper model download — call `system_is_whisper_model_downloaded` first, and surface the download requirement to the user before switching. Use this when the user explicitly asks for a non-European transcription language (e.g., 'transcribe this in Chinese'), or when project content clearly indicates a different language than the current setting.",
		inputSchema: {
			type: "object",
			properties: {
				language: {
					type: "string",
					enum: [
						"auto",
						"chinese",
						"japanese",
						"korean",
						"hindi",
						"arabic",
						"thai",
						"tamil",
						"telugu",
						"kannada",
						"malayalam",
						"bengali",
						"marathi",
						"gujarati",
						"punjabi",
					],
					description: "Target language. 'auto' = Parakeet (default); the others route to Whisper.",
				},
			},
			required: ["language"],
		},
		command: "system.setTranscriptionLanguage",
	},
	{
		name: "system_is_whisper_model_downloaded",
		description:
			"Check whether the Whisper Large-v3-turbo model has been downloaded yet. Returns { downloaded: boolean }. ALWAYS call this before `system_set_transcription_language` to a non-'auto' value — Whisper transcription fails with a structured error if the model isn't on disk, and surprising the user with a 1.1 GB download mid-flow is bad UX.",
		inputSchema: { type: "object", properties: {} },
		command: "system.isWhisperModelDownloaded",
	},
	{
		name: "system_get_narration_engine",
		description:
			"Read the active narration (TTS) engine for the current workspace. Returns { engine } — 'local-kokoro' (default; Kokoro-82M on-device, English, no key/cloud) or 'replicate' (cloud TTS, needs the user's Replicate key). Use before recommending a switch or when disclosing which engine narration uses.",
		inputSchema: { type: "object", properties: {} },
		command: "system.getNarrationEngine",
	},
	{
		name: "system_set_narration_engine",
		description:
			"Set the DEFAULT narration engine for the current workspace. Pass `engine` = 'local-kokoro' (on-device English, no key) or 'replicate' (cloud, needs the user's Replicate key). Individual media_generate_narration calls can still override this via their `model` arg. Switching to local triggers a one-time ~330 MB model download on first use — call system_is_kokoro_model_downloaded to check.",
		inputSchema: {
			type: "object",
			properties: {
				engine: { type: "string", description: "'local-kokoro' | 'replicate'." },
			},
			required: ["engine"],
		},
		command: "system.setNarrationEngine",
	},
	{
		name: "system_is_kokoro_model_downloaded",
		description:
			"Check whether the local Kokoro-82M TTS model (English on-device narration) has been downloaded. Returns { downloaded: boolean }. The model (~330 MB) auto-downloads on first local narration; calling this first lets you surface the download instead of a long first-run wait.",
		inputSchema: { type: "object", properties: {} },
		command: "system.isKokoroModelDownloaded",
	},
	{
		name: "system_download_kokoro_model",
		description:
			"Pre-download the local Kokoro-82M TTS model + voices (~330 MB) now so the first narration doesn't pay the wait. Idempotent; returns { downloaded: true }. Optional — narration also auto-downloads on first use.",
		inputSchema: { type: "object", properties: {} },
		command: "system.downloadKokoroModel",
	},

	// ── workspaces (v1.19) ──────────────────────────────────────────
	// Multi-workspace isolation: each workspace has its own projects,
	// exports, Replicate key, and (v1.19.0+) YouTube connections.
	// Agents managing an agency account can switch workspaces mid-
	// flow to operate inside a specific client's bucket.
	{
		name: "workspace_list",
		description:
			"List every workspace on this machine. Returns `currentWorkspaceId` + a `limit` object describing the plan's cap (`max: null` for unlimited on Team, 1 on Starter/Trial, 3 on Creator). Call this first to see what workspaces exist and which one every other query defaults to.",
		inputSchema: { type: "object", properties: {} },
		command: "workspace.list",
	},
	{
		name: "workspace_current",
		description: "Return the active workspace (what every workspace-scoped query defaults to).",
		inputSchema: { type: "object", properties: {} },
		command: "workspace.current",
	},
	{
		name: "workspace_create",
		description:
			"Create a new workspace. On plan cap: returns `{ ok: false, details: { code: 'workspace_limit_reached', upgradeTo: 'Creator' | 'Team' | null } }` — surface that to the user instead of retrying. Pass `switchTo: true` to make the new workspace active immediately.",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "Display name, max 80 chars." },
				switchTo: {
					type: "boolean",
					description: "Switch to the new workspace immediately. Default false.",
				},
			},
			required: ["name"],
		},
		command: "workspace.create",
	},
	{
		name: "workspace_rename",
		description: "Rename a workspace. No cross-workspace side effects.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				name: { type: "string", description: "New name, max 80 chars." },
			},
			required: ["id", "name"],
		},
		command: "workspace.rename",
	},
	{
		name: "workspace_delete",
		description:
			"Hard-delete a workspace and everything inside it: project rows (on-disk .pandastudio files remain), exports, shots, Replicate key + YouTube connections. Refuses to delete the last remaining workspace. Call `workspace.contents` first and show the user what they'll lose.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
		},
		command: "workspace.delete",
	},
	{
		name: "workspace_switch",
		description:
			"Change the active workspace. All subsequent project.*/export.*/motion.* queries operate inside the target until the next switch.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
		},
		command: "workspace.switch",
	},
	{
		name: "workspace_contents",
		description:
			"Count projects / exports / published YouTube videos in a workspace. Use before `workspace.delete` for the 'you will lose N items' warning.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
		},
		command: "workspace.contents",
	},
	{
		name: "workspace_get_brand",
		description:
			"Return the active workspace's brand kit (name, tagline, colors, typography, voice, logoPath). Use BEFORE authoring custom motion graphics, lower-thirds, outros, or thumbnails — the v1.32 motion-philosophy contract requires reading the brand and using its values verbatim instead of inventing a default look. Returns { brand: null } if no brand is configured (in which case ASK the user for at least the primary color + light/dark mood before authoring).",
		inputSchema: { type: "object", properties: {} },
		command: "workspace.get-brand",
	},
	{
		name: "workspace_set_brand",
		description:
			"Write/replace the active workspace's brand kit. Pass any subset of fields under `brand`. Hex colors are normalized to #rrggbb on the way in; empty strings are dropped; unknown voice values are ignored. Pass brand=null (or omit it) to clear the brand entirely. Don't call this on every turn — only when the user explicitly tells you their brand is changing.",
		inputSchema: {
			type: "object",
			properties: {
				brand: {
					type: ["object", "null"],
					properties: {
						name: { type: "string" },
						tagline: { type: "string" },
						colors: {
							type: "object",
							properties: {
								primary: { type: "string" },
								accent: { type: "string" },
								ink: { type: "string" },
								background: { type: "string" },
							},
						},
						typography: {
							type: "object",
							properties: {
								display: { type: "string" },
								body: { type: "string" },
							},
						},
						voice: {
							type: "string",
							enum: ["minimal", "bold", "editorial", "casual", "corporate", "playful"],
						},
						logoPath: { type: "string" },
					},
				},
			},
		},
		command: "workspace.set-brand",
	},
	{
		name: "workspace_get_project_defaults",
		description:
			"Return the active workspace's project-look defaults (wallpaper/background, captionSettings, editorDefaults) that new projects and fresh recordings start from. Returns { defaults: null } when none are set.",
		inputSchema: { type: "object", properties: {} },
		command: "workspace.get-project-defaults",
	},
	{
		name: "workspace_set_project_defaults",
		description:
			"Set the active workspace's project-look defaults so every NEW project + recording starts from them (so the user does not re-set the same look each time). Pass any subset under `defaults`. Unknown/badly-typed fields are dropped. Pass defaults=null (or omit) to clear. Use when the user says e.g. 'use this look for all my projects' or 'always start with this background/captions'.",
		inputSchema: {
			type: "object",
			properties: {
				defaults: {
					type: ["object", "null"],
					properties: {
						wallpaper: { type: "string" },
						captionSettings: {
							type: "object",
							properties: {
								enabled: { type: "boolean" },
								templateId: { type: "string" },
								wordsPerLine: { type: "integer" },
								positionY: { type: "number" },
								styleOverrides: { type: "object" },
							},
						},
						editorDefaults: {
							type: "object",
							properties: {
								padding: { type: "number" },
								shadowIntensity: { type: "number" },
								borderRadius: { type: "number" },
								showBlur: { type: "boolean" },
								motionBlurAmount: { type: "number" },
							},
						},
					},
				},
			},
		},
		command: "workspace.set-project-defaults",
	},

	// ── YouTube publishing (v1.19) ──────────────────────────────────
	// Connect Google accounts per workspace, publish exports, edit
	// already-published videos. All verbs operate on the active
	// workspace unless the agent switches first.
	{
		name: "youtube_is_configured",
		description:
			"Return whether this PandaStudio build has Google OAuth credentials baked in. When false, every other `youtube.*` verb will fail — tell the user this build can't publish to YouTube.",
		inputSchema: { type: "object", properties: {} },
		command: "youtube.is-configured",
	},
	{
		name: "youtube_connect",
		description:
			"Start Google OAuth in the user's system browser. Long-running: waits up to 5 minutes for consent. On success, stores refresh token encrypted under the active workspace and returns the account + its channels. INTERACTIVE — only call when the user explicitly asks to connect a YouTube account.",
		inputSchema: { type: "object", properties: {} },
		command: "youtube.connect",
	},
	{
		name: "youtube_disconnect",
		description:
			"Revoke and delete a YouTube account from the active workspace. Published videos stay on YouTube; only the local connection + cached channels + encrypted refresh token are removed.",
		inputSchema: {
			type: "object",
			properties: { accountId: { type: "string" } },
			required: ["accountId"],
		},
		command: "youtube.disconnect",
	},
	{
		name: "youtube_list_accounts",
		description:
			"List connected Google accounts in the active workspace + cached YouTube channels. Call this before `export.publish-youtube` so the user can pick account + channel.",
		inputSchema: { type: "object", properties: {} },
		command: "youtube.list-accounts",
	},
	{
		name: "youtube_list_channels",
		description:
			"Re-pull the channel list for a connected account from YouTube (bypasses local cache). Useful if the user just created a new channel under the same Google account.",
		inputSchema: {
			type: "object",
			properties: { accountId: { type: "string" } },
			required: ["accountId"],
		},
		command: "youtube.list-channels",
	},
	{
		name: "export_publish_youtube",
		description:
			"Upload an export-library entry to YouTube via resumable upload. Stamps title/description/tags/privacy on the video and (optionally) pushes the entry's thumbnail. Returns `{ videoId, videoUrl }`. LONG-RUNNING (expect ~30 s per 100 MB). The export row is marked `youtubeVideoId` on success, so repeated calls on an already-published entry should check that field first.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Export entry id." },
				accountId: { type: "string" },
				channelId: { type: "string" },
				title: {
					type: "string",
					description: "Max 100 chars; < and > are stripped (YouTube rejects them).",
				},
				description: {
					type: "string",
					description:
						"Plain text, line breaks OK. < and > are stripped automatically and the text is clamped to 5000 chars, so a stray angle bracket (common in AI-written copy) no longer fails the upload.",
				},
				tags: { type: "array", items: { type: "string" } },
				categoryId: { type: "string" },
				privacyStatus: {
					type: "string",
					description: "public | unlisted | private. Default unlisted.",
				},
				setThumbnail: { type: "boolean" },
			},
			required: ["id", "accountId", "channelId", "title"],
		},
		command: "export.publish-youtube",
	},
	{
		name: "instagram_connect",
		description:
			"Start connecting an Instagram account. Opens the user's browser to the Instagram consent page and returns `{ connectionId, redirectUrl }`. INTERACTIVE: the user must finish consent in the browser, then poll `instagram_status` until active before publishing. Only Business/Creator accounts can publish (a Meta restriction). Requires an activated PandaStudio license.",
		inputSchema: { type: "object", properties: {} },
		command: "instagram.connect",
	},
	{
		name: "instagram_status",
		description:
			"Check whether the Instagram connection is active yet. Returns `{ status, active }`. Poll after `instagram_connect` until `active` is true.",
		inputSchema: {
			type: "object",
			properties: {
				connectionId: { type: "string", description: "From instagram_connect (optional)." },
			},
		},
		command: "instagram.status",
	},
	{
		name: "instagram_account",
		description:
			"Read the connected Instagram account: `username`, `account_type`, and `publishable` (true only for Business/Creator accounts). Call before `export_publish_instagram` to warn the user if their account type can't publish.",
		inputSchema: { type: "object", properties: {} },
		command: "instagram.account",
	},
	{
		name: "instagram_disconnect",
		description:
			"Disconnect the user's Instagram account. Already-published Reels stay on Instagram.",
		inputSchema: { type: "object", properties: {} },
		command: "instagram.disconnect",
	},
	{
		name: "export_publish_instagram",
		description:
			"Publish an export-library entry to Instagram as a Reel. The video uploads directly to Composio storage (never through our server) and publishes via the broker. Returns `{ mediaId, permalink }`. LONG-RUNNING: Instagram processes the Reel for ~30-120 s before it goes live. Requires a connected Business/Creator account (check `instagram_account` first). Instagram only accepts short-form video — export a 9:16 clip up to ~90 s.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Export entry id." },
				caption: { type: "string", description: "Reel caption, max 2200 chars; hashtags go here." },
				shareToFeed: { type: "boolean", description: "Also show in the feed grid. Default true." },
			},
			required: ["id"],
		},
		command: "export.publish-instagram",
	},
	{
		name: "export_list_youtube",
		description:
			"List recently-published videos on a connected account (includes videos not published via PandaStudio). Dashboard data.",
		inputSchema: {
			type: "object",
			properties: {
				accountId: { type: "string" },
				max: { type: "number", description: "Default 25, max 50." },
			},
			required: ["accountId"],
		},
		command: "export.list-youtube",
	},
	{
		name: "export_update_youtube",
		description:
			"Update an already-published video's metadata (title / description / tags / category / privacyStatus). Pass only the fields you want to change. Cannot replace the video file — YouTube requires deleting and re-uploading for that.",
		inputSchema: {
			type: "object",
			properties: {
				accountId: { type: "string" },
				videoId: { type: "string" },
				title: {
					type: "string",
					description: "Max 100 chars; < and > are stripped (YouTube rejects them).",
				},
				description: {
					type: "string",
					description:
						"Plain text, line breaks OK. < and > are stripped automatically and the text is clamped to 5000 chars, so a stray angle bracket (common in AI-written copy) no longer fails the upload.",
				},
				tags: { type: "array", items: { type: "string" } },
				categoryId: { type: "string" },
				privacyStatus: { type: "string" },
			},
			required: ["accountId", "videoId"],
		},
		command: "export.update-youtube",
	},
	{
		name: "export_update_youtube_thumbnail",
		description:
			"Replace an already-published video's thumbnail on YouTube via thumbnails.set. Expects a local 1280×720 image (no auto-crop — pre-process or use `export.generate-thumbnail` output).",
		inputSchema: {
			type: "object",
			properties: {
				accountId: { type: "string" },
				videoId: { type: "string" },
				imagePath: { type: "string" },
			},
			required: ["accountId", "videoId", "imagePath"],
		},
		command: "export.update-youtube-thumbnail",
	},

	// ── project lifecycle ───────────────────────────────────────────
	{
		name: "project_list",
		description:
			"List projects in the active workspace (id, name, path, modifiedAt, clipCount, revision, workspaceId). Pass `allWorkspaces: true` to see across every workspace on the machine. Each row carries its workspaceId; the top-level response also returns currentWorkspaceId so you can detect cross-workspace mismatches.",
		inputSchema: {
			type: "object",
			properties: {
				allWorkspaces: {
					type: "boolean",
					description:
						"When true, list across every workspace (each row tagged with workspaceId). Default false — current workspace only.",
				},
			},
		},
		command: "project.list",
	},
	{
		name: "project_set_folder",
		description:
			'Move a project to a folder (organisational label shown on the Home page) or back to Unsorted. Folders are flat (no nesting) and scoped to the project\'s owning workspace. Identify the project by `id` (preferred) or `path`. Pass `folder: ""` (empty string) or omit the field to clear the folder and return the project to Unsorted. Returns { id, path, folder }. Use this when the user asks to organise, sort, label, group, archive, or categorise projects.',
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Project UUID (preferred)." },
				path: { type: "string", description: "Absolute project file path." },
				folder: {
					type: "string",
					description:
						"Folder label. Case-sensitive; whitespace is trimmed. Empty string or omitted = move to Unsorted.",
				},
			},
		},
		command: "project.setFolder",
	},
	{
		name: "project_rename",
		description:
			"Rename a project (the display name shown in the editor title bar and the Home grid). Identify the project by `id` (preferred) or `path`. Pass the new `name` (trimmed; must be non-empty). The on-disk filename is NOT changed (files are keyed by project id), so this is safe to call while the project is open. Returns { id, path, name }. Use when the user asks to rename, retitle, or relabel a project.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Project UUID (preferred)." },
				path: { type: "string", description: "Absolute project file path." },
				name: { type: "string", description: "New display name. Trimmed; must be non-empty." },
			},
			required: ["name"],
		},
		command: "project.rename",
	},
	{
		name: "project_locate",
		description:
			"Look up a project's owning workspace WITHOUT reading the project body. Returns { id, filePath, workspaceId, workspaceName, isInActiveWorkspace }. **Cheap pre-flight you SHOULD call when given a project id with no other context** — before any edit, export, or publish. If isInActiveWorkspace is false, surface the mismatch to the user before proceeding (the YouTube account + Replicate key are workspace-scoped, so publishing to YouTube on the wrong workspace publishes to the wrong client's channel).",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Project UUID." },
			},
			required: ["id"],
		},
		command: "project.locate",
	},
	{
		name: "project_current",
		description:
			"Return the project currently loaded in the editor window: { project: {id, path, name, revision, clipCount} | null }. Use this when the user says 'edit what I'm working on' / 'the project that's open' — no need to ask them for an id. Returns { project: null } when no editor window is open.",
		inputSchema: { type: "object", properties: {} },
		command: "project.current",
	},
	{
		name: "project_show",
		description:
			"Resolve a project's path + summary metadata by id or path. Cheaper than project_read.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Project UUID (preferred)" },
				path: { type: "string", description: "Project file path" },
			},
		},
		command: "project.show",
	},
	{
		name: "project_read",
		description:
			"Read a project's full JSON. Returns { path, project, clipStates, workspaceId, workspaceName, isInActiveWorkspace }. `clipStates` is a per-clip summary: { clipId, mediaPath, durationMs, transcribed, wordCount, audioCleaned, cleanedAudioPath? } — use it to decide whether to call transcript_transcribe or audio_clean before editing. **Workspace fields:** every read includes the project's owning workspace; if `isInActiveWorkspace` is false, the YouTube account and Replicate key in scope are NOT the ones that own this project — surface the mismatch to the user before any export or publish. Pass `project.revision` back as `expectedRevision` on subsequent writes for conflict-safe edits. **Performance tip:** pass `includeTranscript: false` after your first read to drop the per-clip transcript words from the response — they're typically 600+ KB on a 5-minute recording and most agent flows don't need them after pacing is done. clipStates always tells you the transcribed/wordCount status either way. Clips at project.mainTrack.clips[], overlays at project.editor.mediaOverlayRegions[]. Response includes editedDurationMs, sourceDurationMs, totalTrimmedMs, trimCount.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				includeTranscript: {
					type: "boolean",
					description:
						"When false, per-clip transcripts are stripped from the returned project object. Saves 600+ KB on typical recordings, 2-4s of JSON parse on subsequent reads. Default true.",
				},
			},
		},
		command: "project.read",
	},
	{
		name: "project_new",
		description:
			"Create a new project. `withMedia` (array of absolute video file paths) imports them as clips; FFmpeg probes each duration. Returns { id, path, project }.",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "Display name" },
				withMedia: {
					type: "array",
					items: { type: "string" },
					description: "Absolute paths to video files to import as clips",
				},
			},
			required: ["name"],
		},
		command: "project.new",
	},
	{
		name: "project_fork_from_shot",
		description:
			"Fork an exported video's AI-generated shot into a new 9:16 project. Carries forward the source project's timing surgery (trim regions, transcript edits, speed regions, per-clip transcribed/audioCleaned status) but STRIPS every overlay row — zooms, FX, motion graphics, captions, transitions, lower thirds, annotations, clip-transforms, background music — because those were sized for 16:9 and don't fit a vertical short. The new project is cropped to the shot's [startMs, endMs] range, switched to 9:16 with a centered cover-crop so the landscape source FILLS the vertical frame (not letterboxed), and ready to receive Shorts-native graphics/captions on top. Pass exportId + shotId from export.list (the shot lives under `entry.generatedShots[]`); the verb looks up the source project path, runs the fork, writes the new file, and returns its id + path. If the source project has been edited since export (revision drift) the verb returns `revision_mismatch` with the live revision; confirm with the user and retry with `force: true`. Returns { id, path, name, aspectRatio, sourceProjectPath, sourceProjectRevision, liveRevision, project }.",
		inputSchema: {
			type: "object",
			properties: {
				exportId: {
					type: "string",
					description: "Export library entry id (from export.list).",
				},
				shotId: {
					type: "string",
					description:
						"Shot id (from the export entry's `generatedShots` array; produced by generate-shorts).",
				},
				aspectRatio: {
					type: "string",
					description:
						"Target aspect. Defaults to '9:16' (the right answer for almost every shot generator output).",
				},
				force: {
					type: "boolean",
					description:
						"Set true to fork even when the source project has drifted since export. Without it, drift returns revision_mismatch and the caller must confirm with the user first.",
				},
			},
			required: ["exportId", "shotId"],
		},
		command: "project.fork-from-shot",
	},
	{
		name: "project_open",
		description:
			"Open the desktop editor focused on a specific project (so the user can take over).",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
			},
		},
		command: "project.open",
	},

	// ── compose: clips, motion graphics, FX ────────────────────────
	{
		name: "project_add_clip",
		description:
			"Append (or insert) a video clip into the project's main track. Probes duration via FFmpeg. Pass `webcam` (a second, separately-recorded source) to make the clip a two-speaker podcast composite (media=host, webcam=guest, kind=podcast) — for 3+ speakers or audio auto-sync use project_add_podcast_clip instead.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				media: { type: "string", description: "Absolute path to video file (the host source)" },
				webcam: {
					type: "string",
					description:
						"Optional absolute path to a SECOND, separately-recorded source (the guest). When set, the clip becomes a two-speaker podcast composite. Use project_add_podcast_clip for 3+ participants or audio auto-sync.",
				},
				atIndex: {
					type: "number",
					description: "Insert before this zero-based clip index. Omit to append at the end.",
				},
				expectedRevision: { type: "number" },
			},
			required: ["media"],
		},
		command: "project.add-clip",
	},
	{
		name: "project_add_podcast_clip",
		description:
			"Assemble 2-4 separately-recorded sources (e.g. host + guest exported from Zoom/Riverside) into ONE podcast composite clip — the import equivalent of an in-app/remote podcast recording. media=host (the authoritative clock); guests=ordered guest paths (1-3). Speakers are assigned host/guest/guest-2/guest-3 and stored as participants[]. By default auto-syncs each guest to the host via audio cross-correlation (set autoSync=false to skip); fine-tune later with project_set_participant_offset. After this, run transcript_transcribe (it transcribes each speaker separately and merges into one speaker-attributed transcript), then edit by transcript exactly like a recorded podcast. Preview + export render every participant via the existing N-party podcast layout.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				media: { type: "string", description: "Absolute path to the HOST video (reference clock)" },
				guests: {
					type: "array",
					items: { type: "string" },
					description:
						"Absolute paths to the 1-3 guest videos in participant order (guest, guest-2, guest-3).",
				},
				labels: {
					type: "array",
					items: { type: "string" },
					description:
						"Optional display names parallel to [host, ...guests] (index 0 = host). Falls back to the speaker id.",
				},
				autoSync: {
					type: "boolean",
					description:
						"Audio-align each guest to the host before assembling (default true). Set false to assemble with zero offsets.",
				},
				atIndex: {
					type: "number",
					description: "0-based insert position in the clips array. Omit to append.",
				},
				expectedRevision: { type: "number" },
			},
			required: ["media", "guests"],
		},
		command: "project.add-podcast-clip",
	},
	{
		name: "project_set_participant_offset",
		description:
			"Fine-tune ONE participant's A/V sync on a multi-party podcast composite. speaker = guest | guest-2 | guest-3 (the host is the reference clock and can't be offset). offsetMs shifts that participant's video AND audio vs the host: positive delays, negative advances, 0 clears (±10000). The N-party analogue of project_set_webcam_offset (which only reaches guest-1). Honored in preview + export.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				clipId: { type: "string", description: "Clip id of the podcast composite" },
				speaker: {
					type: "string",
					description: "Which participant to nudge: guest | guest-2 | guest-3",
				},
				offsetMs: {
					type: "number",
					description: "Time nudge in ms (±10000). Positive delays this guest; 0 clears.",
				},
				expectedRevision: { type: "number" },
			},
			required: ["clipId", "speaker", "offsetMs"],
		},
		command: "project.set-participant-offset",
	},
	{
		name: "project_auto_sync_podcast",
		description:
			"Re-run audio auto-sync on an existing podcast composite clip: cross-correlates each guest's audio against the host and stores the resulting offset on each participant. Use after project_add_podcast_clip with autoSync=false, or to re-align if a manual nudge drifted. Returns the per-guest offsets + confidence; fine-tune afterward with project_set_participant_offset.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				clipId: { type: "string", description: "Clip id of the podcast composite" },
				expectedRevision: { type: "number" },
			},
			required: ["clipId"],
		},
		command: "project.auto-sync-podcast",
	},
	{
		name: "project_add_motion_graphic",
		description:
			"Drop a motion-graphic MP4/WebM onto the timeline. PREFERRED: pass `fromJob` (the jobId from motion_render_html / motion_generate / motion_concat) — the server resolves the outputPath internally, so you never handle the path string at all. Fallback: pass `file` (an absolute path) only for external/uploaded files. Also accepts `file: 'bundled:transition/<id>'` (ids from asset_list_transitions) — the house-opener pattern: a bundled transition placed as an overlay auto-stamps transitionId so it COVER-fits any canvas (a 16:9 sweep fills a 9:16 frame) and carries its SFX via soundUrl. Image files (png/jpg/webp/gif/avif) are detected and render as image overlays; pair `file: <image>` with `layer: 'background'` for a timed BACKGROUND-IMAGE underlay (cover-fills the canvas behind the camera — with a background-effect remove region over the same span, the image replaces the speaker's real background for just that duration). **Defaults to a `bundled:sound/mouse-click` SFX as the graphic appears** — pass `soundUrl: null` to make it silent, or any other `bundled:sound/<id>` to swap the sound.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				fromJob: {
					type: "string",
					description:
						"PREFERRED for render outputs. The jobId returned by motion_render_html / motion_generate / motion_concat. The server reads the outputPath the job produced — you never construct or pass a path, eliminating the path-truncation failure mode entirely. The job must have succeeded (call job_wait first). Mutually exclusive with `file`.",
				},
				file: {
					type: "string",
					description:
						"Absolute path to an external MP4/WebM (e.g. a user upload). For RENDER outputs use `fromJobId` instead. If you must use `file`, pass the exact `outputPath` from a render job — never construct paths manually (they get truncated at the space in `Application Support` and the overlay silently fails). One of `fromJobId` or `file` is required.",
				},
				durationMs: { type: "number" },
				atMs: { type: "number", description: "Default: end of timeline" },
				soundUrl: {
					type: ["string", "null"],
					description:
						"SFX played when the motion graphic appears. Defaults to bundled:sound/mouse-click. Pass any other bundled id (bundled:sound/<id> — bundled:sound/swoosh-fast, bundled:sound/message-pop, etc.; use asset_list_sounds to discover) to swap the sound, or pass null explicitly to make the graphic silent.",
				},
				soundVolume: {
					type: "number",
					description: "Sound volume 0–1. Default 1. Ignored when soundUrl is null.",
				},
				anchorSourceMs: {
					type: "number",
					description:
						"Anchor the motion graphic to a SOURCE-time moment (raw recording time). Pass this whenever atMs was derived from a transcript word's startMs — the region will then re-anchor automatically when subsequent transcript edits (remove-fillers, remove-silences, delete-words) shift the edited-time map. Without it, the motion graphic drifts silently. Omit for free-floating placement.",
				},
				anchorSourceEndMs: {
					type: "number",
					description:
						"Optional anchor end (source ms) for ranged anchoring — the region's duration tracks the source-time span instead of preserving its visible duration.",
				},
				backdropBlurStrength: {
					type: "number",
					description:
						"Frosted-glass backdrop blur sigma in 1080p-px. The compositor blurs the camera through the overlay's alpha shape — blur follows the visible content, not the bounding box. Editor's 'Glass' default is 24; 12 is subtle, 36+ is heavy. Pair with a transparent render (motion_render_html --transparent) so the overlay has alpha for the mask to read. Omit or pass 0 to disable.",
				},
				backdropBlurTint: {
					type: "string",
					description:
						"Optional CSS color string composited over the blurred backdrop. Editor default: 'rgba(10,10,10,0.18)' (slight dark glass). Only applied when backdropBlurStrength > 0.",
				},
				layer: {
					type: "string",
					enum: ["overlay", "background"],
					description:
						"'background' renders this full-frame graphic BEHIND the camera (graphic-background + talking-head-card layout) — pair it with a CARD camera clip-transform (cam-right-portrait / cam-bottom-right-quarter) over the same span. The camera card composites on top in preview AND export. Default 'overlay' (on top).",
				},
				expectedRevision: { type: "number" },
			},
			required: ["durationMs"],
		},
		command: "project.add-motion-graphic",
	},
	{
		name: "project_add_designed_segment",
		description:
			"Create a 'designed segment' — the split where the host stays LIVE on one half and a motion-graphic panel fills the other. 16:9: host right / panel left, like a Vox or MKBHD explainer beat. 9:16 SHORTS: host in a top/bottom band, panel in the other band (cameraSide top|bottom). ONE atomic call places both pieces over the same time range with the same transition and source anchor, so they can't drift or mismatch: the camera is repositioned + cover-cropped into its half (a full-bleed split clip-transform) and a full-frame transparent panel graphic is composited on top. Stays in the live compositor — camera is full-quality and scrubbable, nothing baked. IMPORTANT: author the panel graphic as a FULL-FRAME TRANSPARENT render at the project aspect via motion_render_html --transparent (1920x1080 for 16:9, 1080x1920 for 9:16; the premium `paper-panel` and `vox-side-panel` templates are aspect-aware — render either at 9:16 and it reflows into a top/bottom band) — paint the opaque panel + content on the panel side, leave the camera's half fully transparent (it reveals the repositioned host). See SKILL.md 'Designed segments' and 'Editing a Short'.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				fromJob: {
					type: "string",
					description:
						"PREFERRED. The jobId from the transparent motion_render_html job (the full-frame panel graphic with the camera half transparent). Server resolves the outputPath internally — no shell, no path truncation. Mutually exclusive with `file`.",
				},
				file: {
					type: "string",
					description:
						"Absolute path to the transparent panel graphic (WebM/MOV with alpha). Prefer `fromJob`; if used, pass a render job's exact outputPath — never hand-construct (truncates at the space in 'Application Support').",
				},
				durationMs: { type: "number" },
				atMs: { type: "number", description: "Default: end of timeline" },
				cameraSide: {
					type: "string",
					enum: ["left", "right", "top", "bottom"],
					description:
						"Which half the CAMERA fills; the panel graphic fills the opposite half. 16:9: 'left'/'right' ('right' is the canonical reference — host right, panel left). 9:16 SHORTS: 'top'/'bottom' — the camera fills a horizontal band and the panel covers the other band (render a premium panel like `paper-panel` or `vox-side-panel` at 9:16; both reflow into a top/bottom band).",
				},
				cameraRatio: {
					type: "number",
					enum: [50, 55],
					description:
						"Camera's share of the split axis (width for left/right, height for top/bottom): 55 (default for 16:9) or 50 (balanced — pair the 9:16 shorts template with 50). Panel gets the rest. Author the panel's opaque band to match (e.g. left 45% for cameraSide=right ratio=55; bottom 50% for cameraSide=top ratio=50).",
				},
				transitionMs: {
					type: "number",
					description: "Slide-in/out window at each edge in ms. Default 320.",
				},
				soundUrl: {
					type: ["string", "null"],
					description:
						"SFX when the segment appears. Defaults to bundled:sound/mouse-click (inherited from project.add-motion-graphic). Pass any other bundled:sound/<id> to swap, or pass null explicitly to make the segment silent.",
				},
				soundVolume: {
					type: "number",
					description: "Sound volume 0–1. Default 1. Ignored when soundUrl is null.",
				},
				anchorSourceMs: {
					type: "number",
					description:
						"Anchor BOTH regions to a SOURCE-time moment (transcript word startMs). Pass when atMs was derived from a transcript word so the whole segment stays glued across later transcript edits. Omit for free-floating placement.",
				},
				anchorSourceEndMs: {
					type: "number",
					description: "Optional anchor end (source ms) for ranged anchoring.",
				},
				expectedRevision: { type: "number" },
			},
			required: ["durationMs", "cameraSide"],
		},
		command: "project.add-designed-segment",
	},
	{
		name: "project_set_overlay_backdrop_blur",
		description:
			"Set or clear the frosted-glass backdrop-blur effect on an existing media-overlay region. Compositor blurs the camera (or whatever is underneath) through the overlay's alpha mask, so blur follows visible content shape — not a rectangular halo. Works on any media overlay (image / video / motion graphic) but visible only when the overlay has alpha; opaque overlays show no effect. Pass strength=0 to disable.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				regionId: {
					type: "string",
					description: "Media-overlay region id from project.read.",
				},
				strength: {
					type: "number",
					description:
						"Blur sigma in 1080p-px. 0 disables. Editor default 24; 12 subtle; 36+ heavy.",
				},
				tint: {
					type: "string",
					description:
						"Optional CSS color string. Editor default: 'rgba(10,10,10,0.18)'. Ignored when strength is 0.",
				},
				expectedRevision: { type: "number" },
			},
			required: ["regionId"],
		},
		command: "project.set-overlay-backdrop-blur",
	},
	{
		name: "project_set_overlay_crop",
		description:
			"Set or clear a source-pixel crop on a media overlay (image / video / motion graphic). Coordinates are normalized 0–1 over the overlay's NATIVE source dimensions (NOT the canvas) — independent of where the overlay is positioned on the timeline. Common uses: cut black bars off b-roll before compositing; isolate the centre column of a 16:9 clip when stacking it into a 9:16 short; zoom into one quadrant of a motion graphic. Omit x/y/width/height (or pass identity {0,0,1,1}) to clear the crop entirely. The renderer clamps out-of-range values so a malformed crop is at worst 'whole source'.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				regionId: {
					type: "string",
					description: "Media-overlay region id from project.read.",
				},
				x: { type: "number", description: "Crop x origin in [0, 1) of source width." },
				y: { type: "number", description: "Crop y origin in [0, 1) of source height." },
				width: { type: "number", description: "Crop width in (0, 1] of source width." },
				height: { type: "number", description: "Crop height in (0, 1] of source height." },
				expectedRevision: { type: "number" },
			},
			required: ["regionId"],
		},
		command: "project.set-overlay-crop",
	},
	{
		name: "project_add_fx",
		description: "Drop an FX overlay (bundled fxId or custom video URL) onto the timeline.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				fxId: {
					type: "string",
					description: "Bundled FX id (e.g. film-burn). Use asset_list_fx to discover.",
				},
				src: { type: "string", description: "Direct path/URL (alternative to fxId)" },
				atMs: { type: "number" },
				durationMs: { type: "number", description: "Default 2500ms for bundled FX" },
				speed: {
					type: "number",
					description:
						"Playback-speed multiplier for the looping FX (0.25-4, default 1). 2 = twice as fast, 0.5 = half. Speeds up / slows down a film burn, light leak, etc. without re-rendering.",
				},
				expectedRevision: { type: "number" },
			},
			required: ["atMs"],
		},
		command: "project.add-fx",
	},
	{
		name: "project_add_transition",
		description:
			"Place a transition at a cut between two clips. Drops a bundled transition overlay (a full-frame transparent WebM that goes opaque at its midpoint) CENTERED on atMs, so the opaque peak masks the cut and reads as a scene change. No render step. Pass atMs = the cut time (a clip boundary from project_read). Ids (asset_list_transitions): fade-black, fade-white, flash, light-sweep, film-burn, glitch.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				transitionId: {
					type: "string",
					description: "Bundled id, e.g. fade-black. From asset_list_transitions.",
				},
				file: {
					type: "string",
					description: "Custom transition video (path / file:// URL). Use instead of transitionId.",
				},
				atMs: {
					type: "number",
					description: "Edited-timeline CUT time to center the transition on.",
				},
				durationMs: {
					type: "number",
					description: "Total length. Default 1000 (native length of the bundled set).",
				},
				expectedRevision: { type: "number" },
			},
			required: ["atMs"],
		},
		command: "project.add-transition",
	},
	{
		name: "project_add_lower_third",
		description:
			"One-call lower third: renders an lt-* nameplate motion template (hyperframes) with your name/title and places it on the timeline as a transparent overlay at atMs. ASYNC — returns { jobId, outputPath }; call job_wait — it resolves once the region is PLACED (result: { path, revision, outputPath, durationMs }), no separate project_add_motion_graphic call needed. Designs (see motion_list, category lower-third): lt-vox-marker (default, highlighter swipe), lt-broadcast-bar (news chyron), lt-glass-card (frosted), lt-kinetic-stack (bold word-by-word), lt-minimal-line (editorial), lt-corner-plate (documentary bracket + kicker slot), lt-accent-slab (knockout name), lt-avatar-pill (creator pill), lt-typewriter-tag (mono typing), lt-gradient-sweep (gradient glow).",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				name: { type: "string", description: "Primary text (person/brand name)" },
				title: { type: "string", description: "Secondary line (role / handle / tagline)" },
				templateId: {
					type: "string",
					description: "lt-* design id. Default lt-vox-marker.",
				},
				atMs: { type: "number", description: "Edited timeline time" },
				aspectRatio: {
					type: "string",
					description: "16:9 | 9:16 | 1:1. Default 16:9 — match the project's aspect.",
				},
				slots: {
					type: "object",
					description:
						"Optional extra slot overrides (colors like accentColor/inkColor, or kicker for lt-corner-plate). Keys from motion_list. name/title args win over same-key entries.",
				},
				soundUrl: {
					type: "string",
					description:
						'SFX on enter. Bundled id (bundled:sound/<id>). Default bundled:sound/mouse-click. Pass "none" for silent.',
				},
				soundVolume: { type: "number", description: "Sound volume 0–1. Default 1." },
				anchorSourceMs: {
					type: "number",
					description:
						"Anchor to a SOURCE-time moment. Pass when atMs comes from a transcript word's startMs so the region survives later trims.",
				},
				anchorSourceEndMs: {
					type: "number",
					description: "Optional anchor end (source ms) for ranged anchoring.",
				},
				expectedRevision: { type: "number" },
			},
			required: ["name", "atMs"],
		},
		command: "project.add-lower-third",
	},

	// ── compose: visual regions ─────────────────────────────────────
	{
		name: "project_add_zoom",
		description:
			"Add a zoom region — highlight a UI moment. Typical pattern: find 'click X' in transcript, drop zoom there. ALWAYS pass anchorSourceMs (= the same source-time value you use for atMs) when picking from a transcript word — without it, the zoom drifts off the moment as soon as any trim is added (which the YouTube editing playbook always does via remove-fillers / remove-silences). Ships with a short swoosh SFX by default; pass soundUrl=\"none\" for silent.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				atMs: { type: "number" },
				durationMs: { type: "number" },
				depth: {
					type: "number",
					description:
						"1 (mild) - 6 (extreme). Default 2 (1.5×) — soft, modern feel. Use 3-4 for emphasis beats, 5-6 for dramatic punch-ins.",
				},
				focusX: {
					type: "number",
					description:
						"Normalised 0-1 horizontal center. Default 0.5. Ignored when followCursor is true.",
				},
				focusY: {
					type: "number",
					description:
						"Normalised 0-1 vertical center. Default 0.5. Ignored when followCursor is true.",
				},
				followCursor: {
					type: "boolean",
					description:
						"When true, the zoom continuously pans to follow the recorded mouse cursor (smoothed) for its duration — the Screen-Studio-style cursor-follow camera. Requires cursor telemetry (screen recordings); falls back to static focus otherwise. Ideal for screen-recording walkthroughs. Default false.",
				},
				soundUrl: {
					type: "string",
					description:
						'SFX played at the zoom\'s leading edge. Bundled id (bundled:sound/<id>). Default bundled:sound/swoosh-fast. Pass "none" for silent.',
				},
				soundVolume: {
					type: "number",
					description: "Sound volume 0–1. Default 1.",
				},
				anchorSourceMs: {
					type: "number",
					description:
						"Anchor the zoom to a moment in the original recording (a transcript word's startMs, a click in cursor telemetry). When set, the zoom's edited-time position is recomputed automatically every time a trim or speed region is added/removed. STRONGLY RECOMMENDED when atMs comes from the transcript — otherwise the zoom will drift off the moment as soon as any trim is added.",
				},
				anchorSourceEndMs: {
					type: "number",
					description:
						"Optional anchor end (source ms). When set, the zoom's duration tracks the source-time span instead of preserving the original visible duration. Useful for zooms covering a multi-word phrase.",
				},
				expectedRevision: { type: "number" },
			},
			required: ["atMs", "durationMs"],
		},
		command: "project.add-zoom",
	},
	{
		name: "project_add_spotlight",
		description:
			"Add a focus region over the video. kind 'spotlight' DIMS everything OUTSIDE a rounded rectangle to draw the eye to one spot (Focusee-style); kind 'blur' BLURS everything INSIDE the rectangle to hide an email, username, or other sensitive detail. The rect is 0..1 fractions of the video and tracks content through zooms. Defaults give a centred half-size box; pass x/y/width/height to place it.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				atMs: { type: "number" },
				durationMs: { type: "number" },
				kind: {
					type: "string",
					enum: ["spotlight", "blur"],
					description: '"spotlight" (default — dims outside) or "blur" (blurs inside).',
				},
				x: { type: "number", description: "Rect left edge, 0..1 of video width. Default 0.25." },
				y: { type: "number", description: "Rect top edge, 0..1 of video height. Default 0.25." },
				width: { type: "number", description: "Rect width, 0..1. Default 0.5." },
				height: { type: "number", description: "Rect height, 0..1. Default 0.5." },
				roundness: { type: "number", description: "Corner radius px, 0..120. Default 16." },
				maskOpacity: {
					type: "number",
					description: "SPOTLIGHT only: surround darkness 0..1. Default 0.6.",
				},
				blurAmount: {
					type: "number",
					description: "BLUR only: blur strength px, 0..120. Default 12.",
				},
				feathering: { type: "number", description: "Soft edge px, 0..120. Default 12." },
				expectedRevision: { type: "number" },
			},
			required: ["atMs", "durationMs"],
		},
		command: "project.add-spotlight",
	},
	{
		name: "project_add_background_effect",
		description:
			"Add a BACKGROUND EFFECT region on the camera video: AI person segmentation runs between startMs and endMs and either BLURS the background behind the speaker (mode 'blur' — video-call style) or REMOVES it so the project wallpaper shows through behind them (mode 'remove'). Behaves exactly like a zoom region on the timeline: draggable, trimmable, source-anchored (pass anchorSourceMs when placing from a transcript word so it survives later trims). Camera / talking-head footage only. Preview and export render it identically. Find placed regions via project_read under editor.backgroundEffectRegions[]; retime/restyle with project_update_region (regionType 'background-effect'), delete with project_remove_region.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				atMs: { type: "number", description: "Edited-time start (ms). Or pass startMs." },
				startMs: { type: "number", description: "Alias for atMs (edited-time start, ms)." },
				endMs: { type: "number", description: "Edited-time end (ms). Alternative to durationMs." },
				durationMs: {
					type: "number",
					description: "Duration in ms. Default 5000 when neither durationMs nor endMs given.",
				},
				mode: {
					type: "string",
					enum: ["blur", "remove"],
					description:
						'"blur" = person sharp, background gaussian-blurred. "remove" = background cut away; the project wallpaper/background shows through behind the person.',
				},
				strength: {
					type: "number",
					description:
						"Blur strength in px sigma at 1080p (mode='blur' only; ignored for 'remove'). 1-120, default 18.",
				},
				outline: {
					type: "boolean",
					description:
						"Person OUTLINE (colored keyline + drop shadow) around the cutout — the VOX magazine-cutout look. DEFAULTS ON for mode 'remove'; pass outline:false to remove the background with no keyline. For 'blur' it's off unless set true.",
				},
				outlineWidth: {
					type: "number",
					description: "Outline keyline width in px at 1080p. 1-120, default 36.",
				},
				outlineColor: {
					type: "string",
					description: "Outline color (hex/rgb). Default white '#ffffff'.",
				},
				outlineShadow: {
					type: "boolean",
					description:
						"Whether the outline casts a drop shadow (lifted-sticker look). Default true.",
				},
				matteContract: {
					type: "number",
					description:
						"Manually tune the person BOUNDARY, px at 1080p: >0 contracts the edge INWARD (kills background fringe / tightens the cutout), <0 expands it outward. -60..60, default 0.",
				},
				matteFeather: {
					type: "number",
					description: "Soften the matte edge, px at 1080p. 0..60, default 0.",
				},
				anchorSourceMs: {
					type: "number",
					description:
						"Anchor to a SOURCE-time moment (transcript word startMs). The region then re-anchors automatically on subsequent trim/speed edits.",
				},
				anchorSourceEndMs: {
					type: "number",
					description: "Optional anchor end (source ms) for ranged anchoring.",
				},
				expectedRevision: { type: "number" },
			},
			required: ["mode"],
		},
		command: "project.add-background-effect",
	},
	{
		name: "project_update_spotlight",
		description:
			"Patch an existing focus region in-place: move/resize the rect, retime it, restyle it (roundness/feathering/darkness/blur), or switch spotlight<->blur. Only the fields you pass change. Find ids via project_read under editor.spotlightRegions[].id.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				regionId: {
					type: "string",
					description: "The id of the focus region (editor.spotlightRegions[].id).",
				},
				startMs: { type: "number", description: "New edited-time start (ms)." },
				endMs: { type: "number", description: "New edited-time end (ms)." },
				kind: {
					type: "string",
					enum: ["spotlight", "blur"],
					description: 'Switch kind: "spotlight" (dims outside) or "blur" (blurs inside).',
				},
				x: { type: "number", description: "Rect left edge, 0..1 of video width." },
				y: { type: "number", description: "Rect top edge, 0..1 of video height." },
				width: { type: "number", description: "Rect width, 0..1." },
				height: { type: "number", description: "Rect height, 0..1." },
				roundness: { type: "number", description: "Corner radius px, 0..120." },
				maskOpacity: {
					type: "number",
					description: "SPOTLIGHT only: surround darkness 0..1.",
				},
				blurAmount: {
					type: "number",
					description: "BLUR only: blur strength px, 0..120.",
				},
				feathering: { type: "number", description: "Soft edge px, 0..120." },
				expectedRevision: { type: "number" },
			},
			required: ["regionId"],
		},
		command: "project.update-spotlight",
	},
	{
		name: "project_remove_spotlight",
		description:
			"Remove a focus region (spotlight or blur) by id. Find ids via project_read under editor.spotlightRegions[].id.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				regionId: {
					type: "string",
					description: "The id of the focus region to remove (editor.spotlightRegions[].id).",
				},
				expectedRevision: { type: "number" },
			},
			required: ["regionId"],
		},
		command: "project.remove-spotlight",
	},
	{
		name: "project_render_frame",
		description:
			"Render the composited preview frame at a given edited-time to a PNG and return its path so a VISION agent can `read` the image. Use this to SEE what's on screen — e.g. to locate an email/username/face to cover before calling project_add_spotlight (kind=blur). Returns { path, width, height, timeMs, maskRect }. `maskRect` is the video content rect as 0..1 fractions of the image — the SAME coordinate space spotlight/blur x/y/width/height use. To cover something you see at image-fractions (ix,iy,iw,ih): x=(ix-maskRect.x)/maskRect.width, y=(iy-maskRect.y)/maskRect.height, width=iw/maskRect.width, height=ih/maskRect.height. Caveats: existing focus regions are NOT drawn (so you see content clearly), and the frame reflects any active zoom at that time — place focus regions referencing an un-zoomed moment, then re-render to verify.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				atMs: { type: "number", description: "Edited-timeline time to render (ms)." },
				outPath: {
					type: "string",
					description: "Optional PNG output path. Defaults to a temp file you can read.",
				},
			},
			required: ["atMs"],
		},
		command: "project.render-frame",
	},
	{
		name: "project_render_sheet",
		description:
			"Render N preview frames sampled across an edited-time range and tile them into ONE contact-sheet PNG (row-major grid). THE verification tool for pacing and motion: one call + one image read shows caption changes, zoom ramps, overlay mutations, and dead stretches — use this instead of N sequential project_render_frame calls. Returns { sheetPath, cols, rows, frames: [{index,row,col,atMs,timeMs,path}] }; per-cell timestamps come from the frames array (cell k = frames[k], left-to-right then top-to-bottom). Every frame's seek is verified — no stale frames. If tiling is unavailable, sheetPath is null and frames[].path are readable individually.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				fromMs: { type: "number", description: "Range start, edited ms. Default 0." },
				toMs: { type: "number", description: "Range end, edited ms. Default: edited end." },
				count: { type: "number", description: "Frames sampled evenly. Default 12, max 24." },
				cols: { type: "number", description: "Grid columns. Default 4." },
				outPath: { type: "string", description: "Optional sheet PNG output path." },
			},
		},
		command: "project.render-sheet",
	},
	{
		name: "project_apply_edit_plan",
		description:
			'Apply a whole editing plan in ONE call: a JSON array of timeline ops, applied atomically (single read, all ops, single save; any invalid op aborts with nothing written). Supported ops: {"op":"add-trim","startMs","endMs"} | {"op":"add-zoom","atMs","durationMs","depth?","focusX?","focusY?","soundUrl?","anchorSourceMs?"} | {"op":"add-speed","startMs","endMs","speed"}. ALWAYS prefer this over sequential project_add_trim/zoom/speed calls when executing a beat map — it replaces 20+ round-trips with one.',
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				plan: {
					type: "string",
					description:
						'JSON array of ops, e.g. [{"op":"add-trim","startMs":1000,"endMs":1400},{"op":"add-zoom","atMs":5000,"durationMs":2500,"depth":2}]',
				},
				expectedRevision: { type: "number" },
			},
			required: ["plan"],
		},
		command: "project.apply-edit-plan",
	},
	{
		name: "audio_probe",
		description:
			'EARS without exporting: per-clip audio stats from the export-relevant track (cleanedAudioPath when present, else source). Returns hasAudio, mean/max volume (dB), detected silence spans (clip-SOURCE time), and the project audio overlays (music beds) — verify "is there dead air / is the level sane / did my music land" before export. Synchronous, a few seconds per clip.',
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				clipId: { type: "string", description: "Optional — probe only this clip." },
				noiseDb: { type: "number", description: "Silence threshold dBFS. Default -30." },
				minSilenceSec: { type: "number", description: "Min silence to report, sec. Default 0.5." },
			},
		},
		command: "audio.probe",
	},
	{
		name: "project_set_region_sound",
		description:
			'Set or clear the sound effect on an existing region (zoom / motionGraphic / fx). Use to swap the default zoom swoosh, add a ding to a motion graphic, or mute an effect sound. Pass soundUrl="none" to clear.',
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				regionId: { type: "string", description: "Target region id" },
				regionType: {
					type: "string",
					enum: ["zoom", "motionGraphic", "fx"],
					description: "Region kind that owns the id",
				},
				soundUrl: {
					type: "string",
					description:
						'Bundled id (bundled:sound/<id>), absolute path, or file:// URL. Pass "none" to clear.',
				},
				soundVolume: {
					type: "number",
					description: 'Sound volume 0–1. Ignored when soundUrl is "none". Default 1.',
				},
				expectedRevision: { type: "number" },
			},
			required: ["regionId", "regionType", "soundUrl"],
		},
		command: "project.set-region-sound",
	},
	{
		name: "project_add_trim",
		description: "Mark a span the exporter SKIPS. Use directly for manual cuts.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				startMs: { type: "number" },
				endMs: { type: "number" },
				expectedRevision: { type: "number" },
			},
			required: ["startMs", "endMs"],
		},
		command: "project.add-trim",
	},
	{
		name: "project_add_speed",
		description: "Mark a span to play at a different speed. Useful for fast-forwarding setup.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				startMs: { type: "number" },
				endMs: { type: "number" },
				speed: { type: "number", description: "0.25, 0.5, 0.75, 1.25, 1.5, 1.75, or 2" },
				expectedRevision: { type: "number" },
			},
			required: ["startMs", "endMs", "speed"],
		},
		command: "project.add-speed",
	},

	{
		name: "project_add_annotation",
		description:
			"Drop a text or figure annotation overlay on the canvas for a given time range. Position and size are in percent (0-100) of the canvas dimensions.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				startMs: { type: "number" },
				endMs: { type: "number" },
				type: {
					type: "string",
					description: "text | figure",
				},
				text: { type: "string", description: "Required when type is 'text'" },
				x: { type: "number", description: "Horizontal center, percent 0-100. Default 50." },
				y: { type: "number", description: "Vertical center, percent 0-100. Default 50." },
				width: { type: "number", description: "Width, percent 0-100. Default 30." },
				height: { type: "number", description: "Height, percent 0-100. Default 20." },
				anchorSourceMs: {
					type: "number",
					description:
						"Anchor the annotation to a SOURCE-time moment (raw recording time). Pass when startMs was derived from a transcript word's startMs — the annotation re-anchors automatically on subsequent transcript edits. Without it, the annotation drifts after any trim. Omit for free-floating placement.",
				},
				anchorSourceEndMs: {
					type: "number",
					description: "Optional anchor end (source ms) for ranged anchoring.",
				},
				expectedRevision: { type: "number" },
			},
			required: ["startMs", "endMs", "type"],
		},
		command: "project.add-annotation",
	},
	{
		name: "project_add_clip_transform_region",
		description:
			"Time-bounded transform on the main video clip between startMs and endMs. TWO families of preset: (1) cam-* render the single clip inside a sub-rect of the canvas, freeing the rest for motion graphics (use ONLY on camera-only / user-uploaded recordings; for screen recordings use cursor-telemetry zooms). (2) podcast layouts swap the WHOLE podcast composite for the window — change which participant(s) are shown over time WITHIN ONE recording. For multi-party (host + up to 3 guests) use the PARTICIPANT-AWARE presets podcast-solo / podcast-pair / podcast-grid / podcast-screen-share with a `participants` list (e.g. show just guest-2, or Kamal+Vimal side by side). Outside the region the clip renders with its natural layout. Renderer interpolates over `transitionMs` (default 320ms) at each boundary so the tiles smoothly resize.",
		inputSchema: {
			type: "object",
			required: ["startMs", "endMs", "preset"],
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				startMs: { type: "number" },
				endMs: { type: "number" },
				preset: {
					type: "string",
					enum: [
						"cam-bottom-half",
						"cam-top-half",
						"cam-right-portrait",
						"cam-right-portrait-sm",
						"cam-left-portrait",
						"cam-bottom-right-quarter",
						"cam-bottom-left-quarter",
						"cam-right-55",
						"cam-left-55",
						"cam-right-50",
						"cam-left-50",
						"layout-side-by-side",
						"layout-podcast",
						"layout-host-full",
						"layout-guest-full",
						"podcast-solo",
						"podcast-pair",
						"podcast-grid",
						"podcast-screen-share",
					],
					description:
						"cam-* (camera reposition into a sub-rect): cam-bottom-half / cam-top-half (9:16); cam-right-portrait / cam-left-portrait (16:9 ~35% card); cam-right-portrait-sm (small ~25% host card — for a full-frame graphic background); cam-bottom-right-quarter / cam-bottom-left-quarter (corner card); cam-right-55/left-55/right-50/left-50 (designed splits). PODCAST layouts (whole-composite swap over time, PODCAST clips only): the PARTICIPANT-AWARE family is podcast-solo (one person — pass participants=[who]), podcast-pair (two — participants=[left,right]), podcast-grid (everyone, or participants subset), podcast-screen-share (shared screen + participant strip). Legacy 2-person presets layout-side-by-side / layout-podcast / layout-host-full / layout-guest-full still work. IMPORTANT: podcast/layout-* only do anything on a PODCAST clip (kind='podcast'); on other clips use cam-*. Check clip.kind + participants via project_read first.",
				},
				participants: {
					type: "array",
					items: { type: "string" },
					description:
						"Ordered participant speaker ids for the participant-aware podcast-* presets: 'host' | 'guest' | 'guest-2' | 'guest-3'. podcast-solo→[who], podcast-pair→[left,right], podcast-grid/podcast-screen-share→the set to show (omit = everyone). Ignored by cam-* and legacy layout-* presets.",
				},
				transitionMs: {
					type: "number",
					description: "Transition window at each edge in ms. Default 320.",
				},
				anchorSourceMs: {
					type: "number",
					description:
						"Anchor to a SOURCE-time moment (transcript word startMs). Pass when startMs was derived from a transcript word — the region re-anchors automatically on subsequent transcript edits.",
				},
				anchorSourceEndMs: {
					type: "number",
					description: "Optional anchor end (source ms) for ranged anchoring.",
				},
				expectedRevision: { type: "number" },
			},
		},
		command: "project.add-clip-transform-region",
	},

	// ── project lifecycle (extended) ───────────────────────────────
	{
		name: "project_save",
		description:
			"Persist a project. Two modes: (1) pass a full `project` JSON to OVERWRITE the file (use after building/mutating a project object client-side) — always pass `expectedRevision` so a concurrent edit returns { ok:false, details:{ code:'revision_conflict' } }; (2) OMIT `project` to simply confirm the current on-disk state. The add_*/set_* verbs already autosave, so a bodyless save is a no-op confirmation that returns the current revision — NOT an error. You usually don't need an explicit save at all.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				project: {
					type: "object",
					description:
						"Full project JSON to persist (overwrite mode). Omit to just confirm current on-disk state — edits via add_*/set_* verbs already autosave.",
				},
				expectedRevision: {
					type: "number",
					description:
						"Revision from your last project_read. Strongly recommended in overwrite mode.",
				},
			},
		},
		command: "project.save",
	},
	{
		name: "project_delete",
		description:
			"Permanently delete a project file from disk. There is no trash — this is irreversible. By default the original source recording is KEPT (only the project is removed). Pass deleteRecording=true to ALSO permanently delete the project's original recording file(s) from disk. Use project_list to confirm the id before deleting.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				deleteRecording: {
					type: "boolean",
					description:
						"Also permanently delete the project's original source recording file(s). Default false. IRREVERSIBLE.",
				},
			},
		},
		command: "project.delete",
	},
	{
		name: "project_remove_clip",
		description:
			"Remove a clip from the main track by its clip id. Use project_read → clipStates to find clip ids. All regions whose time falls within the removed clip are also removed.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				clipId: {
					type: "string",
					description: "Clip id to remove (e.g. clip-1). From clipStates in project_read.",
				},
				expectedRevision: { type: "number" },
			},
			required: ["clipId"],
		},
		command: "project.remove-clip",
	},
	{
		name: "project_split_clip",
		description:
			"Split a clip in two at a position in source time (milliseconds from the start of that clip). Produces two clips: the portion before the split point and the portion after. Useful for inserting a motion graphic between two halves of a recording.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				clipId: { type: "string", description: "Clip to split" },
				atSourceMs: {
					type: "number",
					description: "Split position in milliseconds from the clip's own start (source time)",
				},
				expectedRevision: { type: "number" },
			},
			required: ["clipId", "atSourceMs"],
		},
		command: "project.split-clip",
	},
	{
		name: "project_move_clip",
		description:
			"Reorder a clip on the main track. `clipId` identifies the clip; `toIndex` is its new 0-based position after the move. Project-level regions (zooms, trims, speeds, annotations, FX, media overlays, clip transforms) automatically migrate to follow their original clips so the user-perceived edits stay attached to the same content — a zoom that was 'into the explanation in clip 2' is still pointing at the same explanation after clip 2 moves to position 0. Per-clip transcripts ride on the clips themselves and don't need separate migration.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				clipId: { type: "string", description: "Clip id to move" },
				toIndex: {
					type: "number",
					description:
						"0-based target position in the clips array (post-move). Out-of-range values clamp to bounds.",
				},
				expectedRevision: { type: "number" },
			},
			required: ["clipId", "toIndex"],
		},
		command: "project.move-clip",
	},

	// ── compose: edit existing regions ─────────────────────────────
	{
		name: "project_remove_region",
		description:
			"Delete an existing region (zoom, trim, speed, annotation, fx, overlay, clip-transform, background-effect, audio-overlay) by its id. Use project_read to find region ids — visual regions live under editor.*Regions; audio overlays live under audioOverlays[]. If the region belongs to a link group (designed-segment pair: a clip-transform parking the camera into one half + the panel motion-graphic on the other half), deleting either half also removes its peer so the pair stays coherent. Returns the updated project.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				regionType: {
					type: "string",
					description:
						"zoom | trim | speed | annotation | fx | overlay | clip-transform | background-effect | audio-overlay",
				},
				regionId: { type: "string", description: "id of the region to delete" },
				expectedRevision: { type: "number" },
			},
			required: ["regionType", "regionId"],
		},
		command: "project.remove-region",
	},
	{
		name: "project_clear_edits",
		description:
			"Reset the project to a clean editing slate in ONE atomic call. Removes every time-based region (trim, speed, zoom, motion graphic, lower third, FX, annotation, clip-transform), removes all audio overlays, and turns captions off (keeping the user's chosen caption template + style overrides so re-enabling later restores their look). Clips, transcripts, cleaned audio, and the project aspect ratio are NOT touched. Use this when the user says 'start over', 'clear all edits', or 'reset the timeline' — instead of looping project_remove_region (which N-tuples revisions and failure points). Pass full=true to also clear per-clip LUTs + crops + webcam layout + wallpaper for a true blank canvas. Returns a `cleared` summary listing how many of each kind were removed.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				full: {
					type: "boolean",
					description:
						"Also reset project-level visual config (per-clip LUT presets, LUT intensity, screen crop, webcam crop, webcam layout, wallpaper). Default false — only time-based edits + captions.enabled are cleared. Aspect ratio is NEVER reset.",
				},
				expectedRevision: { type: "number" },
			},
		},
		command: "project.clear-edits",
	},
	{
		name: "project_update_region",
		description:
			"Patch fields on an existing region without replacing it. Accepts any subset of the region's own properties — only the supplied fields are changed, everything else is preserved. Overlay geometry (x/y/width/height) is PERCENT of canvas 0-100; values <= 1 are treated as 0-1 fractions and scaled. Works on zoom (depth, focusX, focusY, focusMode: 'static'|'auto' — set 'auto' for the cursor-follow camera), trim (startMs, endMs), speed (startMs, endMs, speed), fx (atMs, durationMs, opacity, blendMode, speed), annotation, overlay, clip-transform (startMs, endMs, preset, transitionMs), background-effect (startMs, endMs, mode: 'blur'|'remove', strength), and audio-overlay (startMs, endMs, sourceStartMs, volume — lets you drag-trim an audio overlay without removing it). Time shifts on a link-grouped region (e.g. one half of a designed segment) propagate to every peer in the group so the pair stays coherent.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				regionType: {
					type: "string",
					description:
						"zoom | trim | speed | annotation | fx | overlay | clip-transform | background-effect | audio-overlay",
				},
				regionId: { type: "string", description: "id of the region to update" },
				patch: {
					type: "object",
					description:
						"Fields to update (partial). E.g. { depth: 4 } to change zoom depth, or { startMs: 2000, endMs: 15000, sourceStartMs: 4000 } to shift + trim an audio overlay (play seconds 4–17 of the source from the 2s mark on the timeline).",
				},
				expectedRevision: { type: "number" },
			},
			required: ["regionType", "regionId", "patch"],
		},
		command: "project.update-region",
	},

	// ── compose: webcam + crop + export settings ────────────────────
	{
		name: "project_set_webcam_layout",
		description:
			"Set the PROJECT-LEVEL webcam layout preset and optional position/scale. Use 'none' to hide the webcam. 'podcast' = two co-equal speaker tiles (host + guest). 'podcast-host-full'/'podcast-guest-full' = a single speaker full-frame (host=mediaPath/speaker 1, guest=webcamPath/speaker 2). To vary the layout PER SECTION of a podcast, split the clip and use project_set_clip_layout instead.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				preset: {
					type: "string",
					description:
						"picture-in-picture | vertical-stack | side-by-side | podcast | podcast-host-full | podcast-guest-full | none",
				},
				cx: {
					type: "number",
					description:
						"Horizontal center of the webcam overlay, normalised 0-1. Only for picture-in-picture.",
				},
				cy: {
					type: "number",
					description:
						"Vertical center of the webcam overlay, normalised 0-1. Only for picture-in-picture.",
				},
				scale: {
					type: "number",
					description: "Size multiplier for the webcam overlay. Default 1.0.",
				},
				cropX: { type: "number", description: "Webcam crop left edge, normalised 0-1." },
				cropY: { type: "number", description: "Webcam crop top edge, normalised 0-1." },
				cropWidth: { type: "number", description: "Webcam crop width, normalised 0-1." },
				cropHeight: { type: "number", description: "Webcam crop height, normalised 0-1." },
				expectedRevision: { type: "number" },
			},
			required: ["preset"],
		},
		command: "project.set-webcam-layout",
	},
	{
		name: "project_set_crop",
		description:
			"Set the main video crop region for the project. All values are normalised 0-1 relative to the source frame dimensions. Default is { x:0, y:0, width:1, height:1 } (no crop).",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				x: { type: "number", description: "Left edge, normalised 0-1" },
				y: { type: "number", description: "Top edge, normalised 0-1" },
				width: { type: "number", description: "Crop width, normalised 0-1" },
				height: { type: "number", description: "Crop height, normalised 0-1" },
				expectedRevision: { type: "number" },
			},
			required: ["x", "y", "width", "height"],
		},
		command: "project.set-crop",
	},
	{
		name: "project_set_screen_transform",
		description:
			"Move and/or scale the MAIN video within the frame — the automation equivalent of dragging or resizing the main clip on the canvas. Distinct from project_set_crop (which trims SOURCE pixels): this repositions and zooms the WHOLE video inside the frame. `scale` is a uniform multiplier (0.1-5; >1 zooms in and the overflow is clipped to the canvas, <1 shrinks it so the wallpaper shows around it). `x`/`y` shift the center as a fraction of canvas width/height (-2..2; 0 = centered). Omitted fields keep their current value. Pass reset:true (or no x/y/scale) to clear it back to the natural layout. Global (whole timeline); preview and export honor it identically.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				x: { type: "number", description: "Center X offset, fraction of canvas width (-2..2)." },
				y: { type: "number", description: "Center Y offset, fraction of canvas height (-2..2)." },
				scale: { type: "number", description: "Uniform scale multiplier (0.1..5). 1 = natural." },
				reset: { type: "boolean", description: "Clear the transform (back to natural layout)." },
				expectedRevision: { type: "number" },
			},
		},
		command: "project.set-screen-transform",
	},
	{
		name: "project_set_backdrop",
		description:
			"Set what fills the canvas BEHIND the main video when it's scaled down / parked in a corner (via project_set_screen_transform). mode='blur-self' shows a blurred, cover-cropped copy of the main video itself — the Shorts / camera-in-a-corner look. mode='wallpaper' (default) clears it back to the configured wallpaper. Only visible when the main video doesn't fill the frame; for the full one-click corner layout use project_set_shorts_layout. Preview and export render it identically.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				mode: {
					type: "string",
					enum: ["blur-self", "wallpaper"],
					description: "'blur-self' (blurred self-fill) or 'wallpaper' (default / clear).",
				},
				expectedRevision: { type: "number" },
			},
		},
		command: "project.set-backdrop",
	},
	{
		name: "project_set_shorts_layout",
		description:
			"One-shot vertical (9:16) layout for a camera-only clip — the automation equivalent of the editor's Layout picker. layout='full' = camera fills the frame (clears any transform + backdrop). layout='camera-corner' = camera shrinks to a draggable bottom-right tile over a blurred self-fill of itself (sets the main-clip transform AND backdrop together). For a screen-recording (screen+camera) clip, use project_set_webcam_layout with 'picture-in-picture' instead — that already gives screen-fills-with-camera-corner.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				layout: {
					type: "string",
					enum: ["full", "camera-corner"],
					description: "'full' or 'camera-corner'.",
				},
				expectedRevision: { type: "number" },
			},
		},
		command: "project.set-shorts-layout",
	},
	{
		name: "project_set_focal_point",
		description:
			"Set or clear a clip's FACE FOCAL POINT (source-normalised 0-1, origin top-left). When set, cover-cropped layouts — a 9:16 fill or a top/bottom designed-segment band — bias toward this point instead of centering geometrically, so the face stays in frame. Omit clipId to apply to ALL clips (single-clip shorts). Pass clear=true (or omit x/y) to reset to centered. NOTE: the editor AUTO-DETECTS this for vertical talking-head clips when they open, so you rarely need this — use it to override the auto framing or when building a short fully headless.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				clipId: {
					type: "string",
					description: "Target clip id (from project.read clipStates). Omit to apply to all clips.",
				},
				x: { type: "number", description: "Face center X, 0-1. Omit (with y) to clear." },
				y: { type: "number", description: "Face center Y, 0-1. Omit (with x) to clear." },
				clear: { type: "boolean", description: "Reset the focal point to geometric centering." },
				expectedRevision: { type: "number" },
			},
		},
		command: "project.set-focal-point",
	},
	{
		name: "project_auto_reframe",
		description:
			"ACTIVE-SPEAKER AUTO-REFRAME — a tracked virtual camera (Opus-Clip style) for director-cut footage (talk shows, interviews, multi-cam) reframed into a vertical/square canvas. Detects shot cuts, then densely tracks faces (MediaPipe, bundled offline, with tiling for small/far faces) and, on multi-person shots, frames WHOEVER IS TALKING (mouth-open × audio speech-energy) rather than the biggest face. The crop smoothly PANS to follow the subject within a shot and CUTS at shot boundaries, with a safe-zone clamp so the face never leaves frame. This is the right tool (not project_set_focal_point) when a landscape source with multiple/alternating people is cut to 9:16 — set-focal-point sets one static point for the whole clip. Async: opens a renderer for the dense pass (allow a couple minutes for a few-minute source). Optional zoom = fixed punch-in (omit for adaptive). Skips clips already matching the canvas aspect. clear=true reverts to the static crop. Preview and export render the crop identically, per frame.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				clipId: {
					type: "string",
					description:
						"Target one clip (from project.read clipStates). Omit to reframe every landscape clip.",
				},
				threshold: {
					type: "number",
					description: "Scene-cut sensitivity 0-1 (default 0.3). Lower = more cuts.",
				},
				minShotMs: {
					type: "number",
					description: "Minimum shot length ms (default 500); closer cuts are merged.",
				},
				samplesPerShot: {
					type: "number",
					description: "Frames sampled per shot for the focal median (default 3).",
				},
				zoom: {
					type: "number",
					description:
						"Fixed punch-in (≥1) for every shot. Omit for the default ADAPTIVE zoom that sizes each speaker's face to a consistent fraction of the frame. Pass e.g. 1.3 to force a uniform punch-in.",
				},
				clear: {
					type: "boolean",
					description: "Remove the auto-reframe track(s), reverting to the static cover-crop.",
				},
				expectedRevision: { type: "number" },
			},
		},
		command: "project.auto-reframe",
	},
	{
		name: "project_set_export_settings",
		description:
			"Pre-configure the project's export defaults (quality, format, resolution). These are the settings the Export dialog opens with — they don't affect the CLI export_start quality flag.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				quality: {
					type: "string",
					description: "medium | good | source. Controls CRF/bitrate preset.",
				},
				format: {
					type: "string",
					description: "mp4 | webm. Default mp4. (PandaStudio is video-only.)",
				},
				resolution: {
					type: "string",
					description: "Output resolution: 4k | 1080p | 720p | 480p | source. Default source.",
				},
				expectedRevision: { type: "number" },
			},
		},
		command: "project.set-export-settings",
	},

	{
		name: "project_set_aspect_ratio",
		description:
			"Change the project's output aspect ratio. Affects the canvas size and how the video is cropped/letterboxed on export. Pick based on the target platform: 16:9 for YouTube/desktop, 9:16 for Shorts/Reels/TikTok, 1:1 for Instagram feed. A camera-only project whose source aspect differs from the new ratio is auto cover-cropped (centered) to fill the frame instead of letterboxing.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				ratio: {
					type: "string",
					description: "16:9 | 9:16 | 1:1 | 4:3 | 3:4",
				},
				expectedRevision: { type: "number" },
			},
			required: ["ratio"],
		},
		command: "project.set-aspect-ratio",
	},
	{
		name: "project_set_wallpaper",
		description:
			"Set the project's background wallpaper. Pass a bundled wallpaper id (e.g. 'gradient-blue', 'dark-mesh') or 'none' to remove the background. The available wallpaper ids match the filenames in the app's /public/wallpapers/ directory.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				wallpaper: {
					type: "string",
					description: "Bundled wallpaper id or 'none' to remove background",
				},
				expectedRevision: { type: "number" },
			},
			required: ["wallpaper"],
		},
		command: "project.set-wallpaper",
	},
	{
		name: "project_set_style",
		description:
			"Adjust the project's cinematic framing style: padding around the recording (0-200), drop shadow intensity (0-100), border radius (0-100), motion blur amount (0-100), and whether to show blur behind the recording. Pass only the fields you want to change — others are left as-is.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				padding: { type: "number", description: "Padding around the recording in px. 0-200." },
				shadowIntensity: { type: "number", description: "Drop shadow strength. 0-100." },
				borderRadius: { type: "number", description: "Corner rounding. 0-100." },
				motionBlurAmount: { type: "number", description: "Motion blur strength. 0-100." },
				showBlur: {
					type: "boolean",
					description: "Whether to show a blurred background behind the recording.",
				},
				cursorScale: {
					type: "number",
					description:
						"Custom-cursor overlay size. 0 = off (no synthetic cursor). >0 (e.g. 1.5) draws an enlarged cursor that tracks the recording's cursor telemetry. Screen recordings only. 0-5.",
				},
				expectedRevision: { type: "number" },
			},
		},
		command: "project.set-style",
	},

	{
		name: "project_add_audio",
		description:
			"Add a background audio overlay (music, VO, ambient) as a first-class timeline region. Plays from startMs to endMs on the edited timeline; sourceStartMs is the in-point into the source file. Waveform peaks are extracted automatically and stored on the overlay for the timeline UI. Use project_update_region (regionType=audio-overlay) to drag/trim it afterward. Returns { overlayId } — save this to trim/remove later.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				audioPath: {
					type: "string",
					description: "Absolute path to audio file (mp3, wav, aac, m4a, ogg)",
				},
				startMs: {
					type: "number",
					description: "Where on the edited timeline playback starts. Default 0.",
				},
				endMs: {
					type: "number",
					description:
						"Where on the edited timeline playback ends. Precedence: endMs > maxDurationMs > durationMs. If all are omitted, defaults to the source file's real duration.",
				},
				sourceStartMs: {
					type: "number",
					description:
						"In-point into the source file in ms. Default 0. Combine with endMs-startMs to play a window of the source (e.g. startMs=2000, endMs=15000, sourceStartMs=4000 plays seconds 4–17 of the source at timeline position 2–15s).",
				},
				durationMs: {
					type: "number",
					description: "Fallback duration when neither endMs nor maxDurationMs is given.",
				},
				volume: { type: "number", description: "Volume multiplier 0–2. Default 0.8." },
				fadeIn: {
					type: "number",
					description:
						"Fade-in ramp at the overlay's audible start, in ms (e.g. 1000 = 1s). Applied by the export mixer. Omit for a hard start.",
				},
				fadeOut: {
					type: "number",
					description:
						"Fade-out ramp ending at the overlay's audible end, in ms. Applied for bounded overlays (endMs/maxDurationMs set); ignored on uncapped full-length overlays. Useful for seam-crossfading a looped music bed. Omit for a hard stop.",
				},
				maxDurationMs: {
					type: "number",
					description:
						"[Legacy] Sets endMs = startMs + maxDurationMs when endMs is absent. Prefer endMs.",
				},
				anchorSourceMs: {
					type: "number",
					description:
						"Anchor an SFX overlay to a SOURCE-time moment (e.g. a punchline word). Pass when startMs was derived from a transcript word's source-time — the overlay re-anchors automatically on subsequent transcript edits. DO NOT pass for background music tracks; those should stay free-floating (they cover a fixed slot of the edited timeline regardless of content edits).",
				},
				anchorSourceEndMs: {
					type: "number",
					description:
						"Optional anchor end (source ms). When set, the overlay's edited duration tracks the source-time span between anchorSourceMs and anchorSourceEndMs.",
				},
				expectedRevision: { type: "number" },
			},
			required: ["audioPath"],
		},
		command: "project.add-audio",
	},
	{
		name: "project_remove_audio",
		description:
			"Remove a background audio overlay by its id. Use project_read to find overlay ids in project.audioOverlays.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				overlayId: {
					type: "string",
					description: "Audio overlay id (e.g. audio-1) from project.audioOverlays",
				},
				expectedRevision: { type: "number" },
			},
			required: ["overlayId"],
		},
		command: "project.remove-audio",
	},
	{
		name: "project_set_clip_lut",
		description:
			"Apply a color-grade LUT preset to a specific clip. Use asset_list_luts to browse available presets. The grade is applied in preview (CSS filter) and export (FFmpeg eq/hue chain). Pass 'none' to clear. Returns { clipId, lutPreset, lutIntensity }.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				clipId: { type: "string", description: "Clip id from project_read mainTrack.clips[n].id" },
				lutPreset: {
					type: "string",
					description:
						"Preset id. none | cinematicTealOrange | cinematicShadowBlue | filmNoir | vintageKodak | modernVibrant | moodyDark | warmSunset | coolNordic | bleachBypass | vintagePolaroid | naturalEnhanced",
				},
				lutIntensity: {
					type: "number",
					description: "Blend strength 0–1. Defaults to 1 (full effect).",
				},
				expectedRevision: { type: "number" },
			},
			required: ["clipId", "lutPreset"],
		},
		command: "project.set-clip-lut",
	},
	{
		name: "project_set_clip_kind",
		description:
			"Stamp a clip's capture origin authoritatively: kind = camera | screen | upload | podcast. project.read returns each clip's kind (your visual-strategy signal: camera → designed segments + emphasis zooms; screen → cursor zooms). On pre-v1.28 projects kind wasn't recorded, so project.read INFERS it (flagged kindInferred:true) — and inference can be wrong. Use this to correct/lock it. `camera` = talking-head; `screen` = screen recording (maybe with webcam PiP); `upload` = imported file; `podcast` = two-speaker composite (host=mediaPath, guest=webcamPath).",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				clipId: { type: "string", description: "Clip id from project_read mainTrack.clips[n].id" },
				kind: { type: "string", enum: ["camera", "screen", "upload", "podcast"] },
				expectedRevision: { type: "number" },
			},
			required: ["clipId", "kind"],
		},
		command: "project.set-clip-kind",
	},
	{
		name: "project_set_webcam_offset",
		description:
			"Fine-tune a podcast composite's guest/host sync. offsetMs shifts the guest (webcamPath) relative to the host: positive delays the guest, negative advances it, 0 clears it (±10000). Honored in preview + export — the guest VIDEO and AUDIO shift together. Use when the two speakers look or sound slightly out of sync.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				clipId: { type: "string", description: "Clip id of the podcast composite" },
				offsetMs: {
					type: "number",
					description: "Guest time nudge in ms (±10000). Positive delays guest; 0 clears.",
				},
				expectedRevision: { type: "number" },
			},
			required: ["clipId", "offsetMs"],
		},
		command: "project.set-webcam-offset",
	},
	{
		name: "project_set_clip_layout",
		description:
			"Set ONE clip's webcam layout — the per-section override for a podcast. preset: podcast | podcast-host-full | podcast-guest-full | picture-in-picture | side-by-side | vertical-stack | none (none clears the override so the clip inherits the project layout). 'podcast-host-full' shows only speaker 1 (host=mediaPath) full-frame; 'podcast-guest-full' shows only speaker 2 (guest=webcamPath). Speaker-driven editing flow: transcript_get returns each word's `speaker` ('host'/'guest') for podcast clips; project_split_clip at the points where the active speaker changes; then call this per section to cut to whoever is talking. Honored in preview + export.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				clipId: { type: "string", description: "Clip id of the section to set" },
				preset: {
					type: "string",
					description:
						"podcast | podcast-host-full | podcast-guest-full | picture-in-picture | side-by-side | vertical-stack | none",
				},
				expectedRevision: { type: "number" },
			},
			required: ["clipId", "preset"],
		},
		command: "project.set-clip-layout",
	},
	{
		name: "project_set_clip_style",
		description:
			"Set ONE clip's framing style — padding, borderRadius (roundness), and/or shadowIntensity (each 0–100) — overriding the project-level values for just that clip. Use in a multi-clip project to frame sources differently: e.g. a full-bleed camera clip (padding 0, borderRadius 0, shadowIntensity 0) next to a padded, rounded podcast clip. Pass a field as null to CLEAR its override (inherit project); omit a field to leave it unchanged. Project-level equivalents are project_set_style. Honored in preview + export.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				clipId: { type: "string", description: "Clip id to style" },
				padding: { type: "number", description: "Padding 0–100; null clears, omit leaves as-is." },
				borderRadius: {
					type: "number",
					description: "Roundness 0–100; null clears, omit leaves as-is.",
				},
				shadowIntensity: {
					type: "number",
					description: "Shadow 0–100; null clears, omit leaves as-is.",
				},
				expectedRevision: { type: "number" },
			},
			required: ["clipId"],
		},
		command: "project.set-clip-style",
	},

	// ── transcript-based editing ────────────────────────────────────
	{
		name: "transcript_transcribe",
		description:
			"Transcribe each clip's audio with word-level timestamps via the bundled Parakeet TDT model. ASYNC — returns { jobId }; call job_wait. After this, transcript_get returns the merged edited-time transcript.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				clipId: { type: "string", description: "Optional - transcribe only this clip" },
			},
		},
		command: "transcript.transcribe",
	},
	{
		name: "transcript_get",
		description:
			"Return the merged transcript. Each word carries BOTH time bases: startMs/endMs are SOURCE time (the raw recording; use for anchorSourceMs), and editedStartMs/editedEndMs are EDITED-timeline time with trims/speeds applied (null = the word sits inside a trim). Read the base you need; no conversion calls required. Word IDs feed transcript_delete_words. For a PODCAST composite, each word also carries `speaker` ('host' = speaker 1 / mediaPath, 'guest' = speaker 2 / webcamPath) — use these spans to drive project_set_clip_layout (cut to whoever is talking).",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
			},
		},
		command: "transcript.get",
	},
	{
		name: "transcript_delete_words",
		description:
			"Delete words from the project — internally translates each word's [startMs, endMs] into a trim region the exporter skips. THIS is the editor's 'click word, hit delete' workflow, callable from MCP.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				wordIds: {
					type: "array",
					items: { type: "string" },
					description: "Word IDs from transcript_get",
				},
				expectedRevision: { type: "number" },
			},
			required: ["wordIds"],
		},
		command: "transcript.delete-words",
	},
	{
		name: "transcript_insert_words",
		description:
			"Add word(s) the transcription MISSED — the counterpart to transcript_find_replace (which only rewrites words that already exist). Speech-to-text sometimes drops a spoken word; this inserts it with plausible timing (fills the gap the drop left, sized to the local speaking rate; borrows a few ms from the previous word when neighbours are flush). Anchor with EITHER afterWordId (insert right after that word — usual) OR beforeWordId (insert right before it — to add at the very start). Word ids come from transcript_get. `text` may be multiple space-separated words. Non-destructive — existing word ids are untouched, so trims/zooms/captions anchored elsewhere are unaffected. Does NOT re-transcribe.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				afterWordId: {
					type: "string",
					description: "Insert immediately AFTER this word id (from transcript_get).",
				},
				beforeWordId: {
					type: "string",
					description:
						"Insert immediately BEFORE this word id (use to add at the very start). Provide exactly one of afterWordId / beforeWordId.",
				},
				text: {
					type: "string",
					description: "The word(s) to insert. Space-separated text inserts multiple words.",
				},
				expectedRevision: { type: "number" },
			},
			required: ["text"],
		},
		command: "transcript.insert-words",
	},
	{
		name: "transcript_restore_words",
		description:
			"Restore previously deleted words — removes the trim region(s) covering them, undoing transcript_delete_words / transcript_remove_fillers / repeat removal. THIS is the editor's 'select struck-through words → Restore' workflow, callable from MCP. Silence-removal trims are left untouched.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				wordIds: {
					type: "array",
					items: { type: "string" },
					description: "Word IDs (from transcript_get) that are currently deleted.",
				},
				expectedRevision: { type: "number" },
			},
			required: ["wordIds"],
		},
		command: "transcript.restore-words",
	},
	{
		name: "transcript_remove_fillers",
		description:
			"Auto-detect filler words and bulk-trim them. By DEFAULT removes only vocalised pauses (um, uh, uhm, umm, hmm, hm) — sounds with no lexical meaning, so removing every occurrence never breaks a sentence. Pass aggressive=true to ALSO catch lexical-word fillers (like, you know, i mean, sort of, kind of); these can false-positive on legitimate uses ('I like this template' loses 'like'), so the agent should only opt in when the user explicitly asks for a thorough cleanup. Also strips immediately-repeated words ('the the') unless includeRepeats=false.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				aggressive: {
					type: "boolean",
					description:
						"Include lexical-word fillers (like, you know, i mean, sort of, kind of) in addition to vocalised pauses. False positives possible on legitimate uses. Default false.",
				},
				includeRepeats: { type: "boolean", description: "Default true" },
				expectedRevision: { type: "number" },
			},
		},
		command: "transcript.remove-fillers",
	},
	{
		name: "transcript_search",
		description:
			"Find every occurrence of a phrase in the merged transcript. Returns matches with their word IDs.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				query: { type: "string" },
			},
			required: ["query"],
		},
		command: "transcript.search",
	},
	{
		name: "transcript_find_issues",
		description:
			"Scan the transcript for editorial problems the speaker created and recovered from: **duplicate-take** (a line re-recorded later — keep the cleaner second take, cut the first), **false-start** (an abandoned fragment before a restart), and **adjacent-repeat** (a stutter like 'the the'). Returns candidate `issues`, each with `type`, `severity`, the `wordIds` of the DISCARDED attempt (pass straight to transcript.delete-words), the edited-time span, the offending `text`, and a `note` explaining what's kept. CONSERVATIVE and read-only — it never edits. Deliberate parallel structure ('one for transcription, one for outreach') is NOT flagged as a false start, and lone stopword repeats across pause tokens are skipped. A `severity: \"low\"` false-start is a REVIEW candidate (the restart diverges from the fragment — possibly an intentional list): KEEP it by default unless context clearly shows a flubbed take. Review every candidate against context before deleting. Run this after transcribe + remove-fillers as the content-cleanup pass. Filter with `types` (comma-separated) and cap with `limit`.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				types: {
					type: "string",
					description:
						"Optional comma-separated filter: any of `duplicate-take`, `false-start`, `adjacent-repeat`. Omit for all.",
				},
				limit: { type: "number", description: "Optional max number of issues to return." },
			},
		},
		command: "transcript.find-issues",
	},
	{
		name: "transcript_find_replace",
		description:
			"Find every occurrence of a phrase in the transcript and replace it with new text. Useful for correcting mis-transcribed names, technical terms, or brand names without re-transcribing. Timing is preserved — only the displayed/exported text changes. Returns { replacedCount, wordsPatched }; replacedCount is 0 if the phrase wasn't found.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				find: {
					type: "string",
					description:
						'Phrase to search for. Case-insensitive; punctuation is ignored. Digits are SIGNIFICANT when the phrase contains them ("try30" matches only the token "try30") and ignored otherwise ("than" also matches "than60"). A multi-word phrase also matches a single merged STT token ("Wispr Flow" as one token; "of $499" matches "of$499"), and a phrase equal to a token\'s raw text always matches — so space/digit/punctuation-bearing tokens (even pure numbers like "30%") are all targetable.',
				},
				replace: { type: "string", description: "Replacement text (replaces the whole phrase)" },
				expectedRevision: { type: "number" },
			},
			required: ["find", "replace"],
		},
		command: "transcript.find-replace",
	},
	{
		name: "transcript_remove_silences",
		description:
			"Detect and trim silent sections — the SAME two passes as the UI Remove Silences button, unioned: (1) transcript word-gaps (leading, inter-word, trailing) longer than `thresholdMs`; (2) ffmpeg audio-level silencedetect on each clip's media, catching real dead air the transcript misses (speech-to-text invents phantom words over quiet stretches). Bulk-creates trim regions. Returns { removedCount, totalTrimmedMs, audioDetectionFailed }.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				thresholdMs: {
					type: "number",
					description:
						"Gaps longer than this are trimmed. Default 500ms — same threshold as the UI Remove Silences button, so the agent removes the same silences a manual click would.",
				},
				expectedRevision: { type: "number" },
			},
		},
		command: "transcript.remove-silences",
	},

	// ── audio ───────────────────────────────────────────────────────
	{
		name: "audio_clean",
		description:
			"Run DeepFilter denoising on each clip's audio. ASYNC. Writes a sibling .cleaned.wav and points clip.cleanedAudioPath at it; export auto-uses it.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				clipId: { type: "string", description: "Optional - clean only this clip" },
			},
		},
		command: "audio.clean",
	},

	// ── captions ────────────────────────────────────────────────────
	{
		name: "caption_toggle",
		description: "Enable or disable captions for the whole project. Requires transcript first.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				enabled: { type: "boolean" },
				expectedRevision: { type: "number" },
			},
			required: ["enabled"],
		},
		command: "caption.toggle",
	},
	{
		name: "caption_set_template",
		description:
			"Pick a caption template: classic, modern, minimal, bold, spotlight, boxed, neon, colored, or editorial. `editorial` is a magazine-emphasis style: the word being spoken right now renders large (and takes an accent color) while the rest of the line shrinks, so one big word sweeps across the line in time with the speech.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				templateId: {
					type: "string",
					enum: [
						"classic",
						"modern",
						"minimal",
						"bold",
						"spotlight",
						"boxed",
						"neon",
						"colored",
						"editorial",
					],
				},
				expectedRevision: { type: "number" },
			},
			required: ["templateId"],
		},
		command: "caption.set-template",
	},

	{
		name: "caption_set_style",
		description:
			"Override specific style properties of the caption overlay without changing the template. All fields are optional — pass only what you want to change. positionY controls vertical placement in PERCENT of frame height (0=top, 100=bottom, default 85; a 0-1 fraction like 0.85 is auto-converted to percent). fontFamily sets the caption font (a system font like 'Georgia' or a loaded custom font; unloaded fonts fall back). fontSize is in REM (e.g. '2.6rem'), matching the editor's Font size slider; it is clamped to 1.0–5.0rem (a px value is converted to rem), so you can't exceed the editor's max.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				wordsPerLine: {
					type: "number",
					description: "Max words shown at once. Default varies by template.",
				},
				positionY: {
					type: "number",
					description:
						"Vertical position as percent of frame height from the top (0-100). Default 85. Fractions \u2264 1.0 (e.g. 0.85) are treated as 0-1 and converted to percent.",
				},
				fontFamily: {
					type: "string",
					description:
						"Caption font family, e.g. 'Inter', 'Georgia', or a loaded custom font name. Fonts not loaded in the app fall back to a system default.",
				},
				color: { type: "string", description: "Caption text color (hex/CSS)" },
				backgroundColor: { type: "string", description: "Caption background color" },
				highlightColor: {
					type: "string",
					description: "Color of the currently-spoken word highlight",
				},
				highlightBackgroundColor: {
					type: "string",
					description: "Background of the currently-spoken word",
				},
				strokeColor: { type: "string", description: "Text stroke/outline color" },
				strokeWidth: { type: "number", description: "Text stroke width in px" },
				fontSize: {
					type: "string",
					description:
						"Font size in REM, e.g. '2.6rem'. Clamped to 1.0–5.0rem (the editor's slider range).",
				},
				uppercase: {
					type: "boolean",
					description:
						"Force ALL-CAPS caption text. true uppercases every caption word; false restores the template's own casing (use false to turn OFF a template that ships uppercase, e.g. 'editorial').",
				},
				expectedRevision: { type: "number" },
			},
		},
		command: "caption.set-style",
	},

	// ── motion graphics ─────────────────────────────────────────────
	// `motion_list`, `motion_themes`, and `motion_generate` were
	// removed in v1.31.0. Those bundled-template tools are for the
	// in-app Gemma E2B local model (which can't author HTML); they
	// were never on the agent's surface from a product standpoint
	// but the MCP schema previously exposed them, and the mere
	// presence of `motion_generate` in the tool list lured agents
	// into picking it over the architecturally-correct
	// `motion_render_html`. The bundled templates use flat
	// solid-color backgrounds and CSS keyframes — they don't meet
	// the aesthetic baseline (the Hyperframes example gallery)
	// that agents are expected to clear. Removing the tools
	// eliminates the temptation. Agents now author HTML directly.
	{
		name: "media_generate_image",
		description:
			'Generate a single image via Replicate gpt-image-2 — for B-roll, concept stills, reference frames. Project-agnostic; writes to <userData>/generated-images/ and returns { imagePath, prompt, aspectRatio, predictionId }. The canonical B-roll workflow is: media_generate_image → motion_render_html (Ken-Burns + vignette wrap to a WebM) → project_add_motion_graphic — see SKILL.md "B-roll generation". Aspect ratios are gpt-image-2 native (1:1 / 3:2 / 2:3). For 16:9 video B-roll, generate 3:2 and crop in the wrap; for 9:16, generate 2:3. Requires the user\'s Replicate API key (Settings → Integrations).',
		inputSchema: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description:
						"Image-gen prompt. Be visual: lighting, framing, palette, mood. Avoid mentioning text overlays — those land better via the motion-graphic wrap.",
				},
				aspectRatio: {
					type: "string",
					description: "'1:1' | '3:2' (default) | '2:3'.",
				},
				quality: {
					type: "string",
					description: "'low' (~½ cost, good for iteration) | 'medium' (default) | 'high'.",
				},
				referenceImagePath: {
					type: "string",
					description:
						"Optional reference image — absolute path or https URL — for style transfer / continuity across multiple B-roll stills.",
				},
				outputName: {
					type: "string",
					description: "Optional file-stem hint. Slugified; timestamp appended automatically.",
				},
			},
			required: ["prompt"],
		},
		command: "media.generate-image",
	},
	{
		name: "media_generate_narration",
		description:
			"Generate a voiceover / narration audio clip. Project-agnostic; writes audio to <userData>/narration/ and returns { audioPath, durationMs, model, voice, predictionId }. Canonical workflow: media_generate_narration → project_add_audio (place at startMs, pass the returned durationMs so the overlay is sized to the speech). DEFAULT is the LOCAL, on-device Kokoro engine (English) — no API key, no cloud, runs on the user's machine; the model auto-downloads (~330 MB) on first use. Kokoro voices (pass in `voice`): af_heart (default), af_bella, am_michael, bf_emma, bm_george, etc. (a*=American, b*=British; f=female, m=male). To use CLOUD TTS instead (more voices/languages, needs the user's Replicate key), set `model` to a Replicate model: 'elevenlabs-v3' (most expressive — embed inline tags like [excited]/[whispers]) | 'gemini-flash-tts' (30 voices, multilingual, 'style' sets tone) | 'minimax-turbo' (fast, 'style' maps to an emotion, 'speed' 0.5-2). Cloud voices — gemini Kore/Puck/Charon; minimax Friendly_Person/Wise_Woman. Omit `model` to honour the workspace default (system_get_narration_engine).",
		inputSchema: {
			type: "object",
			properties: {
				text: {
					type: "string",
					description:
						"The script to speak. For the cloud elevenlabs-v3 model you can embed delivery tags inline, e.g. 'Welcome [excited] to the future of editing.' (Local Kokoro ignores such tags.)",
				},
				model: {
					type: "string",
					description:
						"Engine/model selector. Omit for the workspace default (local Kokoro). 'kokoro-local' forces on-device English. Cloud (needs Replicate key): 'elevenlabs-v3' | 'gemini-flash-tts' | 'minimax-turbo'.",
				},
				voice: {
					type: "string",
					description:
						"Voice for the chosen engine. Local Kokoro: af_heart/af_bella/am_michael/bf_emma/bm_george/... Cloud: gemini Kore/Puck/...; minimax Friendly_Person/... Omit for the engine's default voice.",
				},
				language: {
					type: "string",
					description:
						"Optional BCP-47 language hint for the cloud models, e.g. 'en-US', 'es-ES'. Local Kokoro is English-only and ignores this.",
				},
				style: {
					type: "string",
					description:
						"Optional tone/emotion hint (e.g. 'warm and upbeat'). Maps to Gemini's style prompt and MiniMax's emotion enum.",
				},
				speed: {
					type: "number",
					description: "Optional playback speed for MiniMax (0.5-2, 1 = normal).",
				},
			},
			required: ["text"],
		},
		command: "media.generate-narration",
	},
	{
		name: "media_generate_music",
		description:
			"Generate an original instrumental background-music track via Replicate (Google Lyria-2). Project-agnostic; writes audio to <userData>/generated-music/ and returns { audioPath, durationMs, model, predictionId }. Canonical workflow: media_generate_music → project_add_audio (place at startMs, pass the returned durationMs so the overlay is sized). The bundled library (asset_list_music) is the faster default for common moods — reach for generation when the user wants something specific/custom the library doesn't cover. Describe the music in `prompt` (genre, mood, instruments, tempo, use-case). Lyria-2 is instrumental only (~30s clips, 48kHz stereo) — loop for longer videos. Requires the user's Replicate API key (Settings → Integrations).",
		inputSchema: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description:
						"What the music should sound like — genre, mood, instruments, tempo, use-case. e.g. 'upbeat lo-fi hip hop with mellow piano, relaxed, for a coding montage'.",
				},
				negativePrompt: {
					type: "string",
					description: "Optional — qualities to steer AWAY from, e.g. 'vocals, drums, harsh'.",
				},
				seed: {
					type: "number",
					description: "Optional integer seed for reproducible output.",
				},
			},
			required: ["prompt"],
		},
		command: "media.generate-music",
	},
	// `motion_generate` removed in v1.31.0 — see comment above the
	// motion-graphics section.
	{
		name: "motion_list",
		description:
			"List motion-graphic building blocks. Returns two arrays. `templates`: the slot-parameterized bundled templates — each has id, name, description, style, tags, aspectRatios, durationMs, `overlay`, and `slots` (key, type: string|color|list, label, default); render with motion_generate. `registryBlocks`: standalone Hyperframes compositions (animated captions, shader transitions, data-viz, social cards, code themes, VFX) — each has name, kind, title, description, tags, durationMs, dimensions, and `htmlPath`; these have NO slots, so render the htmlPath directly with motion_render_html and edit the HTML if you need different text. Prefer a `template` when one fits (it's parameterized); reach into `registryBlocks` for captions/transitions/data-viz the templates don't cover.",
		inputSchema: { type: "object", properties: {} },
		command: "motion.list",
	},
	{
		name: "motion_generate",
		description:
			"Render a bundled template by id with your own slot values (text, colors, list items) and a background mode, then add the result to the timeline with project_add_motion_graphic (or project_add_designed_segment for split-panel). Async — returns { jobId, outputPath }; call job_wait, then pass that jobId as `fromJob` to the add tool. Discover templates + slots with motion_list. Prefer this over motion_render_html whenever a bundled template fits the brief — it's faster and already designed. The same automatic quality gates as motion_render_html apply (pre-render contract lint; STATIC_RENDER on frozen output).",
		inputSchema: {
			type: "object",
			properties: {
				templateId: {
					type: "string",
					description:
						"Template id from motion_list (e.g. creator-card, stat-reveal, split-panel).",
				},
				slots: {
					type: "object",
					description:
						"Editable values keyed by slot key (see motion_list / the SKILL catalog): text strings, color hex strings, or list arrays. An 'image'-typed slot (see its `type` in motion_list) takes an ABSOLUTE FILE PATH to an image — the server stages the file into the render, so you can pass a project-media path or a generated image (e.g. from media_generate_image). Omitted slots fall back to the template default.",
				},
				aspectRatio: {
					type: "string",
					enum: ["16:9", "9:16", "1:1"],
					description: "Defaults to the template's first listed aspect.",
				},
				background: {
					type: "string",
					enum: ["solid", "transparent", "glass"],
					description:
						"'solid' = hard full-frame card. 'transparent' = alpha; camera shows through un-painted pixels. 'glass' = alpha + frosted blur of the camera behind the content (then set backdropBlurStrength on project_add_motion_graphic). Omit to use the template's natural mode — overlay templates (split-panel, lower thirds, grain/3D/shatter/parallax titles) default to transparent, opaque cards to solid. Don't force 'solid' on an overlay template — its see-through half turns black.",
				},
				outputName: { type: "string", description: "Optional filename stem (no extension)." },
			},
			required: ["templateId", "slots"],
		},
		command: "motion.generate",
	},
	// Video templates ("storyboards") — multi-scene, parameterized videos that
	// render several templates and concatenate them into one finished clip.
	{
		name: "motion_list_storyboards",
		description:
			"List the bundled VIDEO templates (storyboards). Unlike single-scene templates (motion_list), a storyboard is a whole short video: an ordered set of scenes plus a `params` brief you fill in once. Returns each storyboard's id, name, audience (youtube|podcaster|course), description, aspectRatios, and `params` (the brief: key, label, type string|color|asset, required, default — color params default to the workspace brand kit via brand.* sentinels). Use a storyboard when the user wants a finished intro/outro/episode-open/lesson-open rather than a single overlay. Render one with motion_generate_storyboard.",
		inputSchema: { type: "object", properties: {} },
		command: "motion.list-storyboards",
	},
	{
		name: "motion_generate_storyboard",
		description:
			"Render a multi-scene VIDEO template (storyboard) by id. Fill the brief via `params`; missing color params fall back to the workspace brand kit, missing required text params fail fast. The server renders each scene and concatenates them into one MP4. Async — returns { jobId, outputPath, sceneCount }; call job_wait, then pass that jobId as `fromJob` to project_add_motion_graphic. Discover storyboards + their params with motion_list_storyboards.",
		inputSchema: {
			type: "object",
			properties: {
				storyboardId: {
					type: "string",
					description:
						"Storyboard id from motion_list_storyboards (e.g. youtube-creator-intro, podcast-episode-open, course-lesson-open).",
				},
				params: {
					type: "object",
					description:
						"The brief, keyed by param key (see motion_list_storyboards). Text and color values. Omitted color params fall back to the workspace brand kit; omitted required text params cause a fast failure.",
				},
				aspectRatio: {
					type: "string",
					enum: ["16:9", "9:16", "1:1"],
					description: "Defaults to the storyboard's first listed aspect.",
				},
				outputName: { type: "string", description: "Optional filename stem (no extension)." },
			},
			required: ["storyboardId"],
		},
		command: "motion.generate-storyboard",
	},
	// Custom HTML authoring path is `motion_render_html` (for briefs no
	// bundled template fits).
	{
		name: "motion_render_html",
		description:
			"Render arbitrary HTML/CSS/JS to video via the HyperFrames engine — frame-perfect, seekable capture through chrome-headless-shell's BeginFrame API. Use this when the bundled motion-graphic templates don't fit the brief. The HTML MUST expose a paused GSAP timeline registered as `window.__timelines[<data-composition-id>] = tl` — NOT CSS keyframes, NOT setTimeout, NOT `window.__hf.seek` (that lower-level protocol skips the compositor invalidation wrapper and renders with 1-second stalls). See the SKILL.md `Custom motion graphics — HTML authoring` section for the required `data-composition-id`/`data-width`/`data-height`/`data-duration` root element, the canonical template, and pacing rules. Pass either inline `html` or `htmlPath`. Set `transparent: true` for a WebM+alpha overlay (lower thirds, watermarks). Renders queue automatically and execute serially in submission order — fire multiple renders back-to-back without waiting, then job_wait each. RENDER_BUSY appears only past a 16-deep runaway ceiling. Two automatic quality gates apply: a pre-render lint rejects contract violations (unpaused timeline, repeat:-1, Math.random, missing __timelines registration, shadow/blur radii over 500px), and a post-render check fails any clip frozen for 90%+ of its duration with STATIC_RENDER (fix the composition; never place a gated clip). Async — returns { jobId, outputPath }; poll job_wait for the final file.",
		inputSchema: {
			type: "object",
			properties: {
				html: {
					type: "string",
					description: "Inline HTML string (mutually exclusive with htmlPath).",
				},
				htmlPath: {
					type: "string",
					description: "Absolute path to .html file (mutually exclusive with html).",
				},
				aspectRatio: {
					type: "string",
					description: "16:9 (default) | 9:16 | 1:1. Ignored if width+height supplied.",
				},
				width: { type: "number" },
				height: { type: "number" },
				durationMs: { type: "number", description: "How long to capture. Default 2500." },
				frameRate: { type: "number", description: "Default 30." },
				outputName: { type: "string", description: "Optional filename stem." },
				audioPath: {
					type: "string",
					description:
						"Absolute path to an audio file (mp3, wav, aac, m4a) to mux into the MP4. Without this the output is silent. Ignored when transparent: true.",
				},
				audioVolume: {
					type: "number",
					description: "Volume multiplier for audioPath. Range 0–2. Default 1.0.",
				},
				assets: {
					type: "array",
					items: { type: "string" },
					description:
						'Absolute paths to local files to stage alongside inline HTML. Reference them by basename: pass ["/path/logo.png"] and use <img src="logo.png"> in the HTML. Avoids base64-encoding large images.',
				},
				transparent: {
					type: "boolean",
					description:
						"Render with a transparent background (VP9/yuva420p WebM instead of H.264 MP4). Use for overlays — lower thirds, watermarks, bug logos, name plates — anything that composites on top of existing video without a white/black fill. The returned outputPath will have a .webm extension. Note: audioPath is ignored in transparent mode.",
				},
			},
		},
		command: "motion.render-html",
	},
	{
		name: "motion_screenshot",
		description:
			"Capture a single PNG frame of an HTML composition at a given timestamp — no FFmpeg, sub-second. Use BEFORE committing to a full motion_render_html render to validate layout, fonts, brand colors, element positions. Returns { outputPath, previewPath, width, height }. `outputPath` is the full-res 1920×1080 PNG (user-facing artifact, keep on disk). `previewPath` is a 1280-wide downscaled sidecar — `read` THIS for vision-based verification (~600KB base64, processes in seconds). The full-res file is too big for most vision-model context to chew on quickly (a 1920×1080 PNG base64-encodes to ~2.1MB and stalls vision models for minutes). If `previewPath` is absent (source already ≤1280px wide), `read` outputPath directly. If your model isn't vision-capable, skip the `read` and surface outputPath to the user instead.",
		inputSchema: {
			type: "object",
			properties: {
				html: {
					type: "string",
					description: "Inline HTML string (mutually exclusive with htmlPath).",
				},
				htmlPath: {
					type: "string",
					description: "Absolute path to .html file (mutually exclusive with html).",
				},
				aspectRatio: {
					type: "string",
					description: "16:9 (default) | 9:16 | 1:1. Ignored if width+height supplied.",
				},
				width: { type: "number" },
				height: { type: "number" },
				atMs: {
					type: "number",
					description:
						"Milliseconds into the animation to screenshot. Waits this long after page load. Default 0 (first visible frame). Max 30000. Use e.g. 2000 to preview the animation mid-way.",
				},
				assets: {
					type: "array",
					items: { type: "string" },
					description:
						"Absolute paths to local files to stage alongside inline HTML — same as motion_render_html.",
				},
				outputName: { type: "string", description: "Optional PNG filename stem." },
			},
		},
		command: "motion.screenshot",
	},
	{
		name: "motion_concat",
		description:
			"Concatenate multiple MP4s into one final video using a lossless stream copy (no re-encode — fast). All clips must share the same resolution and codec; all motion_render_html outputs qualify automatically. Use this after rendering individual scenes to assemble the final promo. Returns { outputPath, clipCount } directly.",
		inputSchema: {
			type: "object",
			required: ["clips"],
			properties: {
				clips: {
					type: "array",
					items: { type: "string" },
					description:
						"Ordered array of absolute paths to MP4 files to join. Minimum 2. The output plays them in the order given.",
				},
				outputName: { type: "string", description: "Optional filename stem for the output MP4." },
			},
		},
		command: "motion.concat",
	},
	{
		name: "motion_verify_frames",
		description:
			"Extract PNG frames at given timestamps from a rendered video for visual verification. Operationalises the 'lint passing ≠ design working — VIEW THE FRAMES' rule in reference/motion-philosophy.md. Call after motion_render_html or export.start before declaring a motion-graphics deliverable done. Pass either entryId (export-library entry) or videoPath (arbitrary MP4). Timestamps in seconds, typically 8-15 across hero moments. Returns { frames: [{ timestampSeconds, path, previewPath, previewWidth, previewHeight }, ...] }. For vision-capable models: `read` the `previewPath` of each frame (1280-wide, ~600KB base64, fast). The full-res `path` would be ~2MB base64 and stall the model for minutes. For non-vision models: skip the `read` and surface outDir to the user. Confirm: no cropped faces / text overflow / blank frames / forbidden-zone occlusion / flat-white headlines.",
		inputSchema: {
			type: "object",
			required: ["timestamps"],
			properties: {
				entryId: {
					type: "string",
					description:
						"Export library entry id. Mutually exclusive with videoPath — one must be provided.",
				},
				videoPath: {
					type: "string",
					description:
						"Absolute path to an MP4 (e.g. a motion.render-html intermediate output). Mutually exclusive with entryId.",
				},
				timestamps: {
					type: "array",
					items: { type: "number" },
					description:
						"Timestamps in seconds to extract frames at (e.g. [0.5, 1.5, 3.0, 5.0, 7.5, 10.0, 12.5, 15.0]). Max 30 per call.",
				},
				outputName: {
					type: "string",
					description:
						"Optional subdir stem for the output PNGs. Defaults to verify-<rand>. Frames land in RECORDINGS_DIR/<stem>/frame-<ms>.png.",
				},
			},
		},
		command: "motion.verify-frames",
	},

	// ── assets ──────────────────────────────────────────────────────
	{
		name: "asset_list_sounds",
		description: "List every bundled sound effect (id, name, category, absolute path).",
		inputSchema: { type: "object", properties: {} },
		command: "asset.list-sounds",
	},
	{
		name: "asset_list_fx",
		description:
			"List every bundled FX video overlay (id, title, blendMode, defaults, absolute path).",
		inputSchema: { type: "object", properties: {} },
		command: "asset.list-fx",
	},
	{
		name: "asset_list_transitions",
		description:
			"List every bundled transition (id, title, category, durationSeconds). Use the id with project_add_transition, centered on a cut.",
		inputSchema: { type: "object", properties: {} },
		command: "asset.list-transitions",
	},
	{
		name: "asset_list_music",
		description:
			"List every bundled background music track. Each track has: id, title, category, mood, durationMs, absolutePath, and agent-routing hints `intents` (e.g. product_video, kinetic_text, promo, intro, outro, tech_review, vlog, generic) and `recommendedFor` (youtube-long | shorts | linkedin | loom). Match on intents first when picking a track — use mood/category as tiebreakers. Use absolutePath with project_add_audio to attach a track to a project.",
		inputSchema: { type: "object", properties: {} },
		command: "asset.list-music",
	},
	{
		name: "asset_list_luts",
		description:
			"List all available LUT color-grade presets (id, label, category). Pass the id to project_set_clip_lut. Categories: natural | cinematic | dramatic | vintage | modern.",
		inputSchema: { type: "object", properties: {} },
		command: "asset.list-luts",
	},

	// ── project-aware LLM ──────────────────────────────────────────
	{
		name: "llm_generate_title",
		description:
			"Generate a YouTube-ready title from the project's merged transcript using the bundled local LLM.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				maxChars: { type: "number", description: "Default 70" },
			},
		},
		command: "llm.generate-title",
	},
	{
		name: "llm_generate_description",
		description: "Generate a YouTube description (3-5 sentences) from the merged transcript.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				maxChars: { type: "number", description: "Default 400" },
			},
		},
		command: "llm.generate-description",
	},
	{
		name: "llm_generate_caption",
		description:
			"Generate an Instagram Reel caption (1-3 punchy sentences + a few hashtags) from the merged transcript, on the local model. Feed the result into export_publish_instagram's caption.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				maxChars: { type: "number", description: "Default 2200" },
			},
		},
		command: "llm.generate-caption",
	},
	{
		name: "llm_generate_timestamps",
		description: "Generate YouTube-style chapter timestamps from the merged transcript.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				maxChapters: { type: "number", description: "Default 8" },
			},
		},
		command: "llm.generate-timestamps",
	},

	// ── export (the centerpiece) ────────────────────────────────────
	{
		name: "export_start",
		description:
			"Render the project to MP4 via the same Tier-3 PixiJS pipeline the editor's Export Video button uses (v1.24+ — convergence release). When an editor window is already open on the target project, the agent reuses it. Otherwise the agent spawns a hidden editor window for the duration of the render and closes it after. ASYNC — returns { jobId, outputPath }; call job_wait. Honours every region/style/caption/FX/motion-graphic in the project. Video overlays (motion graphics added via project_add_motion_graphic) — opaque MP4 and transparent WebM/VP9+alpha — composite inline in the export pipeline; no extra call needed.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				outputPath: {
					type: "string",
					description: "Where to write the MP4. Default: recordings dir",
				},
				quality: { type: "string", description: "draft | standard | high | ultra. Default high" },
			},
		},
		command: "export.start",
	},
	{
		name: "export_list",
		description: "List every entry in the export library, newest-first.",
		inputSchema: { type: "object", properties: {} },
		command: "export.list",
	},
	{
		name: "export_set_details",
		description:
			"Set an export's YouTube-facing details — title, description, and/or chapter timestamps (the fields in the export's Content tab). Pass only what you want to change. Call this when the user asks to update the title/description of an export. `id` is the export-library entry id; when the user is on the export page it is available to the agent as exportPage.entryId in the editor context (else call export_list to find it).",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Export-library entry id." },
				title: { type: "string", description: "New video title." },
				description: { type: "string", description: "New video description." },
				timestamps: {
					type: "array",
					description:
						"Chapter timestamps as an array of { timeMs, label } objects, sorted ascending. Omit to leave unchanged.",
					items: {
						type: "object",
						properties: {
							timeMs: { type: "number" },
							label: { type: "string" },
						},
					},
				},
			},
			required: ["id"],
		},
		command: "export.set-details",
	},
	{
		name: "export_generate_thumbnail",
		description:
			"Generate a YouTube thumbnail for an export-library entry via Replicate's gpt-image-2 model (3:2, photorealistic, high contrast, mobile-readable). Two ways to drive it: (1) pass `subject` (the topic-relevant hero image, 4-10 words) + `hook` (2-4 word overlay) and optionally `reaction`/`layout` — the prompt is assembled deterministically, no transcript needed; or (2) omit them and the local LLM suggests subject/hook/reaction/layout from the transcript. `prompt` overrides everything with a verbatim prompt. `referenceImagePath` is the person's face (passed as input_images). Requires the user's Replicate API key (Settings → Integrations; stored encrypted). Returns { imagePath, prompt, iterations }.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Export entry id." },
				subject: {
					type: "string",
					description:
						"The topic-relevant hero image, described concretely (4-10 words), e.g. 'a phone showing a first $79 Stripe sale'. When set, no transcript/LLM is needed.",
				},
				hook: {
					type: "string",
					description: "2-4 word overlay text (auto-uppercased), e.g. 'FIRST SALE'.",
				},
				reaction: {
					type: "string",
					description:
						"Facial reaction: excitement (default) | shock | delight | awe | curiosity | pride | determination | relief.",
				},
				layout: {
					type: "string",
					description:
						"Composition: reaction-split (default) | subject-hero | before-after | big-face | product-only | versus.",
				},
				prompt: {
					type: "string",
					description: "Optional verbatim prompt. Overrides subject/hook/reaction/layout entirely.",
				},
				referenceImagePath: {
					type: "string",
					description:
						"Optional reference person image (absolute path or https URL) passed as gpt-image-2 `input_images`.",
				},
				quality: {
					type: "string",
					description: "gpt-image-2 quality. 'low' | 'medium' (default) | 'high'.",
				},
			},
			required: ["id"],
		},
		command: "export.generate-thumbnail",
	},
	{
		name: "export_edit_thumbnail",
		description:
			"Iterate on the existing thumbnail via natural-language edit prompt ('make it more red', 'add bold text at top', 'remove the logo'). The current thumbnail is passed to gpt-image-2 as input_images, and the result replaces it. The previous thumbnail is pushed onto `entry.thumbnailIterations` so the user can revert. Quality is fixed at 'low' on edits — fast and cheap, suitable for rapid iteration.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Export entry id." },
				editPrompt: {
					type: "string",
					description: "What to change. One-sentence natural-language instruction.",
				},
			},
			required: ["id", "editPrompt"],
		},
		command: "export.edit-thumbnail",
	},
	{
		name: "export_set_thumbnail",
		description:
			"Attach a manually-chosen image file (PNG / JPEG / WebP) as the thumbnail. Use this when the user provides a ready-made image, or when an agent has already generated one elsewhere. Copies the file into the managed thumbnails directory; iteration history is cleared. Prefer `export.generate-thumbnail` for AI-generated thumbnails so iteration history is preserved.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Export entry id." },
				sourcePath: {
					type: "string",
					description: "Absolute path to the local image file (PNG / JPEG / WebP).",
				},
			},
			required: ["id", "sourcePath"],
		},
		command: "export.set-thumbnail",
	},
	{
		name: "export_clear_thumbnail",
		description: "Remove the current thumbnail and wipe its iteration history.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Export entry id." },
			},
			required: ["id"],
		},
		command: "export.clear-thumbnail",
	},
	{
		name: "export_revert_thumbnail",
		description:
			"Revert to a previous thumbnail from the iteration history (`entry.thumbnailIterations[].id`). The current image gets pushed onto history, so the revert itself is undoable.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Export entry id." },
				iterationId: {
					type: "string",
					description: "id of the iteration entry from `entry.thumbnailIterations`.",
				},
			},
			required: ["id", "iterationId"],
		},
		command: "export.revert-thumbnail",
	},

	// ── preview overlay (v1.9.2) ────────────────────────────────────
	{
		name: "preview_show",
		description:
			"Pop up a small floating, always-on-top window showing the project's live preview. ~1-2s boot. Singleton — second call reuses the window. Lets you show the user what you just did without them leaving the chat.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				atMs: { type: "number", description: "Start playhead here. Default 0" },
				autoplay: { type: "boolean", description: "Default true" },
			},
		},
		command: "preview.show",
	},
	{
		name: "preview_seek",
		description: "Move the open preview overlay's playhead.",
		inputSchema: {
			type: "object",
			properties: { atMs: { type: "number" } },
			required: ["atMs"],
		},
		command: "preview.seek",
	},
	{
		name: "preview_hide",
		description: "Close the preview overlay.",
		inputSchema: { type: "object", properties: {} },
		command: "preview.hide",
	},

	// ── async jobs ─────────────────────────────────────────────────
	{
		name: "job_cancel",
		description:
			"Cancel a running or queued job. Idempotent — already-terminal jobs are returned as-is.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Job id" },
			},
			required: ["id"],
		},
		command: "job.cancel",
	},
	{
		name: "job_wait",
		description:
			"Block server-side until an async job (transcribe, audio_clean, motion_render_html, export_start) reaches a terminal state. Default timeout 5 minutes, hard cap 30 minutes. Returns `{ job, timedOut: true }` when the deadline elapses with the job still running — this is NOT a failure; re-call job_wait with the same id to keep polling. The job continues regardless of whether anyone is waiting on it. Always call this after kicking off async work.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Job id from the async tool's response" },
				timeoutMs: {
					type: "number",
					description:
						"Max wait in ms. Default 300_000 (5 min). Hard-capped at 1_800_000 (30 min). Don't fight the cap — if a render legitimately needs longer, re-call job_wait with the same id once it returns timedOut.",
				},
			},
			required: ["id"],
		},
		command: "job.wait",
	},
	{
		name: "job_get",
		description: "Snapshot a job's current status + progress + result without blocking.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
		},
		command: "job.get",
	},

	// ── timeline helpers ────────────────────────────────────────────
	{
		name: "timeline_source_to_edited",
		description:
			"Convert source-time ms to edited-timeline ms, accounting for trims and speed regions. Returns null if inside a trimmed region.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				path: { type: "string" },
				sourceMs: { type: "number", description: "Source-time position in ms" },
			},
			required: ["sourceMs"],
		},
		command: "timeline.source-to-edited",
	},

	// ── escape hatch ────────────────────────────────────────────────
	{
		name: "pandastudio_call",
		description:
			"Generic dispatch — call ANY verb.noun including ones added to PandaStudio after this MCP server version shipped. Use system_list_commands first to discover available commands. Args object is passed through unchanged.",
		inputSchema: {
			type: "object",
			properties: {
				command: { type: "string", description: "verb.noun, e.g. project.split-clip" },
				args: { type: "object", description: "Arguments object" },
			},
			required: ["command"],
		},
		command: null, // handled specially in dispatch
	},
];

// ── MCP server boot ───────────────────────────────────────────────────

const server = new Server(
	{
		name: "pandastudio",
		version: "1.73.0",
	},
	{
		capabilities: {
			tools: {},
		},
	},
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
	return {
		tools: TOOLS.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
		})),
	};
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const tool = TOOLS.find((t) => t.name === request.params.name);
	if (!tool) {
		return {
			content: [{ type: "text", text: `unknown tool: ${request.params.name}` }],
			isError: true,
		};
	}

	const args = request.params.arguments ?? {};
	let command;
	let dispatchArgs;

	if (tool.name === "pandastudio_call") {
		// Escape hatch — caller supplies command + args directly
		command = args.command;
		dispatchArgs = args.args ?? {};
		if (typeof command !== "string" || !command.includes(".")) {
			return {
				content: [
					{ type: "text", text: "pandastudio_call requires `command` of the form 'verb.noun'" },
				],
				isError: true,
			};
		}
	} else {
		command = tool.command;
		dispatchArgs = args;
	}

	try {
		const result = await callPandastudio(command, dispatchArgs);
		// Format the response for the MCP client. Default is a text
		// block carrying the JSON result. For `motion.screenshot` and
		// `motion.verify-frames` we ALSO inline the downscaled preview
		// PNGs as MCP image content blocks — vision-capable models see
		// them directly in the tool result, so the agent doesn't have
		// to issue a separate `read` call and we don't depend on
		// opencode's read tool routing binary correctly. Inlining a
		// ~160KB preview adds ~210KB base64 to the response, which is
		// trivial vs the seconds-vs-minutes vision-processing gap we
		// were trying to close.
		const content = [
			{
				type: "text",
				text: JSON.stringify(result, null, 2),
			},
		];
		try {
			const data = result?.data ?? result;
			const previews = collectInlinePreviewPaths(command, data);
			for (const previewPath of previews) {
				const fs = await import("node:fs/promises");
				const buf = await fs.readFile(previewPath);
				content.push({
					type: "image",
					data: buf.toString("base64"),
					mimeType: "image/png",
				});
			}
		} catch (imgErr) {
			// Non-fatal: model still gets the JSON path; vision check
			// just won't fire this turn. Surface to stderr for debugging.
			console.error(
				`[pandastudio-mcp] could not inline preview image for ${command}: ${imgErr?.message ?? imgErr}`,
			);
		}
		return {
			content,
			isError: result?.ok === false,
		};
	} catch (err) {
		return {
			content: [{ type: "text", text: `tool error: ${err?.message ?? String(err)}` }],
			isError: true,
		};
	}
});

/** Decide which (if any) preview PNGs to inline as image content
 *  blocks for a given tool result. Only motion.screenshot (one
 *  preview) and motion.verify-frames (one per frame) qualify today.
 *  Returns the list of absolute paths, empty array otherwise. */
function collectInlinePreviewPaths(command, data) {
	if (!data || typeof data !== "object") return [];
	if (command === "motion.screenshot") {
		return typeof data.previewPath === "string" ? [data.previewPath] : [];
	}
	if (command === "motion.verify-frames") {
		const frames = Array.isArray(data.frames) ? data.frames : [];
		return frames
			.map((f) => (f && typeof f.previewPath === "string" ? f.previewPath : null))
			.filter((p) => p !== null);
	}
	return [];
}

// Start stdio transport (the MCP standard for local subprocess
// servers). For HTTP/SSE transports there's @modelcontextprotocol/
// sdk/server/sse — overkill for our use case since this server is
// always spawned by an MCP client (Cursor / Continue / Claude
// Desktop) on the same machine.
const transport = new StdioServerTransport();
await server.connect(transport);
