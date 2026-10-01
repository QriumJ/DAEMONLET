import Foundation
import CoreGraphics
import Darwin

// Public current-state query only. No event tap or accessibility/input-monitoring request.
let parent = getppid()
repeat {
    let option = CGEventSource.flagsState(.combinedSessionState).contains(.maskAlternate)
    print(option ? "1" : "0")
    fflush(stdout)
    if CommandLine.arguments.contains("--once") { break }
    usleep(100_000)
} while getppid() == parent && parent > 1
