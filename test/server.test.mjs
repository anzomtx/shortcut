import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { createApp } from "../src/server.mjs";

const execFileAsync = promisify(execFile);
let temporaryDirectory;
let server;
let baseUrl;
let sampleSize;
let registeredMedia;
let savedProject;

async function registerSample() {
  const response = await fetch(`${baseUrl}/api/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relativePath: "sample.mp4" }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function waitForExport(id) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/exports/${id}`);
    const job = await response.json();
    if (job.status === "completed" || job.status === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Export did not complete before the test timeout");
}

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "shortcut-test-"));
  const samplePath = path.join(temporaryDirectory, "sample.mp4");
  await execFileAsync("ffmpeg", [
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=160x90:rate=24",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=1000:sample_rate=48000",
    "-t",
    "1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    samplePath,
  ]);
  sampleSize = (await stat(samplePath)).size;

  server = await createApp({
    mediaRoot: temporaryDirectory,
    dataRoot: path.join(temporaryDirectory, "data"),
    outputRoot: path.join(temporaryDirectory, "outputs"),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("lists, registers, and range-streams an H.264 MP4", async () => {
  const libraryResponse = await fetch(`${baseUrl}/api/files`);
  assert.equal(libraryResponse.status, 200);
  const library = await libraryResponse.json();
  assert.deepEqual(library.files.map((file) => file.relativePath), ["sample.mp4"]);

  const media = await registerSample();
  registeredMedia = media;
  assert.equal(media.video.width, 160);
  assert.equal(media.video.height, 90);
  assert.equal(media.size, sampleSize);
  assert.equal(media.durationUs, 1_000_000);
  assert.equal(media.video.codec, "h264");
  assert.equal(media.audio[0].codec, "aac");
  assert.ok(media.keyframeCount >= 1);

  const metadataResponse = await fetch(`${baseUrl}${media.metadataUrl}`);
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.video.averageFrameRate, 24);

  const keyframesResponse = await fetch(`${baseUrl}${media.keyframesUrl}`);
  assert.equal(keyframesResponse.status, 200);
  const keyframes = await keyframesResponse.json();
  assert.equal(keyframes.timeUnit, "microseconds");
  assert.equal(keyframes.keyframesUs[0], 0);

  const headResponse = await fetch(`${baseUrl}${media.streamUrl}`, { method: "HEAD" });
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get("accept-ranges"), "bytes");
  assert.equal(Number(headResponse.headers.get("content-length")), sampleSize);

  const rangeResponse = await fetch(`${baseUrl}${media.streamUrl}`, {
    headers: { Range: "bytes=0-99" },
  });
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get("content-range"), `bytes 0-99/${sampleSize}`);
  assert.equal((await rangeResponse.arrayBuffer()).byteLength, 100);

  const suffixResponse = await fetch(`${baseUrl}${media.streamUrl}`, {
    headers: { Range: "bytes=-64" },
  });
  assert.equal(suffixResponse.status, 206);
  assert.equal((await suffixResponse.arrayBuffer()).byteLength, 64);

  const invalidResponse = await fetch(`${baseUrl}${media.streamUrl}`, {
    headers: { Range: `bytes=${sampleSize}-` },
  });
  assert.equal(invalidResponse.status, 416);
  assert.equal(invalidResponse.headers.get("content-range"), `bytes */${sampleSize}`);
});

