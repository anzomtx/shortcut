const video = document.querySelector("#video");
const viewerEmpty = document.querySelector("#viewer-empty");
const viewerTitle = document.querySelector("#viewer-title");
const metadata = document.querySelector("#media-metadata");
const rootPath = document.querySelector("#root-path");
const fileList = document.querySelector("#file-list");
const notice = document.querySelector("#notice");
const refreshButton = document.querySelector("#refresh-button");
const serverStatus = document.querySelector("#server-status");
const previousKeyframeButton = document.querySelector("#previous-keyframe");
const nextKeyframeButton = document.querySelector("#next-keyframe");
const playheadTime = document.querySelector("#playhead-time");
const timeline = document.querySelector("#timeline");
const markInButton = document.querySelector("#mark-in");
const markOutButton = document.querySelector("#mark-out");
const addSegmentButton = document.querySelector("#add-segment");
const inPoint = document.querySelector("#in-point");
const outPoint = document.querySelector("#out-point");
const editedDuration = document.querySelector("#edited-duration");
const segmentList = document.querySelector("#segment-list");
const projectName = document.querySelector("#project-name");
const saveProjectButton = document.querySelector("#save-project");
const projectList = document.querySelector("#project-list");
const exportFastButton = document.querySelector("#export-fast");
const exportAccurateButton = document.querySelector("#export-accurate");
const exportProgress = document.querySelector("#export-progress");
const exportStatus = document.querySelector("#export-status");

let currentMedia = null;
let keyframesUs = [];
let markInUs = 0;
let markOutUs = 0;
let segments = [];
let currentProjectId = null;

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

function isKeyframe(timestampUs) {
  let low = 0;
  let high = keyframesUs.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (keyframesUs[middle] < timestampUs) low = middle + 1;
    else high = middle;
  }
  return [keyframesUs[low - 1], keyframesUs[low]].some(
    (keyframe) => Number.isFinite(keyframe) && Math.abs(keyframe - timestampUs) <= 2_000,
  );
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

  if (!currentMedia?.durationUs) return;
  const toX = (timestampUs) => (timestampUs / currentMedia.durationUs) * width;

  context.fillStyle = "#36382f";
  context.fillRect(0, height / 2 - 1, width, 2);

  context.fillStyle = "rgba(209, 254, 63, 0.7)";
  const keyframeStep = Math.max(1, Math.ceil(keyframesUs.length / Math.max(width / 3, 1)));
  for (let index = 0; index < keyframesUs.length; index += keyframeStep) {
    const x = Math.round(toX(keyframesUs[index]));
    context.fillRect(x, height / 2 - 8, 1, 16);
  }

  for (const segment of segments) {
    const start = toX(segment.inUs);
    const segmentWidth = Math.max(2, toX(segment.outUs) - start);
    context.fillStyle = "rgba(91, 181, 255, 0.38)";
    context.fillRect(start, 8, segmentWidth, height - 16);
    context.strokeStyle = "#5bb5ff";
    context.strokeRect(start + 0.5, 8.5, segmentWidth - 1, height - 17);
  }

  context.fillStyle = "#f0a36e";
  context.fillRect(toX(markInUs), 0, 2, height);
  context.fillStyle = "#ef6e68";
  context.fillRect(toX(markOutUs) - 2, 0, 2, height);
  context.fillStyle = "#f4f3ea";
  context.fillRect(toX(video.currentTime * 1_000_000) - 1, 0, 2, height);
}

function renderMarks() {
  inPoint.value = `In ${formatTimeUs(markInUs)}`;
  outPoint.value = `Out ${formatTimeUs(markOutUs)}`;
  inPoint.classList.toggle("on-keyframe", isKeyframe(markInUs));
  addSegmentButton.disabled = !currentMedia || markOutUs <= markInUs;
  drawTimeline();
}

