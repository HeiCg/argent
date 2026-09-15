// swift-tools-version: 6.0
//
// Copied VERBATIM (with this provenance banner prepended) from the owner's
// device-farm/device-stream `tools/sim-input` for the argent fork's open iOS
// driver bench (ticket iOS-2). The four Swift sources under Sources/sim-input/
// are byte-identical to that source and carry their own Apache-2.0 provenance
// banners pointing at baguette (https://github.com/tddworks/baguette).
// Nothing here is reverse-engineered from any closed argent binary.

import PackageDescription

// Standalone Swift CLI ported from baguette's IndigoHIDInput +
// IOHIDDigitizerDispatch. SimulatorKit / CoreSimulator are NOT linked
// at build time — they are dlopen'd at runtime from the active Xcode's
// developer directory (resolved via `xcode-select -p` with a fallback
// scan of `/Applications/Xcode*.app`). Linking them statically would
// bake LC_LOAD_DYLIB entries that dyld must resolve before main(),
// which fails on hosts whose Xcode lives outside /Applications/Xcode.app.
let package = Package(
    name: "sim-input",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "sim-input",
            path: "Sources/sim-input"
        )
    ]
)
