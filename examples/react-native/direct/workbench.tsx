import type { ActiveDirect } from "@hraness/direct";
import { useMemo, useState, type ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";

import {
  deviceStatusDirectDefinition,
  deviceStatusScenarioMetadata,
  type DeviceStatusDirectRoute,
  type DeviceStatusViewport,
} from "./definition";
import type { DeviceStatusDirectWorld } from "./world";

function frameOnly(): boolean {
  return new URLSearchParams(globalThis.location.search).get("directFrame") === "1";
}

function scenarioUrl(id: string, route: string, onlyFrame = false): string {
  const url = new URL(route, globalThis.location.origin);
  url.searchParams.set("__direct_scenario", id);
  if (onlyFrame) url.searchParams.set("directFrame", "1");
  return url.toString();
}

export function DeviceStatusWorkbench({
  activation,
  children,
}: {
  readonly activation: ActiveDirect<DeviceStatusDirectWorld, DeviceStatusDirectRoute>;
  readonly children: ReactNode;
}) {
  const window = useWindowDimensions();
  const initialViewport = deviceStatusScenarioMetadata[activation.scenario]?.viewport ?? "phone";
  const [viewport, setViewport] = useState<DeviceStatusViewport>(initialViewport);
  const [query, setQuery] = useState("");
  const onlyFrame = frameOnly();
  const dimensions = viewport === "phone"
    ? { width: 390, height: 844 }
    : { width: 820, height: 1_080 };
  const scale = onlyFrame ? 1 : Math.min(1, (window.height - 76) / dimensions.height);
  const selected = deviceStatusDirectDefinition.scenarios.get(activation.scenario);
  const scenarios = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return deviceStatusDirectDefinition.scenarios.list().filter((scenario) => (
      normalized.length === 0
      || scenario.id.includes(normalized)
      || scenario.title.toLowerCase().includes(normalized)
      || (scenario.description?.toLowerCase().includes(normalized) ?? false)
    ));
  }, [query]);

  if (onlyFrame) {
    return (
      <View
        accessibilityLabel={`Direct ready: ${activation.scenario}`}
        nativeID="direct-frame"
        style={styles.frameOnly}
        testID="direct-frame"
      >
        {children}
      </View>
    );
  }

  return (
    <View
      accessibilityLabel={`Direct ready: ${activation.scenario}`}
      nativeID="direct-workbench"
      style={styles.workbench}
      testID="direct.react-native-example/v1"
    >
      <View style={styles.sidebar}>
        <View style={styles.brand}>
          <Text style={styles.eyebrow}>DIRECT · REACT NATIVE</Text>
          <Text style={styles.brandTitle}>Device UI lab</Text>
          <Text style={styles.brandDetail}>Real screen. Deterministic port. No simulator.</Text>
        </View>
        <TextInput
          accessibilityLabel="Search Direct scenarios"
          onChangeText={setQuery}
          placeholder="Search scenarios"
          placeholderTextColor="#73786e"
          style={styles.search}
          value={query}
        />
        <ScrollView contentContainerStyle={styles.scenarioList}>
          {scenarios.map((scenario) => {
            const active = scenario.id === activation.scenario;
            const metadata = deviceStatusScenarioMetadata[scenario.id];
            return (
              <Pressable
                accessibilityRole="link"
                key={scenario.id}
                onPress={() => globalThis.location.assign(scenarioUrl(scenario.id, scenario.route))}
                style={[styles.scenario, active && styles.scenarioActive]}
              >
                <Text style={[styles.scenarioGroup, active && styles.scenarioGroupActive]}>
                  {metadata?.group ?? "Device"}
                </Text>
                <Text style={[styles.scenarioTitle, active && styles.scenarioTitleActive]}>
                  {scenario.title}
                </Text>
                {scenario.description === null ? null : (
                  <Text style={styles.scenarioDetail}>{scenario.description}</Text>
                )}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <View style={styles.stage}>
        <View style={styles.toolbar}>
          <View style={styles.toolbarText}>
            <Text style={styles.toolbarTitle}>{selected?.title ?? activation.scenario}</Text>
            <Text style={styles.toolbarDetail}>{activation.scenario} · {viewport}</Text>
          </View>
          <View style={styles.toolbarActions}>
            {(["phone", "tablet"] as const).map((candidate) => (
              <Pressable
                accessibilityRole="button"
                key={candidate}
                onPress={() => setViewport(candidate)}
                style={[styles.toolbarButton, viewport === candidate && styles.toolbarButtonActive]}
              >
                <Text style={styles.toolbarButtonLabel}>{candidate}</Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="link"
              onPress={() => globalThis.open(
                scenarioUrl(activation.scenario, activation.route, true),
                "_blank",
              )}
              style={styles.toolbarButton}
            >
              <Text style={styles.toolbarButtonLabel}>open frame</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => globalThis.location.reload()}
              style={styles.toolbarButton}
            >
              <Text style={styles.toolbarButtonLabel}>reset</Text>
            </Pressable>
          </View>
        </View>
        <ScrollView contentContainerStyle={styles.stageScroll} horizontal>
          <View style={{ height: dimensions.height * scale, width: dimensions.width * scale }}>
            <View style={[
              styles.device,
              {
                height: dimensions.height,
                transform: [{ scale }],
                transformOrigin: "top left",
                width: dimensions.width,
              },
            ]}>
              {children}
            </View>
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frameOnly: { flex: 1 },
  workbench: { backgroundColor: "#10120e", flex: 1, flexDirection: "row" },
  sidebar: {
    backgroundColor: "#171a14",
    borderRightColor: "#32372d",
    borderRightWidth: 1,
    maxWidth: 330,
    width: 310,
  },
  brand: { borderBottomColor: "#32372d", borderBottomWidth: 1, gap: 5, padding: 20 },
  eyebrow: { color: "#b8ff55", fontSize: 10, fontWeight: "800", letterSpacing: 1.4 },
  brandTitle: { color: "#f4f6ed", fontSize: 24, fontWeight: "800" },
  brandDetail: { color: "#9ba293", fontSize: 12, lineHeight: 17 },
  search: {
    backgroundColor: "#22261e",
    borderColor: "#3a4033",
    borderRadius: 10,
    borderWidth: 1,
    color: "#f4f6ed",
    margin: 14,
    minHeight: 42,
    paddingHorizontal: 12,
  },
  scenarioList: { gap: 8, paddingBottom: 28, paddingHorizontal: 12 },
  scenario: { borderColor: "transparent", borderRadius: 10, borderWidth: 1, gap: 4, padding: 11 },
  scenarioActive: { backgroundColor: "#26321c", borderColor: "#679e29" },
  scenarioGroup: { color: "#848c7d", fontSize: 9, fontWeight: "800", letterSpacing: 0.9, textTransform: "uppercase" },
  scenarioGroupActive: { color: "#b8ff55" },
  scenarioTitle: { color: "#dde1d7", fontSize: 14, fontWeight: "700" },
  scenarioTitleActive: { color: "#ffffff" },
  scenarioDetail: { color: "#8f9788", fontSize: 11, lineHeight: 16 },
  stage: { flex: 1, minWidth: 0 },
  toolbar: {
    alignItems: "center",
    borderBottomColor: "#30352c",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    minHeight: 64,
    paddingHorizontal: 18,
  },
  toolbarText: { flex: 1, gap: 3 },
  toolbarTitle: { color: "#f4f6ed", fontSize: 15, fontWeight: "700" },
  toolbarDetail: { color: "#899182", fontFamily: "monospace", fontSize: 10 },
  toolbarActions: { flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" },
  toolbarButton: { borderColor: "#42483c", borderRadius: 7, borderWidth: 1, minHeight: 34, paddingHorizontal: 10, paddingVertical: 8 },
  toolbarButtonActive: { backgroundColor: "#344326", borderColor: "#78a943" },
  toolbarButtonLabel: { color: "#d9ddd3", fontSize: 10, fontWeight: "700", textTransform: "uppercase" },
  stageScroll: { alignItems: "flex-start", justifyContent: "center", minWidth: "100%", padding: 24 },
  device: {
    backgroundColor: "#ffffff",
    borderColor: "#3e4438",
    borderRadius: 24,
    borderWidth: 1,
    overflow: "hidden",
    shadowColor: "#000000",
    shadowOffset: { height: 12, width: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 30,
  },
});
