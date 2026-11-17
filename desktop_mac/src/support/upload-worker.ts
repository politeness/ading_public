import { parentPort, workerData } from "node:worker_threads";
import { uploadPendingReportsOnce } from "./uploader";

interface UploadTarget {
  name: string;
  pendingDirectory: string;
  endpoint: string;
}

interface WorkerConfig {
  targets: UploadTarget[];
}

const config = workerData as WorkerConfig;
let current: Promise<void> | null = null;

function run(): void {
  if (current) return;
  current = Promise.all(config.targets.map((target) =>
    uploadPendingReportsOnce({
      pendingDirectory: target.pendingDirectory,
      endpoint: target.endpoint,
      onResult: (result) => parentPort?.postMessage({ target: target.name, ...result })
    })
  )).then(() => undefined).finally(() => {
    current = null;
  });
}

parentPort?.on("message", run);
setInterval(run, 60_000);
run();