test("rejects paths outside the configured media root", async () => {
  const response = await fetch(`${baseUrl}/api/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relativePath: "../outside.mp4" }),
  });
  assert.equal(response.status, 403);
});

test("persists and updates project edit decision lists", async () => {
  const media = registeredMedia ?? (await registerSample());
  const createResponse = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Test cut",
      editMode: "remove",
      sourceMediaId: media.id,
      segments: [{ inUs: 0, outUs: 500_000 }],
    }),
  });
  assert.equal(createResponse.status, 201);
  const project = await createResponse.json();
  savedProject = project;
  assert.equal(project.source.relativePath, "sample.mp4");
  assert.equal(project.editMode, "remove");
  assert.equal(project.segments.length, 1);

  const exportResponse = await fetch(`${baseUrl}/api/projects/${project.id}/export`);
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get("content-disposition"), /attachment; filename="test-cut\.json"/);
  const exportedProject = await exportResponse.json();
  assert.equal(exportedProject.format, "shortcut-project");
  assert.equal(exportedProject.project.id, project.id);

  const listResponse = await fetch(`${baseUrl}/api/projects`);
  const projectList = await listResponse.json();
  assert.equal(projectList.projects[0].id, project.id);

  const updateResponse = await fetch(`${baseUrl}/api/projects/${project.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Updated cut",
      editMode: "remove",
      sourceMediaId: media.id,
      segments: [{ inUs: 0, outUs: 750_000 }],
    }),
  });
  assert.equal(updateResponse.status, 200);
  const updatedProject = await updateResponse.json();
  assert.equal(updatedProject.name, "Updated cut");
  assert.equal(updatedProject.segments[0].outUs, 750_000);
  savedProject = updatedProject;
});

test("deletes a saved project", async () => {
  const media = registeredMedia ?? (await registerSample());
  const createResponse = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Disposable cut",
      editMode: "include",
      sourceMediaId: media.id,
      segments: [],
    }),
  });
  const project = await createResponse.json();
  const deleteResponse = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE" });
  assert.equal(deleteResponse.status, 204);
  const getResponse = await fetch(`${baseUrl}/api/projects/${project.id}`);
  assert.equal(getResponse.status, 404);
});

test("imports an exported project document as a new project", async () => {
  const exportResponse = await fetch(`${baseUrl}/api/projects/${savedProject.id}/export`);
  const document = await exportResponse.json();
  const importResponse = await fetch(`${baseUrl}/api/projects/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(document),
  });
  assert.equal(importResponse.status, 201);
  const imported = await importResponse.json();
  assert.notEqual(imported.id, savedProject.id);
  assert.equal(imported.name, savedProject.name);
  assert.equal(imported.source.relativePath, "sample.mp4");
  assert.deepEqual(imported.segments, savedProject.segments);
});

test("persists validated application preferences", async () => {
  const defaultsResponse = await fetch(`${baseUrl}/api/preferences`);
  assert.equal(defaultsResponse.status, 200);
  const defaults = await defaultsResponse.json();
  assert.equal(defaults.sidebarCollapsed, true);
  assert.equal(defaults.defaultEditMode, "remove");
  assert.equal(defaults.libraryPath, await realpath(temporaryDirectory));
  assert.equal(defaults.exportPath, await realpath(path.join(temporaryDirectory, "outputs")));

  const alternateLibrary = path.join(temporaryDirectory, "alternate-library");
  const alternateExports = path.join(temporaryDirectory, "alternate-exports");
  await mkdir(alternateLibrary);

  const updateResponse = await fetch(`${baseUrl}/api/preferences`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...defaults,
      sidebarCollapsed: false,
      libraryPath: alternateLibrary,
      exportPath: alternateExports,
      shortcuts: { ...defaults.shortcuts, "edit.applyRange": "KeyR" },
    }),
  });
  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json();
  assert.equal(updated.sidebarCollapsed, false);
  assert.equal(updated.shortcuts["edit.applyRange"], "KeyR");
  assert.equal(updated.libraryPath, await realpath(alternateLibrary));
  assert.equal(updated.exportPath, await realpath(alternateExports));
  assert.equal((await stat(alternateExports)).isDirectory(), true);

  const libraryResponse = await fetch(`${baseUrl}/api/files`);
  const library = await libraryResponse.json();
  assert.equal(library.mediaRoot, await realpath(alternateLibrary));
  assert.deepEqual(library.files, []);

  const restoreResponse = await fetch(`${baseUrl}/api/preferences`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...defaults, exportPath: alternateExports }),
  });
  assert.equal(restoreResponse.status, 200);
  registeredMedia = await registerSample();
});

test("exports a keyframe-aligned project without re-encoding", async () => {
  assert.ok(savedProject);
  const createResponse = await fetch(`${baseUrl}/api/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: savedProject.id,
      mode: "fast",
      outputName: "fast-output.mp4",
    }),
  });
  assert.equal(createResponse.status, 202);
  const queuedJob = await createResponse.json();
  assert.equal(queuedJob.status, "paused");
  const resumeResponse = await fetch(`${baseUrl}/api/exports/${queuedJob.id}/resume`, { method: "POST" });
  assert.equal(resumeResponse.status, 200);
  const job = await waitForExport(queuedJob.id);
  assert.equal(job.status, "completed", job.error);
  assert.equal(job.progress, 1);
  assert.equal(job.outputName, "fast-output.mp4");
  const preferences = await (await fetch(`${baseUrl}/api/preferences`)).json();
  assert.equal(path.dirname(job.outputPath), preferences.exportPath);
  assert.ok((await stat(job.outputPath)).size > 0);

  const queueResponse = await fetch(`${baseUrl}/api/exports`);
  const queue = await queueResponse.json();
  assert.ok(queue.jobs.some((candidate) => candidate.id === job.id && candidate.status === "completed"));
  const invalidPauseResponse = await fetch(`${baseUrl}/api/exports/${job.id}/pause`, { method: "POST" });
  assert.equal(invalidPauseResponse.status, 409);

  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name",
    "-of",
    "default=nw=1:nk=1",
    job.outputPath,
  ]);
  assert.equal(stdout.trim(), "h264");
});

