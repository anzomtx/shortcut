import {
  buildSequenceLayout,
  getSequenceDurationUs,
  mapSequenceToSource,
  subtractSequenceRange,
} from "./edit-model.js";
import { findShortcutAction, normalizeShortcutEvent } from "./shortcut-model.js";

const DEFAULT_PREFERENCES = {
  version: 1,
  sidebarCollapsed: true,
  defaultEditMode: "remove",
  libraryPath: "",
  exportPath: "",
  exportNameTemplate: "%o-%m-%h.%ext",
  importSearchPaths: [],
  onlyFastEdits: false,
  previewScale: "source",
  previewGeneration: true,
  stillsSeeking: true,
  stillsScale: "half",
  shortcuts: {
    "ui.toggleSidebar": "KeyB",
    "ui.openPreferences": "Mod+Comma",
    "playback.toggle": "Space",
    "playback.previousKeyframe": "ArrowDown",
    "playback.nextKeyframe": "ArrowUp",
    "playback.backward1": null,
    "playback.forward1": null,
    "playback.backward3": "ArrowLeft",
    "playback.forward3": "ArrowRight",
    "playback.backward6": null,
    "playback.forward6": null,
    "playback.backward10": null,
    "playback.forward10": null,
    "edit.markIn": "KeyZ",
    "edit.markOut": "KeyC",
    "edit.applyRange": "KeyX",
    "edit.removeSelected": "Delete",
    "edit.undo": "Mod+KeyZ",
    "edit.redo": "Mod+Shift+KeyZ",
    "project.save": "Mod+KeyS",
  },
};

const video = document.querySelector("#video");
const viewerShell = document.querySelector(".viewer-shell");
const viewerEmpty = document.querySelector("#viewer-empty");
const viewerTitle = document.querySelector("#viewer-title");
const metadata = document.querySelector("#media-metadata");
const rootPath = document.querySelector("#root-path");
const missingPathWarning = document.querySelector("#missing-path-warning");
const fileList = document.querySelector("#file-list");
const notice = document.querySelector("#notice");
const refreshButton = document.querySelector("#refresh-button");
const serverStatus = document.querySelector("#server-status");
const playheadTime = document.querySelector("#playhead-time");
const timeline = document.querySelector("#timeline");
const inPoint = document.querySelector("#in-point");
const outPoint = document.querySelector("#out-point");
const editedDuration = document.querySelector("#edited-duration");
const segmentList = document.querySelector("#segment-list");
const applyRangeButton = document.querySelector("#apply-range");
const includeModeButton = document.querySelector("#include-mode");
const removeModeButton = document.querySelector("#remove-mode");
const projectName = document.querySelector("#project-name");
const saveProjectButton = document.querySelector("#save-project");
const projectList = document.querySelector("#project-list");
const importProjectButton = document.querySelector("#import-project");
const projectFileInput = document.querySelector("#project-file-input");
const exportFastButton = document.querySelector("#export-fast");
const exportAccurateButton = document.querySelector("#export-accurate");
const exportQueueList = document.querySelector("#export-queue-list");
const exportQueueSummary = document.querySelector("#export-queue-summary");
const clearExportQueueButton = document.querySelector("#clear-export-queue");
const startExportQueueButton = document.querySelector("#start-export-queue");
const appLayout = document.querySelector("#app-layout");
const libraryPanel = document.querySelector("#library-panel");
const panelResizer = document.querySelector("#panel-resizer");
const panelTabs = [...document.querySelectorAll("[data-panel-tab]")];
const panelContents = [...document.querySelectorAll("[data-panel-content]")];
const toggleSidebarButton = document.querySelector("#toggle-sidebar");
const openPreferencesButton = document.querySelector("#open-preferences");
const openAdminButton = document.querySelector("#open-admin");
const adminDialog = document.querySelector("#admin-dialog");
const closeAdminButton = document.querySelector("#close-admin");
const adminLogElement = document.querySelector("#admin-log");
const adminStopButton = document.querySelector("#admin-stop");
const adminRestartButton = document.querySelector("#admin-restart");
const adminShutdownButton = document.querySelector("#admin-shutdown");
const preferencesDialog = document.querySelector("#preferences-dialog");
const preferencesForm = document.querySelector("#preferences-form");
const closePreferencesButton = document.querySelector("#close-preferences");
const defaultEditModeSelect = document.querySelector("#default-edit-mode");
const libraryPathInput = document.querySelector("#library-path");
const exportPathInput = document.querySelector("#export-path");
const exportNameTemplateInput = document.querySelector("#export-name-template");
const exportNameExample = document.querySelector("#export-name-example");
const importSearchPathsInput = document.querySelector("#import-search-paths");
const onlyFastEditsInput = document.querySelector("#only-fast-edits");
const previewScaleSelect = document.querySelector("#preview-scale");
const previewProgress = document.querySelector("#preview-progress");
const previewGenerationInput = document.querySelector("#preview-generation");
const stillsSeekingInput = document.querySelector("#stills-seeking");
const previewControls = document.querySelector("#preview-controls");
const stillIndicator = document.querySelector("#still-indicator");
const stillElement = document.querySelector("#keyframe-still");
const stillsProgress = document.querySelector("#stills-progress");
const adminStopBackgroundButton = document.querySelector("#admin-stop-background");
const stillsScaleSelect = document.querySelector("#stills-scale");
const mediaList = document.querySelector("#media-list");
const clearMediaButton = document.querySelector("#clear-media");
const shortcutList = document.querySelector("#shortcut-list");
const preferencesMessage = document.querySelector("#preferences-message");
const resetShortcutsButton = document.querySelector("#reset-shortcuts");
const clearProxiesButton = document.querySelector("#clear-proxies");
const recoveryBar = document.querySelector("#recovery-bar");
const recoveryMessage = document.querySelector("#recovery-message");
const recoveryRestoreButton = document.querySelector("#recovery-restore");
const recoveryDismissButton = document.querySelector("#recovery-dismiss");

const DRAFT_KEY = "shortcut.draft.v1";
const CLEAN_CLOSE_KEY = "shortcut.clean-close";

let currentMedia = null;
let keyframesUs = [];
let sourceMetadataLine = "";
let previewIsProxy = false;
let stillBaseUrl = null;
let stillCount = 0;
let stillMode = false;
let pendingTargetUs = null;
let markInUs = 0;
let markOutUs = 0;
let segments = [];
let selectedSegmentId = null;
let currentProjectId = null;
let selectedMediaPath = null;
let selectedProjectId = null;
let selectedExportJobId = null;
let editMode = "remove";
let sequencePlayheadUs = 0;
let activeSegmentIndex = 0;
let programmaticSeek = false;
let undoStack = [];
let redoStack = [];
let preferences = structuredClone(DEFAULT_PREFERENCES);
let preferencesDraft = structuredClone(DEFAULT_PREFERENCES);
let capturingActionId = null;
let savingPreferences = false;

const ICON_PATHS = {
  open: ["M3 7h6l2 2h10v9H3z", "M3 7V5h7l2 2"],
  download: ["M12 3v11", "m8 10 4 4 4-4", "M5 19h14"],
  delete: ["M4 7h16", "M9 7V4h6v3", "m7 7-1 7H8L7 7"],
};

function makeIconButton(label, paths) {
  const button = document.createElement("button");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  button.type = "button";
  button.className = "icon-button";
  button.title = label;
  button.setAttribute("aria-label", label);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const data of paths) {
    const pathElement = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pathElement.setAttribute("d", data);
    svg.append(pathElement);
  }
  button.append(svg);
  return button;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent > 1 ? 1 : 0)} ${units[exponent]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "Duration unavailable";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return [hours, minutes, remainingSeconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function formatTimeUs(timestampUs) {
  const totalMilliseconds = Math.max(0, Math.round(timestampUs / 1_000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000);
  const milliseconds = totalMilliseconds % 1_000;
  return `${[hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":")}.${String(milliseconds).padStart(3, "0")}`;
}

function sequenceLayout() {
  return buildSequenceLayout(segments);
}

function sequenceDurationUs() {
  return getSequenceDurationUs(segments);
}

function sequenceToSource(timestampUs) {
  return mapSequenceToSource(segments, timestampUs);
}

function sourceToSequence(sourceUs, preferredIndex = activeSegmentIndex) {
  const layout = sequenceLayout();
  const preferred = layout[preferredIndex];
  if (preferred && sourceUs >= preferred.segment.inUs && sourceUs <= preferred.segment.outUs) {
    return preferred.sequenceInUs + sourceUs - preferred.segment.inUs;
  }
  const item = layout.find(
    (candidate) => sourceUs >= candidate.segment.inUs && sourceUs < candidate.segment.outUs,
  );
  return item ? item.sequenceInUs + sourceUs - item.segment.inUs : null;
}

function timelineDurationUs() {
  return editMode === "remove" ? sequenceDurationUs() : currentMedia?.durationUs ?? 0;
}

function currentEditTimeUs() {
  if (stillMode && pendingTargetUs !== null) return pendingTargetUs;
  return editMode === "remove" ? sequencePlayheadUs : Math.round(video.currentTime * 1_000_000);
}

function isKeyframe(timestampUs) {
  if (keyframesUs.length === 0) return false;
  if (timestampUs <= keyframesUs[0]) return true;
  let low = 0;
  let high = keyframesUs.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (keyframesUs[middle] < timestampUs) low = middle + 1;
    else high = middle;
  }
  return [keyframesUs[low - 1], keyframesUs[low]].some(
    (keyframe) => Number.isFinite(keyframe) && Math.abs(keyframe - timestampUs) <= 80_000,
  );
}

function snapToKeyframe(timestampUs) {
  let low = 0;
  let high = keyframesUs.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (keyframesUs[middle] < timestampUs) low = middle + 1;
    else high = middle;
  }
  const candidates = [keyframesUs[low - 1], keyframesUs[low]];
  let best = timestampUs;
  let bestDelta = Infinity;
  for (const keyframe of candidates) {
    if (!Number.isFinite(keyframe)) continue;
    const delta = Math.abs(keyframe - timestampUs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = keyframe;
    }
  }
  return bestDelta <= 80_000 ? best : timestampUs;
}

function snapEditPoint(timestampUs) {
  if (preferences.onlyFastEdits) return nearestInSorted(keyframesUs, timestampUs);
  return snapToKeyframe(timestampUs);
}

function nearestInSorted(arr, targetUs) {
  if (arr.length === 0) return targetUs;
  let low = 0;
  let high = arr.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (arr[middle] < targetUs) low = middle + 1;
    else high = middle;
  }
  const before = arr[low - 1];
  const after = arr[low];
  if (!Number.isFinite(before)) return Number.isFinite(after) ? after : targetUs;
  if (!Number.isFinite(after)) return before;
  return Math.abs(before - targetUs) <= Math.abs(after - targetUs) ? before : after;
}

