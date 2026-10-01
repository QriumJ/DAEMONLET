import Foundation
import CoreGraphics
import Darwin

// Public current-state query only. No event tap or accessibility/input-monitoring request.
func optionEditingAllowed(_ flags: CGEventFlags) -> Bool {
    flags.contains(.maskAlternate) && flags.intersection([.maskControl, .maskCommand, .maskShift]).isEmpty
}
let parent = getppid()
repeat {
    let option = optionEditingAllowed(CGEventSource.flagsState(.combinedSessionState))
    print(option ? "1" : "0")
    fflush(stdout)
    if CommandLine.arguments.contains("--once") { break }
    usleep(100_000)
} while getppid() == parent && parent > 1
