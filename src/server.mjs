import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, appendFile, lstat, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { exportFrameAccurate, exportStreamCopy, isKeyframeAligned, verifyMediaSource } from "./exporter.mjs";
import { ExportQueue } from "./export-queue.mjs";

const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_ROOT = path.resolve(SOURCE_DIRECTORY, "../public");
const LOG_DIRECTORY = path.resolve(SOURCE_DIRECTORY, "../logs");
const MAX_JSON_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;
const EXPORT_NAME_DEFAULT = "%o-%m-%h.%ext";
const DEFAULT_PREFERENCES = {
  version: 1,
  sidebarCollapsed: true,
  defaultEditMode: "remove",
  libraryPath: null,
  exportPath: null,
  exportNameTemplate: EXPORT_NAME_DEFAULT,
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

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/edit-model.js", ["edit-model.js", "text/javascript; charset=utf-8"]],
  ["/shortcut-model.js", ["shortcut-model.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function createTaskLimiter(limit) {
  let active = 0;
  const waiting = [];
  const acquire = () => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return async (operation) => {
    await acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

async function appendLogLine(fileName, entry) {
  try {
    await mkdir(LOG_DIRECTORY, { recursive: true });
    await appendFile(path.join(LOG_DIRECTORY, fileName), `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.error("Unable to write log file", error);
  }
}

async function readJson(request) {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    const error = new Error("Content-Type must be application/json");
    error.statusCode = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    const error = new Error("Request body must be a JSON object");
    error.statusCode = 400;
    throw error;
  }
  return value;
}

async function scanMp4Files(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await scanMp4Files(root, absolutePath)));
    } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".mp4") {
      const fileStat = await stat(absolutePath);
      files.push({
        name: entry.name,
        relativePath: path.relative(root, absolutePath),
        size: fileStat.size,
      });
    }
  }

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function runFfmpegToFile({ sourcePath, outputPath, ffmpegPath, args, onProgress, onStderr, onSpawn, children, signal }) {
  if (signal?.aborted) return Promise.reject(new DOMException("Background task stopped", "AbortError"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      ["-v", "error", "-y", "-i", sourcePath, ...args, outputPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children?.add(child);
    if (onSpawn) onSpawn(child);
    let stderr = "";
    let progressBuffer = "";
    let progress = 0;
    let aborted = false;
    let killTimer = null;
    const handleAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref?.();
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr = `${stderr}${text}`.slice(-64_000);
      if (onStderr) onStderr(text);
    });
    child.stdout.on("data", (chunk) => {
      if (!onProgress) return;
      progressBuffer += chunk.toString("utf8");
      const lines = progressBuffer.split("\n");
      progressBuffer = lines.pop();
      for (const line of lines) {
        const match = /^out_time_ms=(\d+)$/.exec(line);
        if (match) {
          progress = Number(match[1]) / 1_000_000;
          onProgress(progress);
        }
      }
    });
    child.on("error", (error) => {
      children?.delete(child);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", handleAbort);
      reject(new Error(`Unable to run ffmpeg: ${error.message}`));
    });
    child.on("close", (code) => {
      children?.delete(child);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", handleAbort);
      if (aborted) {
        reject(new DOMException("Background task stopped", "AbortError"));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || "ffmpeg failed"));
        return;
      }
      resolve(progress);
    });
  });
}

function runFfprobe(filePath, ffprobePath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffprobePath,
      [
        "-v",
        "error",
        ...args,
        "-of",
        "json",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout = [];
    let stdoutSize = 0;
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
    timeout.unref?.();

    child.stdout.on("data", (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize > 8 * 1024 * 1024) {
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Unable to run ffprobe: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (stdoutSize > 8 * 1024 * 1024) {
        reject(new Error("ffprobe metadata output exceeded 8 MB"));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || "ffprobe failed"));
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch {
        reject(new Error("ffprobe returned invalid output"));
      }
    });
  });
}

function indexKeyframesWithFfprobe(filePath, ffprobePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffprobePath,
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_packets",
        "-show_entries", "packet=pts_time,flags",
        "-of", "csv=p=0",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const keyframesUs = [];
    let lineBuffer = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
    timeout.unref?.();
    const parseLine = (line) => {
      const [ptsText, flags = ""] = line.trim().split(",");
      if (!flags.includes("K")) return;
      const timestampUs = Math.round(Number(ptsText) * 1_000_000);
      if (Number.isSafeInteger(timestampUs) && timestampUs >= 0) keyframesUs.push(timestampUs);
    };
    child.stdout.on("data", (chunk) => {
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop();
      for (const line of lines) parseLine(line);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Unable to index keyframes with ffprobe: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (lineBuffer) parseLine(lineBuffer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || "ffprobe keyframe indexing failed"));
        return;
      }
      resolve([...new Set(keyframesUs)].sort((left, right) => left - right));
    });
  });
}

function fractionToNumber(value) {
  if (typeof value !== "string") return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

async function analyzeMedia(filePath, ffprobePath) {
  const probe = await runFfprobe(filePath, ffprobePath, [
    "-show_entries",
    "format=duration,format_name,bit_rate:stream=index,codec_type,codec_name,codec_long_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,time_base,duration,sample_rate,channels,channel_layout:stream_tags=rotate",
  ]);

  const videoStream = probe.streams?.find((stream) => stream.codec_type === "video");
  if (!videoStream) return null;

  const durationSeconds = Number(videoStream.duration ?? probe.format?.duration);
  const nominalFrameRate = fractionToNumber(videoStream.r_frame_rate);
  const averageFrameRate = fractionToNumber(videoStream.avg_frame_rate);
  const rotationSideData = videoStream.side_data_list?.find((item) => Number.isFinite(item.rotation));

  const keyframesUs = await indexKeyframesWithFfprobe(filePath, ffprobePath);

  return {
    container: probe.format?.format_name ?? null,
    durationUs: Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1_000_000) : null,
    bitRate: Number(probe.format?.bit_rate) || null,
    video: {
      streamIndex: videoStream.index,
      codec: videoStream.codec_name,
      codecLongName: videoStream.codec_long_name ?? null,
      width: videoStream.width,
      height: videoStream.height,
      pixelFormat: videoStream.pix_fmt ?? null,
      timeBase: videoStream.time_base ?? null,
      nominalFrameRate,
      averageFrameRate,
      isVariableFrameRate:
        nominalFrameRate !== null &&
        averageFrameRate !== null &&
        Math.abs(nominalFrameRate - averageFrameRate) > 0.001,
      rotation: Number(rotationSideData?.rotation ?? videoStream.tags?.rotate) || 0,
    },
    audio: (probe.streams ?? [])
      .filter((stream) => stream.codec_type === "audio")
      .map((stream) => ({
        streamIndex: stream.index,
        codec: stream.codec_name,
        codecLongName: stream.codec_long_name ?? null,
        sampleRate: Number(stream.sample_rate) || null,
        channels: stream.channels ?? null,
        channelLayout: stream.channel_layout ?? null,
        timeBase: stream.time_base ?? null,
      })),
    keyframesUs,
  };
}

async function readCachedAnalysis(cacheDirectory, mediaId, fileStat) {
  try {
    const cached = JSON.parse(await readFile(path.join(cacheDirectory, `${mediaId}.json`), "utf8"));
    if (cached.version === 3 && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
      return cached.analysis;
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return null;
}

async function writeCachedAnalysis(cacheDirectory, mediaId, fileStat, analysis) {
  const cachePath = path.join(cacheDirectory, `${mediaId}.json`);
  const temporaryPath = `${cachePath}.${randomUUID()}.tmp`;
  await writeFile(
    temporaryPath,
    JSON.stringify({ version: 3, size: fileStat.size, mtimeMs: fileStat.mtimeMs, analysis }),
  );
  await rename(temporaryPath, cachePath);
}

function invalidPersistedData(message) {
  const error = new Error(message);
  error.code = "INVALID_PERSISTED_DATA";
  return error;
}

async function recoverInvalidPersistence(filePath, error, recoveries) {
  if (error.code === "ENOENT") return false;
  if (!(error instanceof SyntaxError) && error.code !== "INVALID_PERSISTED_DATA") throw error;
  const recoveryPath = `${filePath}.corrupt-${Date.now()}-${randomUUID()}`;
  await rename(filePath, recoveryPath);
  recoveries?.push({ name: path.basename(filePath), recoveryPath });
  console.warn(`Ignored invalid persisted data in ${filePath}; moved it to ${recoveryPath}.`);
  return true;
}

function serializeMedia(media) {
  const { keyframesUs, ...metadata } = media.analysis;
  return {
    id: media.id,
    name: media.name,
    relativePath: media.relativePath,
    absolutePath: media.relativePath ? null : media.absolutePath,
    size: media.size,
    mtimeMs: media.mtimeMs,
    ...metadata,
    keyframeCount: keyframesUs.length,
    streamUrl: `/api/media/${media.id}/stream`,
    metadataUrl: `/api/media/${media.id}/metadata`,
    keyframesUrl: `/api/media/${media.id}/keyframes`,
  };
}

async function readProjects(projectsPath, recoveries) {
  try {
    const projects = JSON.parse(await readFile(projectsPath, "utf8"));
    if (!Array.isArray(projects) || projects.some((project) => !project || typeof project.id !== "string")) {
      throw invalidPersistedData("Persisted projects are invalid");
    }
    return new Map(projects.map((project) => [project.id, project]));
  } catch (error) {
    if (await recoverInvalidPersistence(projectsPath, error, recoveries)) return new Map();
    return new Map();
  }
}

async function readExportJobs(exportsPath, recoveries) {
  try {
    const jobs = JSON.parse(await readFile(exportsPath, "utf8"));
    if (!Array.isArray(jobs)) throw invalidPersistedData("Persisted export queue is invalid");
    return jobs.map((job) => ({
      ...job,
      status: ["completed", "failed", "stopped"].includes(job.status) ? job.status : "paused",
      progress: ["completed", "failed", "stopped"].includes(job.status) ? job.progress : 0,
      startedAt: ["completed", "failed", "stopped"].includes(job.status) ? job.startedAt : null,
      media: {
        path: job.sourcePath,
        sourceIdentity: job.sourceIdentity ?? null,
        analysis: { audio: job.hasAudio ? [{}] : [] },
      },
    }));
  } catch (error) {
    if (await recoverInvalidPersistence(exportsPath, error, recoveries)) return [];
    return [];
  }
}

function serializePersistedExport(job) {
  return {
    id: job.id,
    projectId: job.projectId,
    projectName: job.projectName,
    mode: job.mode,
    status: job.status,
    progress: job.progress,
    outputName: job.outputName,
    outputPath: job.outputPath,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    startedAt: job.startedAt ?? null,
    sourcePath: job.media.path,
    sourceIdentity: job.media.sourceIdentity,
    hasAudio: job.media.analysis.audio.length > 0,
    segments: job.segments,
  };
}

async function readPreferences(preferencesPath, recoveries) {
  try {
    const saved = JSON.parse(await readFile(preferencesPath, "utf8"));
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
      throw invalidPersistedData("Persisted preferences are invalid");
    }
    return {
      ...DEFAULT_PREFERENCES,
      ...saved,
      shortcuts: { ...DEFAULT_PREFERENCES.shortcuts, ...saved.shortcuts },
    };
  } catch (error) {
    if (await recoverInvalidPersistence(preferencesPath, error, recoveries)) return structuredClone(DEFAULT_PREFERENCES);
    return structuredClone(DEFAULT_PREFERENCES);
  }
}

function validateExportNameTemplate(value) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 100) {
    const error = new Error("Export name template must be between 1 and 100 characters");
    error.statusCode = 400;
    throw error;
  }
  const template = value.trim();
  if (template.includes("/") || template.includes("\\") || template.includes("..")) {
    const error = new Error("Export name template cannot contain path separators");
    error.statusCode = 400;
    throw error;
  }
  const unknownTokens = [...template.matchAll(/%([a-zA-Z]+)%?/g)]
    .map((match) => match[1])
    .filter((token) => !["f", "o", "m", "h", "ext"].includes(token));
  if (unknownTokens.length > 0) {
    const error = new Error(`Unknown template token %${unknownTokens[0]}. Use %f, %o, %m, %h, or %ext.`);
    error.statusCode = 400;
    throw error;
  }
  return template;
}

function validateImportSearchPaths(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) {
    const error = new Error("Import search paths must be a list of at most 20 folders");
    error.statusCode = 400;
    throw error;
  }
  const normalized = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim() || !path.isAbsolute(entry)) {
      const error = new Error("Every import search path must be an absolute folder path");
      error.statusCode = 400;
      throw error;
    }
    normalized.push(path.normalize(entry.trim()));
  }
  return [...new Set(normalized)];
}

function validatePreferences(body) {
  if (
    typeof body.sidebarCollapsed !== "boolean" ||
    (body.defaultEditMode !== "include" && body.defaultEditMode !== "remove") ||
    typeof body.libraryPath !== "string" ||
    !body.libraryPath.trim() ||
    !path.isAbsolute(body.libraryPath) ||
    typeof body.exportPath !== "string" ||
    !body.exportPath.trim() ||
    !path.isAbsolute(body.exportPath) ||
    !body.shortcuts ||
    typeof body.shortcuts !== "object" ||
    Array.isArray(body.shortcuts)
  ) {
    const error = new Error("Preferences are invalid");
    error.statusCode = 400;
    throw error;
  }
  const exportNameTemplate = body.exportNameTemplate === undefined
    ? EXPORT_NAME_DEFAULT
    : validateExportNameTemplate(body.exportNameTemplate);
  const importSearchPaths = validateImportSearchPaths(body.importSearchPaths);
  const entries = Object.entries(body.shortcuts);
  if (entries.length > 100) {
    const error = new Error("Too many shortcut mappings");
    error.statusCode = 400;
    throw error;
  }
  const shortcuts = {};
  for (const [action, shortcut] of entries) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9.]{0,63}$/.test(action) ||
      (shortcut !== null && (typeof shortcut !== "string" || shortcut.length > 64))
    ) {
      const error = new Error("Shortcut mappings are invalid");
      error.statusCode = 400;
      throw error;
    }
    shortcuts[action] = shortcut;
  }
  return {
    version: 1,
    sidebarCollapsed: body.sidebarCollapsed,
    defaultEditMode: body.defaultEditMode,
    libraryPath: path.normalize(body.libraryPath.trim()),
    exportPath: path.normalize(body.exportPath.trim()),
    exportNameTemplate,
    importSearchPaths,
    onlyFastEdits: body.onlyFastEdits === true,
    previewScale: body.previewScale === "half" || body.previewScale === "quarter" ? body.previewScale : "source",
    previewGeneration: body.previewGeneration !== false,
    stillsSeeking: body.stillsSeeking !== false,
    stillsScale: ["full", "half", "quarter", "eighth"].includes(body.stillsScale) ? body.stillsScale : "half",
    shortcuts,
  };
}

function validateProjectInput(body, mediaRegistry) {
  if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 100) {
    const error = new Error("Project name must be between 1 and 100 characters");
    error.statusCode = 400;
    throw error;
  }
  const media = mediaRegistry.get(body.sourceMediaId);
  if (!media) {
    const error = new Error("Project source media is not registered");
    error.statusCode = 400;
    throw error;
  }
  if (!Array.isArray(body.segments)) {
    const error = new Error("Project segments must be an array");
    error.statusCode = 400;
    throw error;
  }

  const segments = body.segments.map((segment) => ({
    id: typeof segment.id === "string" ? segment.id : randomUUID(),
    inUs: segment.inUs,
    outUs: segment.outUs,
  }));
  segments.sort((left, right) => left.inUs - right.inUs);

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (
      !Number.isSafeInteger(segment.inUs) ||
      !Number.isSafeInteger(segment.outUs) ||
      segment.inUs < 0 ||
      segment.outUs <= segment.inUs ||
      segment.outUs > media.analysis.durationUs
    ) {
      const error = new Error("Every segment must be within the source duration and have a positive length");
      error.statusCode = 400;
      throw error;
    }
    if (index > 0 && segments[index - 1].outUs > segment.inUs) {
      const error = new Error("Project segments cannot overlap");
      error.statusCode = 400;
      throw error;
    }
  }

  return {
    name: body.name.trim(),
    editMode: body.editMode === "remove" ? "remove" : "include",
    source: {
      mediaId: media.id,
      relativePath: media.relativePath,
      absolutePath: media.relativePath ? null : media.absolutePath,
      name: media.name,
      size: media.size,
      mtimeMs: media.mtimeMs,
    },
    segments,
  };
}

function validateProjectImport(body) {
  if (body?.format !== "shortcut-project" || body.version !== 1 || !body.project) {
    const error = new Error("File is not a supported Shortcut project");
    error.statusCode = 400;
    throw error;
  }
  const project = body.project;
  if (
    typeof project.source?.relativePath !== "string" ||
    !project.source.relativePath ||
    path.isAbsolute(project.source.relativePath)
  ) {
    const error = new Error("Imported project source path is invalid");
    error.statusCode = 400;
    throw error;
  }
  return project;
}

function createExportName(project, mode, requestedName, jobId, template = EXPORT_NAME_DEFAULT) {
  if (requestedName !== undefined) {
    if (
      typeof requestedName !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,100}\.mp4$/i.test(requestedName)
    ) {
      const error = new Error("Output name must be a safe MP4 file name");
      error.statusCode = 400;
      throw error;
    }
    return requestedName;
  }
  const slug = project.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "shortcut-export";
  const originalBase = path.basename(project.source.name, path.extname(project.source.name));
  let name = template
    .replaceAll("%f", originalBase)
    .replaceAll("%o", slug)
    .replaceAll("%m", mode)
    .replaceAll("%h", jobId.slice(0, 8))
    .replaceAll("%ext", "mp4");
  name = name.replace(/[^a-zA-Z0-9._ -]+/g, "").trim().slice(0, 120);
  if (!name) name = `${slug}-${mode}-${jobId.slice(0, 8)}.mp4`;
  if (!/\.mp4$/i.test(name)) name += ".mp4";
  return name;
}

function serializeExport(job) {
  return {
    id: job.id,
    projectId: job.projectId,
    projectName: job.projectName,
    mode: job.mode,
    status: job.status,
    progress: job.progress,
    outputName: job.outputName,
    outputPath: job.outputPath,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    startedAt: job.startedAt ?? null,
  };
}

function runTool(toolPath, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(toolPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      reject(new Error(`${label} was not found at "${toolPath}". Install an Intel-compatible FFmpeg package or set ${label.toUpperCase()}_PATH. (${error.message})`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${label} failed its startup check: ${Buffer.concat(stderr).toString("utf8").trim() || `exit code ${code}`}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

export async function verifyRuntime({
  ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg",
  ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe",
} = {}) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major !== 22) console.warn(`Shortcut is tested with Node.js 22 LTS; current version is ${process.version}.`);
  const [encoders] = await Promise.all([
    runTool(ffmpegPath, ["-hide_banner", "-encoders"], "ffmpeg"),
    runTool(ffprobePath, ["-version"], "ffprobe"),
  ]);
  if (!/\blibx264\b/.test(encoders)) {
    throw new Error(`FFmpeg at "${ffmpegPath}" does not include the required libx264 encoder.`);
  }
  if (!/^\s*A.....\s+aac\s/m.test(encoders)) {
    throw new Error(`FFmpeg at "${ffmpegPath}" does not include the required AAC encoder.`);
  }
}

function parseRange(header, size) {
  if (!header) return null;
  if (!header.startsWith("bytes=") || header.includes(",")) return undefined;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return undefined;

  let start;
  let end;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return undefined;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
    if (start >= size || end < start) return undefined;
    end = Math.min(end, size - 1);
  }

  return { start, end };
}

async function streamFile(request, response, filePath, contentType) {
  const fileStat = await stat(filePath);
  const range = parseRange(request.headers.range, fileStat.size);
  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
  };

  if (range === undefined) {
    response.writeHead(416, { ...headers, "Content-Range": `bytes */${fileStat.size}` });
    response.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? fileStat.size - 1;
  const statusCode = range ? 206 : 200;
  headers["Content-Length"] = String(end - start + 1);
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${fileStat.size}`;

  response.writeHead(statusCode, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream = createReadStream(filePath, { start, end });
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

async function streamMedia(request, response, media) {
  return streamFile(request, response, media.path, "video/mp4");
}

export async function createApp(options = {}) {
  const configuredRoot = path.resolve(options.mediaRoot ?? process.env.MEDIA_ROOT ?? "media");
  const dataRoot = path.resolve(options.dataRoot ?? process.env.DATA_ROOT ?? ".shortcut-data");
  const configuredOutputRoot = path.resolve(
    options.outputRoot ?? process.env.OUTPUT_ROOT ?? path.join(configuredRoot, "shortcut-exports"),
  );
  const publicRoot = path.resolve(options.publicRoot ?? DEFAULT_PUBLIC_ROOT);
  const ffprobePath = options.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe";
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const cacheDirectory = path.join(dataRoot, "metadata");
  const proxyDirectory = path.join(dataRoot, "proxies");
  const stillRoot = path.join(dataRoot, "stills");
  const exportWorkRoot = path.join(dataRoot, "export-work");
  const projectsPath = path.join(dataRoot, "projects.json");
  const preferencesPath = path.join(dataRoot, "preferences.json");
  const exportsPath = path.join(dataRoot, "exports.json");
  const apiToken = randomBytes(32).toString("hex");
  await Promise.all([
    mkdir(configuredRoot, { recursive: true }),
    mkdir(cacheDirectory, { recursive: true }),
    mkdir(proxyDirectory, { recursive: true }),
    mkdir(stillRoot, { recursive: true }),
    mkdir(configuredOutputRoot, { recursive: true }),
    mkdir(exportWorkRoot, { recursive: true }),
  ]);
  let mediaRoot = await realpath(configuredRoot);
  let outputRoot = await realpath(configuredOutputRoot);
  const canonicalProxyDirectory = await realpath(proxyDirectory);
  const canonicalStillRoot = await realpath(stillRoot);
  const mediaRegistry = new Map();
  const mediaAnalysisTasks = new Map();
  const runMediaAnalysis = createTaskLimiter(2);
  const runBackgroundTask = createTaskLimiter(2);
  const persistenceRecoveries = [];
  const projects = await readProjects(projectsPath, persistenceRecoveries);
  const restoredExportJobs = await readExportJobs(exportsPath, persistenceRecoveries);
  let preferences = await readPreferences(preferencesPath, persistenceRecoveries);
  const missingPaths = [];
  if (preferences.libraryPath) {
    const candidate = path.resolve(preferences.libraryPath);
    try {
      await mkdir(candidate, { recursive: true });
      mediaRoot = await realpath(candidate);
      preferences = { ...preferences, libraryPath: mediaRoot };
    } catch (error) {
      missingPaths.push({ kind: "library", path: preferences.libraryPath });
      console.warn(`Saved library folder unavailable (${error.message}); using default.`);
    }
  } else {
    preferences = { ...preferences, libraryPath: mediaRoot };
  }
  if (preferences.exportPath) {
    const candidate = path.resolve(preferences.exportPath);
    try {
      await mkdir(candidate, { recursive: true });
      outputRoot = await realpath(candidate);
      preferences = { ...preferences, exportPath: outputRoot };
    } catch (error) {
      missingPaths.push({ kind: "export", path: preferences.exportPath });
      console.warn(`Saved export folder unavailable (${error.message}); using default.`);
    }
  } else {
    preferences = { ...preferences, exportPath: outputRoot };
  }
  let projectWrite = Promise.resolve();
  let preferenceWrite = Promise.resolve();
  let exportWrite = Promise.resolve();

  const adminLogEntries = [];
  function logAdmin(message, level = "info") {
    const entry = { at: new Date().toISOString(), level, message };
    adminLogEntries.push(entry);
    if (adminLogEntries.length > 500) adminLogEntries.splice(0, adminLogEntries.length - 500);
    return entry;
  }
  logAdmin("Server started");
  logAdmin(`Library folder: ${mediaRoot}`);
  logAdmin(`Export folder: ${outputRoot}`);
  for (const recovery of persistenceRecoveries) {
    logAdmin(`Recovered invalid ${recovery.name}; original data was moved aside`, "warn");
  }

  function persistProjects() {
    projectWrite = projectWrite.catch(() => {}).then(async () => {
      const temporaryPath = `${projectsPath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, JSON.stringify([...projects.values()], null, 2));
      await rename(temporaryPath, projectsPath);
    });
    return projectWrite;
  }

  function persistPreferences() {
    preferenceWrite = preferenceWrite.catch(() => {}).then(async () => {
      const temporaryPath = `${preferencesPath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(preferences, null, 2));
      await rename(temporaryPath, preferencesPath);
    });
    return preferenceWrite;
  }

  function persistExportJobs(jobs) {
    const snapshot = jobs.map(serializePersistedExport);
    exportWrite = exportWrite.catch(() => {}).then(async () => {
      const temporaryPath = `${exportsPath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(snapshot, null, 2));
      await rename(temporaryPath, exportsPath);
    });
    return exportWrite;
  }

  const backgroundChildren = new Set();
  const proxyTasks = new Map();

  async function assertSafeCacheDirectory(rootPath, canonicalRoot, targetPath = rootPath) {
    const rootStat = await lstat(rootPath);
    if (rootStat.isSymbolicLink()) {
      const error = new Error("Cache root must not be a symbolic link");
      error.statusCode = 409;
      throw error;
    }
    let targetStat;
    try {
      targetStat = await lstat(targetPath);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      const error = new Error("Cache directory must be a real directory");
      error.statusCode = 409;
      throw error;
    }
    const resolved = await realpath(targetPath);
    if (!isWithin(canonicalRoot, resolved)) {
      const error = new Error("Cache directory escaped its configured root");
      error.statusCode = 409;
      throw error;
    }
    return true;
  }

  function proxyDimensions(media, scale) {
    const divisor = scale === "quarter" ? 4 : 2;
    const width = media.analysis.video.width;
    const height = media.analysis.video.height;
    return {
      width: Math.max(2, Math.round(width / divisor / 2) * 2),
      height: Math.max(2, Math.round(height / divisor / 2) * 2),
    };
  }

  function proxyFilePath(mediaId, scale) {
    return path.join(proxyDirectory, `${mediaId}-${scale}.mp4`);
  }

  function proxySidecarPath(mediaId, scale) {
    return path.join(proxyDirectory, `${mediaId}-${scale}.json`);
  }

  async function readProxySidecar(mediaId, scale) {
    try {
      return JSON.parse(await readFile(proxySidecarPath(mediaId, scale), "utf8"));
    } catch {
      return null;
    }
  }

  async function isProxyCurrent(media, scale) {
    const [sidecar, proxyStat] = await Promise.all([
      readProxySidecar(media.id, scale),
      stat(proxyFilePath(media.id, scale)).catch(() => null),
    ]);
    return Boolean(
      proxyStat &&
        sidecar &&
        sidecar.sourceSize === media.size &&
        sidecar.sourceMtimeMs === media.mtimeMs &&
        sidecar.scale === scale,
    );
  }

  async function ensureProxy(media, scale) {
    await verifyMediaSource(media);
    if (!preferences.previewGeneration) return { status: "off", progress: 0, error: null, dims: null };
    const key = `${media.id}:${scale}`;
    if (proxyTasks.has(key)) return proxyTasks.get(key).task;
    const controller = new AbortController();
    const task = { status: "pending", progress: 0, error: null, dims: null, child: null, controller, promise: null };
    task.promise = runBackgroundTask(async () => {
      let tempPath = null;
      try {
        if (controller.signal.aborted) throw new DOMException("Background task stopped", "AbortError");
        if (await isProxyCurrent(media, scale)) {
          const sidecar = await readProxySidecar(media.id, scale);
          task.status = "ready";
          task.dims = { width: sidecar.width, height: sidecar.height };
          return task;
        }
        await mkdir(proxyDirectory, { recursive: true });
        const dims = proxyDimensions(media, scale);
        const sourceFps = media.analysis.video.averageFrameRate ?? 30;
        const previewFps = Math.max(1, Math.round(sourceFps / 2));
        const gop = Math.max(1, Math.round(previewFps));
        tempPath = `${proxyFilePath(media.id, scale)}.${randomUUID()}.tmp`;
        logAdmin(`Generating ${scale}-res proxy for ${media.name} (${previewFps} fps)...`);
        const progressSeconds = await runFfmpegToFile({
          sourcePath: media.path,
          outputPath: tempPath,
          ffmpegPath,
          args: [
            "-vf",
            `scale=${dims.width}:${dims.height},fps=${previewFps}`,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-g",
            String(gop),
            "-keyint_min",
            String(gop),
            "-sc_threshold",
            "0",
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            "-f",
            "mp4",
          ],
          onProgress: (seconds) => {
            const duration = media.analysis.durationUs / 1_000_000;
            task.progress = duration > 0 ? Math.min(0.99, seconds / duration) : 0;
          },
          children: backgroundChildren,
          signal: controller.signal,
          onSpawn: (child) => {
            task.child = child;
          },
        });
        if (controller.signal.aborted) throw new DOMException("Background task stopped", "AbortError");
        await rename(tempPath, proxyFilePath(media.id, scale));
        await writeFile(
          proxySidecarPath(media.id, scale),
          JSON.stringify({
            sourceSize: media.size,
            sourceMtimeMs: media.mtimeMs,
            scale,
            width: dims.width,
            height: dims.height,
            fps: previewFps,
            gop,
          }),
        );
        task.status = "ready";
        task.progress = 1;
        task.dims = { width: dims.width, height: dims.height };
        logAdmin(`Generated ${scale}-res proxy for ${media.name} (${dims.width}x${dims.height}, ${gop}f keyframes)`);
      } catch (error) {
        task.status = "failed";
        task.error = error.name === "AbortError" ? "Proxy generation stopped" : error.message;
        logAdmin(`Proxy generation failed for ${media.name}: ${task.error}`, error.name === "AbortError" ? "warn" : "error");
      } finally {
        task.child = null;
        if (tempPath) await rm(tempPath, { force: true }).catch(() => {});
      }
      return task;
    });
    proxyTasks.set(key, { task });
    task.promise.catch(() => {});
    return task;
  }

  const STILLS_MAX_COUNT = 5000;
  const STILLS_DIVISORS = { full: 1, half: 2, quarter: 4, eighth: 8 };
  const stillTasks = new Map();

  async function deleteMediaProxies(mediaId) {
    await assertSafeCacheDirectory(proxyDirectory, canonicalProxyDirectory);
    const entries = await readdir(proxyDirectory).catch(() => []);
    let removed = 0;
    for (const name of entries) {
      if (!name.startsWith(`${mediaId}-`)) continue;
      try {
        await unlink(path.join(proxyDirectory, name));
        removed += 1;
      } catch {
        // already gone
      }
    }
    return removed;
  }

  async function deleteMediaStills(mediaId) {
    const directory = path.join(stillRoot, mediaId);
    await assertSafeCacheDirectory(stillRoot, canonicalStillRoot);
    if (!await assertSafeCacheDirectory(stillRoot, canonicalStillRoot, directory)) return 0;
    let removed = 0;
    const entries = await readdir(directory).catch(() => []);
    removed = entries.length;
    const quarantine = path.join(stillRoot, `.delete-${mediaId}-${randomUUID()}`);
    await rename(directory, quarantine);
    await rm(quarantine, { recursive: true, force: true });
    return removed;
  }

  async function summarizeMediaRecord(media) {
    let hasStills = false;
    try {
      await readFile(path.join(stillRoot, media.id, "manifest.json"), "utf8");
      hasStills = true;
    } catch {
      // no stills
    }
    let hasProxies = false;
    for (const name of await readdir(proxyDirectory).catch(() => [])) {
      if (name.startsWith(`${media.id}-`) && name.endsWith(".mp4")) {
        hasProxies = true;
        break;
      }
    }
    return {
      id: media.id,
      name: media.name,
      relativePath: media.relativePath,
      size: media.size,
      durationUs: media.analysis.durationUs,
      keyframeCount: media.analysis.keyframesUs.length,
      hasProxies,
      hasStills,
    };
  }

  async function cancelProxyTasksFor(mediaId = null) {
    const matches = [...proxyTasks.entries()].filter(([key]) => mediaId === null || key.startsWith(`${mediaId}:`));
    for (const [, { task }] of matches) task.controller.abort();
    await Promise.allSettled(matches.map(([, { task }]) => task.promise));
    for (const [key, entry] of matches) {
      if (proxyTasks.get(key) === entry) proxyTasks.delete(key);
    }
    return matches.filter(([, { task }]) => task.status === "failed").length;
  }

  async function cancelStillsTasks(mediaId = null) {
    const matches = [...stillTasks.entries()].filter(([key]) => mediaId === null || key === mediaId);
    for (const [, { task }] of matches) task.controller.abort();
    await Promise.allSettled(matches.map(([, { task }]) => task.promise));
    for (const [key, entry] of matches) {
      if (stillTasks.get(key) === entry) stillTasks.delete(key);
    }
    return matches.filter(([, { task }]) => task.status === "failed").length;
  }

  async function ensureStills(media) {
    await verifyMediaSource(media);
    const expected = media.analysis.keyframesUs.length;
    if (expected === 0 || expected > STILLS_MAX_COUNT) return { status: "off", count: 0 };
    const key = media.id;
    if (stillTasks.has(key)) return stillTasks.get(key).task;
    const controller = new AbortController();
    const task = { status: "pending", count: 0, progress: 0, error: null, child: null, controller, promise: null };
    task.promise = runBackgroundTask(async () => {
      try {
        if (controller.signal.aborted) throw new DOMException("Background task stopped", "AbortError");
        const directory = path.join(stillRoot, media.id);
        const manifestPath = path.join(directory, "manifest.json");
        const scale = preferences.stillsScale ?? "half";
        try {
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          if (
            manifest.sourceSize === media.size &&
            manifest.sourceMtimeMs === media.mtimeMs &&
            manifest.scale === scale &&
            Array.isArray(manifest.entries)
          ) {
            task.status = "ready";
            task.count = manifest.count ?? 0;
            return task;
          }
        } catch {
          // no manifest yet
        }
        await mkdir(directory, { recursive: true });
        await unlink(manifestPath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        for (const name of await readdir(directory).catch(() => [])) {
          if (/\.jpg$/i.test(name)) await unlink(path.join(directory, name)).catch(() => {});
        }
        const divisor = STILLS_DIVISORS[scale] ?? 2;
        const stillWidth = Math.max(2, Math.round(media.analysis.video.width / divisor / 2) * 2);
        const stillHeight = Math.max(2, Math.round(media.analysis.video.height / divisor / 2) * 2);
        logAdmin(`Extracting ${scale}-res keyframe stills for ${media.name}...`);
        const progressTimer = setInterval(() => {
          readdir(directory)
            .then((names) => {
              const written = names.filter((name) => /\.jpg$/i.test(name)).length;
              task.progress = expected > 0 ? Math.min(0.99, written / expected) : 0;
              task.count = written;
            })
            .catch(() => {});
        }, 300);
        const extractedTimestamps = [];
        let showInfoBuffer = "";
        const parseShowInfoLine = (line) => {
          const match = /pts_time:([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i.exec(line);
          if (!match) return;
          const timestampUs = Math.round(Number(match[1]) * 1_000_000);
          if (Number.isSafeInteger(timestampUs)) extractedTimestamps.push(timestampUs);
        };
        try {
          await runFfmpegToFile({
            sourcePath: media.path,
            outputPath: path.join(directory, "kf-%06d.jpg"),
            ffmpegPath,
            args: [
              "-vf",
              `scale=${stillWidth}:${stillHeight},select='eq(key,1)',showinfo`,
              "-vsync",
              "vfr",
              "-q:v",
              "4",
              "-f",
              "image2",
              "-loglevel",
              "info",
            ],
            onStderr: (text) => {
              showInfoBuffer += text;
              const lines = showInfoBuffer.split("\n");
              showInfoBuffer = lines.pop();
              for (const line of lines) parseShowInfoLine(line);
            },
            onSpawn: (child) => {
              task.child = child;
            },
            children: backgroundChildren,
            signal: controller.signal,
          });
        } finally {
          clearInterval(progressTimer);
        }
        if (showInfoBuffer) parseShowInfoLine(showInfoBuffer);
        const extracted = (await readdir(directory)).filter((name) => /\.jpg$/i.test(name)).sort();
        const entries = new Array(expected).fill(null);
        let matched = 0;
        let fileCursor = 0;
        for (let index = 0; index < expected; index += 1) {
          const target = media.analysis.keyframesUs[index];
          while (
            fileCursor + 1 < extracted.length &&
            Math.abs(extractedTimestamps[fileCursor + 1] - target) <= Math.abs(extractedTimestamps[fileCursor] - target)
          ) {
            fileCursor += 1;
          }
          const timestamp = extractedTimestamps[fileCursor];
          if (extracted[fileCursor] && Number.isFinite(timestamp) && Math.abs(timestamp - target) <= 150_000) {
            entries[index] = extracted[fileCursor];
            matched += 1;
            fileCursor += 1;
          }
        }
        if (matched === 0) {
          throw new Error(`no keyframe stills matched the keyframe index (extracted ${extracted.length}, indexed ${expected})`);
        }
        const temporaryManifestPath = `${manifestPath}.${randomUUID()}.tmp`;
        await writeFile(
          temporaryManifestPath,
          JSON.stringify({
            sourceSize: media.size,
            sourceMtimeMs: media.mtimeMs,
            count: matched,
            expected,
            scale,
            width: stillWidth,
            height: stillHeight,
            entries,
          }),
        );
        await rename(temporaryManifestPath, manifestPath);
        task.status = "ready";
        task.count = matched;
        task.progress = 1;
        logAdmin(`Extracted ${matched} of ${expected} ${scale}-res keyframe stills for ${media.name}`);
      } catch (error) {
        task.status = "failed";
        task.error = error.name === "AbortError" ? "Stills extraction stopped" : error.message;
        logAdmin(`Stills extraction failed for ${media.name}: ${error.message}`, "warn");
      } finally {
        task.child = null;
      }
      return task;
    });
    stillTasks.set(key, { task });
    task.promise.catch(() => {});
    return task;
  }

  async function registerMediaByPath(resolvedPath) {
    const filePath = await realpath(resolvedPath);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || path.extname(filePath).toLowerCase() !== ".mp4") {
      const error = new Error("Only MP4 files can be registered");
      error.statusCode = 415;
      throw error;
    }

    const id = createHash("sha256").update(filePath).digest("hex").slice(0, 24);
    let analysis = await readCachedAnalysis(cacheDirectory, id, fileStat);
    if (!analysis) {
      let analysisTask = mediaAnalysisTasks.get(id);
      if (!analysisTask) {
        analysisTask = runMediaAnalysis(async () => {
          logAdmin(`Analyzing ${path.basename(filePath)} with ffprobe...`);
          const result = await analyzeMedia(filePath, ffprobePath);
          if (result) await writeCachedAnalysis(cacheDirectory, id, fileStat, result);
          return result;
        }).finally(() => mediaAnalysisTasks.delete(id));
        mediaAnalysisTasks.set(id, analysisTask);
      }
      analysis = await analysisTask;
    }
    if (!analysis || analysis.video.codec !== "h264") {
      logAdmin(`${path.basename(filePath)} rejected: no H.264 video stream`, "error");
      const error = new Error("The MP4 must contain an H.264 video stream");
      error.statusCode = 415;
      throw error;
    }

    const media = {
      id,
      name: path.basename(filePath),
      relativePath: isWithin(mediaRoot, filePath) ? path.relative(mediaRoot, filePath) : null,
      absolutePath: filePath,
      path: filePath,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      sourceIdentity: {
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        dev: fileStat.dev,
        ino: fileStat.ino,
      },
      analysis,
    };
    mediaRegistry.set(id, media);
    logAdmin(`Registered ${media.name} (${keyframeLabel(analysis)})`);
    if (preferences.previewGeneration && preferences.previewScale !== "source") {
      ensureProxy(media, preferences.previewScale).catch(() => {});
    }
    ensureStills(media).catch(() => {});
    return media;
  }

  async function registerMedia(relativePath) {
    if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
      const error = new Error("relativePath must be a relative file path");
      error.statusCode = 400;
      throw error;
    }

    const requestedPath = path.resolve(mediaRoot, relativePath);
    if (!isWithin(mediaRoot, requestedPath)) {
      const error = new Error("File is outside the configured media root");
      error.statusCode = 403;
      throw error;
    }
    const filePath = await realpath(requestedPath);
    if (!isWithin(mediaRoot, filePath)) {
      const error = new Error("File is outside the configured media root");
      error.statusCode = 403;
      throw error;
    }
    return registerMediaByPath(filePath);
  }

  async function locateMediaFile(name) {
    const searchRoots = [mediaRoot, ...preferences.importSearchPaths];
    logAdmin(`Searching for "${name}" in ${searchRoots.length} folder${searchRoots.length === 1 ? "" : "s"}...`);
    const matches = [];
    async function scan(directory, depth) {
      if (depth > 12 || matches.length > 64) return;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await scan(absolutePath, depth + 1);
        } else if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) {
          matches.push(absolutePath);
        }
      }
    }
    await Promise.all(searchRoots.map((root) => scan(root, 0)));
    if (matches.length === 0) {
      logAdmin(`"${name}" was not found`, "error");
      return null;
    }
    matches.sort((left, right) =>
      left.split(path.sep).length - right.split(path.sep).length || left.localeCompare(right),
    );
    logAdmin(`Found "${name}" at ${matches[0]}`);
    return registerMediaByPath(matches[0]);
  }

  function keyframeLabel(analysis) {
    const count = analysis.keyframesUs.length;
    return `${count} keyframe${count === 1 ? "" : "s"}`;
  }

  const loggedExportStatuses = new Map();
  const exportQueue = new ExportQueue({
    jobs: restoredExportJobs,
    onChange: (job, jobs) => {
      if (job) {
        const previous = loggedExportStatuses.get(job.id);
        if (previous !== job.status) {
          loggedExportStatuses.set(job.id, job.status);
          const label = job.outputName;
          if (job.status === "running") logAdmin(`Exporting ${label}...`);
          else if (job.status === "paused") logAdmin(`Export paused: ${label}`);
          else if (job.status === "stopping") logAdmin(`Stopping export ${label}...`);
          else if (job.status === "finalizing") logAdmin(`Finalizing export ${label}...`);
          else if (job.status === "completed") logAdmin(`Export completed: ${label}`);
          else if (job.status === "stopped") logAdmin(`Export stopped: ${label}`, "warn");
          else if (job.status === "failed") logAdmin(`Export failed: ${label} (${job.error ?? "unknown error"})`, "error");
        }
      }
      persistExportJobs(jobs).catch((error) => console.error("Unable to persist export queue", error));
    },
    runner: async (job, control) => {
      await verifyMediaSource(job.media);
      const exportOptions = {
        ffmpegPath,
        media: job.media,
        segments: job.segments,
        outputPath: job.outputPath,
        signal: control.signal,
        setProcess: control.setProcess,
        waitIfPaused: control.waitIfPaused,
        onFinalizing: control.setFinalizing,
        onProgress: (progress) => {
          if (Number.isFinite(progress)) {
            job.progress = Math.max(job.progress, Math.round(progress * 1_000) / 1_000);
          }
        },
      };
      if (job.mode === "fast") {
        await exportStreamCopy({ ...exportOptions, workRoot: exportWorkRoot });
      } else {
        await exportFrameAccurate(exportOptions);
      }
    },
  });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const host = String(request.headers.host ?? "");
      const hostName = (() => {
        try {
          return new URL(`http://${host}`).hostname;
        } catch {
          return "";
        }
      })();
      if (!["127.0.0.1", "localhost", "[::1]"].includes(hostName)) {
        sendJson(response, 403, { error: "Invalid Host header" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/session") {
        sendJson(response, 200, { token: apiToken });
        return;
      }

      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        const origin = request.headers.origin;
        if (origin && origin !== `http://${host}`) {
          sendJson(response, 403, { error: "Cross-origin requests are not allowed" });
          return;
        }
        if (request.headers["x-shortcut-token"] !== apiToken) {
          sendJson(response, 403, { error: "Missing or invalid API token" });
          return;
        }
      }

      if (request.method === "GET" && url.pathname === "/api/preferences") {
        sendJson(response, 200, {
          ...preferences,
          missingPaths,
          recoveryWarnings: persistenceRecoveries.map(({ name }) => ({ name })),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/exports") {
        sendJson(response, 200, { jobs: exportQueue.list().map(serializeExport) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/admin/log") {
        sendJson(response, 200, { entries: adminLogEntries });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/stop") {
        const stopped = exportQueue.stopAll();
        await exportQueue.waitForIdle();
        await exportWrite;
        logAdmin(stopped > 0 ? `Force stopped ${stopped} export job${stopped === 1 ? "" : "s"}` : "Force stop requested with no active jobs", "warn");
        sendJson(response, 200, { stopped });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/stop-background") {
        const stopped = [...proxyTasks.values(), ...stillTasks.values()]
          .filter(({ task }) => task.status === "pending").length;
        await Promise.all([cancelProxyTasksFor(), cancelStillsTasks()]);
        logAdmin(stopped > 0 ? `Stopped ${stopped} background FFmpeg process${stopped === 1 ? "" : "es"}` : "No background FFmpeg processes were running", "warn");
        sendJson(response, 200, { stopped });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/restart") {
        logAdmin("Resetting server state...", "warn");
        exportQueue.stopAll();
        await exportQueue.waitForIdle();
        await Promise.all([cancelProxyTasksFor(), cancelStillsTasks()]);
        await exportWrite;
        mediaRegistry.clear();
        projects.clear();
        persistenceRecoveries.length = 0;
        for (const [projectId, project] of await readProjects(projectsPath, persistenceRecoveries)) projects.set(projectId, project);
        preferences = await readPreferences(preferencesPath, persistenceRecoveries);
        for (const recovery of persistenceRecoveries) {
          logAdmin(`Recovered invalid ${recovery.name}; original data was moved aside`, "warn");
        }
        missingPaths.length = 0;
        if (preferences.libraryPath) {
          const candidate = path.resolve(preferences.libraryPath);
          try {
            await mkdir(candidate, { recursive: true });
            mediaRoot = await realpath(candidate);
            preferences = { ...preferences, libraryPath: mediaRoot };
          } catch (error) {
            missingPaths.push({ kind: "library", path: preferences.libraryPath });
            logAdmin(`Saved library folder unavailable: ${preferences.libraryPath}`, "warn");
          }
        } else {
          preferences = { ...preferences, libraryPath: mediaRoot };
        }
        if (preferences.exportPath) {
          const candidate = path.resolve(preferences.exportPath);
          try {
            await mkdir(candidate, { recursive: true });
            outputRoot = await realpath(candidate);
            preferences = { ...preferences, exportPath: outputRoot };
          } catch (error) {
            missingPaths.push({ kind: "export", path: preferences.exportPath });
            logAdmin(`Saved export folder unavailable: ${preferences.exportPath}`, "warn");
          }
        } else {
          preferences = { ...preferences, exportPath: outputRoot };
        }
        loggedExportStatuses.clear();
        logAdmin(`Server state reloaded from disk. Library folder: ${mediaRoot}`);
        sendJson(response, 200, { ok: true, libraryPath: mediaRoot, exportPath: outputRoot });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/shutdown") {
        logAdmin("Server shutdown requested...", "warn");
        const stopped = exportQueue.stopAll();
        await Promise.all([
          exportQueue.waitForIdle(),
          cancelProxyTasksFor(),
          cancelStillsTasks(),
        ]);
        await exportWrite;
        sendJson(response, 200, { ok: true, stopped, message: "Server is shutting down" });
        logAdmin("Server stopped");
        setTimeout(() => process.exit(0), 100);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/log") {
        const body = await readJson(request);
        const level = body.level === "error" || body.level === "warn" ? body.level : "info";
        const message = String(body.message ?? "").slice(0, 2000);
        await appendLogLine("client-errors.jsonl", {
          at: new Date().toISOString(),
          level,
          message,
          stack: String(body.stack ?? "").slice(0, 8000),
          context: body.context ?? null,
        });
        if (message) logAdmin(`Client ${level}: ${message.slice(0, 160)}`, level === "error" ? "error" : "warn");
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/exports") {
        exportQueue.clear();
        await exportWrite;
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/exports/start") {
        const resumed = exportQueue.resumeAll();
        await exportWrite;
        sendJson(response, 200, {
          resumed,
          jobs: exportQueue.list().map(serializeExport),
        });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/preferences") {
        const nextPreferences = validatePreferences(await readJson(request));
        const previousStillsScale = preferences.stillsScale;
        await Promise.all([
          mkdir(nextPreferences.libraryPath, { recursive: true }),
          mkdir(nextPreferences.exportPath, { recursive: true }),
        ]);
        const [nextMediaRoot, nextOutputRoot] = await Promise.all([
          realpath(nextPreferences.libraryPath),
          realpath(nextPreferences.exportPath),
        ]);
        if (nextMediaRoot !== mediaRoot) {
          mediaRegistry.clear();
          logAdmin(`Library folder changed to ${nextMediaRoot}; registered media cleared`, "warn");
        }
        if (nextOutputRoot !== outputRoot) {
          logAdmin(`Export folder changed to ${nextOutputRoot}`, "warn");
        }
        mediaRoot = nextMediaRoot;
        outputRoot = nextOutputRoot;
        preferences = {
          ...nextPreferences,
          libraryPath: mediaRoot,
          exportPath: outputRoot,
        };
        await persistPreferences();
        if (preferences.stillsScale !== previousStillsScale) {
          await cancelStillsTasks();
          logAdmin(`Keyframe stills resolution changed to ${preferences.stillsScale}; regenerating`, "warn");
        }
        if (preferences.previewGeneration && preferences.previewScale !== "source") {
          for (const media of mediaRegistry.values()) {
            ensureProxy(media, preferences.previewScale).catch(() => {});
          }
        }
        for (const media of mediaRegistry.values()) {
          ensureStills(media).catch(() => {});
        }
        logAdmin("Preferences saved");
        sendJson(response, 200, preferences);
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/proxies") {
        await cancelProxyTasksFor();
        await assertSafeCacheDirectory(proxyDirectory, canonicalProxyDirectory);
        let removed = 0;
        const entries = await readdir(proxyDirectory).catch(() => []);
        for (const name of entries) {
          if (!/\.(mp4|json)$/i.test(name)) continue;
          try {
            await unlink(path.join(proxyDirectory, name));
            removed += 1;
          } catch {
            // already gone
          }
        }
        logAdmin(`Cleared ${removed} preview proxy file${removed === 1 ? "" : "s"}`);
        sendJson(response, 200, { removed });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/exports") {
        const body = await readJson(request);
        const project = projects.get(body.projectId);
        if (!project) {
          const error = new Error("Project not found");
          error.statusCode = 404;
          throw error;
        }
        if (body.mode !== "fast" && body.mode !== "accurate") {
          const error = new Error("Export mode must be fast or accurate");
          error.statusCode = 400;
          throw error;
        }
        if (preferences.onlyFastEdits && body.mode === "accurate") {
          const error = new Error("Frame-accurate export is disabled when only fast edits are allowed");
          error.statusCode = 400;
          throw error;
        }
        if (project.segments.length === 0) {
          const error = new Error("Add at least one keep segment before exporting");
          error.statusCode = 400;
          throw error;
        }
        const media = mediaRegistry.get(project.source.mediaId);
        if (!media) {
          const error = new Error("Open the project source media before exporting");
          error.statusCode = 400;
          throw error;
        }
        if (
          body.mode === "fast" &&
          project.segments.some(
            (segment) => !isKeyframeAligned(media.analysis.keyframesUs, segment.inUs),
          )
        ) {
          const error = new Error("Fast export requires every segment in point to be on a keyframe");
          error.statusCode = 400;
          throw error;
        }

        const id = randomUUID();
        const outputName = createExportName(project, body.mode, body.outputName, id, preferences.exportNameTemplate);
        const outputPath = path.join(outputRoot, outputName);
        const reserved = exportQueue.list().some(
          (candidate) => candidate.outputName.toLowerCase() === outputName.toLowerCase(),
        );
        if (reserved || await stat(outputPath).then(() => true, (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        })) {
          const error = new Error(`Export destination already exists or is reserved: ${outputName}`);
          error.statusCode = 409;
          throw error;
        }
        if (exportQueue.list().some(
          (candidate) => candidate.outputName.toLowerCase() === outputName.toLowerCase(),
        )) {
          const error = new Error(`Export destination is already reserved: ${outputName}`);
          error.statusCode = 409;
          throw error;
        }
        const job = {
          id,
          projectId: project.id,
          projectName: project.name,
          mode: body.mode,
          status: "paused",
          progress: 0,
          outputName,
          outputPath,
          error: null,
          createdAt: new Date().toISOString(),
          completedAt: null,
          startedAt: null,
          media,
          segments: project.segments.map((segment) => ({ ...segment })),
        };
        exportQueue.add(job);
        try {
          await exportWrite;
        } catch (error) {
          exportQueue.remove(job.id);
          await exportWrite.catch(() => {});
          throw error;
        }
        sendJson(response, 202, serializeExport(job));
        return;
      }

      const exportControlMatch = /^\/api\/exports\/([a-f0-9-]{36})\/(pause|resume|stop)$/.exec(url.pathname);
      if (request.method === "POST" && exportControlMatch) {
        const [, id, action] = exportControlMatch;
        const changed = exportQueue[action](id);
        const job = exportQueue.get(id);
        if (!job) {
          sendJson(response, 404, { error: "Export job not found" });
          return;
        }
        if (!changed) {
          sendJson(response, 409, { error: `Export cannot ${action} while ${job.status}` });
          return;
        }
        await exportWrite;
        sendJson(response, 200, serializeExport(job));
        return;
      }

      const exportMatch = /^\/api\/exports\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (request.method === "GET" && exportMatch) {
        const job = exportQueue.get(exportMatch[1]);
        if (!job) {
          sendJson(response, 404, { error: "Export job not found" });
          return;
        }
        sendJson(response, 200, serializeExport(job));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/projects") {
        const summaries = [...projects.values()]
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .map((project) => ({
            id: project.id,
            name: project.name,
            sourceName: project.source.name,
            editMode: project.editMode ?? "include",
            segmentCount: project.segments.length,
            updatedAt: project.updatedAt,
          }));
        sendJson(response, 200, { projects: summaries });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/projects") {
        const input = validateProjectInput(await readJson(request), mediaRegistry);
        const now = new Date().toISOString();
        const project = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
        projects.set(project.id, project);
        await persistProjects();
        logAdmin(`Project created: ${project.name}`);
        sendJson(response, 201, project);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/projects/import") {
        const imported = validateProjectImport(await readJson(request));
        const media = await registerMedia(imported.source.relativePath);
        const input = validateProjectInput({
          name: imported.name,
          editMode: imported.editMode,
          sourceMediaId: media.id,
          segments: imported.segments,
        }, mediaRegistry);
        const now = new Date().toISOString();
        const project = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
        projects.set(project.id, project);
        await persistProjects();
        logAdmin(`Project imported: ${project.name}`);
        sendJson(response, 201, project);
        return;
      }

      const projectExportMatch = /^\/api\/projects\/([a-f0-9-]{36})\/export$/.exec(url.pathname);
      if (projectExportMatch && request.method === "GET") {
        const project = projects.get(projectExportMatch[1]);
        if (!project) {
          sendJson(response, 404, { error: "Project not found" });
          return;
        }
        const exportDocument = {
          format: "shortcut-project",
          version: 1,
          exportedAt: new Date().toISOString(),
          project,
        };
        const body = JSON.stringify(exportDocument, null, 2);
        const fileName = `${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "shortcut-project"}.json`;
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Cache-Control": "no-store",
        });
        response.end(body);
        return;
      }

      const projectMatch = /^\/api\/projects\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (projectMatch && request.method === "GET") {
        const project = projects.get(projectMatch[1]);
        if (!project) {
          sendJson(response, 404, { error: "Project not found" });
          return;
        }
        sendJson(response, 200, project);
        return;
      }

      if (projectMatch && request.method === "PUT") {
        const existingProject = projects.get(projectMatch[1]);
        if (!existingProject) {
          sendJson(response, 404, { error: "Project not found" });
          return;
        }
        const input = validateProjectInput(await readJson(request), mediaRegistry);
        const project = {
          id: existingProject.id,
          ...input,
          createdAt: existingProject.createdAt,
          updatedAt: new Date().toISOString(),
        };
        projects.set(project.id, project);
        await persistProjects();
        logAdmin(`Project updated: ${project.name}`);
        sendJson(response, 200, project);
        return;
      }

      if (projectMatch && request.method === "DELETE") {
        if (!projects.has(projectMatch[1])) {
          sendJson(response, 404, { error: "Project not found" });
          return;
        }
        const deletedName = projects.get(projectMatch[1]).name;
        projects.delete(projectMatch[1]);
        await persistProjects();
        logAdmin(`Project deleted: ${deletedName}`, "warn");
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/files") {
        logAdmin(`Scanning library folder ${mediaRoot}...`);
        const files = await scanMp4Files(mediaRoot);
        logAdmin(`Library scan found ${files.length} MP4 file${files.length === 1 ? "" : "s"}`);
        sendJson(response, 200, { mediaRoot, files });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/library/locate") {
        const body = await readJson(request);
        if (typeof body.name !== "string" || !body.name.trim() || body.name.includes("/") || body.name.includes("\\")) {
          const error = new Error("name must be a bare file name");
          error.statusCode = 400;
          throw error;
        }
        const media = await locateMediaFile(body.name.trim());
        if (!media) {
          const error = new Error(`"${body.name.trim()}" was not found in the library or import search folders`);
          error.statusCode = 404;
          throw error;
        }
        sendJson(response, 201, serializeMedia(media));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/media") {
        const body = await readJson(request);
        let media;
        if (typeof body.absolutePath === "string" && body.absolutePath.trim()) {
          const resolved = path.resolve(body.absolutePath.trim());
          const allowedRoots = [mediaRoot, ...preferences.importSearchPaths];
          const filePath = await realpath(resolved).catch(() => null);
          if (!filePath || !allowedRoots.some((root) => isWithin(root, filePath))) {
            const error = new Error("Absolute media paths must live inside the library or an import search folder");
            error.statusCode = 403;
            throw error;
          }
          media = await registerMediaByPath(filePath);
        } else {
          media = await registerMedia(body.relativePath);
        }
        sendJson(response, 201, serializeMedia(media));
        return;
      }

      const metadataMatch = /^\/api\/media\/([a-f0-9]{24})\/(metadata|keyframes)$/.exec(url.pathname);
      if (request.method === "GET" && metadataMatch) {
        const media = mediaRegistry.get(metadataMatch[1]);
        if (!media) {
          sendJson(response, 404, { error: "Media is not registered" });
          return;
        }
        if (metadataMatch[2] === "keyframes") {
          sendJson(response, 200, {
            mediaId: media.id,
            timeUnit: "microseconds",
            keyframesUs: media.analysis.keyframesUs,
          });
        } else {
          sendJson(response, 200, serializeMedia(media));
        }
        return;
      }

      const streamMatch = /^\/api\/media\/([a-f0-9]{24})\/stream$/.exec(url.pathname);
      if ((request.method === "GET" || request.method === "HEAD") && streamMatch) {
        const media = mediaRegistry.get(streamMatch[1]);
        if (!media) {
          sendJson(response, 404, { error: "Media is not registered" });
          return;
        }
        await verifyMediaSource(media);
        await streamMedia(request, response, media);
        return;
      }

      const proxyStatusMatch = /^\/api\/media\/([a-f0-9]{24})\/proxy$/.exec(url.pathname);
      if (request.method === "GET" && proxyStatusMatch) {
        const media = mediaRegistry.get(proxyStatusMatch[1]);
        if (!media) {
          sendJson(response, 404, { error: "Media is not registered" });
          return;
        }
        const scale = preferences.previewScale ?? "source";
        if (scale === "source") {
          sendJson(response, 200, { status: "off", scale });
          return;
        }
        const task = await ensureProxy(media, scale);
        sendJson(response, 200, {
          status: task.status,
          scale,
          progress: task.status === "pending" ? Math.round(task.progress * 100) : null,
          error: task.error ?? null,
          width: task.dims?.width ?? null,
          height: task.dims?.height ?? null,
          streamUrl: `/api/media/${media.id}/proxy/stream`,
        });
        return;
      }

      const proxyStreamMatch = /^\/api\/media\/([a-f0-9]{24})\/proxy\/stream$/.exec(url.pathname);
      if ((request.method === "GET" || request.method === "HEAD") && proxyStreamMatch) {
        const media = mediaRegistry.get(proxyStreamMatch[1]);
        if (!media) {
          sendJson(response, 404, { error: "Media is not registered" });
          return;
        }
        const scale = preferences.previewScale ?? "source";
        if (scale === "source") {
          sendJson(response, 404, { error: "No preview proxy is enabled" });
          return;
        }
        await streamFile(request, response, proxyFilePath(media.id, scale), "video/mp4");
        return;
      }

      const stillsMatch = /^\/api\/media\/([a-f0-9]{24})\/stills$/.exec(url.pathname);
      if (request.method === "GET" && stillsMatch) {
        const media = mediaRegistry.get(stillsMatch[1]);
        if (!media) {
          sendJson(response, 404, { error: "Media is not registered" });
          return;
        }
        const task = await ensureStills(media);
        sendJson(response, 200, {
          status: task.status,
          count: task.count,
          progress: task.status === "pending" ? Math.round(task.progress * 100) : null,
          error: task.error ?? null,
          baseUrl: `/api/media/${media.id}/still/`,
        });
        return;
      }

      const stillMatch = /^\/api\/media\/([a-f0-9]{24})\/still\/(\d+)$/.exec(url.pathname);
      if (request.method === "GET" && stillMatch) {
        const media = mediaRegistry.get(stillMatch[1]);
        if (!media) {
          sendJson(response, 404, { error: "Media is not registered" });
          return;
        }
        const index = Number(stillMatch[2]);
        const directory = path.join(stillRoot, media.id);
        let fileName = null;
        try {
          const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
          if (Array.isArray(manifest.entries) && index >= 0 && index < manifest.entries.length) {
            fileName = manifest.entries[index];
          }
        } catch {
          // Manifest not ready yet — fall back to order-based lookup during generation.
          fileName = `kf-${String(index + 1).padStart(6, "0")}.jpg`;
        }
        if (!fileName) {
          sendJson(response, 404, { error: "Still not found" });
          return;
        }
        const filePath = path.join(directory, fileName);
        try {
          const fileStat = await stat(filePath);
          if (!fileStat.isFile()) throw new Error("missing");
        } catch {
          sendJson(response, 404, { error: "Still not found" });
          return;
        }
        const contents = await readFile(filePath);
        response.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": contents.length,
          "Cache-Control": "private, no-cache",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(contents);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/media") {
        const records = await Promise.all([...mediaRegistry.values()].map(summarizeMediaRecord));
        sendJson(response, 200, { records });
        return;
      }

      const mediaDeleteMatch = /^\/api\/media\/([a-f0-9]{24})$/.exec(url.pathname);
      if (request.method === "DELETE" && mediaDeleteMatch) {
        const media = mediaRegistry.get(mediaDeleteMatch[1]);
        if (!media) {
          sendJson(response, 404, { error: "Media is not registered" });
          return;
        }
        await Promise.all([cancelProxyTasksFor(media.id), cancelStillsTasks(media.id)]);
        await Promise.all([deleteMediaProxies(media.id), deleteMediaStills(media.id)]);
        mediaRegistry.delete(media.id);
        logAdmin(`Deleted media record ${media.name} with proxies and stills`, "warn");
        sendJson(response, 200, { removed: true });
        return;
      }

      const mediaStillsDeleteMatch = /^\/api\/media\/([a-f0-9]{24})\/stills$/.exec(url.pathname);
      if (request.method === "DELETE" && mediaStillsDeleteMatch) {
        const media = mediaRegistry.get(mediaStillsDeleteMatch[1]);
        if (!media) {
          sendJson(response, 404, { error: "Media is not registered" });
          return;
        }
        await cancelStillsTasks(media.id);
        const removed = await deleteMediaStills(media.id);
        logAdmin(`Deleted ${removed} still file${removed === 1 ? "" : "s"} for ${media.name}`, "warn");
        sendJson(response, 200, { removed });
        return;
      }

      const mediaProxiesDeleteMatch = /^\/api\/media\/([a-f0-9]{24})\/proxies$/.exec(url.pathname);
      if (request.method === "DELETE" && mediaProxiesDeleteMatch) {
        const media = mediaRegistry.get(mediaProxiesDeleteMatch[1]);
        if (!media) {
          sendJson(response, 404, { error: "Media is not registered" });
          return;
        }
        await cancelProxyTasksFor(media.id);
        const removed = await deleteMediaProxies(media.id);
        logAdmin(`Deleted ${removed} proxy file${removed === 1 ? "" : "s"} for ${media.name}`, "warn");
        sendJson(response, 200, { removed });
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/media") {
        await Promise.all([cancelProxyTasksFor(), cancelStillsTasks()]);
        let removedRecords = 0;
        for (const media of [...mediaRegistry.values()]) {
          await deleteMediaProxies(media.id);
          await deleteMediaStills(media.id);
          removedRecords += 1;
        }
        mediaRegistry.clear();
        logAdmin(`Deleted ${removedRecords} media record${removedRecords === 1 ? "" : "s"} with proxies and stills`, "warn");
        sendJson(response, 200, { removed: removedRecords });
        return;
      }

      const staticFile = STATIC_FILES.get(url.pathname);
      if (request.method === "GET" && staticFile) {
        const [fileName, contentType] = staticFile;
        const contents = await readFile(path.join(publicRoot, fileName));
        response.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": contents.length,
          "Cache-Control": "no-cache",
        });
        response.end(contents);
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error.code === "ENOENT" ? 404 : error.statusCode ?? 500;
      const message = statusCode === 500 ? "Internal server error" : error.message;
      if (statusCode === 500) console.error(error);
      if (!response.headersSent) sendJson(response, statusCode, { error: message });
      else response.destroy();
    }
  });
  server.shutdown = async () => {
    exportQueue.stopAll();
    await Promise.all([
      exportQueue.waitForIdle(),
      cancelProxyTasksFor(),
      cancelStillsTasks(),
    ]);
    await exportWrite;
  };
  return server;
}

async function main() {
  const port = Number(process.env.PORT ?? 4173);
  const host = "127.0.0.1";
  await verifyRuntime();
  process.on("uncaughtException", (error) => {
    console.error(error);
    appendLogLine("server-errors.jsonl", {
      at: new Date().toISOString(),
      level: "error",
      message: error?.message ?? String(error),
      stack: error?.stack ?? null,
    }).finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    console.error(reason);
    appendLogLine("server-errors.jsonl", {
      at: new Date().toISOString(),
      level: "error",
      message: String(reason?.message ?? reason),
      stack: reason?.stack ?? null,
    }).finally(() => process.exit(1));
  });
  const server = await createApp();
  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceTimer = setTimeout(() => process.exit(exitCode || 1), 10_000);
    forceTimer.unref?.();
    try {
      await server.shutdown();
      await new Promise((resolve) => server.close(resolve));
    } finally {
      clearTimeout(forceTimer);
      process.exit(exitCode);
    }
  };
  process.on("SIGINT", () => { shutdown(0); });
  process.on("SIGTERM", () => { shutdown(0); });
  server.listen(port, host, () => {
    console.log(`Shortcut is running at http://${host}:${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