function sequenceKeyframesUs() {
  if (editMode !== "remove") return keyframesUs;
  const result = [];
  for (const item of sequenceLayout()) {
    for (const keyframe of keyframesUs) {
      if (keyframe < item.segment.inUs) continue;
      if (keyframe >= item.segment.outUs) break;
      result.push(item.sequenceInUs + keyframe - item.segment.inUs);
    }
  }
  return result;
}

function drawTimeline() {
  const context = timeline.getContext("2d");
  const width = timeline.clientWidth;
  const height = timeline.clientHeight;
  const scale = window.devicePixelRatio || 1;
  timeline.width = Math.round(width * scale);
  timeline.height = Math.round(height * scale);
  context.scale(scale, scale);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#0a0b09";
  context.fillRect(0, 0, width, height);

  const durationUs = timelineDurationUs();
  if (!currentMedia || durationUs <= 0) return;
  const toX = (timestampUs) => (timestampUs / durationUs) * width;
  context.fillStyle = "#36382f";
  context.fillRect(0, height / 2 - 1, width, 2);

  if (editMode === "remove") {
    for (const item of sequenceLayout()) {
      const start = toX(item.sequenceInUs);
      const clipWidth = Math.max(2, toX(item.sequenceOutUs) - start);
      context.fillStyle = item.index % 2 === 0 ? "rgba(91, 181, 255, 0.34)" : "rgba(91, 181, 255, 0.22)";
      context.fillRect(start, 8, clipWidth, height - 16);
      context.strokeStyle = "#5bb5ff";
      context.strokeRect(start + 0.5, 8.5, clipWidth - 1, height - 17);
    }
  } else {
    for (const segment of segments) {
      const start = toX(segment.inUs);
      const clipWidth = Math.max(2, toX(segment.outUs) - start);
      context.fillStyle = "rgba(91, 181, 255, 0.38)";
      context.fillRect(start, 8, clipWidth, height - 16);
      context.strokeStyle = "#5bb5ff";
      context.strokeRect(start + 0.5, 8.5, clipWidth - 1, height - 17);
    }
  }

  context.fillStyle = "rgba(209, 254, 63, 0.7)";
  const visibleKeyframes = sequenceKeyframesUs();
  const keyframeStep = Math.max(1, Math.ceil(visibleKeyframes.length / Math.max(width / 3, 1)));
  for (let index = 0; index < visibleKeyframes.length; index += keyframeStep) {
    context.fillRect(Math.round(toX(visibleKeyframes[index])), height / 2 - 8, 1, 16);
  }

  context.fillStyle = "#f0a36e";
  context.fillRect(toX(markInUs), 0, 2, height);
  context.fillStyle = "#ef6e68";
  context.fillRect(toX(markOutUs) - 2, 0, 2, height);
  context.fillStyle = "#f4f3ea";
  context.fillRect(toX(currentEditTimeUs()) - 1, 0, 2, height);
}

function renderMarks() {
  const prefix = editMode === "remove" ? "Seq " : "";
  inPoint.value = `${prefix}In ${formatTimeUs(markInUs)}`;
  outPoint.value = `${prefix}Out ${formatTimeUs(markOutUs)}`;
  const sourceIn = editMode === "remove" ? sequenceToSource(markInUs)?.sourceUs : markInUs;
  inPoint.classList.toggle("on-keyframe", Number.isFinite(sourceIn) && isKeyframe(sourceIn));
  applyRangeButton.disabled = !currentMedia || markOutUs <= markInUs;
  drawTimeline();
  updateControlStates();
  persistDraft();
}

function renderSegments() {
  segmentList.replaceChildren();
  selectedSegmentId = segments.some((segment) => segment.id === selectedSegmentId)
    ? selectedSegmentId
    : segments[0]?.id ?? null;
  editedDuration.value = `Edited duration ${formatTimeUs(sequenceDurationUs())}`;

  if (segments.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-segments";
    empty.textContent = editMode === "remove" ? "The sequence is empty. Undo or reset to restore it." : "Mark a source range, then include it.";
    segmentList.append(empty);
  }

  const layout = sequenceLayout();
  segments.forEach((segment, index) => {
    const item = document.createElement("li");
    const jumpButton = document.createElement("button");
    const detail = document.createElement("span");
    const mode = document.createElement("small");
    const removeButton = document.createElement("button");
    item.classList.toggle("selected", segment.id === selectedSegmentId);
    item.addEventListener("click", () => {
      selectedSegmentId = segment.id;
      renderSegments();
    });
    jumpButton.type = "button";
    jumpButton.textContent = String(index + 1).padStart(2, "0");
    jumpButton.title = "Jump to clip start";
    jumpButton.addEventListener("click", (event) => {
      event.stopPropagation();
      selectedSegmentId = segment.id;
      if (editMode === "remove") setSequencePlayhead(layout[index].sequenceInUs);
      else video.currentTime = segment.inUs / 1_000_000;
      renderSegments();
    });
    detail.textContent = `${formatTimeUs(segment.inUs)} - ${formatTimeUs(segment.outUs)}`;
    mode.textContent = isKeyframe(segment.inUs) ? "Fast export ready" : "Frame-accurate only";
    mode.className = isKeyframe(segment.inUs) ? "fast-ready" : "frame-only";
    removeButton.type = "button";
    removeButton.textContent = editMode === "remove" ? "Remove clip" : "Remove";
    removeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      selectedSegmentId = segment.id;
      executeAction("edit.removeSelected");
    });
    item.append(jumpButton, detail, mode, removeButton);
    segmentList.append(item);
  });

  timeline.setAttribute("aria-valuemax", String(timelineDurationUs()));
  drawTimeline();
  updateExportControls();
  updateControlStates();
  persistDraft();
}

function snapshotEdit() {
  return {
    segments: segments.map((segment) => ({ ...segment })),
    markInUs,
    markOutUs,
    sequencePlayheadUs,
    selectedSegmentId,
  };
}

function restoreEdit(snapshot) {
  segments = snapshot.segments.map((segment) => ({ ...segment }));
  markInUs = snapshot.markInUs;
  markOutUs = snapshot.markOutUs;
  sequencePlayheadUs = snapshot.sequencePlayheadUs;
  selectedSegmentId = snapshot.selectedSegmentId;
  if (editMode === "remove" && segments.length > 0) setSequencePlayhead(sequencePlayheadUs);
  renderMarks();
  renderSegments();
}

function recordEdit() {
  undoStack.push(snapshotEdit());
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
}

function resetHistory() {
  undoStack = [];
  redoStack = [];
  updateControlStates();
}

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeDraft(draft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Storage full or unavailable — the draft is best effort.
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
}

function persistDraft() {
  if (!currentMedia) return;
  writeDraft({
    version: 1,
    savedAt: new Date().toISOString(),
    media: {
      name: currentMedia.name,
      relativePath: currentMedia.relativePath,
      absolutePath: currentMedia.absolutePath,
    },
    projectId: currentProjectId,
    projectName: projectName.value || null,
    editMode,
    segments: segments.map(({ id, inUs, outUs }) => ({ id, inUs, outUs })),
    markInUs,
    markOutUs,
    sequencePlayheadUs,
    selectedSegmentId,
  });
}

function resetSequence(record = true) {
  if (!currentMedia) return;
  clearStillMode();
  if (record) recordEdit();
  segments = editMode === "remove"
    ? [{ id: crypto.randomUUID(), inUs: 0, outUs: currentMedia.durationUs }]
    : [];
  selectedSegmentId = segments[0]?.id ?? null;
  sequencePlayheadUs = 0;
  markInUs = 0;
  markOutUs = timelineDurationUs();
  if (editMode === "remove" && segments.length > 0) setSequencePlayhead(0);
  renderMarks();
  renderSegments();
}

function hasModeEdits() {
  if (!currentMedia) return false;
  if (editMode === "include") return segments.length > 0;
  return !(
    segments.length === 1 &&
    segments[0].inUs === 0 &&
    segments[0].outUs === currentMedia.durationUs
  );
}

function changeEditMode(mode) {
  if (mode === editMode) return;
  if (currentMedia && hasModeEdits() && !window.confirm("Switching edit modes will reset the sequence. Continue?")) return;
  editMode = mode;
  includeModeButton.classList.toggle("active", mode === "include");
  removeModeButton.classList.toggle("active", mode === "remove");
  applyRangeButton.textContent = mode === "remove" ? "Remove range" : "Include range";
  resetHistory();
  if (currentMedia) resetSequence(false);
}

function removeSequenceRange(startUs, endUs) {
  segments = subtractSequenceRange(segments, startUs, endUs);
}

