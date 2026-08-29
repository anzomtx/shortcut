import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(ROOT, "src", "server.mjs");
const LOG_DIRECTORY = path.join(ROOT, "logs");

let child = null;
let stopping = false;
let restartCount = 0;
let stopSignal = null;
let killTimer = null;
let stabilityTimer = null;

async function appendLogLine(entry) {
  try {
    await mkdir(LOG_DIRECTORY, { recursive: true });
    await appendFile(path.join(LOG_DIRECTORY, "server-supervisor.log"), `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.error("Unable to write supervisor log", error);
  }
}

function startServer() {
  if (stopping) return;
  child = spawn(process.execPath, [SERVER_PATH], { stdio: "inherit" });
  stabilityTimer = setTimeout(() => { restartCount = 0; }, 30_000);
  stabilityTimer.unref?.();
  child.on("error", (error) => {
    appendLogLine({
      at: new Date().toISOString(),
      level: "error",
      message: `Failed to start server: ${error.message}`,
    }).finally(() => process.exit(1));
  });
  child.on("exit", (code, signal) => {
    child = null;
    clearTimeout(killTimer);
    clearTimeout(stabilityTimer);
    if (stopping) {
      process.exit(stopSignal === "SIGINT" ? 130 : 143);
      return;
    }
    if (code === 0) {
      appendLogLine({
        at: new Date().toISOString(),
        level: "info",
        message: "Server exited cleanly; supervisor stopping",
      });
      process.exit(0);
      return;
    }
    restartCount += 1;
    appendLogLine({
      at: new Date().toISOString(),
      level: "error",
      message: `Server exited unexpectedly (code=${code}, signal=${signal}); restarting (attempt ${restartCount})`,
    }).then(() => setTimeout(startServer, Math.min(1000 * 2 ** Math.min(restartCount - 1, 5), 30_000)));
  });
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  stopSignal = signal;
  if (!child) {
    process.exit(signal === "SIGINT" ? 130 : 143);
    return;
  }
  child.kill(signal);
  killTimer = setTimeout(() => child?.kill("SIGKILL"), 12_000);
  killTimer.unref?.();
}

process.on("SIGINT", () => { stop("SIGINT"); });
process.on("SIGTERM", () => { stop("SIGTERM"); });

appendLogLine({ at: new Date().toISOString(), level: "info", message: "Supervisor starting" });
startServer();
