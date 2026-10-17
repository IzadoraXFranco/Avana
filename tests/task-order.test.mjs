import test from "node:test";
import assert from "node:assert/strict";
import { sortTasks, sortLabels } from "../src/taskOrder.ts";

function task(id, fields = {}) {
  return {
    id,
    title: id,
    position: 1024,
    executionOrder: null,
    priority: "",
    dueDate: null,
    plannedDate: null,
    section: "today",
    completionId: null,
    completedAt: null,
    createdAt: "2026-10-16T12:00:00.000Z",
    updatedAt: "2026-10-16T12:00:00.000Z",
    version: 1,
    ...fields,
  };
}
const ids = (tasks) => tasks.map((item) => item.id);

test("execution order is numeric, with unset values last in both directions", () => {
  const tasks = [
    task("ten", { executionOrder: 10 }),
    task("unset-first", { position: 10 }),
    task("two", { executionOrder: 2 }),
    task("unset-second", { position: 20 }),
    task("one", { executionOrder: 1 }),
  ];
  assert.deepEqual(ids(sortTasks(tasks, "execution", "today")), [
    "one",
    "two",
    "ten",
    "unset-first",
    "unset-second",
  ]);
  assert.deepEqual(ids(sortTasks(tasks, "executionDesc", "today")), [
    "ten",
    "two",
    "one",
    "unset-first",
    "unset-second",
  ]);
});

test("execution ties retain manual position and deterministic creation/id fallbacks", () => {
  const tasks = [
    task("last-position", { executionOrder: 2, position: 20 }),
    task("b", { executionOrder: 2, position: 10 }),
    task("a", { executionOrder: 2, position: 10 }),
    task("earlier-created", {
      executionOrder: 2,
      position: 10,
      createdAt: "2026-10-15T12:00:00.000Z",
    }),
  ];
  for (const sort of ["execution", "executionDesc"]) {
    const expected = ["earlier-created", "a", "b", "last-position"];
    assert.deepEqual(ids(sortTasks(tasks, sort, "today")), expected);
    assert.deepEqual(
      ids(sortTasks([...tasks].reverse(), sort, "today")),
      expected,
    );
  }
});

test("explicit user sorting also applies to Done Today and Done", () => {
  const tasks = [
    task("one", {
      section: null,
      completionId: "completion-one",
      completedAt: "2026-10-16T09:00:00.000Z",
      executionOrder: 1,
      priority: "low",
      dueDate: "2026-10-10",
    }),
    task("ten", {
      section: null,
      completionId: "completion-ten",
      completedAt: "2026-10-16T10:00:00.000Z",
      executionOrder: 10,
      priority: "high",
      dueDate: "2026-10-05",
    }),
    task("two", {
      section: null,
      completionId: "completion-two",
      completedAt: "2026-10-16T11:00:00.000Z",
      executionOrder: 2,
      priority: "medium",
      dueDate: "2026-10-15",
    }),
    task("unset", {
      section: null,
      completionId: "completion-unset",
      completedAt: "2026-10-16T08:00:00.000Z",
    }),
  ];
  const expected = {
    execution: ["one", "two", "ten", "unset"],
    executionDesc: ["ten", "two", "one", "unset"],
    priority: ["ten", "two", "one", "unset"],
    due: ["ten", "one", "two", "unset"],
    completion: ["two", "ten", "one", "unset"],
    completionAsc: ["unset", "one", "ten", "two"],
  };
  for (const section of ["doneToday", "done"]) {
    for (const [sort, order] of Object.entries(expected)) {
      assert.deepEqual(
        ids(sortTasks(tasks, sort, section)),
        order,
        `${section}: ${sort}`,
      );
    }
    // The default history view remains newest first, but never overrides a chosen sort.
    assert.deepEqual(
      ids(sortTasks(tasks, "manual", section)),
      expected.completion,
    );
  }
});

test("manual ordering of active tasks remains independent of execution order", () => {
  const tasks = [
    task("first-manual", { position: 10, executionOrder: 10 }),
    task("last-manual", { position: 30, executionOrder: 1 }),
    task("middle-manual", { position: 20, executionOrder: 2 }),
  ];
  assert.deepEqual(ids(sortTasks(tasks, "manual", "today")), [
    "first-manual",
    "middle-manual",
    "last-manual",
  ]);
  assert.deepEqual(ids(sortTasks(tasks, "execution", "today")), [
    "last-manual",
    "middle-manual",
    "first-manual",
  ]);
});

test("all sort modes preserve input ordering and every task field", () => {
  const tasks = Object.freeze([
    Object.freeze(
      task("later", {
        executionOrder: 10,
        priority: "high",
        position: 20,
        plannedDate: "2026-10-16",
        dueDate: "2026-10-20",
      }),
    ),
    Object.freeze(
      task("earlier", {
        executionOrder: 2,
        priority: "low",
        position: 10,
        section: null,
        completionId: "old-completion",
        completedAt: "2026-10-15T15:00:00.000Z",
      }),
    ),
    Object.freeze(task("unset")),
  ]);
  const snapshot = structuredClone(tasks);
  for (const sort of Object.keys(sortLabels)) {
    for (const section of ["backlog", "hold", "today", "doneToday", "done"]) {
      const result = sortTasks(tasks, sort, section);
      assert.notEqual(result, tasks);
      assert.deepEqual(tasks, snapshot);
      assert.equal(result.length, tasks.length);
      for (const item of result)
        assert.equal(
          item,
          tasks.find((source) => source.id === item.id),
        );
    }
  }
});
