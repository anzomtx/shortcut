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
  child.on("error", (error) => {
    appendLogLine({
      at: new Date().toISOString(),
      level: "error",
      message: `Failed to start server: ${error.message}`,
    }).finally(() => process.exit(1));
  });
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return;
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
    }).then(() => setTimeout(startServer, 1000));
  });
}

process.on("SIGINT", () => {
  stopping = true;
  child?.kill("SIGINT");
});
process.on("SIGTERM", () => {
  stopping = true;
  child?.kill("SIGTERM");
});

appendLogLine({ at: new Date().toISOString(), level: "info", message: "Supervisor starting" });
startServer();