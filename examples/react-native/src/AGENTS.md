# Contents

- `device-status-port.ts` – product-owned platform-neutral status contract, values, cloning, and failure.
- `DeviceStatusApp.tsx` – real loading, ready, failure, and refresh interface shared by both compositions.
- `native-device-status-port.ts` – production React Native platform, appearance, and wall-clock adapter.
- `root.native.tsx` – production composition.
- `root.web.tsx` – development-only Direct composition selected by Metro for web.
- `root.tsx` – production-safe default that resolves to the native root.

# Guidelines

- Product UI depends only on `DeviceStatusPort`; it does not select native or deterministic behavior.
- Keep React Native platform imports in the production adapter and platform-resolved roots.
- Keep Direct imports out of this directory except the explicit `root.web.tsx` development boundary.
- Represent loading, success, and failure as an exhausted discriminated union and ignore stale asynchronous results.
- Keep every status and action accessible through a visible label or accessibility role.
