import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
      sourceMediaId: media.id,
      segments: [{ inUs: 0, outUs: 500_000 }],
    }),
  });
  assert.equal(createResponse.status, 201);
  const project = await createResponse.json();
  savedProject = project;
  assert.equal(project.source.relativePath, "sample.mp4");
  assert.equal(project.segments.length, 1);

  const listResponse = await fetch(`${baseUrl}/api/projects`);
  const projectList = await listResponse.json();
  assert.equal(projectList.projects[0].id, project.id);

  const updateResponse = await fetch(`${baseUrl}/api/projects/${project.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Updated cut",
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
  const job = await waitForExport(queuedJob.id);
  assert.equal(job.status, "completed", job.error);
  assert.equal(job.progress, 1);
  assert.equal(job.outputName, "fast-output.mp4");
  assert.ok((await stat(job.outputPath)).size > 0);

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
