import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { exportFrameAccurate, exportStreamCopy, isKeyframeAligned } from "./exporter.mjs";

const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_ROOT = path.resolve(SOURCE_DIRECTORY, "../public");
const MAX_JSON_BYTES = 64 * 1024;

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
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

async function analyzeMedia(filePath, ffprobePath) {
  const [probe, frameProbe] = await Promise.all([
    runFfprobe(filePath, ffprobePath, [
      "-show_entries",
      "format=duration,format_name,bit_rate:stream=index,codec_type,codec_name,codec_long_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,time_base,duration,sample_rate,channels,channel_layout:stream_tags=rotate:stream_side_data=rotation",
    ]),
    runFfprobe(filePath, ffprobePath, [
      "-select_streams",
      "v:0",
      "-skip_frame",
      "nokey",
      "-show_frames",
      "-show_entries",
      "frame=best_effort_timestamp_time",
    ]),
  ]);

  const videoStream = probe.streams?.find((stream) => stream.codec_type === "video");
  if (!videoStream) return null;

  const durationSeconds = Number(videoStream.duration ?? probe.format?.duration);
  const nominalFrameRate = fractionToNumber(videoStream.r_frame_rate);
  const averageFrameRate = fractionToNumber(videoStream.avg_frame_rate);
  const rotationSideData = videoStream.side_data_list?.find((item) => Number.isFinite(item.rotation));
  const keyframesUs = [
    ...new Set(
      (frameProbe.frames ?? [])
        .map((frame) => Math.round(Number(frame.best_effort_timestamp_time) * 1_000_000))
        .filter((timestamp) => Number.isSafeInteger(timestamp) && timestamp >= 0),
    ),
  ].sort((left, right) => left - right);

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
    if (cached.version === 1 && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
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
    JSON.stringify({ version: 1, size: fileStat.size, mtimeMs: fileStat.mtimeMs, analysis }),
  );
  await rename(temporaryPath, cachePath);
}

function serializeMedia(media) {
  const { keyframesUs, ...metadata } = media.analysis;
  return {
    id: media.id,
    name: media.name,
    relativePath: media.relativePath,
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
    source: {
      mediaId: media.id,
      relativePath: media.relativePath,
      name: media.name,
    },
    segments,
  };
}

function createExportName(project, mode, requestedName, jobId) {
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
  return `${slug}-${mode}-${jobId.slice(0, 8)}.mp4`;
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
    outputPath: job.status === "completed" ? job.outputPath : null,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
  };
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
  await Promise.all([
    mkdir(configuredRoot, { recursive: true }),
    mkdir(cacheDirectory, { recursive: true }),
    mkdir(configuredOutputRoot, { recursive: true }),
    mkdir(exportWorkRoot, { recursive: true }),
  ]);
  const mediaRoot = await realpath(configuredRoot);
  const outputRoot = await realpath(configuredOutputRoot);
  const mediaRegistry = new Map();
  const exportJobs = new Map();
  const projects = await readProjects(projectsPath);
  let projectWrite = Promise.resolve();

  function persistProjects() {
    projectWrite = projectWrite.catch(() => {}).then(async () => {
      const temporaryPath = `${projectsPath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, JSON.stringify([...projects.values()], null, 2));
      await rename(temporaryPath, projectsPath);
    });
    return projectWrite;
  }

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");

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
        const outputName = createExportName(project, body.mode, body.outputName, id);
        const job = {
          id,
          projectId: project.id,
          projectName: project.name,
          mode: body.mode,
          status: "queued",
          progress: 0,
          outputName,
          outputPath: path.join(outputRoot, outputName),
          error: null,
          createdAt: new Date().toISOString(),
          completedAt: null,
        };
        exportJobs.set(id, job);
        sendJson(response, 202, serializeExport(job));

        queueMicrotask(async () => {
          job.status = "running";
          try {
            const exportOptions = {
              ffmpegPath,
              media,
              segments: project.segments,
              outputPath: job.outputPath,
              onProgress: (progress) => {
                job.progress = Math.max(job.progress, Math.round(progress * 1_000) / 1_000);
              },
            };
            if (job.mode === "fast") {
              await exportStreamCopy({ ...exportOptions, workRoot: exportWorkRoot });
            } else {
              await exportFrameAccurate(exportOptions);
            }
            job.status = "completed";
            job.progress = 1;
            job.completedAt = new Date().toISOString();
          } catch (error) {
            job.status = "failed";
            job.error = error.message;
            job.completedAt = new Date().toISOString();
          }
        });
        return;
      }

      const exportMatch = /^\/api\/exports\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (request.method === "GET" && exportMatch) {
        const job = exportJobs.get(exportMatch[1]);
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
        sendJson(response, 201, project);
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
        sendJson(response, 200, project);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/files") {
        sendJson(response, 200, {
          mediaRoot,
          files: await scanMp4Files(mediaRoot),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/media") {
        const body = await readJson(request);
        if (typeof body.relativePath !== "string" || path.isAbsolute(body.relativePath)) {
          const error = new Error("relativePath must be a relative file path");
          error.statusCode = 400;
          throw error;
        }

        const requestedPath = path.resolve(mediaRoot, body.relativePath);
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

        const fileStat = await stat(filePath);
        if (!fileStat.isFile() || path.extname(filePath).toLowerCase() !== ".mp4") {
          const error = new Error("Only MP4 files can be registered");
          error.statusCode = 415;
          throw error;
        }

        const id = createHash("sha256").update(filePath).digest("hex").slice(0, 24);
        let analysis = await readCachedAnalysis(cacheDirectory, id, fileStat);
        if (!analysis) {
          analysis = await analyzeMedia(filePath, ffprobePath);
          if (analysis) await writeCachedAnalysis(cacheDirectory, id, fileStat, analysis);
        }
        if (!analysis || analysis.video.codec !== "h264") {
          const error = new Error("The MP4 must contain an H.264 video stream");
          error.statusCode = 415;
          throw error;
        }

        const media = {
          id,
          name: path.basename(filePath),
          relativePath: path.relative(mediaRoot, filePath),
          path: filePath,
          size: fileStat.size,
          analysis,
        };
        mediaRegistry.set(id, media);
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
