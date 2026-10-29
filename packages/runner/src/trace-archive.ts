import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export interface TraceArchiveValidation { valid: boolean; entries: string[]; errors: string[] }

/** Validate the ZIP central directory/CRC and the actual Playwright trace payload. */
export async function validatePlaywrightTraceArchive(path: string): Promise<TraceArchiveValidation> {
  const errors: string[] = [];
  let entries: string[] = [];
  try {
    const archive = await readFile(path);
    if (archive.length < 100 || archive[0] !== 0x50 || archive[1] !== 0x4b) throw new Error("trace archive is missing ZIP signature or is truncated");
    // `unzip -t` checks each compressed entry against its recorded size and CRC.
    execFileSync("unzip", ["-t", resolve(path)], { stdio: "ignore", timeout: 10_000 });
    entries = execFileSync("unzip", ["-Z1", resolve(path)], { encoding: "utf8", timeout: 10_000 }).split(/\r?\n/).filter(Boolean);
    if (!entries.includes("trace.trace") || !entries.includes("trace.network")) throw new Error("trace archive lacks Playwright trace.trace or trace.network entries");
    const firstLine = execFileSync("unzip", ["-p", resolve(path), "trace.trace"], { encoding: "utf8", timeout: 10_000 }).split(/\r?\n/).find(Boolean);
    if (!firstLine) throw new Error("Playwright trace.trace is empty");
    const metadata: unknown = JSON.parse(firstLine);
    if (!isRecord(metadata) || metadata.type !== "context-options" || metadata.origin !== "library" || !Number.isInteger(metadata.version) || typeof metadata.playwrightVersion !== "string" || metadata.browserName !== "chromium") {
      throw new Error("trace.trace does not begin with valid Playwright Chromium context metadata");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { valid: errors.length === 0, entries, errors };
}

/** Redact HttpOnly session material from trace network metadata while retaining a valid playable ZIP. */
export async function redactTraceCredentials(path: string): Promise<void> {
  const scratch = await mkdtemp(resolve(tmpdir(), "browserproof-trace-redact-"));
  const extracted = resolve(scratch, "extracted");
  const rebuilt = resolve(scratch, "redacted.zip");
  try {
    await mkdir(extracted, { recursive: true });
    execFileSync("unzip", ["-q", resolve(path), "-d", extracted], { stdio: "ignore", timeout: 10_000 });
    await redactDirectory(extracted);
    execFileSync("zip", ["-qr", rebuilt, "."], { cwd: extracted, stdio: "ignore", timeout: 10_000 });
    await rename(rebuilt, resolve(path));
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function redactDirectory(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) { await redactDirectory(path); continue; }
    if (entry.name !== "trace.trace" && entry.name !== "trace.network" && !entry.name.endsWith(".json")) continue;
    const text = await readFile(path, "utf8");
    const lines = text.split(/\r?\n/);
    const redacted = lines.map((line) => {
      if (!line) return line;
      try { return `${JSON.stringify(redactValue(JSON.parse(line)))}${line.endsWith("\n") ? "\n" : ""}`; }
      catch { return line.replace(/((?:cookie|set-cookie|authorization|proxy-authorization)["']?\s*[:=]\s*["'])([^"']*)/gi, "$1[REDACTED]"); }
    }).join("\n");
    await writeFile(path, redacted, "utf8");
  }
}

function redactValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") return key && /^(?:cookie|set-cookie|authorization|proxy-authorization)$/i.test(key) ? "[REDACTED]" : value;
  if (Array.isArray(value)) {
    if (key === "cookies") return value.map((cookie) => isRecord(cookie) ? { ...cookie, value: "[REDACTED]" } : cookie);
    if (key === "headers") return value.map((header) => {
      if (!isRecord(header) || typeof header.name !== "string" || !/^(?:cookie|set-cookie|authorization|proxy-authorization)$/i.test(header.name)) return redactValue(header);
      return { ...header, value: "[REDACTED]" };
    });
    return value.map((entry) => redactValue(entry));
  }
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactValue(child, childKey)]));
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
