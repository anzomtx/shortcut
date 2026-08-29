export class ExportQueue {
  #activeJobId = null;
  #controls = new Map();
  #jobs = new Map();
  #onChange;
  #runner;

  constructor({ runner, onChange = () => {}, jobs = [] }) {
    this.#runner = runner;
    this.#onChange = onChange;
    for (const job of jobs) this.#jobs.set(job.id, job);
  }

  add(job) {
    this.#jobs.set(job.id, job);
    this.#notify(job);
    this.#drain();
    return job;
  }

  get(id) {
    return this.#jobs.get(id);
  }

  list() {
    return [...this.#jobs.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  clear() {
    const jobs = this.list();
    for (const job of jobs) {
      if (this.#controls.has(job.id)) this.stop(job.id);
      this.#jobs.delete(job.id);
    }
    this.#notify(null);
    return jobs.length;
  }

  remove(id) {
    if (this.#controls.has(id) || !this.#jobs.delete(id)) return false;
    this.#notify(null);
    return true;
  }

  pause(id) {
    const job = this.#jobs.get(id);
    if (!job || (job.status !== "queued" && job.status !== "running")) return false;
    job.status = "paused";
    const control = this.#controls.get(id);
    if (control) {
      control.paused = true;
      control.process?.kill("SIGSTOP");
    }
    this.#notify(job);
    return true;
  }

  resume(id) {
    const job = this.#jobs.get(id);
    if (!job || job.status !== "paused") return false;
    const control = this.#controls.get(id);
    if (control) {
      control.paused = false;
      control.process?.kill("SIGCONT");
      for (const resolve of control.resumeWaiters.splice(0)) resolve();
      job.status = "running";
    } else {
      job.status = "queued";
    }
    this.#notify(job);
    this.#drain();
    return true;
  }

  resumeAll() {
    let resumed = 0;
    for (const job of this.list()) {
      if (this.resume(job.id)) resumed += 1;
    }
    return resumed;
  }

  stop(id) {
    const job = this.#jobs.get(id);
    if (!job || ["completed", "failed", "stopped", "stopping", "finalizing"].includes(job.status)) return false;
    const control = this.#controls.get(id);
    if (!control) {
      job.status = "stopped";
      job.completedAt = new Date().toISOString();
      this.#notify(job);
      this.#drain();
      return true;
    }
    job.status = "stopping";
    control.stopRequested = true;
    control.paused = false;
    control.process?.kill("SIGCONT");
    for (const resolve of control.resumeWaiters.splice(0)) resolve();
    control.abortController.abort();
    this.#notify(job);
    return true;
  }

  #notify(job) {
    this.#onChange(job, this.list());
  }

  async #drain() {
    if (this.#activeJobId) return;
    const job = this.list().find((candidate) => candidate.status === "queued");
    if (!job) return;

    this.#activeJobId = job.id;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    const control = {
      abortController: new AbortController(),
      paused: false,
      process: null,
      resumeWaiters: [],
      stopRequested: false,
    };
    this.#controls.set(job.id, control);
    this.#notify(job);

    const runnerControl = {
      signal: control.abortController.signal,
      setProcess: (process) => {
        control.process = process;
        if (process && control.paused) process.kill("SIGSTOP");
      },
      waitIfPaused: async () => {
        if (control.stopRequested) throw new DOMException("Export stopped", "AbortError");
        if (!control.paused) return;
        await new Promise((resolve) => control.resumeWaiters.push(resolve));
        if (control.stopRequested) throw new DOMException("Export stopped", "AbortError");
      },
      setFinalizing: () => {
        job.status = "finalizing";
        this.#notify(job);
      },
    };

    try {
      await this.#runner(job, runnerControl);
      job.status = control.stopRequested ? "stopped" : "completed";
      if (job.status === "completed") job.progress = 1;
    } catch (error) {
      if (control.stopRequested || error.name === "AbortError") job.status = "stopped";
      else {
        job.status = "failed";
        job.error = error.message;
      }
    } finally {
      job.completedAt = new Date().toISOString();
      control.process = null;
      this.#controls.delete(job.id);
      this.#activeJobId = null;
      this.#notify(job);
      queueMicrotask(() => this.#drain());
    }
  }
}
