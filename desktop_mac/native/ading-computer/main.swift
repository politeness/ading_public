// ADing background computer-operation tool.
//
// Why it exists: when an Agent drives the UI with AppleScript's activate or System Events keystrokes,
// the target app is brought to the front and takes over the keyboard and mouse, so the user can't use
// the computer while ADing runs a task.
// Everything here uses system APIs that don't bring apps to the front:
//   - reading the UI, pressing buttons, choosing menus, entering text: Accessibility (AXUIElement), acting directly on the target process;
//   - screenshots: ScreenCaptureKit captures per window, even when the window is in the background or covered.
// Operations that can't be done this way (e.g. coordinate clicks on a pure canvas UI) explicitly return a failure,
// and the caller decides whether to fall back to a foreground approach.
//
// Usage: ading-computer <command> '<JSON arguments>'; the result is written to stdout as one line of JSON.
// Launched by ADing, so the system records the Accessibility and Screen Recording permissions under ADing.

import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit
import LinkPresentation

struct Failure: Error {
  let message: String
  /// When a system permission is missing, names which one, so ADing can prompt the user to grant it (not by matching text, which varies by language)
  var permission: String? = nil
}

/// Text returned to the Agent follows ADing's UI language, passed in via ADING_LANGUAGE when ADing launches this program
let english = ProcessInfo.processInfo.environment["ADING_LANGUAGE"] == "en"
func L(_ zh: String, _ en: String) -> String { english ? en : zh }

func emit(_ value: [String: Any]) {
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{\"ok\":false,\"error\":\"\(L("结果无法编码", "The result could not be encoded"))\"}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func frontmost() -> [String: Any] {
  guard let app = NSWorkspace.shared.frontmostApplication else { return [:] }
  return ["name": app.localizedName ?? "", "pid": Int(app.processIdentifier)]
}

// MARK: - Arguments

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
  emit(["ok": false, "error": L("用法：ading-computer <命令> '<JSON 参数>'", "Usage: ading-computer <command> '<JSON arguments>'")])
  exit(2)
}
let command = arguments[1]
let params: [String: Any] = {
  guard arguments.count >= 3, let data = arguments[2].data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
  return object
}()

func int(_ key: String) -> Int? {
  if let value = params[key] as? Int { return value }
  if let value = params[key] as? Double { return Int(value) }
  if let value = params[key] as? String { return Int(value) }
  return nil
}
func string(_ key: String) -> String? { params[key] as? String }
func requirePid() throws -> pid_t {
  guard let pid = int("pid"), pid > 0 else { throw Failure(message: L("缺少 pid（先用 apps 找到目标应用）", "Missing pid (find the target app with apps first)")) }
  guard NSRunningApplication(processIdentifier: pid_t(pid)) != nil else { throw Failure(message: L("pid \(pid) 对应的应用没有在运行", "No running app has pid \(pid)")) }
  return pid_t(pid)
}

// MARK: - Accessibility

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func text(_ element: AXUIElement, _ name: String) -> String? {
  guard let value = attribute(element, name) else { return nil }
  if let string = value as? String { return string }
  if let number = value as? NSNumber { return number.stringValue }
  return nil
}
func children(_ element: AXUIElement) -> [AXUIElement] {
  (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}
func frame(_ element: AXUIElement) -> [String: Int]? {
  guard let positionValue = attribute(element, kAXPositionAttribute), let sizeValue = attribute(element, kAXSizeAttribute) else { return nil }
  var point = CGPoint.zero, size = CGSize.zero
  AXValueGetValue(positionValue as! AXValue, .cgPoint, &point)
  AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
  return ["x": Int(point.x), "y": Int(point.y), "w": Int(size.width), "h": Int(size.height)]
}
func actions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
  return (names as? [String]) ?? []
}
func clip(_ value: String, _ limit: Int) -> String {
  value.count > limit ? String(value.prefix(limit)) + L("…（共 \(value.count) 字）", "… (\(value.count) characters in total)") : value
}

