# Belle connection wizard

Settings → Belle connection → Open connection wizard adds a guided path while keeping the existing settings controls and their OS-storage/connection confirmations.

1. Check prerequisites: official tunnel-client, Node.js 22.13+, visible character, outbound HTTPS, and separate ChatGPT developer-mode workspace access.
2. Sign in to Platform tunnel settings yourself. Reuse or provision a tunnel yourself, and associate the owning Platform organization and intended ChatGPT workspace. Creating/editing requires Read + Manage; runtime use requires Read + Use.
3. Enter a Restricted runtime key with Tunnels Read + Use and confirm the exact storage target through the existing dialog. Existing credentials can be reused without replacing them. The app cannot verify key permissions.
4. Explicitly connect through the existing target-specific confirmation. Navigation, restart, and saving do not connect or enable auto-connect.
5. In ChatGPT Plugins, create or inspect the connection yourself, choose Tunnel, review discovered tools, and acknowledge the connection. Developer mode and plugin installation remain user actions.
6. Recheck diagnostics and manually test a short Belle display request in ChatGPT.

## State boundaries

- Runtime readiness comes from the manager and its owned runtime health check. Refresh also rechecks readiness without retrieving a key or launching another runtime.
- Plugin installation acknowledgement belongs only to the current wizard visit and target. It resets after target changes, readiness loss, credential/store errors, disconnect, restart, or re-entry.
- Actual tool calls remain **unverified**. This version has no supported invocation evidence; neither readiness nor a checkbox proves an actual ChatGPT tool call.
- Only a bounded step index (`0`–`5`) is stored in renderer localStorage. No target, key, consent, or completed flag is stored there. Missing or invalid progress restarts at step 0.
- Pausing/back navigation unmounts and clears unsaved password input. Pausing the guide preserves the existing runtime; the explicit Disconnect action stops it and disables automatic connection.

## External pages

The settings main frame may request only named guides. Main maps them to five exact HTTPS URLs: Platform tunnel settings, runtime key settings, ChatGPT Plugins, and the two official documentation pages. The IPC rejects arbitrary URLs, query strings, unknown names, and untrusted frames. Tests inject a fake opener, so QA never opens a real account page.

## Verification

`npm run typecheck`, `npm test`, `npm run qa:regression`, renderer/Electron builds, and `node scripts/belle-connection-ui-smoke.mjs` cover contracts and the real renderer/preload using isolated mock storage, confirmations, runtime, and profile. Set `BELLE_QA_EVIDENCE` to an output directory outside Git to retain screenshots/results. The smoke runner removes its temporary profile.

The UI fixture covers initial setup, stored credentials, already-ready runtime, repeated connect clicks, cancellation during launch, pause/back/restart/re-entry/reload, blocked next actions, local key deletion, storage and official-link failure, missing client, readiness loss/recovery, Korean/English, and scrolling at 800×650. Windows is checked through platform contracts, not a live Windows runtime/GPU session.

Real login, organization/workspace association, key creation/permissions, OS-store consent, plugin installation/developer mode, and an end-to-end ChatGPT tool call require separate user acceptance. QA does not perform these actions.

## Official references

Checked 2026-10-01:

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Official tunnel-client onboarding](https://github.com/openai/tunnel-client/blob/main/docs/onboarding.md)
- [Official tunnel-client permissions](https://github.com/openai/tunnel-client/blob/main/docs/permissions.md)
