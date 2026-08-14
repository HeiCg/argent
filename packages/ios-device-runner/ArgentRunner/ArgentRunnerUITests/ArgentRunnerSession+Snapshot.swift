import XCTest

extension ArgentRunnerSession {
  /// Element types an agent can act on directly; always included.
  static let interactiveTypes: Set<XCUIElement.ElementType> = [
    .button, .cell, .checkBox, .collectionView, .datePicker, .link, .menuItem,
    .picker, .pickerWheel, .searchField, .segmentedControl, .slider, .stepper,
    .switch, .tabBar, .textField, .secureTextField, .textView, .toggle, .webView,
  ]

  /// Containers whose content scrolls; they anchor the hidden-content hints.
  static let scrollContainerTypes: Set<XCUIElement.ElementType> = [
    .scrollView, .table, .collectionView, .webView,
  ]

  /// Hard ceiling on emitted nodes so a pathological tree (deep React Native
  /// screens) cannot produce a multi-megabyte reply.
  static let snapshotNodeBudget = 1500

  /// Guard against cyclic or absurdly deep raw trees.
  private static let rawDepthLimit = 100

  /// Captures the accessibility tree in ONE XPC round trip (`snapshot()` on
  /// the app element) and then flattens it in-process — the traversal itself
  /// never talks to the AX server, which is what keeps this fast and immune
  /// to per-element query stalls.
  func captureSnapshot(_ request: CommandRequest, of app: XCUIApplication) -> Envelope {
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
    let nodes = Self.flatten(
      root,
      interactiveOnly: request.interactiveOnly ?? false,
      maxDepth: request.depth ?? 60
    )
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
  /// dedupes mirror elements, and annotates scroll containers whose content
  /// extends beyond the visible viewport.
  static func flatten(
    _ root: XCUIElementSnapshot,
    interactiveOnly: Bool,
    maxDepth: Int
  ) -> [SnapshotNodePayload] {
    struct WorkItem {
      let snapshot: XCUIElementSnapshot
      let rawDepth: Int
      let emittedDepth: Int
      let parentIndex: Int
      let scrollAnchor: (index: Int, rect: CGRect)?
    }

    let viewport = root.frame
    var nodes = [makeNode(root, index: 0, depth: 0, parentIndex: nil, visible: true)]
    var seen: Set<String> = [identity(root)]
    var hiddenAbove: Set<Int> = []
    var hiddenBelow: Set<Int> = []

    let rootAnchor = scrollAnchor(root, index: 0)
    var stack = root.children.reversed().map {
      WorkItem(snapshot: $0, rawDepth: 1, emittedDepth: 1, parentIndex: 0, scrollAnchor: rootAnchor)
    }

    while let item = stack.popLast() {
      if nodes.count >= snapshotNodeBudget { break }
      if item.rawDepth > rawDepthLimit { continue }

      let snapshot = item.snapshot
      let frame = snapshot.frame
      let visible = viewport.isEmpty || (!frame.isEmpty && viewport.intersects(frame))
      if !visible, let anchor = item.scrollAnchor {
        if frame.maxY <= anchor.rect.minY {
          hiddenAbove.insert(anchor.index)
        } else if frame.minY >= anchor.rect.maxY {
          hiddenBelow.insert(anchor.index)
        }
      }

      let include =
        visible && item.emittedDepth <= maxDepth
        && shouldInclude(snapshot, interactiveOnly: interactiveOnly)
      let key = identity(snapshot)
      let duplicate = seen.contains(key)

      var childParentIndex = item.parentIndex
      var childEmittedDepth = item.emittedDepth
      var childAnchor = item.scrollAnchor
      if include && !duplicate {
        seen.insert(key)
        let index = nodes.count
        nodes.append(
          makeNode(
            snapshot, index: index, depth: item.emittedDepth, parentIndex: item.parentIndex,
            visible: visible
          )
        )
        childParentIndex = index
        childEmittedDepth += 1
        childAnchor = scrollAnchor(snapshot, index: index) ?? item.scrollAnchor
      }
      for child in snapshot.children.reversed() {
        stack.append(
          WorkItem(
            snapshot: child,
            rawDepth: item.rawDepth + 1,
            emittedDepth: childEmittedDepth,
            parentIndex: childParentIndex,
            scrollAnchor: childAnchor
          )
        )
      }
    }

    for index in nodes.indices {
      if hiddenAbove.contains(index) { nodes[index].hiddenContentAbove = true }
      if hiddenBelow.contains(index) { nodes[index].hiddenContentBelow = true }
    }
    return nodes
  }

  private static func shouldInclude(
    _ snapshot: XCUIElementSnapshot,
    interactiveOnly: Bool
  ) -> Bool {
    if interactiveTypes.contains(snapshot.elementType) { return true }
    if interactiveOnly { return false }
    if scrollContainerTypes.contains(snapshot.elementType) { return true }
    return !snapshot.label.isEmpty || !snapshot.identifier.isEmpty
      || valueText(snapshot.value) != nil
  }

  private static func makeNode(
    _ snapshot: XCUIElementSnapshot,
    index: Int,
    depth: Int,
    parentIndex: Int?,
    visible: Bool
  ) -> SnapshotNodePayload {
    let frame = snapshot.frame
    return SnapshotNodePayload(
      index: index,
      type: elementTypeName(snapshot.elementType),
      label: snapshot.label.isEmpty ? nil : snapshot.label,
      identifier: snapshot.identifier.isEmpty ? nil : snapshot.identifier,
      value: valueText(snapshot.value),
      rect: SnapshotRect(
        x: frame.minX, y: frame.minY, width: frame.width, height: frame.height
      ),
      enabled: snapshot.isEnabled,
      focused: snapshot.hasFocus ? true : nil,
      selected: snapshot.isSelected ? true : nil,
      // A one-shot snapshot carries no true hittability; visible + enabled is
      // the honest approximation and the tool layer treats it as advisory.
      hittable: visible && snapshot.isEnabled,
      depth: depth,
      parentIndex: parentIndex,
      hiddenContentAbove: nil,
      hiddenContentBelow: nil
    )
  }

  /// Mirror elements (the same control surfaced twice by the AX tree) carry
  /// identical type, texts, and geometry; emitting both only pads the tree.
  private static func identity(_ snapshot: XCUIElementSnapshot) -> String {
    let frame = snapshot.frame
    return
      "\(snapshot.elementType.rawValue)|\(snapshot.label)|\(snapshot.identifier)|"
      + "\(Int(frame.minX)),\(Int(frame.minY)),\(Int(frame.width)),\(Int(frame.height))"
  }

  private static func scrollAnchor(
    _ snapshot: XCUIElementSnapshot,
    index: Int
  ) -> (index: Int, rect: CGRect)? {
    scrollContainerTypes.contains(snapshot.elementType) ? (index, snapshot.frame) : nil
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
