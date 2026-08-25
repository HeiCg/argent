import XCTest

extension ArgentRunnerSession {
  /// Element types an agent can act on directly; always included.
  static let interactiveTypes: Set<XCUIElement.ElementType> = [
    .button, .cell, .checkBox, .collectionView, .datePicker, .link, .menuItem,
    .picker, .pickerWheel, .searchField, .segmentedControl, .slider, .stepper,
    .switch, .tabBar, .textField, .secureTextField, .textView, .toggle, .webView,
  ]

  /// Containers whose content scrolls; included even when unlabeled so the
  /// tree shows where scrolling is possible.
  static let scrollContainerTypes: Set<XCUIElement.ElementType> = [
    .scrollView, .table, .collectionView, .webView,
  ]

  /// Hard ceiling on emitted nodes so a pathological tree (deep React Native
  /// screens) cannot produce a multi-megabyte reply.
  static let snapshotNodeBudget = 1500

  /// Guard against cyclic or absurdly deep raw trees.
  private static let rawDepthLimit = 100

  /// Ceiling on emitted node depth.
  private static let emittedDepthLimit = 60

  /// Captures the accessibility tree in ONE XPC round trip (`snapshot()` on
  /// the app element) and then flattens it in-process: the traversal itself
  /// never talks to the AX server, which is what keeps this fast and immune
  /// to per-element query stalls.
  func captureSnapshot(of app: XCUIApplication) -> Envelope {
    var root: XCUIElementSnapshot?
    var lastError = ""

    for attempt in 0..<2 {
      if attempt > 0 { Thread.sleep(forTimeInterval: 0.4) }
      do {
        root = try app.snapshot()
        break
      } catch {
        lastError = String(describing: error)
      }
    }

    guard let root else {
      return .failure(
        .snapshotFailed,
        "XCTest could not capture the accessibility tree: \(lastError)",
        hint: "Retry after the UI settles, or use screenshot as visual truth."
      )
    }

    let nodes = Self.flatten(root)

    let capped = nodes.count >= Self.snapshotNodeBudget

    return .success(
      SnapshotPayload(
        nodes: nodes,
        quality: SnapshotQualityPayload(
          state: capped ? "degraded" : "healthy",
          backend: "xctest",
          reason: capped ? "node budget reached; deeper content was dropped" : nil,
          reasonCode: capped ? "node_cap" : nil
        )
      )
    )
  }

  /// Pure tree walk over the one-shot snapshot: filters to elements an agent
  /// can name or act on, assigns indices and parent links in emission order,
  /// and dedupes mirror elements.
  static func flatten(_ root: XCUIElementSnapshot) -> [SnapshotNodePayload] {
    struct WorkItem {
      let snapshot: XCUIElementSnapshot
      let rawDepth: Int
      let emittedDepth: Int
      let parentIndex: Int
    }

    let viewport = root.frame
    var nodes = [makeNode(root, index: 0, depth: 0, parentIndex: nil)]
    var seen: Set<String> = [identity(root)]

    var stack = root.children.reversed().map {
      WorkItem(snapshot: $0, rawDepth: 1, emittedDepth: 1, parentIndex: 0)
    }

    while let item = stack.popLast() {
      if nodes.count >= snapshotNodeBudget { break }
      if item.rawDepth > rawDepthLimit { continue }

      let snapshot = item.snapshot
      let frame = snapshot.frame
      let visible = viewport.isEmpty || (!frame.isEmpty && viewport.intersects(frame))

      let include = visible && item.emittedDepth <= emittedDepthLimit && shouldInclude(snapshot)
      let key = identity(snapshot)
      let duplicate = seen.contains(key)

      var childParentIndex = item.parentIndex
      var childEmittedDepth = item.emittedDepth

      if include && !duplicate {
        seen.insert(key)
        let index = nodes.count
        nodes.append(
          makeNode(snapshot, index: index, depth: item.emittedDepth, parentIndex: item.parentIndex)
        )
        childParentIndex = index
        childEmittedDepth += 1
      }

      for child in snapshot.children.reversed() {
        stack.append(
          WorkItem(
            snapshot: child,
            rawDepth: item.rawDepth + 1,
            emittedDepth: childEmittedDepth,
            parentIndex: childParentIndex
          )
        )
      }
    }

    return nodes
  }

  private static func shouldInclude(_ snapshot: XCUIElementSnapshot) -> Bool {
    if interactiveTypes.contains(snapshot.elementType) { return true }
    if scrollContainerTypes.contains(snapshot.elementType) { return true }

    return !snapshot.label.isEmpty || !snapshot.identifier.isEmpty
      || valueText(snapshot.value) != nil
  }

  private static func makeNode(
    _ snapshot: XCUIElementSnapshot,
    index: Int,
    depth: Int,
    parentIndex: Int?
  ) -> SnapshotNodePayload {
    let frame = snapshot.frame
    return SnapshotNodePayload(
      index: index,
      type: elementTypeName(snapshot.elementType),
      label: snapshot.label.isEmpty ? nil : snapshot.label,
      identifier: snapshot.identifier.isEmpty ? nil : snapshot.identifier,
      value: valueText(snapshot.value),
      // Sanitized: a geometry-less element reports CGRect.null (infinite
      // origin), and JSONEncoder refuses non-finite doubles; one such node
      // must not degrade the whole reply to the encode-failure fallback.
      rect: SnapshotRect(
        x: finite(frame.minX), y: finite(frame.minY),
        width: finite(frame.width), height: finite(frame.height)
      ),
      enabled: snapshot.isEnabled,
      focused: snapshot.hasFocus ? true : nil,
      selected: snapshot.isSelected ? true : nil,
      depth: depth,
      parentIndex: parentIndex
    )
  }