function applyMarkedRange() {
  if (!currentMedia || markOutUs <= markInUs) return;
  recordEdit();
  if (editMode === "remove") {
    const removalStartUs = markInUs;
    removeSequenceRange(markInUs, markOutUs);
    sequencePlayheadUs = Math.min(removalStartUs, sequenceDurationUs());
    markInUs = sequencePlayheadUs;
    markOutUs = sequencePlayheadUs;
    if (segments.length > 0) setSequencePlayhead(sequencePlayheadUs);
    else video.pause();
    notice.textContent = "Range removed and the sequence gap closed.";
  } else {
    const overlaps = segments.some((segment) => markInUs < segment.outUs && markOutUs > segment.inUs);
    if (overlaps) {
      undoStack.pop();
      notice.textContent = "Included ranges cannot overlap.";
      return;
    }
    segments.push({ id: crypto.randomUUID(), inUs: markInUs, outUs: markOutUs });
    segments.sort((left, right) => left.inUs - right.inUs);
    notice.textContent = "Range included in the sequence.";
  }
  renderMarks();
  renderSegments();
}

function removeSelectedSegment() {
  if (!selectedSegmentId) return;
  recordEdit();
  segments = segments.filter((segment) => segment.id !== selectedSegmentId);
  selectedSegmentId = segments[0]?.id ?? null;
  sequencePlayheadUs = Math.min(sequencePlayheadUs, sequenceDurationUs());
  if (editMode === "remove" && segments.length > 0) setSequencePlayhead(sequencePlayheadUs);
  renderMarks();
  renderSegments();
}

function undoEdit() {
  const snapshot = undoStack.pop();
  if (!snapshot) return;
  redoStack.push(snapshotEdit());
  restoreEdit(snapshot);
}

function redoEdit() {
  const snapshot = redoStack.pop();
  if (!snapshot) return;
  undoStack.push(snapshotEdit());
  restoreEdit(snapshot);
}

function setSequencePlayhead(timestampUs) {
  clearStillMode();
  const mapped = sequenceToSource(timestampUs);
  if (!mapped) return;
  sequencePlayheadUs = mapped.sequenceUs;
  activeSegmentIndex = mapped.index;
  programmaticSeek = true;
  video.currentTime = mapped.sourceUs / 1_000_000;
  playheadTime.value = formatTimeUs(sequencePlayheadUs);
  drawTimeline();
}

function hideStill() {
  stillElement.hidden = true;
}

function updateStillIndicator() {
  stillIndicator.hidden = !stillMode;
}

function clearStillMode() {
  stillMode = false;
  pendingTargetUs = null;
  hideStill();
  updateStillIndicator();
}

function enterStillMode(sourceUs, sequenceUs) {
  const index = keyframesUs.findIndex((keyframe) => Math.abs(keyframe - sourceUs) <= 80_000);
  if (index < 0) {
    if (editMode === "remove") setSequencePlayhead(sequenceUs ?? sourceToSequence(sourceUs) ?? 0);
    else video.currentTime = sourceUs / 1_000_000;
    return;
  }
  stillMode = true;
  pendingTargetUs = sourceUs;
  if (editMode === "remove" && Number.isFinite(sequenceUs)) sequencePlayheadUs = sequenceUs;
  stillElement.src = `${stillBaseUrl}${index}`;
  stillElement.hidden = false;
  updateStillIndicator();
  const displayUs = currentEditTimeUs();
  playheadTime.value = formatTimeUs(displayUs);
  timeline.setAttribute("aria-valuenow", String(Math.round(displayUs)));
  drawTimeline();
}

stillElement.addEventListener("error", () => {
  if (!stillMode) return;
  const target = pendingTargetUs;
  stillMode = false;
  pendingTargetUs = null;
  hideStill();
  updateStillIndicator();
  if (Number.isFinite(target)) {
    if (editMode === "remove") setSequencePlayhead(sourceToSequence(target) ?? 0);
    else video.currentTime = target / 1_000_000;
  }
});

function exitStillMode(seekTo) {
  const target = pendingTargetUs;
  stillMode = false;
  pendingTargetUs = null;
  hideStill();
  updateStillIndicator();
  if (seekTo && Number.isFinite(target) && editMode === "include") {
    video.currentTime = target / 1_000_000;
  }
}

function seekToKeyframeOrSource(sourceUs, sequenceUs) {
  if (stillBaseUrl && stillCount > 0 && preferences.stillsSeeking !== false && video.paused) {
    enterStillMode(sourceUs, sequenceUs);
    return;
  }
  if (editMode === "remove") setSequencePlayhead(sequenceUs ?? sourceToSequence(sourceUs) ?? 0);
  else video.currentTime = sourceUs / 1_000_000;
}

function seekBySeconds(seconds) {
  if (!currentMedia) return;
  const baseUs = currentEditTimeUs();
  if (editMode === "remove") {
    const targetUs = baseUs + seconds * 1_000_000;
    const snappedUs = nearestInSorted(sequenceKeyframesUs(), targetUs);
    const mapped = sequenceToSource(snappedUs);
    if (mapped) seekToKeyframeOrSource(mapped.sourceUs, snappedUs);
    else setSequencePlayhead(snappedUs);
  } else {
    const targetUs = baseUs + seconds * 1_000_000;
    const snappedUs = nearestInSorted(keyframesUs, Math.max(0, Math.min(targetUs, (video.duration || 0) * 1_000_000)));
    seekToKeyframeOrSource(snappedUs);
  }
}

function seekKeyframe(direction) {
  if (!currentMedia) return;
  const indexValues = sequenceKeyframesUs();
  if (indexValues.length === 0) return;
  const currentUs = currentEditTimeUs();
  let low = 0;
  let high = indexValues.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (indexValues[middle] < currentUs + (direction > 0 ? 1_000 : -1_000)) low = middle + 1;
    else high = middle;
  }
  const index = direction > 0 ? low : low - 1;
  if (index < 0 || index >= indexValues.length) return;
  const target = indexValues[index];
  if (editMode === "remove") {
    const mapped = sequenceToSource(target);
    if (mapped) seekToKeyframeOrSource(mapped.sourceUs, target);
  } else {
    seekToKeyframeOrSource(target);
  }
}

async function togglePlayback() {
  if (!currentMedia || (editMode === "remove" && segments.length === 0)) return;
  if (video.paused) {
    if (stillMode) exitStillMode(true);
    if (editMode === "remove") setSequencePlayhead(sequencePlayheadUs >= sequenceDurationUs() ? 0 : sequencePlayheadUs);
    await video.play();
  } else video.pause();
}

function syncRemovePlayback() {
  if (editMode !== "remove" || segments.length === 0 || programmaticSeek) return;
  const sourceUs = Math.round(video.currentTime * 1_000_000);
  const layout = sequenceLayout();
  const current = layout[activeSegmentIndex];
  if (!video.paused && current && sourceUs >= current.segment.outUs - 15_000) {
    const next = layout[activeSegmentIndex + 1];
    if (next) setSequencePlayhead(next.sequenceInUs);
    else {
      sequencePlayheadUs = sequenceDurationUs();
      video.pause();
    }
    return;
  }
  const sequenceUs = sourceToSequence(sourceUs);
  if (sequenceUs !== null) {
    sequencePlayheadUs = Math.min(sequenceUs, sequenceDurationUs());
    activeSegmentIndex = layout.findIndex(
      (item) => sequencePlayheadUs >= item.sequenceInUs && sequencePlayheadUs <= item.sequenceOutUs,
    );
    return;
  }
  const next = layout.find((item) => item.segment.inUs > sourceUs);
  if (next) setSequencePlayhead(next.sequenceInUs);
  else setSequencePlayhead(sequenceDurationUs());
}

function seekTimeline(clientX) {
  if (!currentMedia || timelineDurationUs() <= 0) return;
  const bounds = timeline.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
  const targetUs = ratio * timelineDurationUs();
  if (previewIsProxy) {
    if (stillMode) exitStillMode(false);
    if (editMode === "remove") setSequencePlayhead(targetUs);
    else video.currentTime = targetUs / 1_000_000;
    return;
  }
  const snappedUs = nearestInSorted(editMode === "remove" ? sequenceKeyframesUs() : keyframesUs, targetUs);
  if (editMode === "remove") {
    const mapped = sequenceToSource(snappedUs);
    if (mapped) seekToKeyframeOrSource(mapped.sourceUs, snappedUs);
    else setSequencePlayhead(snappedUs);
  } else {
    seekToKeyframeOrSource(snappedUs);
  }
}

function updateExportControls() {
  const hasSegments = Boolean(currentMedia && segments.length > 0);
  const onlyFast = Boolean(preferences.onlyFastEdits);
  exportAccurateButton.disabled = !hasSegments || onlyFast;
  exportAccurateButton.hidden = onlyFast;
  exportFastButton.disabled = !hasSegments || segments.some((segment) => !isKeyframe(segment.inUs));
}

function updateControlStates() {
  const hasMedia = Boolean(currentMedia);
  document.querySelectorAll('[data-action^="playback."]').forEach((button) => {
    button.disabled = !hasMedia || (editMode === "remove" && segments.length === 0);
  });
  document.querySelectorAll('[data-action="edit.markIn"], [data-action="edit.markOut"]').forEach((button) => {
    button.disabled = !hasMedia;
  });
  document.querySelector('[data-action="edit.undo"]').disabled = undoStack.length === 0;
  document.querySelector('[data-action="edit.redo"]').disabled = redoStack.length === 0;
  document.querySelector('[data-action="edit.reset"]').disabled = !hasMedia;
  saveProjectButton.disabled = !hasMedia;
}

async function request(url, options) {
  const response = await fetch(url, options);
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

function renderMissingPaths() {
  const missing = Array.isArray(preferences.missingPaths) ? preferences.missingPaths : [];
  if (missing.length === 0) {
    missingPathWarning.hidden = true;
    return;
  }
  missingPathWarning.textContent = missing
    .map((entry) => `${entry.kind === "export" ? "Export" : "Library"} folder not found: ${entry.path}`)
    .join(" · ");
  missingPathWarning.hidden = false;
}

function reportClientError(level, message, context) {
  try {
    fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level, message: String(message).slice(0, 2000), context }),
    }).catch(() => {});
  } catch {
    // Logging is best effort.
  }
}

