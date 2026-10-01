# Character size and opacity

Settings → Character & display accepts any size from 20% to 400% (92–1840 DIP), rather than only presets. Values outside this finite safety range are rejected. A removed monitor recovers an off-screen oversized window to fit the current work area. Layout editing temporarily provides at least a 280 DIP area and restores the selected size when Done is pressed.

Opacity is saved separately from visibility, from 0% to 100%. At 50% or lower, the whole pet passes clicks through. Speech bubbles and task/control windows are separate native windows and remain readable. The existing transparent-pixel click-through preference still applies above the threshold.

While the pointer is over painted character pixels, hold Option (Mac) or left Alt (Windows) and wheel up to increase opacity/down to decrease it. Normal scrolling, horizontal gestures, Control/Command/AltGraph combinations, and modifier wheel during a drag are not consumed. Wheel updates are coalesced and serialized.

Always-available recovery: tray → **Restore 100% opacity**, or Settings → Character & display → the same button. This also shows a hidden character. Neither zero opacity nor click-through hides the window or changes voice/tunnel settings.

On Mac, a bundled foreground child queries only the public current Option flag (`CGEventSource.flagsState`), every 100 ms, without installing an event tap or requesting Accessibility/Input Monitoring. At low opacity, Option while the pointer is inside the pet temporarily restores full opacity and normal painted-pixel interaction. It does not take focus. Key release, cursor exit, a stale 350 ms heartbeat, hide, reload, sleep and shutdown clear the lease. The child exits when its parent exits. A missing/failed helper falls back to tray/Settings recovery; it never requests a new permission automatically. Windows has no global modifier recovery helper in this revision; use the tray/Settings when click-through is active.

QA uses real Mac Electron renderer/preload and native window opacity, with injected mouse-wheel input and a deterministic Option adapter. The helper has separately executed without a permission request. Physical Option + trackpad/mouse and multiple physical monitors remain user acceptance checks; Windows GUI is deferred. No user settings, pack, profile, credentials or OS permissions are changed by these tests.
