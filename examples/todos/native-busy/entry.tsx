import { createRoot } from "react-dom/client";
import { TodoApp } from "../src/TodoApp.js";
import { createControlledTodoPort, parseBusyOutcome } from "./controlled-port.js";
// Last import preserves each source tree's independently built document CSS.
import "../src/styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null || Object.hasOwn(window, "__todoBusyFixture")) throw new Error("Busy fixture requires its own fresh document");
const fixture = createControlledTodoPort(parseBusyOutcome(location.search));
Object.defineProperty(window, "__todoBusyFixture", {
  value: Object.freeze({ inspect: fixture.inspect, release: fixture.release }),
  enumerable: false, configurable: false, writable: false,
});
const root = createRoot(rootElement);
root.render(<TodoApp port={fixture.port} />);
window.addEventListener("pagehide", () => { root.unmount(); fixture.dispose(); }, { once: true });