function applyPreviewSource(proxy) {
  previewIsProxy = true;
  previewProgress.textContent = "";
  const keepTime = video.currentTime;
  video.src = proxy.streamUrl;
  if (Number.isFinite(keepTime) && keepTime > 0) {
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = keepTime;
    }, { once: true });
  }
  video.load();
  const label = proxy.scale === "half" ? "Half" : "Quarter";
  metadata.textContent = `${sourceMetadataLine} · ${label}-res preview (${proxy.width}x${proxy.height})`;
}

async function waitForProxy(media) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    let proxy;
    try {
      proxy = await request(`/api/media/${media.id}/proxy`);
    } catch {
      return;
    }
    if (proxy.status === "ready") {
      applyPreviewSource(proxy);
      notice.textContent = "Preview proxy ready.";
      return;
    }
    if (proxy.status === "failed") {
      previewProgress.textContent = "";
      notice.textContent = `Preview proxy failed: ${proxy.error ?? "unknown"}`;
      return;
    }
    if (proxy.status === "pending" && Number.isFinite(proxy.progress)) {
      const percent = Math.round(proxy.progress);
      previewProgress.textContent = `Generating ${proxy.scale === "half" ? "half" : "quarter"}-res preview... ${percent}%`;
      notice.textContent = `Generating ${proxy.scale === "half" ? "half" : "quarter"}-res preview... ${percent}%`;
    }
  }
}

function updatePreviewControlsState() {
  const generationEnabled = preferences.previewGeneration !== false;
  previewScaleSelect.disabled = !generationEnabled;
  previewGenerationInput.checked = preferences.previewGeneration !== false;
  stillsSeekingInput.checked = preferences.stillsSeeking !== false;
  if (!generationEnabled) {
    previewScaleSelect.value = "source";
  }
}

async function configurePreview(media) {
  updatePreviewControlsState();
  const generationEnabled = preferences.previewGeneration !== false;
  if (!generationEnabled) {
    previewIsProxy = false;
    previewProgress.textContent = "";
    stillIndicator.hidden = true;
    video.src = media.streamUrl;
    video.load();
    metadata.textContent = sourceMetadataLine;
    return;
  }
  const scale = preferences.previewScale;
  if (!scale || scale === "source") {
    previewIsProxy = false;
    previewProgress.textContent = "";
    video.src = media.streamUrl;
    video.load();
    metadata.textContent = sourceMetadataLine;
    return;
  }
  try {
    const proxy = await request(`/api/media/${media.id}/proxy`);
    if (proxy.status === "ready") {
      applyPreviewSource(proxy);
      notice.textContent = `${proxy.scale === "half" ? "Half" : "Quarter"}-res preview ready.`;
      return;
    }
    if (proxy.status === "pending") {
      const percent = Number.isFinite(proxy.progress) ? Math.round(proxy.progress) : null;
      const label = proxy.scale === "half" ? "half" : "quarter";
      previewProgress.textContent = percent !== null
        ? `Generating ${label}-res preview... ${percent}%`
        : `Generating ${label}-res preview...`;
      notice.textContent = previewProgress.textContent;
      await waitForProxy(media);
      return;
    }
    previewProgress.textContent = "";
    notice.textContent = `Preview proxy unavailable: ${proxy.error ?? "unknown"}`;
  } catch {
    previewIsProxy = false;
    previewProgress.textContent = "";
    video.src = media.streamUrl;
    video.load();
    metadata.textContent = sourceMetadataLine;
  }
}

async function configureStills(media) {
  clearStillMode();
  stillBaseUrl = null;
  stillCount = 0;
  stillsProgress.hidden = true;
  stillsProgress.textContent = "";
  if (!media) return;
  try {
    const result = await request(`/api/media/${media.id}/stills`);
    stillBaseUrl = result.baseUrl ?? null;
    stillCount = result.count ?? 0;
    if (result.status === "ready") {
      return;
    }
    if (result.status === "pending") {
      if (Number.isFinite(result.progress)) {
        stillsProgress.hidden = false;
        stillsProgress.textContent = `${Math.round(result.progress)}%`;
      }
      const mediaId = media.id;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (!currentMedia || currentMedia.id !== mediaId) return;
        try {
          const updated = await request(`/api/media/${mediaId}/stills`);
          if (!currentMedia || currentMedia.id !== mediaId) return;
          stillBaseUrl = updated.baseUrl ?? stillBaseUrl;
          stillCount = updated.count ?? stillCount;
          if (updated.status === "ready") {
            stillCount = updated.count ?? stillCount;
            stillsProgress.hidden = true;
            return;
          }
          if (updated.status === "failed" || updated.status === "off") {
            stillsProgress.hidden = true;
            return;
          }
          if (Number.isFinite(updated.progress)) {
            stillsProgress.hidden = false;
            stillsProgress.textContent = `${Math.round(updated.progress)}%`;
          }
        } catch {
          return;
        }
      }
    }
  } catch {
    // Stills are an optional enhancement.
  }
}

function adoptMedia(media, keyframes) {
  clearStillMode();
  currentMedia = media;
  keyframesUs = keyframes;
  editMode = preferences.defaultEditMode;
  includeModeButton.classList.toggle("active", editMode === "include");
  removeModeButton.classList.toggle("active", editMode === "remove");
  applyRangeButton.textContent = editMode === "remove" ? "Remove range" : "Include range";
  video.src = media.streamUrl;
  video.load();
  viewerEmpty.hidden = true;
  viewerTitle.textContent = media.name;
  sourceMetadataLine = `${media.video.width}x${media.video.height} · ${formatDuration(media.durationUs / 1_000_000)} · ${media.video.averageFrameRate?.toFixed(3) ?? "?"} fps · ${formatBytes(media.size)}`;
  metadata.textContent = sourceMetadataLine;
  currentProjectId = null;
  projectName.value = `${media.name.replace(/\.mp4$/i, "")} edit`;
  selectedMediaPath = media.relativePath ?? selectedMediaPath;
  resetHistory();
  resetSequence(false);
  notice.textContent = `Source indexed with ${keyframesUs.length} keyframe${keyframesUs.length === 1 ? "" : "s"}.`;
}

