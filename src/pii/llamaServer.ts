import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function resolvePath(value: string): string {
  return isAbsolute(value) ? value : join(projectRoot, value);
}

const SERVER_BIN = resolvePath(process.env.LLAMA_SERVER_BIN ?? "vendor/llama/llama-server");
const SERVER_LIB_DIR = dirname(SERVER_BIN);
const MODEL_PATH = resolvePath(process.env.MODEL_PATH ?? "models/d1-2B-Q8_0.gguf");
const PORT = Number(process.env.LLAMA_PORT ?? 8080);
const HOST = process.env.LLAMA_HOST ?? "127.0.0.1";
const CTX_SIZE = process.env.LLAMA_CTX_SIZE ?? "8192";
const VERBOSE = process.env.LLAMA_SERVER_VERBOSE === "1";

// Optional remote "System One" backend (TypeSafe Jev via OpenCode). When an
// OpenCode API key is present we skip the local llama-server entirely and
// call the hosted endpoint instead.
const API_KEY =
  process.env.OPENCODE_APIKEY ??
  process.env.OPENCODE_API_KEY ??
  process.env.OPENCODE_API_TOKEN ??
  "";
const REMOTE_ENDPOINT =
  process.env.JEV_ENDPOINT ??
  process.env.OPENCODE_SYSTEMONE_URL ??
  "https://opencode.ai/inference/systemone/v1/systemone";
const REMOTE_MODEL =
  process.env.JEV_MODEL ?? process.env.OPENCODE_MODEL ?? "jev-1.13-free";

export const useRemoteModel = API_KEY.length > 0;
export const jevModel = useRemoteModel ? REMOTE_MODEL : undefined;

export const serverUrl = useRemoteModel ? REMOTE_ENDPOINT : `http://${HOST}:${PORT}`;
export const inferenceUrl = useRemoteModel
  ? REMOTE_ENDPOINT
  : `${serverUrl}/v1/systemone`;

export function inferenceHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  return headers;
}

let server: ChildProcess | null = null;
let starting: Promise<void> | null = null;

async function isHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}

async function waitForHealth(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy()) return;
    if (server && server.exitCode !== null) {
      throw new Error(`llama-server exited with code ${server.exitCode}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`llama-server did not become healthy within ${timeoutMs}ms`);
}

/**
 * Starts llama-server with the local GGUF and resolves once the model is loaded.
 * Safe to call multiple times; only one process is spawned.
 */
export async function startModelServer(): Promise<void> {
  if (useRemoteModel) {
    console.log(`[model] Using remote System One model ${jevModel} at ${REMOTE_ENDPOINT}`);
    return;
  }
  if (starting) return starting;

  starting = (async () => {
    if (await isHealthy()) {
      console.log(`[model] Using already-running llama-server at ${serverUrl}`);
      return;
    }

    if (!existsSync(SERVER_BIN)) {
      throw new Error(
        `llama-server not found at ${SERVER_BIN}. Download a build from ` +
          `https://github.com/ggml-org/llama.cpp/releases and extract it there, ` +
          `or set LLAMA_SERVER_BIN.`
      );
    }
    if (!existsSync(MODEL_PATH)) {
      throw new Error(
        `Model not found at ${MODEL_PATH}. Run "npm run model:download" or set MODEL_PATH.`
      );
    }

    console.log(`[model] Starting llama-server on ${serverUrl}`);
    server = spawn(
      SERVER_BIN,
      [
        "--model",
        MODEL_PATH,
        "--host",
        HOST,
        "--port",
        String(PORT),
        "--ctx-size",
        CTX_SIZE,
        // A systemone request is evaluated in one batch, so the batch sizes
        // must be large enough to hold the whole question + state.
        "--batch-size",
        CTX_SIZE,
        "--ubatch-size",
        CTX_SIZE,
      ],
      {
        env: {
          ...process.env,
          LD_LIBRARY_PATH: [SERVER_LIB_DIR, process.env.LD_LIBRARY_PATH]
            .filter(Boolean)
            .join(":"),
        },
        stdio: VERBOSE ? "inherit" : ["ignore", "ignore", "ignore"],
      }
    );

    server.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`[model] llama-server exited (code=${code}, signal=${signal})`);
      }
      server = null;
    });

    await waitForHealth();
    console.log("[model] Model loaded and ready");
  })();

  try {
    await starting;
  } catch (error) {
    starting = null;
    throw error;
  }
}

export function stopModelServer(): void {
  if (useRemoteModel) return;
  if (!server) return;
  server.kill("SIGTERM");
  server = null;
}
