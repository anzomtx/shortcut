import assert from "node:assert/strict";
import test from "node:test";
import { findShortcutAction, normalizeShortcutEvent } from "../public/shortcut-model.js";

test("does not dispatch unassigned actions for modifier-only keys", () => {
  const shortcut = normalizeShortcutEvent({
    code: "MetaLeft",
    ctrlKey: false,
    metaKey: true,
    altKey: false,
    shiftKey: false,
  });
  assert.equal(shortcut, null);
  assert.equal(findShortcutAction({ "edit.removeSelected": null }, shortcut), null);
});

test("normalizes and resolves keyboard chords", () => {
  const shortcut = normalizeShortcutEvent({
    code: "KeyZ",
    ctrlKey: false,
    metaKey: true,
    altKey: false,
    shiftKey: true,
  });
  assert.equal(shortcut, "Mod+Shift+KeyZ");
  assert.equal(findShortcutAction({ "edit.redo": shortcut }, shortcut), "edit.redo");
});