async function loadMedia(locator, button) {
  notice.textContent = "Validating media and indexing keyframes...";
  if (button) button.disabled = true;
  try {
    const body = typeof locator === "string"
      ? { relativePath: locator }
      : locator.absolutePath
        ? { absolutePath: locator.absolutePath }
        : { relativePath: locator.relativePath };
    const media = await request("/api/media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const keyframeIndex = await request(media.keyframesUrl);
    adoptMedia(media, keyframeIndex.keyframesUs);
    configurePreview(media);
    configureStills(media);
    return true;
  } catch (error) {
    notice.textContent = error.message;
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

async function loadLocatedMedia(name, button) {
  notice.textContent = `Locating "${name}" on this machine...`;
  if (button) button.disabled = true;
  try {
    const media = await request("/api/library/locate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const keyframeIndex = await request(media.keyframesUrl);
    adoptMedia(media, keyframeIndex.keyframesUs);
    configurePreview(media);
    configureStills(media);
    return true;
  } catch (error) {
    notice.textContent = error.message;
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

async function loadDroppedFile(file) {
  if (!file || !/\.mp4$/i.test(file.name)) {
    notice.textContent = "Only MP4 files can be opened by dropping.";
    return;
  }
  notice.textContent = `Locating "${file.name}" on this machine...`;
  viewerShell.classList.add("drop-target");
  try {
    const media = await request("/api/library/locate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name }),
    });
    const keyframeIndex = await request(media.keyframesUrl);
    adoptMedia(media, keyframeIndex.keyframesUs);
    configureStills(media);
    await refreshLibrary();
    notice.textContent = `Opened "${file.name}" from disk. Nothing was copied.`;
  } catch (error) {
    notice.textContent = error.message;
  } finally {
    viewerShell.classList.remove("drop-target");
  }
}

async function refreshLibrary() {
  refreshButton.disabled = true;
  notice.textContent = "Scanning for MP4 files...";
  try {
    const library = await request("/api/files");
    rootPath.textContent = library.mediaRoot;
    renderFiles(library.files);
    notice.textContent = `${library.files.length} MP4 file${library.files.length === 1 ? "" : "s"} found.`;
    serverStatus.textContent = "Local server online";
    serverStatus.classList.add("online");
  } catch (error) {
    notice.textContent = error.message;
    serverStatus.textContent = "Server unavailable";
  } finally {
    refreshButton.disabled = false;
  }
}

function renderFiles(files) {
  fileList.replaceChildren();
  if (files.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-library";
    empty.textContent = "No MP4 files found in this media root.";
    fileList.append(empty);
    return;
  }
  for (const file of files) {
    const item = document.createElement("li");
    const details = document.createElement("div");
    const name = document.createElement("button");
    const fileSize = document.createElement("span");
    item.classList.toggle("selected", file.relativePath === selectedMediaPath);
    name.type = "button";
    name.className = "file-name-button";
    name.textContent = file.name;
    name.title = file.relativePath;
    name.addEventListener("click", () => {
      selectedMediaPath = file.relativePath;
      loadMedia(file.relativePath, name);
    });
    fileSize.textContent = formatBytes(file.size);
    details.append(name, fileSize);
    item.append(details);
    fileList.append(item);
  }
}

async function refreshProjects() {
  try {
    const result = await request("/api/projects");
    renderProjects(result.projects);
  } catch (error) {
    notice.textContent = error.message;
  }
}

async function refreshMediaManager() {
  try {
    const result = await request("/api/media");
    renderMediaManager(result.records);
  } catch (error) {
    notice.textContent = error.message;
  }
}

function renderMediaManager(records) {
  mediaList.replaceChildren();
  clearMediaButton.disabled = records.length === 0;
  if (records.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-queue";
    empty.textContent = "No clips have been opened yet. Load a clip to index it here.";
    mediaList.append(empty);
    return;
  }
  for (const record of records) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = record.name;
    const meta = document.createElement("small");
    meta.textContent = `${record.keyframeCount} keyframes · ${formatBytes(record.size)} · proxy ${record.hasProxies ? "✓" : "–"} · stills ${record.hasStills ? "✓" : "–"}`;
    const actions = document.createElement("div");
    actions.className = "media-record-actions";
    const deleteStills = document.createElement("button");
    deleteStills.textContent = "stills";
    deleteStills.title = "Delete keyframe stills for this clip";
    deleteStills.addEventListener("click", async () => {
      try {
        await request(`/api/media/${record.id}/stills`, { method: "DELETE" });
        await Promise.all([refreshMediaManager(), ifCurrent(record.id, () => configureStills(currentMedia))]);
      } catch (error) {
        notice.textContent = error.message;
      }
    });
    const deleteProxies = document.createElement("button");
    deleteProxies.textContent = "proxy";
    deleteProxies.title = "Delete proxies for this clip";
    deleteProxies.addEventListener("click", async () => {
      try {
        await request(`/api/media/${record.id}/proxies`, { method: "DELETE" });
        await refreshMediaManager();
      } catch (error) {
        notice.textContent = error.message;
      }
    });
    const deleteRecord = document.createElement("button");
    deleteRecord.textContent = "delete";
    deleteRecord.title = "Delete this clip record, its proxies and stills";
    deleteRecord.addEventListener("click", async () => {
      if (!window.confirm(`Delete the record for "${record.name}"? Its proxies and keyframe stills are removed too.`)) return;
      try {
        await request(`/api/media/${record.id}`, { method: "DELETE" });
        await refreshMediaManager();
      } catch (error) {
        notice.textContent = error.message;
      }
    });
    actions.append(deleteStills, deleteProxies, deleteRecord);
    item.append(title, meta, actions);
    mediaList.append(item);
  }
}

function ifCurrent(mediaId, run) {
  if (currentMedia && currentMedia.id === mediaId) run();
}

clearMediaButton.addEventListener("click", async () => {
  if (!window.confirm("Delete all clip records, proxies, and keyframe stills?")) return;
  try {
    const result = await request("/api/media", { method: "DELETE" });
    notice.textContent = `Deleted ${result.removed} media record${result.removed === 1 ? "" : "s"}.`;
    await refreshMediaManager();
  } catch (error) {
    notice.textContent = error.message;
  }
});

function renderProjects(projects) {
  projectList.replaceChildren();
  if (projects.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-projects";
    empty.textContent = "No saved projects yet.";
    projectList.append(empty);
    return;
  }
  for (const project of projects) {
    const item = document.createElement("li");
    const details = document.createElement("div");
    const name = document.createElement("strong");
    const actions = document.createElement("div");
    const openButton = makeIconButton(`Open ${project.name}`, ICON_PATHS.open);
    const exportButton = makeIconButton(`Download ${project.name} as JSON`, ICON_PATHS.download);
    const deleteButton = makeIconButton(`Delete ${project.name}`, ICON_PATHS.delete);
    item.classList.toggle("selected", project.id === selectedProjectId);
    item.addEventListener("click", () => {
      selectedProjectId = project.id;
      renderProjects(projects);
    });
    name.textContent = project.name;
    name.title = project.name;
    details.append(name);
    actions.className = "project-item-actions";
    openButton.addEventListener("click", (event) => {
      event.stopPropagation();
      selectedProjectId = project.id;
      loadProject(project.id, openButton);
    });
    exportButton.addEventListener("click", (event) => {
      event.stopPropagation();
      selectedProjectId = project.id;
      downloadProject(project.id);
    });
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      selectedProjectId = project.id;
      deleteProject(project.id, project.name);
    });
    actions.append(openButton, exportButton, deleteButton);
    item.append(details, actions);
    projectList.append(item);
  }
}

async function importProject(file) {
  if (!file) return;
  importProjectButton.disabled = true;
  notice.textContent = `Importing ${file.name}...`;
  try {
    const document = JSON.parse(await file.text());
    const project = await request("/api/projects/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(document),
    });
    selectedProjectId = project.id;
    await refreshProjects();
    notice.textContent = `${project.name} imported.`;
  } catch (error) {
    notice.textContent = error instanceof SyntaxError ? "Project file is not valid JSON." : error.message;
  } finally {
    importProjectButton.disabled = false;
    projectFileInput.value = "";
  }
}

function downloadProject(projectId = selectedProjectId) {
  if (!projectId) return;
  const link = document.createElement("a");
  link.href = `/api/projects/${projectId}/export`;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

async function deleteProject(projectId = selectedProjectId, name = "this project") {
  if (!projectId || !window.confirm(`Delete ${name}? The source video and rendered exports will not be removed.`)) return;
  try {
    await request(`/api/projects/${projectId}`, { method: "DELETE" });
    if (currentProjectId === projectId) currentProjectId = null;
    if (selectedProjectId === projectId) selectedProjectId = null;
    notice.textContent = `${name} deleted.`;
    await refreshProjects();
  } catch (error) {
    notice.textContent = error.message;
  }
}

async function loadProject(projectId, button) {
  if (button) button.disabled = true;
  notice.textContent = "Opening saved project...";
  try {
    const project = await request(`/api/projects/${projectId}`);
    const source = project.source;
    const loaded = source.relativePath || !source.name
      ? await loadMedia({ relativePath: source.relativePath }, null)
      : await loadLocatedMedia(source.name, null);
    if (!loaded) return;
    currentProjectId = project.id;
    selectedProjectId = project.id;
    projectName.value = project.name;
    editMode = project.editMode ?? "include";
    includeModeButton.classList.toggle("active", editMode === "include");
    removeModeButton.classList.toggle("active", editMode === "remove");
    applyRangeButton.textContent = editMode === "remove" ? "Remove range" : "Include range";
    segments = project.segments.map((segment) => ({ ...segment }));
    selectedSegmentId = segments[0]?.id ?? null;
    sequencePlayheadUs = 0;
    markInUs = 0;
    markOutUs = timelineDurationUs();
    resetHistory();
    if (editMode === "remove" && segments.length > 0) setSequencePlayhead(0);
    renderMarks();
    renderSegments();
    notice.textContent = `Opened ${project.name}.`;
  } catch (error) {
    notice.textContent = error.message;
  } finally {
    if (button) button.disabled = false;
  }
}

async function saveProject() {
  if (!currentMedia) return null;
  saveProjectButton.disabled = true;
  notice.textContent = "Saving edit decision list...";
  try {
    const project = await request(currentProjectId ? `/api/projects/${currentProjectId}` : "/api/projects", {
      method: currentProjectId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: projectName.value,
        editMode,
        sourceMediaId: currentMedia.id,
        segments: segments.map(({ id, inUs, outUs }) => ({ id, inUs, outUs })),
      }),
    });
    currentProjectId = project.id;
    selectedProjectId = project.id;
    projectName.value = project.name;
    notice.textContent = `Saved ${project.name}.`;
    await refreshProjects();
    return project;
  } catch (error) {
    notice.textContent = error.message;
    return null;
  } finally {
    saveProjectButton.disabled = false;
  }
}

async function beginExport(mode) {
  if (preferences.onlyFastEdits && mode === "accurate") {
    notice.textContent = "Frame-accurate export is disabled when only fast edits are allowed.";
    return;
  }
  exportFastButton.disabled = true;
  exportAccurateButton.disabled = true;
  notice.textContent = "Saving project before export...";
  try {
    const project = await saveProject();
    if (!project) return;
    const job = await request("/api/exports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id, mode }),
    });
    selectedExportJobId = job.id;
    activatePanelTab("exports");
    if (preferences.sidebarCollapsed) {
      preferences.sidebarCollapsed = false;
      applySidebarPreference();
      persistPreferences().catch((error) => { notice.textContent = error.message; });
    }
    notice.textContent = `${project.name} added paused. Resume it from the export queue.`;
    await refreshExportQueue();
  } catch (error) {
    notice.textContent = error.message;
  } finally {
    updateExportControls();
  }
}

