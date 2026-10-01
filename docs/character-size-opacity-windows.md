# Windows character size, opacity and Alt recovery

Windows uses the existing size range (20–400%) and opacity range (0–100%). At opacity ≤50%, the pet stays click-through until the existing interaction policy permits editing. The tray and Settings can restore opacity to 100%, including from 0%.

The native `DaemonletModifierState.exe` samples only current modifier high bits every 100 ms. Left Alt alone enables recovery while the cursor is inside the visible, ready pet window rectangle. Right Alt/AltGr, Ctrl, Shift and Windows-key combinations do not enable recovery. Leaving the rectangle, releasing Alt, hiding/suspending the pet or resetting the renderer restores the configured opacity and mouse policy. The helper has no keyboard hooks, text/history collection, wheel capture, input injection or additional input permission. It exits when its owning app's output read pipe closes, including a parent crash.

Recovery temporarily reveals the pet so the renderer can apply its painted-character hit test. The renderer consumes Alt+wheel only over the character; other areas and other apps retain their scrolling. The helper itself never receives or consumes wheel events. A missing or failed helper leaves the tray/Settings recovery available and emits a fixed warning.

Existing Visual Studio C++ tools build the x64 helper. Production builds include only the production executable. The explicit `--modifier-qa` build adds a separate synthetic policy executable and is rejected with `--production`.

Automated Windows verification covers all 64 modifier combinations, bounded LF output, pipe/parent lifetime, helper wiring, pet rectangle gating, 0% recovery and configured-opacity restoration. These are CLI/native and mocked-window checks. Interactive acceptance remains required for physical Alt+wheel, 20/400% sizes, 0/50/100% opacity, tray recovery, different-app scrolling, multi-monitor DPI, sleep/resume, and bubble/chat draft/scroll/task restoration. SSH network logon does not establish a GUI pass.