test("re-encodes arbitrary edit points for frame-accurate export", async () => {
  const media = registeredMedia ?? (await registerSample());
  const projectResponse = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Accurate cut",
      sourceMediaId: media.id,
      segments: [{ inUs: 125_000, outUs: 625_000 }],
    }),
  });
  assert.equal(projectResponse.status, 201);
  const project = await projectResponse.json();

  const rejectedFastResponse = await fetch(`${baseUrl}/api/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: project.id, mode: "fast" }),
  });
  assert.equal(rejectedFastResponse.status, 400);

  const exportResponse = await fetch(`${baseUrl}/api/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      mode: "accurate",
      outputName: "accurate-output.mp4",
    }),
  });
  assert.equal(exportResponse.status, 202);
  const queuedJob = await exportResponse.json();
  assert.equal(queuedJob.status, "paused");
  const resumeResponse = await fetch(`${baseUrl}/api/exports/${queuedJob.id}/resume`, { method: "POST" });
  assert.equal(resumeResponse.status, 200);
  const job = await waitForExport(queuedJob.id);
  assert.equal(job.status, "completed", job.error);
  assert.ok((await stat(job.outputPath)).size > 0);

  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nw=1:nk=1",
    job.outputPath,
  ]);
  const duration = Number(stdout.trim());
  assert.ok(duration >= 0.48 && duration <= 0.56, `Unexpected duration: ${duration}`);
});

test("locates dropped filenames through import search folders", async () => {
  const searchFolder = path.join(temporaryDirectory, "search-roots");
  await mkdir(searchFolder, { recursive: true });
  await copyFile(path.join(temporaryDirectory, "sample.mp4"), path.join(searchFolder, "Located Sample.mp4"));

  const currentPreferences = await (await fetch(`${baseUrl}/api/preferences`)).json();
  const updateResponse = await fetch(`${baseUrl}/api/preferences`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...currentPreferences, importSearchPaths: [searchFolder] }),
  });
  assert.equal(updateResponse.status, 200);

  const locateResponse = await fetch(`${baseUrl}/api/library/locate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "located sample.mp4" }),
  });
  assert.equal(locateResponse.status, 201);
  const located = await locateResponse.json();
  assert.equal(located.name, "Located Sample.mp4");

  const missingResponse = await fetch(`${baseUrl}/api/library/locate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "does-not-exist.mp4" }),
  });
  assert.equal(missingResponse.status, 404);

  const restoreResponse = await fetch(`${baseUrl}/api/preferences`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...currentPreferences, importSearchPaths: [] }),
  });
  assert.equal(restoreResponse.status, 200);
});

