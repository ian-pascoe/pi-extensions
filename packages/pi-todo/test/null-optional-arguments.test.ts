import {
  expectNullOptionalArgumentsOmitted,
  recordToolRegistrations,
} from "@ian-pascoe/pi-utils/tool-testing";
import { expect, test } from "vitest";
import piTodoExtension from "../src/pi-todo-extension.js";

function registeredTodoTool() {
  const { pi, tools } = recordToolRegistrations();
  piTodoExtension(pi);
  const [todo] = tools;
  if (todo?.name !== "todo" || tools.length !== 1) throw new Error("Expected only the todo tool");
  return todo;
}

test("todo treats null for an optional parameter like omitting it", () => {
  // `description` is absent from the proven list: its schema accepts null, which removes it.
  const proven = expectNullOptionalArgumentsOmitted(registeredTodoTool(), { action: "list" });
  expect(proven).toEqual(expect.arrayContaining(["id", "title", "tasks", "updates", "status"]));
  expect(proven).not.toContain("description");
});

test("todo keeps null where it has a meaning: description null removes a description", () => {
  const todo = registeredTodoTool();
  const update = { action: "update", id: 1, description: null };
  expect(todo.prepareArguments?.(update)).toEqual(update);
  const batch = { action: "update", updates: [{ id: 1, description: null, title: null }] };
  expect(todo.prepareArguments?.(batch)).toEqual({
    action: "update",
    updates: [{ id: 1, description: null }],
  });
});

test("todo drops a null optional field of a new Task", () => {
  const added = { action: "add", tasks: [{ title: "T", description: null }] };
  expect(registeredTodoTool().prepareArguments?.(added)).toEqual({
    action: "add",
    tasks: [{ title: "T" }],
  });
});
