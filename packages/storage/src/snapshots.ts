import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  RawSnapshotInputSchema,
  StoredSnapshotRefSchema,
  type RawSnapshotInput,
  type SnapshotWriter,
  type StoredSnapshotRef,
} from "@verified-financial/provider-contract";
import type { MetadataStore } from "./metadata.js";

function rawBytes(body: Uint8Array | string): Buffer {
  return typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
}

function storedExtension(mediaType: RawSnapshotInput["mediaType"]): string {
  return mediaType === "pdf" ? "pdf" : `${mediaType}.gz`;
}

function validateSnapshotId(snapshotId: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(snapshotId);
  if (match === null) throw new Error("INVALID_SNAPSHOT_ID");
  return match[1]!;
}

export class ContentAddressedSnapshotStore implements SnapshotWriter {
  readonly rawDirectory: string;
  readonly metadata: MetadataStore;

  constructor(rawDirectory: string, metadata: MetadataStore) {
    this.rawDirectory = rawDirectory;
    this.metadata = metadata;
  }

  async put(input: RawSnapshotInput): Promise<StoredSnapshotRef> {
    const metadata = RawSnapshotInputSchema.parse(input);
    const raw = rawBytes(input.body);
    const digest = createHash("sha256").update(raw).digest("hex");
    const snapshotId = `sha256:${digest}`;
    const extension = storedExtension(metadata.mediaType);
    const path = join(this.rawDirectory, `${digest}.${extension}`);
    const stored = metadata.mediaType === "pdf" ? raw : gzipSync(raw);

    await mkdir(this.rawDirectory, { recursive: true });
    try {
      await writeFile(path, stored, { flag: "wx" });
    } catch (error) {
      if (
        !(error instanceof Error)
        || !("code" in error)
        || error.code !== "EEXIST"
      ) {
        throw error;
      }
    }

    const reference = StoredSnapshotRefSchema.parse({
      ...metadata,
      snapshotId,
      byteLength: raw.byteLength,
    });
    this.metadata.putSnapshot(reference, path);
    return reference;
  }

  async read(reference: StoredSnapshotRef): Promise<Buffer> {
    const parsed = StoredSnapshotRefSchema.parse(reference);
    const digest = validateSnapshotId(parsed.snapshotId);
    const path = join(
      this.rawDirectory,
      `${digest}.${storedExtension(parsed.mediaType)}`,
    );
    const stored = await readFile(path);
    const raw = parsed.mediaType === "pdf" ? stored : gunzipSync(stored);
    const actualId = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    if (actualId !== parsed.snapshotId) throw new Error("SNAPSHOT_CORRUPTED");
    return raw;
  }
}
