# Chat and voice settings relocation

The user approved the `transition-v1` listening result and requested a release
candidate with a simpler chat bubble. The model, selected Belle voice, inference
settings, utterance policy and platform runtimes are unchanged by this UI work.

The bubble's quick switch contains only character and saved-conversation selects.
It is a compact overlay with Escape/outside-click dismissal; the conversation is
not resized. Missing-model setup opens the appropriate Daemonlet settings page.
Voice status and stop remain in the normal conversation view, outside this menu.

Daemonlet Settings now has a **Chat & voice** page for voice enable/auto-read,
voice binding, playback mode, volume, test playback, base installation and advanced
runtime controls, local model management, new/retry/delete conversation, layout
reset and explicit memories. Existing character-pack management stays under
Appearance; the new page links to it. Current character identity is shown so voice
bindings and memories have an explicit target. UI strings include English.

## Ownership and concurrency

The settings preload exposes only a frozen management action/subscription API.
Main validates the exact settings window/main frame, the navigation owner and
character/revision/conversation context after asynchronous initialization.
Dialogs belong to their initiating settings window and revalidate it after
returning. Settings cannot call ready, read, played, scheduled, outputStopped or
retrieve audio. Conversation bodies and speech bindings are omitted from the
management snapshot.

The chat renderer remains the only AudioPlaybackController. Closing settings
never closes that player. Test playback is disabled while chat output is not
ready; opening the chat uses its normal ready handshake. Hide/close/off and R1/R2
still revoke the chat-owned output. Installing/cancelling base voice uses the same
I1 managers; cancellation is not queued behind an install or disabled by the busy
form. No model is downloaded merely by opening settings.

Memory writes capture their character at admission and reject a queued selection
change instead of writing into the newly selected character. An initialized chat
service also follows desktop character selection while its bubble is closed.

## Verification

Mac full suite: 2,336 passed, 5 existing platform/tool skips, 215 files passed.
Typecheck, renderer build, production Electron build, source check and release
structure verification passed. The previous UI source also passed the full
Windows suite (2,255 passed, 85 existing skips); the release-candidate source is
retested when packaged. No tests were deleted or unconditionally skipped.

New regressions cover the two-select menu, installation cancellation availability,
settings-only API exposure, denied audio/credit operations, expired navigation
owners, stale character/conversation context, initiating dialog ownership,
concurrent install cancellation and queued memory selection races. Existing exit
fixtures now include the management controller and retain their cleanup checks.

Real Mac UI verification confirmed the two-item menu, settings tab and advanced
section, persisted Belle binding and volume, disabled test playback with a closed
chat, opening chat from settings, settings-originated synthesis through the chat
player, and immediate stop. Candidate visual/layout and artifact checks are
recorded in the private candidate directory. Raw conversation text/screenshots,
voice/model assets and signing state are not committed.

The requested artifact is a local release candidate, not a published release.
The app version remains 0.8.1. Packaging does not add external character/voice/model
weights. Production signing, notarization, installation replacement, tagging,
pushing and publication are separate operations and are not performed here.