  /// Mirror elements (the same control surfaced twice by the AX tree) carry
  /// identical type, texts, and geometry; emitting both only pads the tree.
  private static func identity(_ snapshot: XCUIElementSnapshot) -> String {
    let frame = snapshot.frame

    return
      "\(snapshot.elementType.rawValue)|\(snapshot.label)|\(snapshot.identifier)|"
      + "\(keyCoordinate(frame.minX)),\(keyCoordinate(frame.minY)),"
      + "\(keyCoordinate(frame.width)),\(keyCoordinate(frame.height))"
  }

  /// Integer-ish dedup-key text for one frame coordinate. `Int(_: Double)`
  /// TRAPS on non-finite or > Int.max input, and geometry-less elements
  /// genuinely reach this walk with CGRect.null frames (infinite origin),
  /// which killed the whole runner process mid-snapshot. A trap cannot be
  /// caught in-process, so every conversion here must be total; the key only
  /// needs to be stable, not exact.
  private static func keyCoordinate(_ v: CGFloat) -> String {
    guard v.isFinite else { return String(describing: v) }
    return String(Int(min(max(v.rounded(), -1e15), 1e15)))
  }

  /// Non-finite coordinates collapse to 0 for the wire payload (see makeNode).
  private static func finite(_ v: CGFloat) -> Double {
    v.isFinite ? Double(v) : 0
  }

  private static func valueText(_ value: Any?) -> String? {
    guard let value, !(value is NSNull) else { return nil }
    let text = String(describing: value)
    return text.isEmpty ? nil : text
  }

  /// XCUIElement.ElementType → the stable names the TypeScript describe
  /// adapter maps onto accessibility roles.
  static func elementTypeName(_ type: XCUIElement.ElementType) -> String {
    switch type {
    case .any: return "Any"
    case .other: return "Other"
    case .application: return "Application"
    case .group: return "Group"
    case .window: return "Window"
    case .sheet: return "Sheet"
    case .drawer: return "Drawer"
    case .alert: return "Alert"
    case .dialog: return "Dialog"
    case .button: return "Button"
    case .radioButton: return "RadioButton"
    case .radioGroup: return "RadioGroup"
    case .checkBox: return "CheckBox"
    case .disclosureTriangle: return "DisclosureTriangle"
    case .popUpButton: return "PopUpButton"
    case .comboBox: return "ComboBox"
    case .menuButton: return "MenuButton"
    case .toolbarButton: return "ToolbarButton"
    case .popover: return "Popover"
    case .keyboard: return "Keyboard"
    case .key: return "Key"
    case .navigationBar: return "NavigationBar"
    case .tabBar: return "TabBar"
    case .tabGroup: return "TabGroup"
    case .toolbar: return "Toolbar"
    case .statusBar: return "StatusBar"
    case .table: return "Table"
    case .tableRow: return "TableRow"
    case .tableColumn: return "TableColumn"
    case .outline: return "Outline"
    case .outlineRow: return "OutlineRow"
    case .browser: return "Browser"
    case .collectionView: return "CollectionView"
    case .slider: return "Slider"
    case .pageIndicator: return "PageIndicator"
    case .progressIndicator: return "ProgressIndicator"
    case .activityIndicator: return "ActivityIndicator"
    case .segmentedControl: return "SegmentedControl"
    case .picker: return "Picker"
    case .pickerWheel: return "PickerWheel"
    case .switch: return "Switch"
    case .toggle: return "Toggle"
    case .link: return "Link"
    case .image: return "Image"
    case .icon: return "Icon"
    case .searchField: return "SearchField"
    case .scrollView: return "ScrollView"
    case .scrollBar: return "ScrollBar"
    case .staticText: return "StaticText"
    case .textField: return "TextField"
    case .secureTextField: return "SecureTextField"
    case .datePicker: return "DatePicker"
    case .textView: return "TextView"
    case .menu: return "Menu"
    case .menuItem: return "MenuItem"
    case .menuBar: return "MenuBar"
    case .menuBarItem: return "MenuBarItem"
    case .map: return "Map"
    case .webView: return "WebView"
    case .incrementArrow: return "IncrementArrow"
    case .decrementArrow: return "DecrementArrow"
    case .timeline: return "Timeline"
    case .ratingIndicator: return "RatingIndicator"
    case .valueIndicator: return "ValueIndicator"
    case .splitGroup: return "SplitGroup"
    case .splitter: return "Splitter"
    case .relevanceIndicator: return "RelevanceIndicator"
    case .colorWell: return "ColorWell"
    case .helpTag: return "HelpTag"
    case .matte: return "Matte"
    case .dockItem: return "DockItem"
    case .ruler: return "Ruler"
    case .rulerMarker: return "RulerMarker"
    case .grid: return "Grid"
    case .levelIndicator: return "LevelIndicator"
    case .cell: return "Cell"
    case .layoutArea: return "LayoutArea"
    case .layoutItem: return "LayoutItem"
    case .handle: return "Handle"
    case .stepper: return "Stepper"
    case .tab: return "Tab"
    case .touchBar: return "TouchBar"
    case .statusItem: return "StatusItem"
    @unknown default: return "Other"
    }
  }
}
