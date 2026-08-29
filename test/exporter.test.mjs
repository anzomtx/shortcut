import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isKeyframeAligned, verifyMediaSource } from "../src/exporter.mjs";

test("requires canonical keyframe timestamps for fast export", () => {
  const keyframesUs = [100_000, 1_000_000, 2_000_000];
  assert.equal(isKeyframeAligned(keyframesUs, 1_000_000), true);
  assert.equal(isKeyframeAligned(keyframesUs, 1_000_001), true);
  assert.equal(isKeyframeAligned(keyframesUs, 1_070_000), false);
  assert.equal(isKeyframeAligned(keyframesUs, 0), false);
});

test("rejects an export source that changed after the job was created", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shortcut-exporter-"));
  const sourcePath = path.join(directory, "source.mp4");
  try {
    await writeFile(sourcePath, "first");
    const original = await stat(sourcePath);
    const media = {
      path: sourcePath,
      sourceIdentity: {
        size: original.size,
        mtimeMs: original.mtimeMs,
        dev: original.dev,
        ino: original.ino,
      },
    };
    await verifyMediaSource(media);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(sourcePath, "replacement");
    await assert.rejects(verifyMediaSource(media), /source changed/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