func ensureAccessibility() throws {
  if !AXIsProcessTrusted() {
    throw Failure(message: L("阿钉还没有「辅助功能」权限：请在 系统设置 → 隐私与安全性 → 辅助功能 里打开阿钉", "ADing doesn't have Accessibility permission yet: turn on ADing in System Settings → Privacy & Security → Accessibility"), permission: "accessibility")
  }
}

/// An element id is the path of child indices from the app's root element, e.g. "0.3.1".
func resolve(_ app: AXUIElement, _ id: String) throws -> AXUIElement {
  var element = app
  if id.isEmpty || id == "root" { return app }
  for part in id.split(separator: ".") {
    guard let index = Int(part) else { throw Failure(message: L("元素编号格式不对：\(id)", "Invalid element id format: \(id)")) }
    let list = children(element)
    guard index >= 0 && index < list.count else { throw Failure(message: L("找不到元素 \(id)：界面可能已经变了，请重新读取界面结构", "Element \(id) not found: the interface may have changed; read the UI structure again")) }
    element = list[index]
  }
  return element
}

func describe(_ element: AXUIElement, id: String, valueLimit: Int = 160) -> [String: Any] {
  var item: [String: Any] = ["id": id, "role": text(element, kAXRoleAttribute) ?? ""]
  for (key, name) in [("subrole", kAXSubroleAttribute), ("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute),
                      ("help", kAXHelpAttribute), ("placeholder", kAXPlaceholderValueAttribute as String)] {
    if let value = text(element, name), !value.isEmpty { item[key] = clip(value, 120) }
  }
  if let value = text(element, kAXValueAttribute), !value.isEmpty { item["value"] = clip(value, valueLimit) }
  if let enabled = attribute(element, kAXEnabledAttribute) as? Bool, !enabled { item["enabled"] = false }
  if let focused = attribute(element, kAXFocusedAttribute) as? Bool, focused { item["focused"] = true }
  let acts = actions(element).filter { $0 != "AXShowMenu" && $0 != "AXScrollToVisible" }
  if !acts.isEmpty { item["actions"] = acts }
  if let box = frame(element) { item["frame"] = box }
  return item
}

/// Pure containers with no text and no actions are not output, only descended into, to avoid feeding hundreds of empty AXGroups to the model.
func tree(pid: pid_t) throws -> [String: Any] {
  try ensureAccessibility()
  let app = AXUIElementCreateApplication(pid)
  let rootId = string("id") ?? ""
  let root = try resolve(app, rootId)
  let maxDepth = min(int("depth") ?? 14, 40)
  let maxItems = min(int("max") ?? 250, 1500)
  let query = string("query")?.lowercased()
  var items: [[String: Any]] = []
  var truncated = false
  func walk(_ element: AXUIElement, id: String, depth: Int) {
    if items.count >= maxItems { truncated = true; return }
    let item = describe(element, id: id)
    let meaningful = item.keys.contains { ["title", "description", "value", "actions", "placeholder", "help"].contains($0) }
      || ["AXWindow", "AXSheet", "AXDialog", "AXTextField", "AXTextArea", "AXMenuBar"].contains(item["role"] as? String ?? "")
    let matches = query == nil || [item["title"], item["description"], item["value"], item["role"], item["placeholder"]]
      .compactMap { $0 as? String }.contains { $0.lowercased().contains(query!) }
    if meaningful && matches { var entry = item; entry["depth"] = depth; items.append(entry) }
    if depth >= maxDepth { return }
    for (index, child) in children(element).enumerated() {
      walk(child, id: id.isEmpty ? "\(index)" : "\(id).\(index)", depth: depth + 1)
    }
  }
  walk(root, id: rootId, depth: 0)
  return ["elements": items, "truncated": truncated,
          "note": truncated ? L("内容太多已截断：用 id 指定子树，或用 query 按文字过滤", "Too much content, truncated: use id to pick a subtree, or query to filter by text") : ""]
}

func perform(pid: pid_t, action: String) throws -> [String: Any] {
  try ensureAccessibility()
  let app = AXUIElementCreateApplication(pid)
  guard let id = string("id") else { throw Failure(message: L("缺少元素编号 id（先用 ui_tree 读取界面）", "Missing element id (read the interface with ui_tree first)")) }
  let element = try resolve(app, id)
  let available = actions(element)
  guard available.contains(action) else {
    throw Failure(message: L("元素 \(id) 不支持 \(action)，它支持的动作：\(available.joined(separator: ", "))", "Element \(id) doesn't support \(action); its supported actions: \(available.joined(separator: ", "))"))
  }
  let result = AXUIElementPerformAction(element, action as CFString)
  guard result == .success else { throw Failure(message: L("执行 \(action) 失败（AXError \(result.rawValue)）", "Performing \(action) failed (AXError \(result.rawValue))")) }
  return ["element": describe(element, id: id)]
}

func setValue(pid: pid_t, insert: Bool) throws -> [String: Any] {
  try ensureAccessibility()
  let app = AXUIElementCreateApplication(pid)
  guard let id = string("id") else { throw Failure(message: L("缺少元素编号 id（先用 ui_tree 读取界面）", "Missing element id (read the interface with ui_tree first)")) }
  guard let value = string(insert ? "text" : "value") else { throw Failure(message: insert ? L("缺少 text", "Missing text") : L("缺少 value", "Missing value")) }
  let element = try resolve(app, id)
  let name = insert ? kAXSelectedTextAttribute : kAXValueAttribute
  var settable: DarwinBoolean = false
  AXUIElementIsAttributeSettable(element, name as CFString, &settable)
  guard settable.boolValue else { throw Failure(message: L("元素 \(id) 的内容不能直接写入（不是可编辑的输入框）", "The content of element \(id) can't be written directly (it isn't an editable input field)")) }
  let result = AXUIElementSetAttributeValue(element, name as CFString, value as CFTypeRef)
  guard result == .success else { throw Failure(message: L("写入失败（AXError \(result.rawValue)）", "Writing failed (AXError \(result.rawValue))")) }
  return ["element": describe(element, id: id, valueLimit: 400)]
}

func readElement(pid: pid_t) throws -> [String: Any] {
  try ensureAccessibility()
  let app = AXUIElementCreateApplication(pid)
  guard let id = string("id") else { throw Failure(message: L("缺少元素编号 id", "Missing element id")) }
  let element = try resolve(app, id)
  var item = describe(element, id: id, valueLimit: 20000)
  if let selected = text(element, kAXSelectedTextAttribute), !selected.isEmpty { item["selectedText"] = clip(selected, 4000) }
  return ["element": item]
}

/// Menu path, e.g. ["File", "Export as PDF…"]. Menu bars of background apps can also be pressed via AX, without bringing the app to the front.
func pressMenu(pid: pid_t) throws -> [String: Any] {
  try ensureAccessibility()
  guard let path = params["path"] as? [String], !path.isEmpty else { throw Failure(message: L("缺少菜单路径 path，例如 [\"文件\",\"存储\"]", "Missing menu path, e.g. [\"File\",\"Save\"]")) }
  let app = AXUIElementCreateApplication(pid)
  guard let menuBar = attribute(app, kAXMenuBarAttribute) else { throw Failure(message: L("这个应用没有可访问的菜单栏", "This app has no accessible menu bar")) }
  var current = menuBar as! AXUIElement
  for (index, title) in path.enumerated() {
    var candidates = children(current)
    // Menu bar item → submenu (AXMenu) → menu item
    if text(current, kAXRoleAttribute) == "AXMenuBarItem" || text(current, kAXRoleAttribute) == "AXMenuItem" {
      candidates = children(current).flatMap { children($0) }
    }
    guard let next = candidates.first(where: { (text($0, kAXTitleAttribute) ?? "") == title })
            ?? candidates.first(where: { (text($0, kAXTitleAttribute) ?? "").hasPrefix(title) }) else {
      let names = candidates.compactMap { text($0, kAXTitleAttribute) }.filter { !$0.isEmpty }
      throw Failure(message: L("菜单里找不到「\(title)」，这一层有：\(names.joined(separator: "、"))", "\"\(title)\" isn't in the menu; this level has: \(names.joined(separator: ", "))"))
    }
    if index == path.count - 1 {
      let result = AXUIElementPerformAction(next, kAXPressAction as CFString)
      guard result == .success else { throw Failure(message: L("按下菜单项失败（AXError \(result.rawValue)）", "Pressing the menu item failed (AXError \(result.rawValue))")) }
      return ["pressed": path]
    }
    current = next
  }
  throw Failure(message: L("菜单路径为空", "The menu path is empty"))
}

// MARK: - Apps and windows

func listApps() -> [String: Any] {
  let apps = NSWorkspace.shared.runningApplications
    .filter { $0.activationPolicy == .regular }
    .map { app -> [String: Any] in
      ["pid": Int(app.processIdentifier), "name": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "",
       "active": app.isActive, "hidden": app.isHidden]
    }
  return ["apps": apps]
}

/// Launches or gets an app without bringing it to the front (equivalent to open -g).
func launchApp() throws -> [String: Any] {
  guard let bundleId = string("bundleId") ?? nil, !bundleId.isEmpty else { throw Failure(message: L("缺少 bundleId", "Missing bundleId")) }
  if let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
    return ["pid": Int(running.processIdentifier), "launched": false]
  }
  guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { throw Failure(message: L("找不到应用 \(bundleId)", "App \(bundleId) not found")) }
  let configuration = NSWorkspace.OpenConfiguration()
  configuration.activates = false
  configuration.hides = false
  let semaphore = DispatchSemaphore(value: 0)
  var pid: pid_t = 0
  var failure: String?
  NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
    pid = app?.processIdentifier ?? 0
    failure = error?.localizedDescription
    semaphore.signal()
  }
  _ = semaphore.wait(timeout: .now() + 20)
  if let failure { throw Failure(message: L("启动失败：\(failure)", "Launch failed: \(failure)")) }
  return ["pid": Int(pid), "launched": true]
}