function renderSegments() {
  segmentList.replaceChildren();
  const totalDurationUs = segments.reduce((total, segment) => total + segment.outUs - segment.inUs, 0);
  editedDuration.value = `Edited duration ${formatTimeUs(totalDurationUs)}`;

  if (segments.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-segments";
    empty.textContent = "Mark an in and out point, then add a segment.";
    segmentList.append(empty);
  }

  segments.forEach((segment, index) => {
    const item = document.createElement("li");
    const jumpButton = document.createElement("button");
    const detail = document.createElement("span");
    const mode = document.createElement("small");
    const removeButton = document.createElement("button");
    jumpButton.type = "button";
    jumpButton.textContent = String(index + 1).padStart(2, "0");
    jumpButton.title = "Jump to segment in point";
    jumpButton.addEventListener("click", () => {
      video.currentTime = segment.inUs / 1_000_000;
    });
    detail.textContent = `${formatTimeUs(segment.inUs)} - ${formatTimeUs(segment.outUs)}`;
    mode.textContent = isKeyframe(segment.inUs) ? "Fast export ready" : "Frame-accurate only";
    mode.className = isKeyframe(segment.inUs) ? "fast-ready" : "frame-only";
    removeButton.type = "button";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => {
      segments = segments.filter((candidate) => candidate.id !== segment.id);
      renderSegments();
      drawTimeline();
    });
    item.append(jumpButton, detail, mode, removeButton);
    segmentList.append(item);
  });

  drawTimeline();
  updateExportControls();
}