function renderExportQueue(jobs) {
  exportQueueList.replaceChildren();
  clearExportQueueButton.disabled = jobs.length === 0;
  startExportQueueButton.disabled = !jobs.some((job) => job.status === "paused");
  const activeJobs = jobs.filter((job) => ["queued", "running", "paused", "stopping"].includes(job.status));
  exportQueueSummary.value = activeJobs.length === 0
    ? jobs.length === 0 ? "Queue empty" : "No active jobs"
    : `${activeJobs.length} active job${activeJobs.length === 1 ? "" : "s"}`;

  if (jobs.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-queue";
    empty.textContent = "New exports appear here paused and remain after server restarts.";
    exportQueueList.append(empty);
    return;
  }

  for (const job of jobs) {
    const item = document.createElement("li");
    const header = document.createElement("div");
    const details = document.createElement("div");
    const title = document.createElement("strong");
    const metadata = document.createElement("span");
    const status = document.createElement("span");
    const progress = document.createElement("progress");
    const actions = document.createElement("div");
    item.classList.toggle("selected", job.id === selectedExportJobId);
    item.addEventListener("click", () => {
      selectedExportJobId = job.id;
      renderExportQueue(jobs);
    });
    header.className = "export-job-header";
    details.className = "export-job-details";
    title.textContent = job.outputName;
    title.title = job.outputPath;
    metadata.textContent = `${job.projectName} · ${job.mode}`;
    status.className = `export-job-status status-${job.status}`;
    status.textContent = job.status;
    details.append(title, metadata);
    header.append(details, status);
    progress.max = 1;
    progress.value = job.progress;
    progress.setAttribute("aria-label", `${job.outputName} progress`);
    actions.className = "export-job-actions";

    if (job.status === "running" || job.status === "queued") {
      const pauseButton = document.createElement("button");
      pauseButton.type = "button";
      pauseButton.textContent = "Pause";
      pauseButton.addEventListener("click", (event) => {
        event.stopPropagation();
        controlExport(job.id, "pause");
      });
      actions.append(pauseButton);
    }
    if (job.status === "paused") {
      const resumeButton = document.createElement("button");
      resumeButton.type = "button";
      resumeButton.textContent = "Resume";
      resumeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        controlExport(job.id, "resume");
      });
      actions.append(resumeButton);
    }
    if (["queued", "running", "paused"].includes(job.status)) {
      const stopButton = document.createElement("button");
      stopButton.type = "button";
      stopButton.textContent = "Stop";
      stopButton.addEventListener("click", (event) => {
        event.stopPropagation();
        controlExport(job.id, "stop");
      });
      actions.append(stopButton);
    }
    if (job.status === "completed") {
      item.title = job.outputPath;
    } else if (job.status === "failed") {
      const error = document.createElement("span");
      error.className = "export-job-error";
      error.textContent = job.error;
      actions.append(error);
    }
    item.append(header, progress);
    if (actions.childElementCount > 0) item.append(actions);
    exportQueueList.append(item);
  }
}

async function refreshExportQueue() {
  try {
    const result = await request("/api/exports");
    renderExportQueue(result.jobs);
  } catch (error) {
    exportQueueSummary.value = "Queue unavailable";
  }
}

async function controlExport(jobId = selectedExportJobId, action) {
  if (!jobId) return;
  if (action === "stop" && !window.confirm("Stop this export? Partial output and temporary files will be removed.")) return;
  try {
    const job = await request(`/api/exports/${jobId}/${action}`, { method: "POST" });
    selectedExportJobId = job.id;
    await refreshExportQueue();
  } catch (error) {
    notice.textContent = error.message;
  }
}

async function clearExportQueue() {
  if (!window.confirm("Clear the export queue? Active exports will stop, but completed files will remain on disk.")) return;
  try {
    await request("/api/exports", { method: "DELETE" });
    selectedExportJobId = null;
    await refreshExportQueue();
    notice.textContent = "Export queue cleared. Completed files were not deleted.";
  } catch (error) {
    notice.textContent = error.message;
  }
}

async function startExportQueue() {
  try {
    const result = await request("/api/exports/start", { method: "POST" });
    notice.textContent = result.resumed === 0
      ? "No paused exports to start."
      : `Started ${result.resumed} export${result.resumed === 1 ? "" : "s"}.`;
    await refreshExportQueue();
  } catch (error) {
    notice.textContent = error.message;
  }
}

let adminLogTimer = null;

function formatLogTime(iso) {
  return iso.slice(11, 19);
}

function renderAdminLog(entries) {
  const nearBottom = adminLogElement.scrollHeight - adminLogElement.scrollTop - adminLogElement.clientHeight < 40;
  adminLogElement.replaceChildren();
  if (!entries || entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "log-empty";
    empty.textContent = "No server activity recorded yet.";
    adminLogElement.append(empty);
    return;
  }
  for (const entry of entries) {
    const line = document.createElement("div");
    const time = document.createElement("span");
    line.className = `log-entry${entry.level === "info" ? "" : ` log-${entry.level}`}`;
    time.className = "log-time";
    time.textContent = formatLogTime(entry.at);
    line.append(time, document.createTextNode(entry.message));
    adminLogElement.append(line);
  }
  if (nearBottom) adminLogElement.scrollTop = adminLogElement.scrollHeight;
}

async function refreshAdminLog() {
  try {
    const result = await request("/api/admin/log");
    renderAdminLog(result.entries);
  } catch {
    renderAdminLog([]);
  }
}

function openAdminConsole() {
  if (adminDialog.open) return;
  adminDialog.showModal();
  refreshAdminLog();
  adminLogTimer = window.setInterval(refreshAdminLog, 1000);
}

function closeAdminConsole() {
  if (adminDialog.open) adminDialog.close();
}

adminDialog.addEventListener("close", () => {
  if (adminLogTimer) {
    window.clearInterval(adminLogTimer);
    adminLogTimer = null;
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!adminDialog.open || capturingActionId) return;
  if (event.composedPath().includes(adminDialog)) return;
  closeAdminConsole();
});
closeAdminButton.addEventListener("click", closeAdminConsole);

async function forceStopServerWork() {
  if (!window.confirm("Force stop all active and paused exports? Partial output is removed; completed files remain.")) return;
  try {
    const result = await request("/api/admin/stop", { method: "POST" });
    notice.textContent = result.stopped > 0 ? `Force stopped ${result.stopped} job${result.stopped === 1 ? "" : "s"}.` : "Nothing was running.";
    await Promise.all([refreshAdminLog(), refreshExportQueue()]);
  } catch (error) {
    notice.textContent = error.message;
  }
}

async function resetServerState() {
  if (!window.confirm("Reset the server? Active exports are stopped and projects, preferences, and folders reload from disk.")) return;
  adminRestartButton.disabled = true;
  try {
    await request("/api/admin/restart", { method: "POST" });
    notice.textContent = "Server state reloaded from disk.";
    await Promise.all([refreshAdminLog(), refreshLibrary(), refreshProjects(), refreshExportQueue()]);
  } catch (error) {
    notice.textContent = error.message;
  } finally {
    adminRestartButton.disabled = false;
  }
}

async function shutdownServer() {
  if (!window.confirm("Shut down the server? Active exports are stopped and the process exits. Double-click the launcher to start it again.")) return;
  adminShutdownButton.disabled = true;
  try {
    await request("/api/admin/shutdown", { method: "POST" });
    notice.textContent = "Server is shutting down.";
  } catch (error) {
    notice.textContent = error.message;
  }
}

adminStopButton.addEventListener("click", forceStopServerWork);
adminRestartButton.addEventListener("click", resetServerState);
adminShutdownButton.addEventListener("click", shutdownServer);

async function stopBackgroundWork() {
  try {
    const result = await request("/api/admin/stop-background", { method: "POST" });
    notice.textContent = result.stopped > 0
      ? `Stopped ${result.stopped} background FFmpeg process${result.stopped === 1 ? "" : "es"}.`
      : "No background FFmpeg processes were running.";
    await refreshAdminLog();
  } catch (error) {
    notice.textContent = error.message;
  }
}
adminStopBackgroundButton.addEventListener("click", stopBackgroundWork);
openAdminButton.addEventListener("click", openAdminConsole);

function activatePanelTab(name) {
  for (const tab of panelTabs) {
    const selected = tab.dataset.panelTab === name;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const content of panelContents) content.hidden = content.dataset.panelContent !== name;
  if (name === "media") refreshMediaManager();
}

function setPanelWidth(width) {
  const maximum = Math.floor(appLayout.clientWidth * 0.4);
  const minimum = Math.min(280, maximum);
  appLayout.style.setProperty("--right-panel-width", `${Math.max(minimum, Math.min(maximum, width))}px`);
}

function beginPanelResize(event) {
  if (window.matchMedia("(max-width: 820px)").matches) return;
  event.preventDefault();
  panelResizer.setPointerCapture(event.pointerId);
  const resize = (moveEvent) => setPanelWidth(appLayout.getBoundingClientRect().right - moveEvent.clientX);
  const finish = () => {
    panelResizer.removeEventListener("pointermove", resize);
    panelResizer.removeEventListener("pointerup", finish);
    panelResizer.removeEventListener("pointercancel", finish);
  };
  panelResizer.addEventListener("pointermove", resize);
  panelResizer.addEventListener("pointerup", finish);
  panelResizer.addEventListener("pointercancel", finish);
}

function applySidebarPreference() {
  const collapsed = preferences.sidebarCollapsed;
  libraryPanel.hidden = collapsed;
  appLayout.classList.toggle("sidebar-collapsed", collapsed);
  toggleSidebarButton.setAttribute("aria-expanded", String(!collapsed));
}

async function persistPreferences(nextPreferences = preferences) {
  preferences = await request("/api/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nextPreferences),
  });
  applySidebarPreference();
  renderMissingPaths();
}

function toggleSidebar() {
  preferences.sidebarCollapsed = !preferences.sidebarCollapsed;
  applySidebarPreference();
  persistPreferences().catch((error) => {
    notice.textContent = error.message;
  });
}

function displayShortcut(shortcut) {
  if (!shortcut) return "Unassigned";
  return shortcut
    .replace("Mod", navigator.platform.includes("Mac") ? "Cmd" : "Ctrl")
    .replace("Key", "")
    .replace("Digit", "")
    .replace("Arrow", "")
    .replace("BracketLeft", "[")
    .replace("BracketRight", "]")
    .replace("Comma", ",")
    .replace("Period", ".")
    .split("+")
    .join(" + ");
}

function renderShortcutEditor() {
  const card = shortcutList.closest(".preferences-card");
  const listScroll = shortcutList.scrollTop;
  const cardScroll = card?.scrollTop ?? 0;
  const activeElement = document.activeElement;
  const focusRestorer = capturingActionId
    ? null
    : activeElement && shortcutList.contains(activeElement) ? activeElement.dataset.shortcutAction : null;
  shortcutList.replaceChildren();
  for (const action of ACTIONS) {
    const row = document.createElement("div");
    const label = document.createElement("span");
    const binding = document.createElement("button");
    const clear = document.createElement("button");
    row.className = "shortcut-row";
    label.textContent = `${action.group} / ${action.label}`;
    binding.type = "button";
    binding.textContent = capturingActionId === action.id ? "Press keys..." : displayShortcut(preferencesDraft.shortcuts[action.id]);
    binding.classList.toggle("capturing", capturingActionId === action.id);
    binding.addEventListener("click", () => {
      capturingActionId = action.id;
      preferencesMessage.textContent = `Recording shortcut for ${action.label}. Press Escape to cancel.`;
      renderShortcutEditor();
    });
    clear.type = "button";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => {
      preferencesDraft.shortcuts[action.id] = null;
      renderShortcutEditor();
    });
    row.append(label, binding, clear);
    shortcutList.append(row);
  }
  shortcutList.scrollTop = listScroll;
  if (card) card.scrollTop = cardScroll;
}

