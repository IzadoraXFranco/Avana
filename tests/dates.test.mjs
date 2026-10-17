import test from "node:test";
import assert from "node:assert/strict";
import { today, sectionOf, isOverdue, formatDate } from "../src/dates.ts";

test("UI groups the same completion by the configured timezone without changing its date", () => {
  const task = { section: null, completedAt: "2026-10-16T02:59:59.000Z" };
  assert.equal(sectionOf(task, "2026-10-15", "America/Sao_Paulo"), "doneToday");
  assert.equal(sectionOf(task, "2026-10-16", "America/Sao_Paulo"), "done");
  assert.equal(sectionOf(task, "2026-10-16", "UTC"), "doneToday");
  assert.equal(task.completedAt, "2026-10-16T02:59:59.000Z");
  assert.equal(
    today("America/Sao_Paulo", new Date("2026-10-16T03:00:00Z")),
    "2026-10-16",
  );
});

test("reopening the app after local midnight groups persisted completions without rewriting them", () => {
  const timezone = "America/Sao_Paulo";
  const task = {
    id: "completed-near-midnight",
    section: null,
    completionId: "first-completion",
    completedAt: "2026-10-17T02:59:59.999Z",
    version: 8,
    comments: [{ body: "Entrega registrada", kind: "evidence" }],
    activity: [{ type: "complete", createdAt: "2026-10-17T02:59:59.999Z" }],
  };
  const persisted = JSON.stringify(task);
  assert.equal(
    sectionOf(task, today(timezone, new Date(task.completedAt)), timezone),
    "doneToday",
  );

  // Each read represents a fresh app session, without a midnight job or prior UI state.
  for (const reopenedAt of [
    "2026-10-17T03:00:00.000Z",
    "2026-10-17T12:00:00.000Z",
    "2026-10-20T12:00:00.000Z",
  ]) {
    const restored = Object.freeze(JSON.parse(persisted));
    const group = sectionOf(
      restored,
      today(timezone, new Date(reopenedAt)),
      timezone,
    );
    assert.equal(group, "done");
    assert.deepEqual(restored, task);
    assert.equal(restored.activity.length, 1);
  }
});

test("completion rollover follows the configured local day even when the UTC day stays unchanged", () => {
  const task = Object.freeze({
    section: null,
    completedAt: "2026-10-16T09:59:59.000Z",
  });
  const reopenedAt = new Date("2026-10-16T10:00:00.000Z");
  assert.equal(today("Pacific/Kiritimati", reopenedAt), "2026-10-17");
  assert.equal(
    sectionOf(task, today("Pacific/Kiritimati", reopenedAt), "Pacific/Kiritimati"),
    "done",
  );
  assert.equal(today("America/Sao_Paulo", reopenedAt), "2026-10-16");
  assert.equal(
    sectionOf(task, today("America/Sao_Paulo", reopenedAt), "America/Sao_Paulo"),
    "doneToday",
  );
});

test("historical completions do not put a reopened task back into a completed grouping", () => {
  const task = Object.freeze({
    section: "today",
    completionId: null,
    completedAt: null,
    plannedDate: "2026-10-17",
    completions: [{ id: "old", completedAt: "2026-10-16T15:00:00.000Z" }],
  });
  assert.equal(sectionOf(task, "2026-10-17", "America/Sao_Paulo"), "today");
  const completedAgain = {
    ...task,
    section: null,
    completionId: "new",
    completedAt: "2026-10-17T15:00:00.000Z",
  };
  assert.equal(
    sectionOf(completedAgain, "2026-10-17", "America/Sao_Paulo"),
    "doneToday",
  );
  assert.equal(
    sectionOf(completedAgain, "2026-10-18", "America/Sao_Paulo"),
    "done",
  );
  assert.deepEqual(completedAgain.completions, task.completions);
});

test("UI retains yesterday in the daily section, and Hold does not hide overdue deadlines", () => {
  const task = {
    section: "today",
    plannedDate: "2026-10-15",
    dueDate: "2026-10-15",
    dueTime: null,
    completedAt: null,
  };
  assert.equal(sectionOf(task, "2026-10-16"), "today");
  assert.equal(isOverdue({ ...task, section: "hold" }, "2026-10-16"), true);
  assert.equal(isOverdue({ ...task, dueDate: null }, "2026-10-16"), false);
  assert.equal(
    isOverdue({ ...task, completedAt: "2026-10-16T12:00:00Z" }, "2026-10-16"),
    false,
  );
});
test("UI distinguishes date-only deadlines from timed deadlines in their original timezone", () => {
  const task = {
    completedAt: null,
    dueDate: "2026-10-16",
    dueTime: null,
    dueTimezone: "America/Sao_Paulo",
  };
  assert.equal(
    isOverdue(task, "2026-10-16", new Date("2026-10-17T02:59:00Z")),
    false,
  );
  assert.equal(isOverdue(task, "2026-10-17"), true);
  assert.equal(
    isOverdue(
      { ...task, dueTime: "09:00" },
      "2026-10-16",
      new Date("2026-10-16T11:59:00Z"),
    ),
    false,
  );
  assert.equal(
    isOverdue(
      { ...task, dueTime: "09:00" },
      "2026-10-16",
      new Date("2026-10-16T12:01:00Z"),
    ),
    true,
  );
  assert.match(formatDate("2026-10-16"), /16/);
});