function updateExportControls(updateMessage = true) {
  const hasSegments = Boolean(currentMedia && segments.length > 0);
  exportAccurateButton.disabled = !hasSegments;
  exportFastButton.disabled =
    !hasSegments || segments.some((segment) => !isKeyframe(segment.inUs));
  if (!updateMessage) return;
  if (!hasSegments) exportStatus.value = "Add a keep segment to enable export.";
  else if (exportFastButton.disabled) {
    exportStatus.value = "Use frame accurate, or move every in point to a keyframe.";
  } else {
    exportStatus.value = "Both export modes are available.";
  }
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

async function loadMedia(relativePath, button) {
  notice.textContent = "Validating media with ffprobe...";
  if (button) button.disabled = true;

  try {
    const media = await request("/api/media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relativePath }),
    });
    const keyframeIndex = await request(media.keyframesUrl);
    currentMedia = media;
    keyframesUs = keyframeIndex.keyframesUs;
    markInUs = 0;
    markOutUs = media.durationUs;
    segments = [];
    video.src = media.streamUrl;
    video.load();
    viewerEmpty.hidden = true;
    viewerTitle.textContent = media.name;
    metadata.textContent = `${media.video.width}x${media.video.height} · ${formatDuration(media.durationUs / 1_000_000)} · ${media.video.averageFrameRate?.toFixed(3) ?? "?"} fps · ${formatBytes(media.size)}`;
    previousKeyframeButton.disabled = keyframesUs.length === 0;
    nextKeyframeButton.disabled = keyframesUs.length === 0;
    markInButton.disabled = false;
    markOutButton.disabled = false;
    timeline.setAttribute("aria-valuemax", String(media.durationUs));
    renderMarks();
    renderSegments();
    currentProjectId = null;
    projectName.value = `${media.name.replace(/\.mp4$/i, "")} edit`;
    saveProjectButton.disabled = false;
    notice.textContent = `Source indexed with ${keyframesUs.length} keyframe${keyframesUs.length === 1 ? "" : "s"}.`;
    return true;
  } catch (error) {
    notice.textContent = error.message;
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

async function refreshProjects() {
  try {
    const result = await request("/api/projects");
    projectList.replaceChildren();
    if (result.projects.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty-projects";
      empty.textContent = "No saved projects yet.";
      projectList.append(empty);
      return;
    }

    for (const project of result.projects) {
      const item = document.createElement("li");
      const details = document.createElement("div");
      const name = document.createElement("strong");
      const summary = document.createElement("span");
      const button = document.createElement("button");
      name.textContent = project.name;
      summary.textContent = `${project.sourceName} · ${project.segmentCount} segment${project.segmentCount === 1 ? "" : "s"}`;
      details.append(name, summary);
      button.type = "button";
      button.textContent = "Open";
      button.addEventListener("click", () => loadProject(project.id, button));
      item.append(details, button);
      projectList.append(item);
    }
  } catch (error) {
    notice.textContent = error.message;
  }
}

async function loadProject(projectId, button) {
  button.disabled = true;
  notice.textContent = "Opening saved project...";
  try {
    const project = await request(`/api/projects/${projectId}`);
    const loaded = await loadMedia(project.source.relativePath, null);
    if (!loaded) return;
    currentProjectId = project.id;
    projectName.value = project.name;
    segments = project.segments.map((segment) => ({ ...segment }));
    renderSegments();
    notice.textContent = `Opened ${project.name}.`;
  } catch (error) {
    notice.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function saveProject() {
  if (!currentMedia) return null;
  saveProjectButton.disabled = true;
  notice.textContent = "Saving edit decision list...";
  const body = {
    name: projectName.value,
    sourceMediaId: currentMedia.id,
    segments: segments.map(({ id, inUs, outUs }) => ({ id, inUs, outUs })),
  };

  try {
    const project = await request(
      currentProjectId ? `/api/projects/${currentProjectId}` : "/api/projects",
      {
        method: currentProjectId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    currentProjectId = project.id;
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
  const buttons = [exportFastButton, exportAccurateButton];
  buttons.forEach((button) => {
    button.disabled = true;
  });
  exportProgress.value = 0;
  exportStatus.value = "Saving project before export...";

  try {
    const project = await saveProject();
    if (!project) return;
    const job = await request("/api/exports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id, mode }),
    });
    exportStatus.value = mode === "fast" ? "Copying source packets..." : "Encoding selected frames...";

    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      const status = await request(`/api/exports/${job.id}`);
      exportProgress.value = status.progress;
      if (status.status === "completed") {
        exportStatus.value = `Exported to ${status.outputPath}`;
        notice.textContent = `${status.outputName} is ready.`;
        break;
      }
      if (status.status === "failed") throw new Error(status.error);
    }
  } catch (error) {
    exportStatus.value = `Export failed: ${error.message}`;
    notice.textContent = error.message;
  } finally {
    updateExportControls(false);
  }
}

function seekKeyframe(direction) {
  if (!currentMedia || keyframesUs.length === 0) return;
  const currentUs = Math.round(video.currentTime * 1_000_000);
  let low = 0;
  let high = keyframesUs.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (keyframesUs[middle] < currentUs + (direction > 0 ? 1_000 : -1_000)) low = middle + 1;
    else high = middle;
  }

  const index = direction > 0 ? low : low - 1;
  if (index >= 0 && index < keyframesUs.length) {
    video.currentTime = keyframesUs[index] / 1_000_000;
  }
}

function addSegment() {
  if (!currentMedia || markOutUs <= markInUs) return;
  const overlaps = segments.some(
    (segment) => markInUs < segment.outUs && markOutUs > segment.inUs,
  );
  if (overlaps) {
    notice.textContent = "Keep segments cannot overlap.";
    return;
  }
  segments.push({ id: crypto.randomUUID(), inUs: markInUs, outUs: markOutUs });
  segments.sort((left, right) => left.inUs - right.inUs);
  notice.textContent = "Segment added to the edit decision list.";
  renderSegments();
}

function seekTimeline(clientX) {
  if (!currentMedia?.durationUs) return;
  const bounds = timeline.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
  video.currentTime = (ratio * currentMedia.durationUs) / 1_000_000;
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
    const name = document.createElement("strong");
    const path = document.createElement("span");
    const button = document.createElement("button");

    name.textContent = file.name;
    path.textContent = `${file.relativePath} · ${formatBytes(file.size)}`;
    details.append(name, path);
    button.type = "button";
    button.textContent = "Load";
    button.addEventListener("click", () => loadMedia(file.relativePath, button));
    item.append(details, button);
    fileList.append(item);
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

refreshButton.addEventListener("click", refreshLibrary);
saveProjectButton.addEventListener("click", saveProject);
exportFastButton.addEventListener("click", () => beginExport("fast"));
exportAccurateButton.addEventListener("click", () => beginExport("accurate"));
previousKeyframeButton.addEventListener("click", () => seekKeyframe(-1));
nextKeyframeButton.addEventListener("click", () => seekKeyframe(1));
markInButton.addEventListener("click", () => {
  markInUs = Math.round(video.currentTime * 1_000_000);
  renderMarks();
});
markOutButton.addEventListener("click", () => {
  markOutUs = Math.round(video.currentTime * 1_000_000);
  renderMarks();
});
addSegmentButton.addEventListener("click", addSegment);
timeline.addEventListener("pointerdown", (event) => seekTimeline(event.clientX));
timeline.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  seekKeyframe(event.key === "ArrowLeft" ? -1 : 1);
});
video.addEventListener("timeupdate", () => {
  playheadTime.value = formatTimeUs(video.currentTime * 1_000_000);
  timeline.setAttribute("aria-valuenow", String(Math.round(video.currentTime * 1_000_000)));
  drawTimeline();
});
video.addEventListener("error", () => {
  notice.textContent = "The browser could not decode this video.";
});

new ResizeObserver(drawTimeline).observe(timeline);

Promise.all([refreshLibrary(), refreshProjects()]);
