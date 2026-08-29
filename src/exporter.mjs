import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

function seconds(timestampUs) {
  return (timestampUs / 1_000_000).toFixed(6);
}

async function runFfmpeg(ffmpegPath, args, options = {}) {
  await options.beforeProcess?.();
  if (options.signal?.aborted) throw new DOMException("Export stopped", "AbortError");
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let progressBuffer = "";
    let stderr = "";
    let aborted = false;
    let killTimer;

    const handleAbort = () => {
      aborted = true;
      child.kill("SIGCONT");
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref?.();
    };
    options.onProcess?.(child);
    options.signal?.addEventListener("abort", handleAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      progressBuffer += chunk.toString("utf8");
      const lines = progressBuffer.split("\n");
      progressBuffer = lines.pop();
      for (const line of lines) {
        const [key, value] = line.trim().split("=");
        const progressUs = Number(value);
        if (key === "out_time_us" && Number.isFinite(progressUs)) options.onProgress?.(progressUs);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_000);
    });
    child.on("error", (error) => reject(new Error(`Unable to run FFmpeg: ${error.message}`)));
    child.on("close", (code) => {
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", handleAbort);
      options.onProcess?.(null);
      if (aborted) reject(new DOMException("Export stopped", "AbortError"));
      else if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `FFmpeg exited with code ${code}`));
    });
  });
}

export function isKeyframeAligned(keyframesUs, timestampUs, toleranceUs = 1) {
  if (!Array.isArray(keyframesUs) || keyframesUs.length === 0) return false;
  let low = 0;
  let high = keyframesUs.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (keyframesUs[middle] < timestampUs) low = middle + 1;
    else high = middle;
  }
  return [keyframesUs[low - 1], keyframesUs[low]].some(
    (keyframe) => Number.isFinite(keyframe) && Math.abs(keyframe - timestampUs) <= toleranceUs,
  );
}

export async function verifyMediaSource(media) {
  const expected = media.sourceIdentity;
  if (!expected) {
    const error = new Error("Export source identity is unavailable; recreate this export job");
    error.statusCode = 409;
    throw error;
  }
  const current = await stat(media.path);
  if (
    current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    const error = new Error("Export source changed after this job was created; recreate the export job");
    error.statusCode = 409;
    throw error;
  }
}

async function publishOutput(temporaryOutput, outputPath) {
  try {
    await link(temporaryOutput, outputPath);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Export destination already exists: ${path.basename(outputPath)}`);
    throw error;
  }
  await rm(temporaryOutput, { force: true }).catch(() => {});
}

export async function exportStreamCopy({
  ffmpegPath,
  media,
  segments,
  outputPath,
  workRoot,
  onProgress,
  signal,
  setProcess,
  waitIfPaused,
  onFinalizing,
}) {
  await Promise.all([mkdir(path.dirname(outputPath), { recursive: true }), mkdir(workRoot, { recursive: true })]);
  const workDirectory = await mkdtemp(path.join(workRoot, "fast-"));
  const temporaryOutput = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${randomUUID()}.tmp.mp4`);
  const totalDurationUs = segments.reduce((total, segment) => total + segment.outUs - segment.inUs, 0);
  let completedDurationUs = 0;

  try {
    const concatLines = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const segmentDurationUs = segment.outUs - segment.inUs;
      const fileName = `segment-${String(index).padStart(4, "0")}.mp4`;
      concatLines.push(`file '${fileName}'`);
      await runFfmpeg(
        ffmpegPath,
        [
          "-y",
          "-ss",
          seconds(segment.inUs),
          "-i",
          media.path,
          "-t",
          seconds(segmentDurationUs),
          "-map",
          "0:v:0",
          "-map",
          "0:a?",
          "-c",
          "copy",
          "-avoid_negative_ts",
          "make_zero",
          "-progress",
          "pipe:1",
          "-nostats",
          fileName,
        ],
        {
          cwd: workDirectory,
          signal,
          onProcess: setProcess,
          beforeProcess: waitIfPaused,
          onProgress: (currentUs) => {
            const extractionProgress = (completedDurationUs + Math.min(currentUs, segmentDurationUs)) / totalDurationUs;
            onProgress?.(Math.min(extractionProgress * 0.85, 0.85));
          },
        },
      );
      completedDurationUs += segmentDurationUs;
    }

    await writeFile(path.join(workDirectory, "segments.txt"), `${concatLines.join("\n")}\n`);
    await runFfmpeg(
      ffmpegPath,
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        "segments.txt",
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-nostats",
        temporaryOutput,
      ],
      {
        cwd: workDirectory,
        signal,
        onProcess: setProcess,
        beforeProcess: waitIfPaused,
        onProgress: (currentUs) => {
          onProgress?.(0.85 + Math.min(currentUs / totalDurationUs, 1) * 0.14);
        },
      },
    );
    await waitIfPaused?.();
    if (signal?.aborted) throw new DOMException("Export stopped", "AbortError");
    onFinalizing?.();
    await publishOutput(temporaryOutput, outputPath);
    onProgress?.(1);
  } finally {
    await Promise.allSettled([
      rm(workDirectory, { recursive: true, force: true }),
      rm(temporaryOutput, { force: true }),
    ]);
  }
}

export async function exportFrameAccurate({
  ffmpegPath,
  media,
  segments,
  outputPath,
  onProgress,
  signal,
  setProcess,
  waitIfPaused,
  onFinalizing,
}) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryOutput = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${randomUUID()}.tmp.mp4`);
  const hasAudio = media.analysis.audio.length > 0;
  const filters = [];
  const concatInputs = [];

  segments.forEach((segment, index) => {
    filters.push(
      `[0:v:0]trim=start=${seconds(segment.inUs)}:end=${seconds(segment.outUs)},setpts=PTS-STARTPTS[v${index}]`,
    );
    concatInputs.push(`[v${index}]`);
    if (hasAudio) {
      filters.push(
        `[0:a:0]atrim=start=${seconds(segment.inUs)}:end=${seconds(segment.outUs)},asetpts=PTS-STARTPTS[a${index}]`,
      );
      concatInputs.push(`[a${index}]`);
    }
  });
  filters.push(
    `${concatInputs.join("")}concat=n=${segments.length}:v=1:a=${hasAudio ? 1 : 0}[vout]${hasAudio ? "[aout]" : ""}`,
  );

  const totalDurationUs = segments.reduce((total, segment) => total + segment.outUs - segment.inUs, 0);
  const args = [
    "-y",
    "-i",
    media.path,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
  ];
  if (hasAudio) args.push("-map", "[aout]");
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
  );
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-movflags", "+faststart", "-progress", "pipe:1", "-nostats", temporaryOutput);

  try {
    await runFfmpeg(ffmpegPath, args, {
      signal,
      onProcess: setProcess,
      beforeProcess: waitIfPaused,
      onProgress: (currentUs) => onProgress?.(Math.min(currentUs / totalDurationUs, 0.99)),
    });
    await waitIfPaused?.();
    if (signal?.aborted) throw new DOMException("Export stopped", "AbortError");
    onFinalizing?.();
    await publishOutput(temporaryOutput, outputPath);
    onProgress?.(1);
  } finally {
    await rm(temporaryOutput, { force: true }).catch(() => {});
  }
}