function updateExportNameExample() {
  const example = (exportNameTemplateInput.value || DEFAULT_PREFERENCES.exportNameTemplate)
    .replaceAll("%f", "source-video")
    .replaceAll("%o", "my-project")
    .replaceAll("%m", "fast")
    .replaceAll("%h", "a1b2c3d4")
    .replaceAll("%ext", "mp4")
    .replace(/[^a-zA-Z0-9._ -]+/g, "")
    .trim() || "my-project-fast-a1b2c3d4.mp4";
  exportNameExample.textContent = /\.mp4$/i.test(example) ? example : `${example}.mp4`;
}

function openPreferences() {
  preferencesDraft = structuredClone(preferences);
  defaultEditModeSelect.value = preferencesDraft.defaultEditMode;
  libraryPathInput.value = preferencesDraft.libraryPath;
  exportPathInput.value = preferencesDraft.exportPath;
  exportNameTemplateInput.value = preferencesDraft.exportNameTemplate || DEFAULT_PREFERENCES.exportNameTemplate;
  importSearchPathsInput.value = (preferencesDraft.importSearchPaths ?? []).join("\n");
  onlyFastEditsInput.checked = Boolean(preferencesDraft.onlyFastEdits);
  stillsScaleSelect.value = preferencesDraft.stillsScale ?? "half";
  previewScaleSelect.value = preferencesDraft.previewScale ?? "source";
  previewGenerationInput.checked = preferencesDraft.previewGeneration !== false;
  stillsSeekingInput.checked = preferencesDraft.stillsSeeking !== false;
  updatePreviewControlsState();
  updateExportNameExample();
  capturingActionId = null;
  preferencesMessage.textContent = "";
  renderShortcutEditor();
  preferencesDialog.showModal();
}

async function savePreferences() {
  if (savingPreferences) return false;
  savingPreferences = true;
  preferencesDraft.defaultEditMode = defaultEditModeSelect.value;
  preferencesDraft.libraryPath = libraryPathInput.value;
  preferencesDraft.exportPath = exportPathInput.value;
  preferencesDraft.exportNameTemplate = exportNameTemplateInput.value;
  preferencesDraft.importSearchPaths = importSearchPathsInput.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  preferencesDraft.onlyFastEdits = onlyFastEditsInput.checked;
  preferencesDraft.stillsScale = stillsScaleSelect.value || "half";
  preferencesDraft.previewScale = previewScaleSelect.value || "source";
  preferencesDraft.previewGeneration = previewGenerationInput.checked;
  preferencesDraft.stillsSeeking = stillsSeekingInput.checked;
  try {
    await persistPreferences(preferencesDraft);
    await refreshLibrary();
    updateExportControls();
    if (currentMedia) {
      configurePreview(currentMedia);
      configureStills(currentMedia);
    }
    notice.textContent = "Preferences saved and paths reloaded.";
    return true;
  } catch (error) {
    preferencesMessage.textContent = error.message;
    return false;
  } finally {
    savingPreferences = false;
  }
}

async function saveAndClosePreferences() {
  if (await savePreferences()) preferencesDialog.close("saved");
}

const ACTIONS = [
  { id: "ui.toggleSidebar", label: "Toggle right panel", group: "Interface", run: toggleSidebar },
  { id: "ui.openPreferences", label: "Open preferences", group: "Interface", run: openPreferences },
  { id: "library.refresh", label: "Refresh library", group: "Library", run: refreshLibrary },
  { id: "library.loadSelected", label: "Load selected media", group: "Library", run: () => selectedMediaPath && loadMedia(selectedMediaPath) },
  { id: "project.openSelected", label: "Open selected project", group: "Project", run: () => selectedProjectId && loadProject(selectedProjectId) },
  { id: "project.save", label: "Save project", group: "Project", run: saveProject },
  { id: "project.exportSelected", label: "Export selected project as JSON", group: "Project", run: () => downloadProject() },
  { id: "project.deleteSelected", label: "Delete selected project", group: "Project", run: () => deleteProject() },
  { id: "playback.toggle", label: "Play or pause", group: "Playback", run: togglePlayback },
  { id: "playback.previousKeyframe", label: "Previous keyframe", group: "Playback", run: () => seekKeyframe(-1), repeatable: true },
  { id: "playback.nextKeyframe", label: "Next keyframe", group: "Playback", run: () => seekKeyframe(1), repeatable: true },
  ...[1, 3, 6, 10].flatMap((seconds) => [
    { id: `playback.backward${seconds}`, label: `Backward ${seconds} seconds`, group: "Playback", run: () => seekBySeconds(-seconds), repeatable: true },
    { id: `playback.forward${seconds}`, label: `Forward ${seconds} seconds`, group: "Playback", run: () => seekBySeconds(seconds), repeatable: true },
  ]),
  { id: "edit.modeInclude", label: "Switch to Include mode", group: "Edit", run: () => changeEditMode("include") },
  { id: "edit.modeRemove", label: "Switch to Remove mode", group: "Edit", run: () => changeEditMode("remove") },
  { id: "edit.markIn", label: "Mark in", group: "Edit", run: () => { markInUs = snapEditPoint(currentEditTimeUs()); renderMarks(); } },
  { id: "edit.markOut", label: "Mark out", group: "Edit", run: () => { markOutUs = snapEditPoint(currentEditTimeUs()); renderMarks(); } },
  { id: "edit.applyRange", label: "Apply marked range", group: "Edit", run: applyMarkedRange },
  { id: "edit.removeSelected", label: "Remove selected clip", group: "Edit", run: removeSelectedSegment },
  { id: "edit.undo", label: "Undo", group: "Edit", run: undoEdit },
  { id: "edit.redo", label: "Redo", group: "Edit", run: redoEdit },
  { id: "edit.reset", label: "Reset sequence", group: "Edit", run: () => resetSequence(true) },
  { id: "export.fast", label: "Fast export", group: "Export", run: () => beginExport("fast") },
  { id: "export.accurate", label: "Frame-accurate export", group: "Export", run: () => beginExport("accurate") },
  { id: "export.pauseSelected", label: "Pause selected export", group: "Export", run: () => controlExport(selectedExportJobId, "pause") },
  { id: "export.resumeSelected", label: "Resume selected export", group: "Export", run: () => controlExport(selectedExportJobId, "resume") },
  { id: "export.stopSelected", label: "Stop selected export", group: "Export", run: () => controlExport(selectedExportJobId, "stop") },
];
const ACTION_MAP = new Map(ACTIONS.map((action) => [action.id, action]));

function executeAction(actionId) {
  ACTION_MAP.get(actionId)?.run();
}

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => executeAction(button.dataset.action));
});
toggleSidebarButton.addEventListener("click", () => executeAction("ui.toggleSidebar"));
openPreferencesButton.addEventListener("click", () => executeAction("ui.openPreferences"));
refreshButton.addEventListener("click", () => executeAction("library.refresh"));
saveProjectButton.addEventListener("click", () => executeAction("project.save"));
importProjectButton.addEventListener("click", () => projectFileInput.click());
projectFileInput.addEventListener("change", () => importProject(projectFileInput.files[0]));
exportFastButton.addEventListener("click", () => executeAction("export.fast"));
exportAccurateButton.addEventListener("click", () => executeAction("export.accurate"));
clearExportQueueButton.addEventListener("click", clearExportQueue);
startExportQueueButton.addEventListener("click", startExportQueue);
includeModeButton.addEventListener("click", () => executeAction("edit.modeInclude"));
removeModeButton.addEventListener("click", () => executeAction("edit.modeRemove"));
for (const tab of panelTabs) {
  tab.addEventListener("click", () => activatePanelTab(tab.dataset.panelTab));
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const next = panelTabs[(panelTabs.indexOf(tab) + offset + panelTabs.length) % panelTabs.length];
    activatePanelTab(next.dataset.panelTab);
    next.focus();
  });
}
panelResizer.addEventListener("pointerdown", beginPanelResize);
panelResizer.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const currentWidth = libraryPanel.getBoundingClientRect().width;
  setPanelWidth(currentWidth + (event.key === "ArrowLeft" ? 20 : -20));
});
resetShortcutsButton.addEventListener("click", () => {
  preferencesDraft.shortcuts = structuredClone(DEFAULT_PREFERENCES.shortcuts);
  preferencesMessage.textContent = "Default shortcuts restored. Press Enter or close Preferences to apply them.";
  renderShortcutEditor();
});
clearProxiesButton.addEventListener("click", async () => {
  if (!window.confirm("Delete all cached preview proxies? They regenerate on demand.")) return;
  try {
    const result = await request("/api/proxies", { method: "DELETE" });
    preferences.previewScale = "source";
    previewScaleSelect.value = "source";
    if (currentMedia) {
      previewIsProxy = false;
      video.src = currentMedia.streamUrl;
      video.load();
      metadata.textContent = sourceMetadataLine;
    }
    preferencesMessage.textContent = `Cleared ${result.removed} preview proxy file${result.removed === 1 ? "" : "s"}. Preview set to full resolution.`;
  } catch (error) {
    preferencesMessage.textContent = error.message;
  }
});
preferencesForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveAndClosePreferences();
});
preferencesForm.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || capturingActionId || !event.target.matches("input, select")) return;
  event.preventDefault();
  saveAndClosePreferences();
});
closePreferencesButton.addEventListener("click", saveAndClosePreferences);
preferencesDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  saveAndClosePreferences();
});
preferencesDialog.addEventListener("click", (event) => {
  if (event.target === preferencesDialog) saveAndClosePreferences();
});
document.addEventListener("pointerdown", (event) => {
  if (!preferencesDialog.open) return;
  if (event.composedPath().includes(preferencesDialog)) return;
  saveAndClosePreferences();
});
exportNameTemplateInput.addEventListener("input", updateExportNameExample);
previewScaleSelect.addEventListener("change", async () => {
  if (preferences.previewGeneration === false) {
    previewScaleSelect.value = "source";
    return;
  }
  preferences.previewScale = previewScaleSelect.value;
  try {
    await persistPreferences({ ...preferences });
    updateExportControls();
    if (currentMedia) {
      notice.textContent = previewScaleSelect.value === "source"
        ? "Previewing full resolution."
        : `Previewing ${previewScaleSelect.value} resolution...`;
      configurePreview(currentMedia);
    }
  } catch (error) {
    notice.textContent = error.message;
  }
});

