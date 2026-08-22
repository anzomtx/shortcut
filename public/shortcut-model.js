const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
]);

export function normalizeShortcutEvent(event) {
  if (MODIFIER_CODES.has(event.code)) return null;
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(event.code);
  return parts.join("+");
}

export function findShortcutAction(shortcuts, shortcut) {
  if (!shortcut) return null;
  return Object.entries(shortcuts).find(([, candidate]) => candidate === shortcut)?.[0] ?? null;
}
