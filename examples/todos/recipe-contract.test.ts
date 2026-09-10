import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createStylexTransformCollector } from "@hraness/ui/stylex-build";

const root = fileURLToPath(new URL("../../", import.meta.url));
const todoPath = new URL("./src/todo.stylex.ts", import.meta.url);
const workbenchPath = new URL("./direct/workbench.stylex.ts", import.meta.url);

// Compile the actual authored recipes and actual StyleX composition. This is a
// narrow emitted-declaration contract, not a substitute for native cascade parity.
async function declarations(source: string, path: URL, expressions: Readonly<Record<string, string>>) {
  const collector = createStylexTransformCollector(root);
  const probes = Object.entries(expressions).map(([name, expression]) =>
    `export const ${name} = stylex.props(${expression});`).join("\n");
  const result = await collector.transform(`${source}\n${probes}`, fileURLToPath(path));
  const file = ts.createSourceFile("compiled.js", result.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const output = new Map<string, ReadonlyMap<string, string>>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !Object.hasOwn(expressions, declaration.name.text)) continue;
      assert.ok(declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer), "Static props must compile to an object");
      const properties = declaration.initializer.properties;
      assert.equal(properties.length, 1, "Expected only a compiled className");
      const property = properties[0];
      assert.ok(property && ts.isPropertyAssignment(property));
      assert.ok((ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === "className");
      assert.ok(ts.isStringLiteral(property.initializer));
      const classes = property.initializer.text.split(" ");
      assert.ok(classes.length > 0 && classes.every((name) => /^x[a-z0-9]+$/u.test(name)));
      const values = new Map<string, string>();
      for (const name of classes) {
        const rule = result.rules.find(([className]) => className === name);
        assert.ok(rule, `Selected class ${name} must have an emitted rule`);
        // These probes concern unconditional physical paint. Preserve but do not
        // pretend to evaluate media/pseudo rules or model the browser cascade.
        const prefix = `.${name}{`;
        if (!rule[1].ltr.startsWith(prefix) || !rule[1].ltr.endsWith("}")) continue;
        const body = rule[1].ltr.slice(prefix.length, -1);
        assert.equal(/[{}]/u.test(body), false);
        for (const declaration of body.split(";").filter(Boolean)) {
          const colon = declaration.indexOf(":");
          assert.ok(colon > 0);
          const key = declaration.slice(0, colon);
          const value = declaration.slice(colon + 1);
          assert.ok(!values.has(key) || values.get(key) === value, `Conflicting selected declarations for ${key}`);
          values.set(key, value);
        }
      }
      output.set(declaration.name.text, values);
    }
  }
  assert.deepEqual([...output.keys()].sort(), Object.keys(expressions).sort());
  collector.seal();
  return output;
}

function border(values: ReadonlyMap<string, string> | undefined, color: string) {
  assert.ok(values);
  expect(values.get("border-width")).toBe("1px");
  expect(values.get("border-style")).toBe("solid");
  expect(values.get("border-color")).toBe(color);
}

test("compiled todo surfaces and retry retain borders, including the composed error color", async () => {
  const source = await readFile(todoPath, "utf8");
  const output = await declarations(source, todoPath, {
    surface: "todoStyles.surface",
    error: "todoStyles.surface, todoStyles.error",
    retry: "todoStyles.retry",
    eyebrow: "todoStyles.eyebrow",
    heading: "todoStyles.heading",
  });
  border(output.get("surface"), "#ccd7ce");
  border(output.get("error"), "#d39c8e");
  border(output.get("retry"), "#405849");
  for (const role of ["surface", "eyebrow", "heading"]) {
    expect(output.get(role)?.get("overflow-wrap")).toBe("normal");
  }
});

test("compiled workbench retains all border roles and selected-link composition", async () => {
  const source = await readFile(workbenchPath, "utf8");
  const output = await declarations(source, workbenchPath, {
    scenario: "workbenchStyles.scenario",
    current: "workbenchStyles.scenario, workbenchStyles.currentScenario",
    frame: "workbenchStyles.frame",
    error: "workbenchStyles.error",
  });
  border(output.get("scenario"), "#405849");
  border(output.get("current"), "#b7e2c1");
  border(output.get("frame"), "#ccd7ce");
  border(output.get("error"), "#d39c8e");
  for (const role of ["scenario", "current"]) {
    expect(output.get(role)?.get("text-underline-offset")).toBe("auto");
  }
});

test("emitted contracts reject omitted border and reset-restoration declarations", async () => {
  const todo = await readFile(todoPath, "utf8");
  const workbench = await readFile(workbenchPath, "utf8");
  const withoutBorders = todo.replaceAll(/^ {4}border(?:Width|Style|Color):.*\n/gmu, "");
  assert.notEqual(withoutBorders, todo);
  const omitted = await declarations(withoutBorders, todoPath, { surface: "todoStyles.surface" });
  expect(omitted.get("surface")?.has("border-width")).toBe(false);
  expect(omitted.get("surface")?.has("border-style")).toBe(false);
  expect(omitted.get("surface")?.has("border-color")).toBe(false);
  const withoutWrap = todo.replaceAll('    overflowWrap: "normal",\n', "");
  assert.notEqual(withoutWrap, todo);
  const wrapped = await declarations(withoutWrap, todoPath, { heading: "todoStyles.heading" });
  expect(wrapped.get("heading")?.has("overflow-wrap")).toBe(false);
  const withoutUnderline = workbench.replaceAll('    textUnderlineOffset: "auto",\n', "");
  assert.notEqual(withoutUnderline, workbench);
  const link = await declarations(withoutUnderline, workbenchPath, { scenario: "workbenchStyles.scenario" });
  expect(link.get("scenario")?.has("text-underline-offset")).toBe(false);
});
