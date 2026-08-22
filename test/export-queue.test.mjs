import assert from "node:assert/strict";
import test from "node:test";
import { ExportQueue } from "../src/export-queue.mjs";

function createJob(id) {
  return {
    id,
    status: "queued",
    progress: 0,
    error: null,
    createdAt: new Date(Date.now() + Number(id) * 10).toISOString(),
    completedAt: null,
  };
}

function waitForStatus(queue, id, status) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const check = () => {
      if (queue.get(id)?.status === status) resolve(queue.get(id));
      else if (Date.now() >= deadline) reject(new Error(`Timed out waiting for ${id} to become ${status}`));
      else setTimeout(check, 5);
    };
    check();
  });
}

test("runs one export at a time and pauses, resumes, and stops jobs", async () => {
  const releases = new Map();
  const starts = [];
  const queue = new ExportQueue({
    runner: async (job, control) => {
      starts.push(job.id);
      await control.waitIfPaused();
      await new Promise((resolve, reject) => {
        releases.set(job.id, resolve);
        control.signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
      });
    },
  });

  queue.add(createJob("1"));
  queue.add(createJob("2"));
  await waitForStatus(queue, "1", "running");
  assert.equal(queue.get("2").status, "queued");

  assert.equal(queue.pause("1"), true);
  assert.equal(queue.get("1").status, "paused");
  assert.equal(queue.resume("1"), true);
  assert.equal(queue.get("1").status, "running");

  releases.get("1")();
  await waitForStatus(queue, "1", "completed");
  await waitForStatus(queue, "2", "running");
  assert.deepEqual(starts, ["1", "2"]);

  assert.equal(queue.stop("2"), true);
  await waitForStatus(queue, "2", "stopped");
});

test("holds and stops queued jobs without starting them", async () => {
  let releaseFirst;
  const starts = [];
  const queue = new ExportQueue({
    runner: async (job) => {
      starts.push(job.id);
      if (job.id === "1") await new Promise((resolve) => { releaseFirst = resolve; });
    },
  });
  queue.add(createJob("1"));
  queue.add(createJob("2"));
  await waitForStatus(queue, "1", "running");
  queue.pause("2");
  releaseFirst();
  await waitForStatus(queue, "1", "completed");
  assert.deepEqual(starts, ["1"]);
  queue.stop("2");
  assert.equal(queue.get("2").status, "stopped");
});

test("restores paused jobs and clears the complete queue", async () => {
  const restored = createJob("1");
  restored.status = "paused";
  const queue = new ExportQueue({
    jobs: [restored],
    runner: async () => assert.fail("Paused restored jobs must not start automatically"),
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(queue.get("1").status, "paused");
  assert.equal(queue.clear(), 1);
  assert.deepEqual(queue.list(), []);
});
