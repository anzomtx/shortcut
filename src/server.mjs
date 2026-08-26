import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open as openFile, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { exportFrameAccurate, exportStreamCopy, isKeyframeAligned } from "./exporter.mjs";
import { ExportQueue } from "./export-queue.mjs";

const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_ROOT = path.resolve(SOURCE_DIRECTORY, "../public");
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

async function readJson(request) {
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

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
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
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => reject(new Error(`Unable to run ffprobe: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || "ffprobe failed"));
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

function fractionToNumber(value) {
  if (typeof value !== "string") return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

// ---------------------------------------------------------------------------
// MP4 container keyframe indexer
// Reads stss (sync samples), stts (time-to-sample), and mdhd (timescale)
// directly from the MP4 atom tree without ffprobe.
// ---------------------------------------------------------------------------

function parseAtomHeader(buf, offset) {
  if (offset + 8 > buf.length) return null;
  const size = buf.readUInt32BE(offset);
  const type = buf.toString("ascii", offset + 4, offset + 8);
  let headerSize = 8;
  let dataSize;
  if (size === 1) {
    if (offset + 16 > buf.length) return null;
    headerSize = 16;
    dataSize = Number(buf.readBigUInt64BE(offset + 8)) - 16;
  } else if (size === 0) {
    dataSize = buf.length - offset - 8;
  } else {
    dataSize = size - 8;
  }
  if (dataSize < 0) return null;
  return { type, size, headerSize, dataOffset: offset + headerSize, dataSize };
}

function findAtom(buf, startOffset, endOffset, targetType) {
  let pos = startOffset;
  while (pos + 8 <= endOffset) {
    const atom = parseAtomHeader(buf, pos);
    if (!atom || atom.size <= 0) break;
    if (atom.type === targetType) return atom;
    pos += atom.size;
  }
  return null;
}

function readMdhdTimescale(buf, dataOffset) {
  if (dataOffset + 4 > buf.length) return null;
  const version = buf[dataOffset];
  const timescaleOffset = dataOffset + (version === 1 ? 20 : 12);
  if (timescaleOffset + 4 > buf.length) return null;
  return buf.readUInt32BE(timescaleOffset) || null;
}

function readStssSamples(buf, dataOffset) {
  if (dataOffset + 8 > buf.length) return [];
  const entryCount = buf.readUInt32BE(dataOffset + 4);
  const samples = [];
  for (let i = 0; i < entryCount; i++) {
    const off = dataOffset + 8 + i * 4;
    if (off + 4 > buf.length) break;
    samples.push(buf.readUInt32BE(off));
  }
  return samples;
}

function computeKeyframesUsFromStts(buf, dataOffset, keyframeSamples, timescale) {
  if (keyframeSamples.length === 0 || timescale <= 0) return [];
  if (dataOffset + 8 > buf.length) return [];
  const entryCount = buf.readUInt32BE(dataOffset + 4);

  const sorted = [...keyframeSamples].sort((a, b) => a - b);
  const resultMap = new Map();
  let processedSamples = 0;
  let accumulatedTicks = 0;
  let sortIdx = 0;
  let pos = dataOffset + 8;

  for (let e = 0; e < entryCount && sortIdx < sorted.length; e++) {
    if (pos + 8 > buf.length) break;
    const count = buf.readUInt32BE(pos);
    const delta = buf.readUInt32BE(pos + 4);
    pos += 8;

    const entryEnd = processedSamples + count;
    while (sortIdx < sorted.length && sorted[sortIdx] <= entryEnd) {
      const sampleNum = sorted[sortIdx];
      const offset = sampleNum - processedSamples - 1;
      const ticks = accumulatedTicks + offset * delta;
      resultMap.set(sampleNum, Math.round((ticks / timescale) * 1_000_000));
      sortIdx++;
    }

    processedSamples = entryEnd;
    accumulatedTicks += count * delta;
  }

  return [...resultMap.values()].sort((a, b) => a - b);
}

async function indexKeyframesFromMp4(filePath) {
  const fd = await openFile(filePath, "r");
  try {
    const fileSize = (await fd.stat()).size;
    let moovOffset = null;
    let moovSize = null;
    let pos = 0;

    while (pos + 8 <= fileSize) {
      const headerBuf = Buffer.alloc(8);
      await fd.read(headerBuf, 0, 8, pos);
      const size = headerBuf.readUInt32BE(0);
      const type = headerBuf.toString("ascii", 4, 8);
      if (size === 1) {
        const extBuf = Buffer.alloc(8);
        await fd.read(extBuf, 0, 8, pos + 8);
        moovSize = Number(extBuf.readBigUInt64BE(0));
      } else if (size === 0) {
        moovSize = fileSize - pos;
      } else {
        moovSize = size;
      }
      if (type === "moov") {
        moovOffset = pos;
        break;
      }
      if (moovSize <= 0) break;
      pos += moovSize;
    }
    if (moovOffset === null) return null;

    const moovBuf = Buffer.alloc(moovSize);
    await fd.read(moovBuf, 0, moovSize, moovOffset);

    let trakAtom = null;
    let searchPos = 8;
    while (searchPos + 8 <= moovSize) {
      const atom = parseAtomHeader(moovBuf, searchPos);
      if (!atom || atom.size <= 0) break;
      if (atom.type === "trak") {
        const mdia = findAtom(moovBuf, atom.dataOffset, atom.dataOffset + atom.dataSize, "mdia");
        if (mdia) {
          const hdlr = findAtom(moovBuf, mdia.dataOffset, mdia.dataOffset + mdia.dataSize, "hdlr");
          if (hdlr && hdlr.dataOffset + 12 <= moovBuf.length) {
            const handlerType = moovBuf.toString("ascii", hdlr.dataOffset + 8, hdlr.dataOffset + 12);
            if (handlerType === "vide") {
              trakAtom = atom;
              break;
            }
          }
        }
      }
      searchPos += atom.size;
    }
    if (!trakAtom) return null;

    const mdiaAtom = findAtom(moovBuf, trakAtom.dataOffset, trakAtom.dataOffset + trakAtom.dataSize, "mdia");
    if (!mdiaAtom) return null;

    const mdhdAtom = findAtom(moovBuf, mdiaAtom.dataOffset, mdiaAtom.dataOffset + mdiaAtom.dataSize, "mdhd");
    if (!mdhdAtom) return null;
    const timescale = readMdhdTimescale(moovBuf, mdhdAtom.dataOffset);
    if (!timescale) return null;

    const minfAtom = findAtom(moovBuf, mdiaAtom.dataOffset, mdiaAtom.dataOffset + mdiaAtom.dataSize, "minf");
    if (!minfAtom) return null;
    const stblAtom = findAtom(moovBuf, minfAtom.dataOffset, minfAtom.dataOffset + minfAtom.dataSize, "stbl");
    if (!stblAtom) return null;

    const stssAtom = findAtom(moovBuf, stblAtom.dataOffset, stblAtom.dataOffset + stblAtom.dataSize, "stss");
    const sttsAtom = findAtom(moovBuf, stblAtom.dataOffset, stblAtom.dataOffset + stblAtom.dataSize, "stts");
    if (!stssAtom || !sttsAtom) return null;

    const keyframeSamples = readStssSamples(moovBuf, stssAtom.dataOffset);
    const keyframesUs = computeKeyframesUsFromStts(moovBuf, sttsAtom.dataOffset, keyframeSamples, timescale);

    return keyframesUs.length > 0 ? keyframesUs : null;
  } finally {
    await fd.close();
  }
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

  let keyframesUs = await indexKeyframesFromMp4(filePath);
  if (!keyframesUs) {
    const frameProbe = await runFfprobe(filePath, ffprobePath, [
      "-select_streams",
      "v:0",
      "-skip_frame",
      "nokey",
      "-show_frames",
      "-show_entries",
      "frame=best_effort_timestamp_time",
    ]);
    keyframesUs = [
      ...new Set(
        (frameProbe.frames ?? [])
          .map((frame) => Math.round(Number(frame.best_effort_timestamp_time) * 1_000_000))
          .filter((timestamp) => Number.isSafeInteger(timestamp) && timestamp >= 0),
      ),
    ].sort((left, right) => left - right);
  }

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
    if (cached.version === 2 && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
      return cached.analysis;
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return null;
}

async function writeCachedAnalysis(cacheDirectory, mediaId, fileStat, analysis) {
  const cachePath = path.join(cacheDirectory, `${mediaId}.json`);
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    JSON.stringify({ version: 2, size: fileStat.size, mtimeMs: fileStat.mtimeMs, analysis }),
  );
  await rename(temporaryPath, cachePath);
}

function serializeMedia(media) {
  const { keyframesUs, ...metadata } = media.analysis;
  return {
    id: media.id,
    name: media.name,
    relativePath: media.relativePath,
    absolutePath: media.relativePath ? null : media.absolutePath,
    size: media.size,
    ...metadata,
    keyframeCount: keyframesUs.length,
    streamUrl: `/api/media/${media.id}/stream`,
    metadataUrl: `/api/media/${media.id}/metadata`,
    keyframesUrl: `/api/media/${media.id}/keyframes`,
  };
}

async function readProjects(projectsPath) {
  try {
    const projects = JSON.parse(await readFile(projectsPath, "utf8"));
    return new Map(projects.map((project) => [project.id, project]));
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }
}

async function readExportJobs(exportsPath) {
  try {
    const jobs = JSON.parse(await readFile(exportsPath, "utf8"));
    if (!Array.isArray(jobs)) throw new Error("Persisted export queue is invalid");
    return jobs.map((job) => ({
      ...job,
      status: ["completed", "failed", "stopped"].includes(job.status) ? job.status : "paused",
      progress: ["completed", "failed", "stopped"].includes(job.status) ? job.progress : 0,
      startedAt: ["completed", "failed", "stopped"].includes(job.status) ? job.startedAt : null,
      media: {
        path: job.sourcePath,
        analysis: { audio: job.hasAudio ? [{}] : [] },
      },
    }));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
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
    hasAudio: job.media.analysis.audio.length > 0,
    segments: job.segments,
  };
}

async function readPreferences(preferencesPath) {
  try {
    const saved = JSON.parse(await readFile(preferencesPath, "utf8"));
    return {
      ...DEFAULT_PREFERENCES,
      ...saved,
      shortcuts: { ...DEFAULT_PREFERENCES.shortcuts, ...saved.shortcuts },
    };
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(DEFAULT_PREFERENCES);
    throw error;
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
    .filter((token) => !["o", "m", "h", "ext"].includes(token));
  if (unknownTokens.length > 0) {
    const error = new Error(`Unknown template token %${unknownTokens[0]}. Use %o, %m, %h, or %ext.`);
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
  let name = template
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

async function streamMedia(request, response, media) {
  const fileStat = await stat(media.path);
  const range = parseRange(request.headers.range, fileStat.size);
  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Type": "video/mp4",
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

  const stream = createReadStream(media.path, { start, end });
  stream.on("error", () => response.destroy());
  stream.pipe(response);
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
  const exportWorkRoot = path.join(dataRoot, "export-work");
  const projectsPath = path.join(dataRoot, "projects.json");
  const preferencesPath = path.join(dataRoot, "preferences.json");
  const exportsPath = path.join(dataRoot, "exports.json");
  await Promise.all([
    mkdir(configuredRoot, { recursive: true }),
    mkdir(cacheDirectory, { recursive: true }),
    mkdir(configuredOutputRoot, { recursive: true }),
    mkdir(exportWorkRoot, { recursive: true }),
  ]);
  let mediaRoot = await realpath(configuredRoot);
  let outputRoot = await realpath(configuredOutputRoot);
  const mediaRegistry = new Map();
  const projects = await readProjects(projectsPath);
  const restoredExportJobs = await readExportJobs(exportsPath);
  let preferences = await readPreferences(preferencesPath);
  const savedMediaRoot = path.resolve(preferences.libraryPath ?? mediaRoot);
  const savedOutputRoot = path.resolve(preferences.exportPath ?? outputRoot);
  await Promise.all([
    mkdir(savedMediaRoot, { recursive: true }),
    mkdir(savedOutputRoot, { recursive: true }),
  ]);
  [mediaRoot, outputRoot] = await Promise.all([
    realpath(savedMediaRoot),
    realpath(savedOutputRoot),
  ]);
  preferences = {
    ...preferences,
    libraryPath: mediaRoot,
    exportPath: outputRoot,
  };
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
      logAdmin(`Analyzing ${path.basename(filePath)} with ffprobe...`);
      analysis = await analyzeMedia(filePath, ffprobePath);
      if (analysis) await writeCachedAnalysis(cacheDirectory, id, fileStat, analysis);
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
      analysis,
    };
    mediaRegistry.set(id, media);
    logAdmin(`Registered ${media.name} (${keyframeLabel(analysis)})`);
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
          else if (job.status === "completed") logAdmin(`Export completed: ${label}`);
          else if (job.status === "stopped") logAdmin(`Export stopped: ${label}`, "warn");
          else if (job.status === "failed") logAdmin(`Export failed: ${label} (${job.error ?? "unknown error"})`, "error");
        }
      }
      persistExportJobs(jobs).catch((error) => console.error("Unable to persist export queue", error));
    },
    runner: async (job, control) => {
      const exportOptions = {
        ffmpegPath,
        media: job.media,
        segments: job.segments,
        outputPath: job.outputPath,
        signal: control.signal,
        setProcess: control.setProcess,
        waitIfPaused: control.waitIfPaused,
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

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && url.pathname === "/api/preferences") {
        sendJson(response, 200, preferences);
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
        const stopped = exportQueue.clear();
        await exportWrite;
        logAdmin(stopped > 0 ? `Force stopped ${stopped} export job${stopped === 1 ? "" : "s"}` : "Force stop requested with no active jobs", "warn");
        sendJson(response, 200, { stopped });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/restart") {
        logAdmin("Resetting server state...", "warn");
        exportQueue.clear();
        await exportWrite;
        mediaRegistry.clear();
        projects.clear();
        for (const [projectId, project] of await readProjects(projectsPath)) projects.set(projectId, project);
        preferences = await readPreferences(preferencesPath);
        const [resetMediaRoot, resetOutputRoot] = await Promise.all([
          realpath(path.resolve(preferences.libraryPath ?? configuredRoot)),
          realpath(path.resolve(preferences.exportPath ?? configuredOutputRoot)),
        ]);
        mediaRoot = resetMediaRoot;
        outputRoot = resetOutputRoot;
        preferences = { ...preferences, libraryPath: mediaRoot, exportPath: outputRoot };
        loggedExportStatuses.clear();
        logAdmin(`Server state reloaded from disk. Library folder: ${mediaRoot}`);
        sendJson(response, 200, { ok: true, libraryPath: mediaRoot, exportPath: outputRoot });
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
        logAdmin("Preferences saved");
        sendJson(response, 200, preferences);
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
        const job = {
          id,
          projectId: project.id,
          projectName: project.name,
          mode: body.mode,
          status: "paused",
          progress: 0,
          outputName,
          outputPath: path.join(outputRoot, outputName),
          error: null,
          createdAt: new Date().toISOString(),
          completedAt: null,
          startedAt: null,
          media,
          segments: project.segments.map((segment) => ({ ...segment })),
        };
        exportQueue.add(job);
        await exportWrite;
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
        await streamMedia(request, response, media);
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
}

async function main() {
  const port = Number(process.env.PORT ?? 4173);
  const host = "127.0.0.1";
  await verifyRuntime();
  const server = await createApp();
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
