import { installDirectBrowser } from "@hraness/direct/web";
import { createRoot } from "react-dom/client";

import "../src/styles.css";
import { createTodoDirectSession } from "./session";
import { TodoDirectError, TodoDirectWorkbench } from "./workbench";
import "./workbench.css";

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Todo Direct root element is missing.");
const root = createRoot(rootElement);
const created = createTodoDirectSession(globalThis.location.search);

if (!created.ok) {
  root.render(<TodoDirectError message={created.error.message} />);
} else {
  const session = created.value;
  const installedBrowser = installDirectBrowser({
    session,
    reset: () => {
      globalThis.location.reload();
      return undefined;
    },
    firewall: {
      onActivityError: session.harness.recordActivityFailure,
      onBlocked: session.harness.recordBlockedNetworkRequest,
    },
  });
  if (!installedBrowser.ok) {
    session.dispose();
    throw new Error(installedBrowser.error.message);
  }

  globalThis.addEventListener("pagehide", session.dispose, { once: true });
  root.render(
    <TodoDirectWorkbench
      activeScenario={session.activation.scenario}
      harness={session.harness}
    />,
  );
}