test("names exports from the filename template preference", async () => {
  assert.ok(savedProject);
  const templateResponse = await fetch(`${baseUrl}/api/preferences`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(await (await fetch(`${baseUrl}/api/preferences`)).json()),
      exportNameTemplate: "%o e.%ext",
    }),
  });
  assert.equal(templateResponse.status, 200);

  const createResponse = await fetch(`${baseUrl}/api/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: savedProject.id, mode: "fast" }),
  });
  assert.equal(createResponse.status, 202);
  const job = await createResponse.json();
  const expectedSlug = savedProject.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  assert.equal(job.outputName, `${expectedSlug} e.mp4`);
  await fetch(`${baseUrl}/api/exports/${job.id}/stop`, { method: "POST" });
});

test("starts all paused exports from the queue", async () => {
  assert.ok(savedProject);
  for (const mode of ["fast", "accurate"]) {
    const createResponse = await fetch(`${baseUrl}/api/exports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: savedProject.id, mode }),
    });
    assert.equal(createResponse.status, 202);
    const job = await createResponse.json();
    assert.equal(job.status, "paused");
  }

  const startResponse = await fetch(`${baseUrl}/api/exports/start`, { method: "POST" });
  assert.equal(startResponse.status, 200);
  const startResult = await startResponse.json();
  assert.equal(startResult.resumed, 2);
  assert.ok(startResult.jobs.some((job) => job.status === "running"));

  const idleResponse = await fetch(`${baseUrl}/api/exports/start`, { method: "POST" });
  const idleResult = await idleResponse.json();
  assert.equal(idleResult.resumed, 0);

  await Promise.all(
    startResult.jobs
      .filter((job) => ["paused", "queued", "running"].includes(job.status))
      .map((job) => waitForExport(job.id)),
  );
});

test("restores and clears the persisted export queue", async () => {
  const exportsPath = path.join(temporaryDirectory, "data", "exports.json");
  const deadline = Date.now() + 2_000;
  let persistedJobs = [];
  while (Date.now() < deadline) {
    try {
      persistedJobs = JSON.parse(await readFile(exportsPath, "utf8"));
      if (persistedJobs.length >= 2 && persistedJobs.every((job) => job.status === "completed")) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(persistedJobs.length >= 2);

  const restoredServer = await createApp({
    mediaRoot: temporaryDirectory,
    dataRoot: path.join(temporaryDirectory, "data"),
    outputRoot: path.join(temporaryDirectory, "outputs"),
  });
  await new Promise((resolve) => restoredServer.listen(0, "127.0.0.1", resolve));
  const restoredUrl = `http://127.0.0.1:${restoredServer.address().port}`;
  const restored = await (await fetch(`${restoredUrl}/api/exports`)).json();
  assert.equal(restored.jobs.length, persistedJobs.length);
  await new Promise((resolve, reject) => restoredServer.close((error) => error ? reject(error) : resolve()));

  const clearResponse = await fetch(`${baseUrl}/api/exports`, { method: "DELETE" });
  assert.equal(clearResponse.status, 204);
  const cleared = await (await fetch(`${baseUrl}/api/exports`)).json();
  assert.deepEqual(cleared.jobs, []);
});

test("exposes an admin log with stop and reset controls", async () => {
  const logResponse = await fetch(`${baseUrl}/api/admin/log`);
  assert.equal(logResponse.status, 200);
  const { entries } = await logResponse.json();
  assert.ok(entries.length >= 2);
  assert.ok(entries.some((entry) => entry.message.includes("Server started")));
  assert.ok(entries.some((entry) => entry.message.startsWith("Scanning library folder")));

  const stopResponse = await fetch(`${baseUrl}/api/admin/stop`, { method: "POST" });
  assert.equal(stopResponse.status, 200);
  const stopResult = await stopResponse.json();
  assert.equal(typeof stopResult.stopped, "number");
  const stopLog = await (await fetch(`${baseUrl}/api/admin/log`)).json();
  assert.ok(stopLog.entries.some((entry) => entry.message.includes("Force stop")));

  const restartResponse = await fetch(`${baseUrl}/api/admin/restart`, { method: "POST" });
  assert.equal(restartResponse.status, 200);
  const restartResult = await restartResponse.json();
  assert.ok(restartResult.libraryPath);

  const afterLog = await (await fetch(`${baseUrl}/api/admin/log`)).json();
  assert.ok(afterLog.entries.some((entry) => entry.message.includes("reloaded from disk")));

  const projectsAfter = await (await fetch(`${baseUrl}/api/projects`)).json();
  assert.ok(Array.isArray(projectsAfter.projects));
});
