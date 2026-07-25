# Expo / React Native example

This small Expo app demonstrates a production-safe boundary for Direct. The same `DeviceStatusApp` renders in both compositions:

```text
                  DeviceStatusApp
                         |
                 DeviceStatusPort
                    /          \
       root.native.tsx          root.web.tsx
       React Native adapter     Direct session
       iOS / Android            deterministic world
```

Metro selects `root.native.tsx` for iOS and Android and `root.web.tsx` for the development web surface. The native root cannot reach the Direct world, deterministic adapter, workbench, browser bridge, or fetch firewall.

## Run it

From the Direct repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run example:react-native
```

Open the Expo URL printed for web. Select `iOS · light`, `Android · dark`, or `Inspection failure` in the scenario sidebar. Add `directFrame=1` to a scenario URL to render only the device frame.

Run the complete non-simulator gate with:

```sh
bun run example:react-native:test
bun run example:react-native:typecheck
bun run example:react-native:verify
```

The verifier exports production JavaScript and paired external source maps for iOS and Android. It requires the real product screen and native adapter, rejects Direct package modules and web-composition sources structurally, and scans for defense-in-depth string markers. It then exports the deterministic React Native Web composition with a paired source map, requires the shared screen, product port, web root, deterministic adapter, and workbench, and rejects native roots or adapters. It uses temporary output directories and leaves no build artifacts in the source tree.

## What the example proves

`ios-ready`, `android-dark`, and `inspection-failure` compose the real React Native component and asynchronous screen state through a deterministic product port. Unit tests exercise the strict worlds, scenario coverage, port success/failure/cancellation, probe accounting, and Strict Mode-style mount cleanup/replay. The session exposes the canonical browser probe, blocks unmapped application `fetch` calls, and disposes in-flight operations.

The checked gate does not launch a browser or make semantic assertions against rendered DOM. A product verifier must still boot each claimed scenario, join the browser probe, and assert the expected accessible state and interactions. The web export check proves that Metro selected the deterministic composition; it is not a substitute for those runtime assertions.

This is fixture evidence. It does not exercise React Native platform detection, `Appearance`, native layout, Metro's host runtime, operating-system behavior, or a physical device. Those remain the `native.platform.direct` coverage claim. The iOS and Android scans prove that the emitted bundles selected the expected native composition and that their configured marker and source-map policies found no Direct dependency.

The example defines its worlds and claims at the package root, creates one harness session through `@hraness/direct/testing`, and installs that session's bridge and fetch boundary atomically through `@hraness/direct/web`. React bindings already work with React Native, while the workbench, scenarios, product ports, and platform metadata belong to the app.