func withContent<T>(_ body: @escaping (SCShareableContent) async throws -> T) throws -> T {
  let semaphore = DispatchSemaphore(value: 0)
  var result: Result<T, Error> = .failure(Failure(message: L("没有结果", "No result")))
  Task {
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
      result = .success(try await body(content))
    } catch {
      result = .failure(error)
    }
    semaphore.signal()
  }
  if semaphore.wait(timeout: .now() + 30) == .timedOut { throw Failure(message: L("读取窗口超时", "Reading windows timed out")) }
  return try result.get()
}

func ensureScreenCapture() throws {
  if !CGPreflightScreenCaptureAccess() {
    throw Failure(message: L("阿钉还没有「屏幕录制」权限：请在 系统设置 → 隐私与安全性 → 屏幕与系统录音 里打开阿钉", "ADing doesn't have Screen Recording permission yet: turn on ADing in System Settings → Privacy & Security → Screen & System Audio Recording"), permission: "screenRecording")
  }
}

func listWindows(pid: pid_t) throws -> [String: Any] {
  try ensureScreenCapture()
  return try withContent { content in
    let windows = content.windows
      .filter { $0.owningApplication?.processID == pid && $0.frame.width >= 40 && $0.frame.height >= 40 }
      .map { window -> [String: Any] in
        ["windowId": Int(window.windowID), "title": window.title ?? "", "onScreen": window.isOnScreen, "layer": window.windowLayer,
         "frame": ["x": Int(window.frame.minX), "y": Int(window.frame.minY), "w": Int(window.frame.width), "h": Int(window.frame.height)]]
      }
    return ["windows": windows]
  }
}