previewGenerationInput.addEventListener("change", async () => {
  preferences.previewGeneration = previewGenerationInput.checked;
  if (!preferences.previewGeneration) {
    previewScaleSelect.value = "source";
    preferences.previewScale = "source";
  }
  updatePreviewControlsState();
  try {
    await persistPreferences({ ...preferences });
    updateExportControls();
    if (currentMedia) {
      configurePreview(currentMedia);
      configureStills(currentMedia);
    }
  } catch (error) {
    notice.textContent = error.message;
  }
});

stillsSeekingInput.addEventListener("change", async () => {
  preferences.stillsSeeking = stillsSeekingInput.checked;
  if (!preferences.stillsSeeking && stillMode) exitStillMode(true);
  try {
    await persistPreferences({ ...preferences });
  } catch (error) {
    notice.textContent = error.message;
  }
});
timeline.addEventListener("pointerdown", (event) => {
  timeline.setPointerCapture(event.pointerId);
  seekTimeline(event.clientX);
});
timeline.addEventListener("pointermove", (event) => {
  if (timeline.hasPointerCapture(event.pointerId)) seekTimeline(event.clientX);
});
timeline.addEventListener("pointerup", (event) => {
  if (timeline.hasPointerCapture(event.pointerId)) timeline.releasePointerCapture(event.pointerId);
});
timeline.addEventListener("pointercancel", (event) => {
  if (timeline.hasPointerCapture(event.pointerId)) timeline.releasePointerCapture(event.pointerId);
});
timeline.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  seekKeyframe(event.key === "ArrowLeft" ? -1 : 1);
});
preferencesDialog.addEventListener("close", () => {
  capturingActionId = null;
});

document.addEventListener("keydown", (event) => {
  if (capturingActionId) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      capturingActionId = null;
      preferencesMessage.textContent = "Shortcut recording cancelled.";
      renderShortcutEditor();
      return;
    }
    const shortcut = normalizeShortcutEvent(event);
    if (!shortcut) return;
    const conflict = Object.entries(preferencesDraft.shortcuts).find(
      ([actionId, candidate]) => actionId !== capturingActionId && candidate === shortcut,
    );
    if (conflict) {
      preferencesDraft.shortcuts[conflict[0]] = null;
    }
    preferencesDraft.shortcuts[capturingActionId] = shortcut;
    capturingActionId = null;
    preferencesMessage.textContent = conflict
      ? `${displayShortcut(shortcut)} reassigned from ${ACTION_MAP.get(conflict[0])?.label ?? conflict[0]}. Press Enter or close Preferences to apply it.`
      : "Shortcut updated. Press Enter or close Preferences to apply it.";
    renderShortcutEditor();
    return;
  }

  if (preferencesDialog.open || (event.target.closest?.("input, select, textarea, [contenteditable='true']") ?? false)) return;
  const shortcut = normalizeShortcutEvent(event);
  const actionId = findShortcutAction(preferences.shortcuts, shortcut);
  const action = ACTION_MAP.get(actionId);
  if (!action || (event.repeat && !action.repeatable)) return;
  event.preventDefault();
  executeAction(action.id);
});

video.addEventListener("timeupdate", () => {
  syncRemovePlayback();
  const displayUs = currentEditTimeUs();
  playheadTime.value = formatTimeUs(displayUs);
  timeline.setAttribute("aria-valuenow", String(Math.round(displayUs)));
  drawTimeline();
});
video.addEventListener("seeked", () => {
  programmaticSeek = false;
  syncRemovePlayback();
});
video.addEventListener("play", () => {
  if (stillMode) exitStillMode(true);
  if (editMode === "remove") setSequencePlayhead(sequencePlayheadUs);
});
video.addEventListener("error", () => {
  notice.textContent = "The browser could not decode this video.";
});
viewerShell.addEventListener("dragover", (event) => {
  if (![...event.dataTransfer.items].some((item) => item.kind === "file")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "link";
  viewerShell.classList.add("drop-target");
});
viewerShell.addEventListener("dragleave", (event) => {
  if (event.target === viewerShell) viewerShell.classList.remove("drop-target");
});
viewerShell.addEventListener("drop", (event) => {
  event.preventDefault();
  viewerShell.classList.remove("drop-target");
  loadDroppedFile(event.dataTransfer.files[0]);
});
new ResizeObserver(drawTimeline).observe(timeline);

function restoreDraftToState(draft) {
  currentProjectId = draft.projectId ?? null;
  editMode = draft.editMode ?? "remove";
  includeModeButton.classList.toggle("active", editMode === "include");
  removeModeButton.classList.toggle("active", editMode === "remove");
  applyRangeButton.textContent = editMode === "remove" ? "Remove range" : "Include range";
  segments = (draft.segments ?? []).map((segment) => ({ ...segment }));
  selectedSegmentId = draft.selectedSegmentId ?? segments[0]?.id ?? null;
  sequencePlayheadUs = draft.sequencePlayheadUs ?? 0;
  markInUs = draft.markInUs ?? 0;
  markOutUs = draft.markOutUs ?? timelineDurationUs();
  if (draft.projectName) projectName.value = draft.projectName;
  resetHistory();
  renderMarks();
  renderSegments();
  if (editMode === "remove" && segments.length > 0) setSequencePlayhead(sequencePlayheadUs);
}

async function restoreDraft(draft) {
  if (!draft?.media) return false;
  const media = draft.media;
  const loaded = media.relativePath
    ? await loadMedia({ relativePath: media.relativePath }, null)
    : await loadLocatedMedia(media.name, null);
  if (!loaded) {
    notice.textContent = `Could not restore ${media.name} — the file may have moved. Draft kept for manual restore.`;
    return false;
  }
  restoreDraftToState(draft);
  return true;
}

function showRecoveryBar(draft) {
  recoveryMessage.textContent = `Unsaved edit session for ${draft.media?.name ?? "a file"} (${(draft.segments ?? []).length} segment${(draft.segments ?? []).length === 1 ? "" : "s"}).`;
  recoveryBar.hidden = false;
}

function hideRecoveryBar() {
  recoveryBar.hidden = true;
}

recoveryRestoreButton.addEventListener("click", async () => {
  const draft = readDraft();
  hideRecoveryBar();
  if (draft) {
    notice.textContent = "Restoring last edit session...";
    await restoreDraft(draft);
  }
});

recoveryDismissButton.addEventListener("click", () => {
  hideRecoveryBar();
  clearDraft();
  reportClientError("info", "User dismissed the recovered draft.", { at: new Date().toISOString() });
});

window.addEventListener("pagehide", () => {
  try {
    localStorage.setItem(CLEAN_CLOSE_KEY, "1");
  } catch {
    // ignore
  }
});
window.addEventListener("error", (event) => {
  reportClientError("error", event.message ?? "Uncaught error", { source: "window.error", stack: event.error?.stack ?? null });
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  reportClientError("error", String(reason?.message ?? reason), { source: "unhandledrejection", stack: reason?.stack ?? null });
});

async function initialize() {
  try {
    const savedPreferences = await request("/api/preferences");
    preferences = {
      ...structuredClone(DEFAULT_PREFERENCES),
      ...savedPreferences,
      shortcuts: { ...DEFAULT_PREFERENCES.shortcuts, ...savedPreferences.shortcuts },
    };
  } catch (error) {
    notice.textContent = `Using default preferences: ${error.message}`;
  }
  editMode = preferences.defaultEditMode;
  activatePanelTab("library");
  applySidebarPreference();
  updatePreviewControlsState();
  renderMissingPaths();
  includeModeButton.classList.toggle("active", editMode === "include");
  removeModeButton.classList.toggle("active", editMode === "remove");
  applyRangeButton.textContent = editMode === "remove" ? "Remove range" : "Include range";
  updateControlStates();
  await Promise.all([refreshLibrary(), refreshProjects(), refreshExportQueue(), refreshMediaManager()]);
  window.setInterval(refreshExportQueue, 750);

  const draft = readDraft();
  if (draft && draft.version === 1) {
    const cleanClose = (() => {
      try {
        return localStorage.getItem(CLEAN_CLOSE_KEY) === "1";
      } catch {
        return false;
      }
    })();
    if (cleanClose) {
      showRecoveryBar(draft);
    } else {
      reportClientError("warn", "Previous session did not close cleanly; restoring draft.", {
        media: draft.media?.name,
        draftAt: draft.savedAt,
      });
      notice.textContent = "Recovering from the previous session after a crash...";
      await restoreDraft(draft);
    }
  }
  try {
    localStorage.setItem(CLEAN_CLOSE_KEY, "0");
  } catch {
    // ignore
  }
}

initialize();
