# Conversation UX

The tray distinguishes **Local character chat** (on-device character/model) from
**Codex task chat** (the existing Codex task route) and **Codex task controls**.
These labels do not change task or model routing.

## Drafts

Unsent local chat drafts live only in the main-process app session. Closing and
reopening the chat bubble restores the current draft; quitting the app discards
unsent drafts. No draft is written to conversation files, browser storage, or
connection metadata. Drafts are scoped to the selected character and conversation,
including an as-yet-unsent new conversation. Returning to another character also
restores that character's last selected conversation for the current session.

A draft is cleared only after durable message admission succeeds. Rejected sends
and storage failures preserve it. Revision checks preserve text typed while the
previous message is being accepted, including the first message creating a new
conversation. Explicit **new conversation** resets the new-conversation draft;
a successfully deleted conversation removes its draft. Input is limited to 6000
UTF-16 code units, with at most 512 session draft slots. The narrow trusted-window
IPC retains drafts without copying the conversation history on every keystroke.

## Reading and waiting

The local history follows incoming text while within 36 pixels of the bottom.
Scrolling farther up stops following. A **View new reply** button and screen-reader
notice appear when the latest assistant message changes. The button returns to the
latest text deliberately; keyboard activation retains focus in history and pointer
activation preserves the previous focused control. Opening a conversation or
reopening its bubble starts at the latest text. Expanding voice controls and window
resizing follow only while the reader is already following.

The empty first reply displays **Preparing chat model** during the real `loading`
phase and **Generating reply** during `generating`. Existing voice status separately
reports model preparation, synthesis, and playback from voice events. No synthetic
percentage or estimated progress is introduced.

## Voice controls

Replies have one primary **Play / Listen again** action. It keeps the existing
read/replay/reproduce behavior; reroll, explicit reproduction, current-setting
synthesis, and seed/cache details sit under **Voice options**. Text is unchanged.

Voice settings start with enable, selected voice, automatic reading, volume, and
test playback. WAV creation is collapsed under **Add a voice from WAV**; cancellation
and import failures remain visible outside the collapsed section. Seed, execution
mode, reference rename, and installation controls stay under advanced settings.
Existing permission acknowledgment and model-install policy remain in force.

## Validation

Automated coverage includes draft scope/reopen/delete/quit, delayed admission and
input updates, rejected admission, trusted IPC, streaming-follow intent, reading
history, explicit return, translation coverage, voice-setting hierarchy and
cancellation, and unchanged menu routes. The isolated Mac UI smoke (`node scripts/character-chat-ui-smoke.mjs`) also
compiles all current renderer entries and the main-process entry in a temporary
output directory, then exercises the real renderer, preload, IPC, chat service,
and native windows with a synthetic model/audio/setup backend. Its 25 checks cover
window reopen, character isolation/restore, repeated-send admission, loading and
generation labels, stream reading/following, new-reply keyboard return and input
focus, failed admission, simulated composing-Enter protection, 350/900 pixel widths,
Home/history focus, and voice options/WAV expansion with form retention.

The test creates and closes only its own temporary windows/profile and does not
read Keychain, connect a tunnel, or touch a real model/profile. Real OS IME input,
actual audio/model generation, drag gestures, real active Codex coexistence, and
Windows GUI remain manual checks. No package or live app restart is produced.
