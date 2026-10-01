# dot → DAEMONLET presentation bridge (MVP)

This is a personal, opt-in output bridge, not an account integration or an automatic subscription to every dot response. It preserves the existing selected character, validated chat-pose rules, VoxCPM2 runtime, voice binding, volume and seed policy. It does not replace models, download assets, append chat messages, read/export history, or accept file paths/commands.

## Architecture and tool contract

`dot/plugin → MCP stdio adapter → authenticated 127.0.0.1 app endpoint → Pet/bubble + existing CharacterVoiceService`

The MCP entry point is `node scripts/dot-presentation-mcp.mjs`. Use `npm run dot:mcp` only for manual development; MCP hosts should launch Node directly to keep stdout JSON-RPC-only. No dependencies were added. The adapter implements a minimal dual-era stdio contract: **2025-06-18** initialize/initialized gating, and **2026-07-28** per-request metadata, server/discover, ping, tools/list and tools/call. Modern requests require params._meta with io.modelcontextprotocol/protocolVersion exactly 2026-07-28 and an object io.modelcontextprotocol/clientCapabilities. Unsupported modern revisions receive -32022; missing/invalid required metadata receives -32602. Modern responses include resultType and server identity. Modern requests never unlock legacy initialization; legacy negotiation selects only the implemented 2025-06-18 revision. Only present/cancel can invoke the app; it is not an official SDK integration or a complete MCP implementation. Official TypeScript SDK documentation was consulted; installing/adopting it requires separate dependency approval. No resources, prompts, arbitrary shell execution, remote URLs or browser endpoints are exposed. The internal `/present` HTTP endpoint is not itself MCP and must not be registered as one.

Only two tools are exposed:

- `present({text?, pose?, state?, speak?, durationMs?})`: at least one text/pose/state required. Text is NFC plain text, 1–600 Unicode code points; control/bidi characters and unpaired surrogates are rejected. Semantic poses: neutral, listening, thinking, happy, sad, error. Unknown bounded pose labels received by the app fall back to neutral and return poseFallback:true; paths are rejected. States: idle, thinking, speaking, done, error. Speak defaults false; duration is 1,000–30,000 ms (default 12,000).
- `cancel({})`: cancels only bridge-owned output and releases normal Pet behavior. Immediate cancellation is allowed despite presentation rate limiting.

Dot bubbles retain the complete bounded text without a literal source prefix. A compact multiline preview offers **Show full text / Collapse** when needed; the expanded text scrolls inside a screen-bounded box (up to 480 DIP). Newlines are preserved. Only deliberate expansion takes keyboard focus; Escape collapses, pointer leave restores transparent-area click-through, and replacement/cancel/expiry releases the view. Existing short authored task dialogue retains its 36-character validation and passive click-through behavior. Voice reads the unchanged full bounded payload exactly once. State-only calls display a short localized status. Expansion creates no history and does not extend expiry.

Presentation is latest-wins, session-only, automatically expires, and is dropped while the Pet is hidden/loading/in layout, a character changes, local/side chat or the lab owns the surface, or the app is shutting down. No hidden queue replays later. Existing validated pose rules choose artwork; missing rules use the pack default/base rig. The service and renderer guard cancellation/late completion.

Acceptance reports accepted, sequence, poseFallback and voice only. It reports no paths, character details, settings or history. Voice requested means requested, not audible/completed. Local unmute is required, and existing voice must already be enabled/configured with playback available. Unsupported/missing voice returns DOT_VOICE_UNAVAILABLE; later synthesis failure shows an error status. Muted calls still render with voice:muted. Cancel/quiet/mute affect dot ownership only. The Pet can retrieve owned audio and acknowledge playback through trusted IPC; it cannot install/configure/enable voice.

## Local opt-in setup

Use a fresh random session token, at least 32 URL-safe characters. App and stdio adapter must inherit the same DAEMONLET_DOT_TOKEN and DAEMONLET_DOT_PORT environment. Generate the token in the parent shell without printing it, putting it in command arguments, committing it or saving a permanent config. Review the session setup before launching.

- DAEMONLET_DOT_BRIDGE=1: explicitly enables this app session.
- DAEMONLET_DOT_PORT=39471: optional loopback port, integer 1024–65535.
- DAEMONLET_DOT_TOKEN: fresh 32–128 URL-safe characters. No default token.

Launch the development app in this environment, then launch the fixed Node adapter command from the MCP host. Unset all three environment variables after testing. The app starts no listener unless explicitly opted in. Invalid token/port or a port conflict leaves the bridge unavailable.

The server binds **127.0.0.1 only**. Every call requires a session bearer token, exact numeric loopback Host and no Origin. No CORS, public listener, persistent credential or access grant is created. Bodies are capped at 8 KiB, stdio messages at 16 KiB, concurrent work is bounded, and presentations are limited to four/second. No text/token is logged by the bridge. Same-user local processes able to inspect process environment remain inside this local trust boundary.

The context/tray menu gains a disabled **dot presentation · this session** heading followed by root-level pause, mute (initially on), and stop controls. Keeping these short controls out of a cascading submenu prevents macOS from compressing their labels against a display edge. Remote tools cannot unmute/resume. Quitting closes the listener, aborts bridge-owned voice, clears memory and removes handlers. The global speech-bubble preference remains respected.

## App-managed Belle connection (macOS)

