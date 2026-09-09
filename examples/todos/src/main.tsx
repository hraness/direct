import { createRoot } from "react-dom/client";

import { createLocalStorageTodoPort } from "./local-storage-todo-port";
import { TodoApp } from "./TodoApp";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Todo root element is missing.");

createRoot(root).render(<TodoApp port={createLocalStorageTodoPort(globalThis.localStorage)} />);
