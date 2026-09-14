import XCTest

extension ArgentRunnerSession {
    /// Element types an agent can act on directly. Always included. (Base B list.)
    static let interactiveTypes: Set<XCUIElement.ElementType> = [
        .button, .cell, .checkBox, .collectionView, .datePicker, .link, .menuItem,
        .picker, .pickerWheel, .searchField, .segmentedControl, .slider, .stepper,
        .switch, .tabBar, .textField, .secureTextField, .textView, .toggle, .webView,
    ]

    /// Containers whose content scrolls. Included even when unlabeled so the tree
    /// shows where scrolling is possible. (Base B list; kept in lockstep with the
    /// host `SCROLL_CONTAINER_TYPES`.)
    static let scrollContainerTypes: Set<XCUIElement.ElementType> = [
        .scrollView, .table, .collectionView, .webView,
    ]

    /// Hard ceiling on emitted nodes (base B budget). Bounds the reply size.
    static let snapshotNodeBudget = 1500
    private static let rawDepthLimit = 100
    private static let emittedDepthLimit = 60

    /// One `app.snapshot()` XPC round trip, retried once. Carried over from base B.
    func snapshotRoot(of app: XCUIApplication) throws -> XCUIElementSnapshot {
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
            throw RunnerError.failed("XCTest could not capture the accessibility tree: \(lastError)")
        }
        return root
    }

    /// `getState` / `getNestedState`: one snapshot XPC round trip, flattened into a
    /// nested `children`-array tree, with per-stage timings whose sum is captureMs,
    /// the monotonic `version`, the info block, and (getState only) a screenshot.
    func captureState(
        _ params: RunnerParams,
        includeScreenshotDefault: Bool,
        forceNoScreenshot: Bool = false
    ) throws -> StateReply {
        let app = try resolveTargetApp(params)
        let maxElements = params.maxElements ?? Self.snapshotNodeBudget
        let wantScreenshot = forceNoScreenshot ? false : (params.includeScreenshot ?? includeScreenshotDefault)

        // captureMs spans the three capture stages (snapshot → serialize → encode)
        // so their sum ≈ captureMs. The screenshot is deliberately outside the span.
        let captureStart = Date()

        let snapStart = Date()
        let root = try snapshotRoot(of: app)
        let snapshotMs = Self.ms(since: snapStart)

        let serStart = Date()
        let (nodes, truncated) = Self.buildNested(root, maxElements: maxElements)
        let hash = Self.canonicalHash(nodes)
        let serializeMs = Self.ms(since: serStart)

        let encStart = Date()
        _ = try? JSONEncoder().encode(nodes)
        let encodeMs = Self.ms(since: encStart)

        let captureMs = Self.ms(since: captureStart)

        var screenshotB64: String?
        if wantScreenshot {
            let png = XCUIScreen.main.screenshot().pngRepresentation
            screenshotB64 = png.isEmpty ? nil : png.base64EncodedString()
        }

        let version = versionForHash(hash)
        let geo = Self.screenGeometry()
        let info = StateInfo(
            bundleId: targetBundleId() ?? (params.bundleId?.trimmedNonEmpty ?? ""),
            orientation: geo.width <= geo.height ? "portrait" : "landscape",
            keyboardVisible: app.keyboards.firstMatch.exists,
            screenWidth: geo.width,
            screenHeight: geo.height,
            scale: geo.scale
        )

        return StateReply(
            tree: nodes,
            truncated: truncated,
            info: info,
            version: version,
            timings: StateTimings(
                snapshotMs: snapshotMs,
                serializeMs: serializeMs,
                encodeMs: encodeMs,
                captureMs: captureMs
            ),
            screenshot: screenshotB64
        )
    }

    static func ms(since start: Date) -> Double {
        -start.timeIntervalSinceNow * 1000
    }

    /// Builds the nested tree from the snapshot: the Application root, then every
    /// element an agent can name or act on, viewport-intersecting, deduped, with a
    /// node budget. A non-included element's kept descendants are hoisted into its
    /// place, so a decorative wrapper never breaks the parent/child chain (the
    /// nested analogue of base B's `parentIndex` flattening).
    static func buildNested(_ root: XCUIElementSnapshot, maxElements: Int) -> (nodes: [NestedNode], truncated: Bool) {
        let viewport = root.frame
        var count = 1 // the root
        var truncated = false
        var seen: Set<String> = [identity(root)]

        func children(of snapshot: XCUIElementSnapshot, rawDepth: Int, emittedDepth: Int) -> [NestedNode] {
            var out: [NestedNode] = []
            for child in snapshot.children {
                if count >= maxElements {
                    truncated = true
                    break
                }
                if rawDepth + 1 > rawDepthLimit { continue }

                let frame = child.frame
                let visible = viewport.isEmpty || (!frame.isEmpty && viewport.intersects(frame))
                let key = identity(child)
                let duplicate = seen.contains(key)
                let include = visible && (emittedDepth + 1) <= emittedDepthLimit
                    && shouldInclude(child) && !duplicate

                if include {
                    seen.insert(key)
                    count += 1
                    let kids = children(of: child, rawDepth: rawDepth + 1, emittedDepth: emittedDepth + 1)
                    out.append(makeNode(child, children: kids))
                } else {
                    // Hoist the kept descendants of the dropped wrapper into this level.
                    let kids = children(of: child, rawDepth: rawDepth + 1, emittedDepth: emittedDepth)
                    out.append(contentsOf: kids)
                }
            }
            return out
        }

        let rootKids = children(of: root, rawDepth: 0, emittedDepth: 0)
        return ([makeNode(root, children: rootKids)], truncated)
    }

    /// Whether an element earns a node: interactive, a scroll container, or
    /// carrying any text. (Base B rule.)
    private static func shouldInclude(_ snapshot: XCUIElementSnapshot) -> Bool {
        if interactiveTypes.contains(snapshot.elementType) { return true }
        if scrollContainerTypes.contains(snapshot.elementType) { return true }
        return !snapshot.label.isEmpty || !snapshot.identifier.isEmpty || valueText(snapshot.value) != nil
    }

    /// One nested node in SCREEN POINTS. `hittable` is a heuristic — an
    /// `XCUIElementSnapshot` exposes no `isHittable` — so it reports true when the
    /// element is enabled and has on-screen area.
    private static func makeNode(_ snapshot: XCUIElementSnapshot, children: [NestedNode]) -> NestedNode {
        let f = snapshot.frame
        let hasArea = !f.isEmpty && f.isFinite && f.width > 0 && f.height > 0
        return NestedNode(
            type: elementTypeName(snapshot.elementType),
            label: snapshot.label.isEmpty ? nil : snapshot.label,
            identifier: snapshot.identifier.isEmpty ? nil : snapshot.identifier,
            value: valueText(snapshot.value),
            bounds: NodeBounds(
                x1: finite(f.minX), y1: finite(f.minY),
                x2: finite(f.maxX), y2: finite(f.maxY)
            ),
            enabled: snapshot.isEnabled,
            hittable: snapshot.isEnabled && hasArea,
            selected: snapshot.isSelected,
            focused: snapshot.hasFocus,
            children: children
        )
    }

    /// Dedup key: mirror elements share type, texts, and geometry. (Base B.)
    private static func identity(_ snapshot: XCUIElementSnapshot) -> String {
        let f = snapshot.frame
        return "\(snapshot.elementType.rawValue)|\(snapshot.label)|\(snapshot.identifier)|"
            + "\(keyCoordinate(f.minX)),\(keyCoordinate(f.minY)),"
            + "\(keyCoordinate(f.width)),\(keyCoordinate(f.height))"
    }

    private static func keyCoordinate(_ v: CGFloat) -> String {
        guard v.isFinite else { return String(describing: v) }
        return String(Int(min(max(v.rounded(), -1e15), 1e15)))
    }

    private static func finite(_ v: CGFloat) -> Double {
        v.isFinite ? Double(v) : 0
    }

    private static func valueText(_ value: Any?) -> String? {
        guard let value, !(value is NSNull) else { return nil }
        let text = String(describing: value)
        return text.isEmpty ? nil : text
    }

    /// FNV-1a over the emitted tree's `(type|label|identifier|value|rounded bounds)`
    /// DFS string — the canonical recipe the `version` hash-change counter keys off.
    static func canonicalHash(_ nodes: [NestedNode]) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        func feed(_ s: String) {
            for b in s.utf8 {
                hash ^= UInt64(b)
                hash = hash &* 0x100000001b3
            }
        }
        func intText(_ v: Double) -> String { String(Int(v.rounded())) }
        func walk(_ n: NestedNode) {
            feed(n.type); feed("|"); feed(n.label ?? ""); feed("|")
            feed(n.identifier ?? ""); feed("|"); feed(n.value ?? ""); feed("|")
            feed(intText(n.bounds.x1)); feed(","); feed(intText(n.bounds.y1)); feed(",")
            feed(intText(n.bounds.x2)); feed(","); feed(intText(n.bounds.y2))
            feed("[")
            for c in n.children { walk(c) }
            feed("]")
        }
        for n in nodes { walk(n) }
        return String(format: "%016llx", hash)
    }

    /// Stable type names for the wire payload; the TS describe adapter maps them
    /// onto accessibility roles. (Base B list, verbatim.)
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
