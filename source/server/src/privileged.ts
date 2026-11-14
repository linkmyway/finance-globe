// Privileged host-side functions for 金融星图.
//
// writeDashboardExport exists for one purpose: exporting the full
// getDashboard payload to the host workspace at
// ~/workspace/finance-globe-export/dashboard-full.json (weekly archive
// pushes reuse it). The action worker cannot write to the host
// filesystem directly, so the write goes through this channel. The
// destination directory and both file names are fixed constants — the
// contract only ever carries the serialized JSON payload.
//
// Integrity rule: the manifest's byte count and SHA-256 are computed
// from the bytes read BACK from disk after the file is written, never
// from the in-memory string, so any encoding surprise shows up as a
// hash of what actually landed.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

const EXPORT_ROOT = "/home/hatch/workspace/finance-globe-export";
const DATA_FILE_NAME = "dashboard-full.json";
const MANIFEST_FILE_NAME = "manifest.json";

export const privileged = definePrivilegedContracts({
  writeDashboardExport: {
    request: z.object({
      json: z.string(),
    }),
    response: z.object({
      path: z.string(),
      manifestPath: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      sha256: z.string(),
    }),
    capabilities: ["fs.read", "fs.write"],
    timeoutMs: 30000,
  },
});

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async writeDashboardExport(args) {
    await mkdir(EXPORT_ROOT, { recursive: true });
    const path = join(EXPORT_ROOT, DATA_FILE_NAME);
    // Idempotent: identical payload overwrites with identical bytes.
    await writeFile(path, args.json, "utf8");

    // Hash the bytes actually on disk, not the string we sent.
    const onDisk = await readFile(path);
    const sizeBytes = onDisk.byteLength;
    const sha256 = createHash("sha256").update(onDisk).digest("hex");

    const manifest = {
      file: DATA_FILE_NAME,
      path,
      sizeBytes,
      sha256,
      exportedAt: new Date().toISOString(),
    };
    const manifestPath = join(EXPORT_ROOT, MANIFEST_FILE_NAME);
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    return { path, manifestPath, sizeBytes, sha256 };
  },
});
