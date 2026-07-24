import { createDirectReactBindings } from "@cclrte/direct/react";
import { useLayoutEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { DeviceStatusApp } from "../src/DeviceStatusApp";
import { mountDeviceStatusDirect, type DeviceStatusSession } from "./mount";
import { DeviceStatusWorkbench } from "./workbench";
import type { DeviceStatusDirectWorld } from "./world";

const directReact = createDirectReactBindings<DeviceStatusDirectWorld>();

function currentSearch(): string {
  return globalThis.location.search;
}

function ActivationError({ message }: { readonly message: string }) {
  return (
    <View accessibilityLabel={`Direct error: ${message}`} nativeID="direct-error" style={styles.error}>
      <Text accessibilityRole="header" style={styles.errorTitle}>Direct activation failed</Text>
      <Text selectable style={styles.errorDetail}>{message}</Text>
    </View>
  );
}

function ActiveComposition({ session }: { readonly session: DeviceStatusSession }) {
  return (
    <directReact.Provider store={session.store}>
      <DeviceStatusWorkbench activation={session.activation}>
        <DeviceStatusApp port={session.harness.port} />
      </DeviceStatusWorkbench>
    </directReact.Provider>
  );
}

export function ReactNativeDirectRoot() {
  const source = currentSearch();
  const [state, setState] = useState<
    | { readonly kind: "starting" }
    | { readonly kind: "error"; readonly message: string }
    | { readonly kind: "active"; readonly session: DeviceStatusSession }
  >({ kind: "starting" });

  useLayoutEffect(() => {
    const mounted = mountDeviceStatusDirect(source);
    if (!mounted.ok) {
      setState({ kind: "error", message: mounted.error.message });
      return;
    }
    setState({ kind: "active", session: mounted.value.session });
    return mounted.value.dispose;
  }, [source]);

  if (state.kind === "error") return <ActivationError message={state.message} />;
  if (state.kind === "starting") {
    return <View accessibilityLabel="Direct starting" style={styles.starting} />;
  }
  return <ActiveComposition session={state.session} />;
}

const styles = StyleSheet.create({
  starting: { backgroundColor: "#10120f", flex: 1 },
  error: {
    alignItems: "center",
    backgroundColor: "#190f0f",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    padding: 28,
  },
  errorTitle: { color: "#ffb1aa", fontSize: 24, fontWeight: "800" },
  errorDetail: { color: "#d7aaa6", fontFamily: "monospace", fontSize: 13, maxWidth: 720 },
});
