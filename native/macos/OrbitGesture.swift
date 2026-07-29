import AppKit
import CoreGraphics
import Foundation

struct Gesture: Decodable {
  let action: String
  let x: Double?
  let y: Double?
  let deltaY: Double?
}

func postMouse(_ type: CGEventType, x: Double, y: Double) {
  guard let display = NSScreen.main?.frame else { return }
  let point = CGPoint(x: max(0, min(1, x)) * display.width,
                      y: max(0, min(1, y)) * display.height)
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?
    .post(tap: .cghidEventTap)
}

if !CGPreflightPostEventAccess() { CGRequestPostEventAccess() }

while let line = readLine() {
  guard let data = line.data(using: .utf8),
        let gesture = try? JSONDecoder().decode(Gesture.self, from: data) else { continue }
  switch gesture.action {
  case "move": postMouse(.mouseMoved, x: gesture.x ?? 0.5, y: gesture.y ?? 0.5)
  case "down": postMouse(.leftMouseDown, x: gesture.x ?? 0.5, y: gesture.y ?? 0.5)
  case "up": postMouse(.leftMouseUp, x: gesture.x ?? 0.5, y: gesture.y ?? 0.5)
  case "scroll":
    CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1,
            wheel1: Int32(gesture.deltaY ?? 0), wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
  case "media-toggle":
    NSAppleScript(source: "tell application \"System Events\" to key code 49")?.executeAndReturnError(nil)
  default: break
  }
}
