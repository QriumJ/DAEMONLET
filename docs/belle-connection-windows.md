# Windows Dots connection: native lifetime and secure-store boundary

Windows uses a bundled native Credential Manager helper for one fixed generic
credential target: `io.github.ddol2ya.daemonlet.belle-connection.runtime-v1`.
`CredWriteW` stores it with `CRED_PERSIST_LOCAL_MACHINE`, in the current user's
credential set across logons on this machine. This is OS-protected storage, not
an application-encrypted JSON file or a roaming credential. Other applications
running as the same user can access generic credentials; this is not per-app
Windows isolation. No plaintext fallback is implemented.

The key travels over private stdin/stdout pipes between Main and the helper.
Only `available`, `has`, `get`, `put` and `remove` are accepted; no caller can
choose another target. Key syntax and payload sizes are bounded, credential
buffers are zeroed before release, native errors become allowlisted codes, and
no credential enters argv or a log. The settings renderer has write-only input
and no credential-read API. Existing native confirmation, target disclosure,
auto-connect default-off, disconnect and removal behavior is preserved.

`ERROR_NO_SUCH_LOGON_SESSION` becomes `STORE_LOCKED`. Windows SSH/network-logon
sessions may have no associated credential set. Availability then remains
false, saving/connecting remain blocked, and no file fallback or alternate
logon is attempted. Actual save/replace/read/delete must be checked in the
owner's normal interactive logon session; an SSH failure is not a GUI failure
or a successful secure-store test.

The app discovers an already installed `tunnel-client-runtime.exe` or
`tunnel-client.exe`, and external Node.js. It checks versions and required
health/MCP flags. It does not install tools, modify PATH, create account keys,
create tunnels, or change remote permissions. The fixed Windows adapter command
uses forward-slash paths and quoted argv compatible with official v0.0.14
`parseCommandArgv`; the official transport uses `exec.Command` rather than a
shell. Unsupported control characters and shell metacharacters in deployment
paths fail closed.

The native host creates a non-inherited Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, launches the client suspended, assigns it
to the Job, and only then resumes execution. Assignment failure terminates the
still-suspended child. The client and its adapter descendants inherit Job
membership; no taskkill/PID search or unrelated process termination is used.
Disconnect closes the parent pipe. Pipe EOF, client exit or host termination
closes the host's sole Job handle. The adapter launch mode removes API keys
before starting Node and forwards only the client's stdio pipes. Runtime keys
remain volatile client environment values; the temporary JSON profile contains
only nonsecret IDs/settings and an environment reference.

## Native verification

Existing Visual Studio C++ tools build the helpers with C++17, `/GS`, ASLR and
DEP. The regular Electron build clears `dist-electron` and builds only production
helpers. The explicit QA build also creates a test client and a credential helper
whose compile-time fixed target ends in `.qa-v1`; it cannot address the production
item. QA plus `--production` is rejected. Never package the QA build directly.

From a Windows checkout with existing dependencies and compiler:

```powershell
node electron/build/build-windows-belle.mjs --credential-qa
$env:DAEMONLET_WINDOWS_NATIVE_TESTS='1'
# Normal interactive owner login only; this uses a synthetic QA key.
$env:DAEMONLET_WINDOWS_CREDENTIAL_TESTS='1'
node node_modules/vitest/vitest.mjs run tests/windows-belle-native.test.ts
```

The successful-store test refuses to overwrite a pre-existing QA item. It checks
missing/save/replace/invalid-key/remove/idempotent-remove and cleans up its item.
For a confirmed unavailable SSH credential set, use
`DAEMONLET_WINDOWS_CREDENTIAL_TESTS='blocked'` instead. That explicitly tests
`STORE_LOCKED`, not successful storage. No actual runtime key is needed.

The real Windows native tests cover disconnect, abort, parent pipe EOF and
forced host termination; client/adapter/grandchild termination; unrelated
process survival; paths with spaces; sanitized adapter environment; secret-free
profile/argv; and temporary-profile cleanup. These are native OS/process proofs
using a mock client. They do not establish live Platform authentication,
plugin discovery, GUI controls, physical sound or lip-sync success.

## First-unit evidence and remaining checks

On 2026-10-01, native C++17 build and typecheck passed on Windows x64. Targeted
connection/native tests passed with the SSH `STORE_LOCKED` path. The full Windows
regression passed: 2,700 tests, zero failures, 89 skipped (including the interactive
credential CRUD test and platform-specific POSIX/macOS cases). The interactive
credential CRUD test remains pending; POSIX-only process-group tests are skipped
on Windows. No actual user key, installed app/profile/pack, or model runtime was
changed. Required next checks are interactive credential CRUD, installed
verified official client compatibility, owner-entered live key/authentication,
Windows modifier recovery, and actual packaged GUI/voice/lip-sync verification.

References: [Windows Credential Manager](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew),
[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[official client v0.0.14 source](https://github.com/openai/tunnel-client/tree/v0.0.14).

Dots voice IPC handlers belong to the app voice controller and register once.
Disconnect, initial loopback-port failure and connection retry detach the
presentation window's listeners and output lease; reattachment uses the same
handlers. Window replacement revokes the old renderer's authority, and controller
shutdown removes the handlers. Connection retries do not require app restart.