Settings → **Belle connection** replaces per-start Terminal key entry. The owner enters an already approved personal tunnel ID, Platform organization ID and dedicated Restricted Tunnels Read+Use runtime key directly into the app. The app cannot inspect the key’s remote scopes. It does not create tunnels, workspace associations, keys, permissions or installations. Store, connect, enable auto-connect and delete each require a native confirmation describing the exact target and lifetime; cancel is the default. Saving alone never connects. Auto-connect starts off and only connects when the owner opens this app, not at OS login. Disconnect also disables auto-connect.

A fixed macOS Security.framework generic-password Keychain item stores the key, accessed by the bundled Swift helper over private pipes. The key is never persisted in JSON, app files, logs, command arguments or browser storage; there is no renderer key-read or reveal API. Nonsecret IDs and the explicit auto-connect consent version are stored separately. Locked/denied/unavailable Keychain access fails closed and can be retried after refreshing status. Windows uses a fixed native Credential Manager item and Job Object supervisor; see [Windows secure-store/lifetime verification](belle-connection-windows.md) for the SSH logon boundary and pending interactive CRUD/live-client checks. Linux displays unavailable secure storage and cannot save or connect; no plaintext fallback is used. Real Keychain access prompts and signed/notarized distribution still require owner validation; mock tests do not establish them.

The app checks an installed official tunnel-client (0.0.14 or later with required flags) and external Node.js (22.13 or later). It forwards only the fixed packaged MCP adapter. Each connection uses a random authenticated loopback port/token and starts voice muted. Runtime credentials are volatile environment values for the official client; the adapter’s environment explicitly removes API keys. A private temporary profile contains only nonsecret configuration and an environment-variable reference. Client stdout/stderr are discarded; public errors are allowlisted. The owned POSIX supervisor group receives orderly stop/forced cleanup on cancellation, disconnect or app exit; an app-parent pipe EOF also stops it. Reconnection is bounded to three delayed retries. Transport readiness is distinct from verified plugin discovery/display/audio.

An externally launched legacy Terminal helper is not adopted or terminated by these settings. To transition, the owner must stop that helper and its app, then open the current development app normally, without DAEMONLET_DOT_BRIDGE or credential environment variables. Choose the existing Belle pack and open Settings from the app menu. Enter the key directly, approve storage, then separately approve Connect. Only after checking actual plugin output should the owner choose whether to enable app-start auto-connect. Deleting the local Keychain item does not revoke a remote Platform key; revoke unused old keys on Platform separately. No credential migration is performed automatically.

Nonsecret mock UI verification:

~~~sh
node scripts/belle-connection-ui-smoke.mjs
~~~

This uses an isolated app profile, real Settings renderer/preload/IPC and in-memory credential/runtime/consent mocks. It never reads or writes the real Keychain, launches a real tunnel, or changes user settings.

## Local verification

With existing dependencies/runtime installed:

~~~sh
npm run typecheck
npm run source:check
npx --no-install vitest run tests/dot-*.test.ts tests/voice-seeds.test.ts
npm test
python3 -B scripts/test-voice-seed.py
python3 -B scripts/test-voice-reference.py
python3 -B scripts/test-voice-worker.py
# Development compilation only; no install/distributable package:
npm run build:renderer
npm run build:electron
npm run dot:smoke
~~~

The smoke defaults to temporary app/Codex profiles, random loopback ports/token, Gpichan, muted voice and no model downloads. An existing pack can be copied into the isolated profile with ELECTRON_SMOKE_DOT_CHARACTER_ID and ELECTRON_SMOKE_DOT_CHARACTER_STORE. To observe an explicitly owner-selected existing local chat, set ELECTRON_SMOKE_DOT_DESKTOP_HOME and ELECTRON_SMOKE_DOT_DESKTOP_TITLE; the exact title must match once. This read-only follower never sends, retries or stops a task. The smoke verifies native multiline text, expansion/scrolling/collapse, display-edge placement, focus, work/control window switching, cancel/expiry restoration, rapid repeats, quiet and missing-voice errors. Incoming task completion is a separate ActivityStore fixture, not proof of an active real turn. It captures only app content and closes its own app. Voice contracts verify the complete payload and cancellation; muted UI smoke does not prove actual audio quality.

## Live account connection: separate approval required

Official dot docs say installed/enabled supported plugins can be used by dot. They do not establish a full response/state subscription API. This bridge relies on explicit tool calls; it never scrapes internal endpoints or automatically receives all dot output.

A private connection can use Secure MCP Tunnel, which supports stdio forwarding. It requires a tunnel identity, runtime key, the proper Platform organization/ChatGPT workspace association and developer-mode permission. These deployment actions require separate owner approval; the repository scripts do not perform them automatically. An owner-approved personal deployment was tested separately with present/cancel, visible text and owner-confirmed audible speech. That does not prove automatic response subscriptions or every later build. Review and approve setup for each new account separately. Do not publish /present, open firewall ports or create a public forwarding service.

After approved setup, forward to the fixed Node adapter command and provide this session's local environment. Discover exactly present/cancel. Test short text, thinking status, muted speech, then locally unmute with existing assets and cancel during speech. Check offline/paused behavior. Live dot tool selection/permissions and end-to-end voice remain unverified until those account tests pass. Reverse DAEMONLET→dot input and realtime voice are out of scope.

References consulted 2026-09-30:

- [dot computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)
- [personal plugin quickstart](https://developers.openai.com/plugins/quickstart)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [MCP stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

Modern compatibility sources: [MCP versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [per-request metadata](https://modelcontextprotocol.io/specification/2026-07-28/basic/index), [server discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover), [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio). Local protocol tests do not prove hosted ChatGPT/dot compatibility.