func screenshot(pid: pid_t) throws -> [String: Any] {
  try ensureScreenCapture()
  guard let out = string("out"), !out.isEmpty else { throw Failure(message: L("缺少输出路径 out", "Missing output path out")) }
  let wantedId = int("windowId")
  let wantedTitle = string("windowTitle")
  let scale = max(1, min(int("scale") ?? 1, 2))
  return try withContent { content in
    let candidates = content.windows.filter { $0.owningApplication?.processID == pid && $0.frame.width >= 40 && $0.frame.height >= 40 && $0.windowLayer == 0 }
    let window: SCWindow? = wantedId.map { id in candidates.first { Int($0.windowID) == id } }
      ?? wantedTitle.map { title in candidates.first { ($0.title ?? "").contains(title) } }
      ?? candidates.first { $0.isOnScreen } ?? candidates.first
    guard let window else { throw Failure(message: L("这个应用没有可截取的窗口", "This app has no window that can be captured")) }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    configuration.width = Int(window.frame.width) * scale
    configuration.height = Int(window.frame.height) * scale
    configuration.showsCursor = false
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .png, properties: [:]) else { throw Failure(message: L("图片编码失败", "Image encoding failed")) }
    try data.write(to: URL(fileURLWithPath: out))
    return ["path": out, "width": image.width, "height": image.height, "windowId": Int(window.windowID), "title": window.title ?? "",
            "frame": ["x": Int(window.frame.minX), "y": Int(window.frame.minY), "w": Int(window.frame.width), "h": Int(window.frame.height)]]
  }
}

// MARK: - Automation permission (controlling other apps)

/// Whether ADing may control a given app, i.e. the Automation permission.
///
/// When an Agent uses AppleScript to control apps like System Events or Finder, macOS shows "ADing wants to control xxx" the first time.
/// When another computer assigns work remotely, nobody is at this computer to click the prompt, and the task gets stuck. So it must be
/// possible to check and grant in advance while someone is present:
///   - askUser false: check only, no prompt; used by "System permissions" under Settings → Permissions;
///   - askUser true: show the system prompt; used when the user clicks "Grant now" in "System permissions", and waits until the user responds.
/// The system can only tell while the target app is running; if it isn't, launch it silently in the background and check again.
func automationStatus(bundleId: String, askUser: Bool) -> String {
  func check() -> OSStatus {
    var target = AEAddressDesc()
    let created = bundleId.withCString { AECreateDesc(DescType(typeApplicationBundleID), $0, strlen($0), &target) }
    guard created == noErr else { return OSStatus(created) }
    defer { AEDisposeDesc(&target) }
    return AEDeterminePermissionToAutomateTarget(&target, AEEventClass(typeWildCard), AEEventID(typeWildCard), askUser)
  }
  var status = check()
  if status == OSStatus(procNotFound), let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.hides = true
    let launched = DispatchSemaphore(value: 0)
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, _ in launched.signal() }
    _ = launched.wait(timeout: .now() + 5)
    for _ in 0..<20 where status == OSStatus(procNotFound) {
      Thread.sleep(forTimeInterval: 0.1)
      status = check()
    }
  }
  switch status {
  case noErr: return "granted"
  case OSStatus(errAEEventNotPermitted): return "denied"
  case OSStatus(errAEEventWouldRequireUserConsent): return "notDetermined"
  case OSStatus(procNotFound): return "notRunning"
  default: return "unknown:\(status)"
  }
}

// MARK: - System link metadata (uses the user's existing network/proxy configuration)

func publicPreviewURL(_ url: URL) -> Bool {
  guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
        url.port == nil || url.port == 443, let host = url.host?.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")),
        host.contains("."), !host.contains(":"),
        host.range(of: "^[0-9.]+$", options: .regularExpression) == nil else { return false }
  return !["localhost", "local", "lan", "home", "internal", "intranet", "corp", "test", "invalid"].contains { host == $0 || host.hasSuffix("." + $0) }
}

func linkPreview() throws -> [String: Any] {
  guard let raw = string("url"), let url = URL(string: raw), publicPreviewURL(url) else {
    throw Failure(message: "Unsupported preview URL")
  }
  let provider = LPMetadataProvider()
  provider.shouldFetchSubresources = true
  provider.timeout = 6
  var finished = false
  var result: [String: Any] = [:]
  provider.startFetchingMetadata(for: url) { metadata, _ in
    DispatchQueue.main.async {
      guard let metadata, let finalURL = metadata.url, publicPreviewURL(finalURL),
            let title = metadata.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else { finished = true; return }
      result = ["title": String(title.prefix(240)), "description": "", "siteName": finalURL.host ?? url.host ?? ""]
      guard let imageProvider = metadata.imageProvider ?? metadata.iconProvider,
            imageProvider.canLoadObject(ofClass: NSImage.self) else { finished = true; return }
      imageProvider.loadObject(ofClass: NSImage.self) { object, _ in
        DispatchQueue.main.async {
          defer { finished = true }
          guard let image = object as? NSImage, image.size.width > 0, image.size.height > 0,
                let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 120, pixelsHigh: 120,
                    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
                let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return }
          bitmap.bitmapData?.initialize(repeating: 0, count: bitmap.bytesPerRow * bitmap.pixelsHigh)
          NSGraphicsContext.saveGraphicsState()
          NSGraphicsContext.current = context
          context.imageInterpolation = .high
          let scale = min(120 / image.size.width, 120 / image.size.height)
          let size = NSSize(width: image.size.width * scale, height: image.size.height * scale)
          image.draw(in: NSRect(x: (120 - size.width) / 2, y: (120 - size.height) / 2, width: size.width, height: size.height))
          NSGraphicsContext.restoreGraphicsState()
          if let png = bitmap.representation(using: .png, properties: [:]), png.count <= 96 * 1024 {
            result["image"] = "data:image/png;base64," + png.base64EncodedString()
          }
        }
      }
    }
  }
  let deadline = Date().addingTimeInterval(7)
  while !finished && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
  if !finished { provider.cancel() }
  return result
}

// MARK: - Entry point

do {
  var result: [String: Any]
  switch command {
  case "link-preview": result = try linkPreview()
  case "permissions":
    result = ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
  case "request":
    // Launched by ADing, so the system attributes the permission prompt and record to ADing
    switch string("kind") {
    case "accessibility":
      let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      result = ["accessibility": AXIsProcessTrustedWithOptions(options)]
    case "screenRecording":
      result = ["screenRecording": CGRequestScreenCaptureAccess()]
    default: throw Failure(message: L("kind 只能是 accessibility 或 screenRecording", "kind must be accessibility or screenRecording"))
    }
  case "automation":
    // Check only, no prompt
    let ids = (params["bundleIds"] as? [String]) ?? []
    result = ["automation": Dictionary(uniqueKeysWithValues: ids.map { ($0, automationStatus(bundleId: $0, askUser: false)) })]
  case "request-automation":
    guard let id = string("bundleId") else { throw Failure(message: L("缺少 bundleId", "bundleId is missing")) }
    result = ["automation": [id: automationStatus(bundleId: id, askUser: true)]]
  case "apps": result = listApps()
  case "launch": result = try launchApp()
  case "windows": result = try listWindows(pid: try requirePid())
  case "screenshot": result = try screenshot(pid: try requirePid())
  case "tree": result = try tree(pid: try requirePid())
  case "read": result = try readElement(pid: try requirePid())
  case "press": result = try perform(pid: try requirePid(), action: kAXPressAction)
  case "action": result = try perform(pid: try requirePid(), action: string("action") ?? "")
  case "set_value": result = try setValue(pid: try requirePid(), insert: false)
  case "insert_text": result = try setValue(pid: try requirePid(), insert: true)
  case "menu": result = try pressMenu(pid: try requirePid())
  default: throw Failure(message: L("未知命令：\(command)", "Unknown command: \(command)"))
  }
  result["ok"] = true
  result["frontmost"] = frontmost()
  emit(result)
} catch let failure as Failure {
  var output: [String: Any] = ["ok": false, "error": failure.message, "frontmost": frontmost()]
  if let permission = failure.permission { output["permission"] = permission }
  emit(output)
  exit(1)
} catch {
  emit(["ok": false, "error": String(describing: error), "frontmost": frontmost()])
  exit(1)
}
