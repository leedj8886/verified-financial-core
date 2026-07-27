import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MetadataStore,
  ContentAddressedSnapshotStore,
} from "./index.js";

const temporaryDirectories: string[] = [];

async function makeStores(): Promise<{
  directory: string;
  metadata: MetadataStore;
  snapshots: ContentAddressedSnapshotStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "verified-storage-"));
  temporaryDirectories.push(directory);
  const metadata = new MetadataStore(join(directory, "metadata.sqlite"));
  const snapshots = new ContentAddressedSnapshotStore(
    join(directory, "raw"),
    metadata,
  );
  return { directory, metadata, snapshots };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("content-addressed snapshot storage", () => {
  it("deduplicates identical JSON and verifies it when reading", async () => {
    const { directory, metadata, snapshots } = await makeStores();
    const input = {
      providerId: "fixture",
      sourceUrl: "https://example.invalid/data",
      mediaType: "json" as const,
      fetchedAt: "2026-07-27T10:00:00+08:00",
      body: "{\"value\":100}",
    };
    const first = await snapshots.put(input);
    const second = await snapshots.put(input);
    expect(second.snapshotId).toBe(first.snapshotId);
    expect((await snapshots.read(first)).toString("utf8"))
      .toBe(input.body);
    const digest = first.snapshotId.slice("sha256:".length);
    const stored = await readFile(join(directory, "raw", `${digest}.json.gz`));
    expect(stored.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(metadata.doctor().snapshotCount).toBe(1);
    metadata.close();
  });

  it("stores PDF bytes without compression", async () => {
    const { directory, metadata, snapshots } = await makeStores();
    const body = Buffer.from("%PDF-fixture", "utf8");
    const reference = await snapshots.put({
      providerId: "official",
      sourceUrl: "https://example.invalid/filing.pdf",
      mediaType: "pdf",
      fetchedAt: "2026-07-27T10:00:00+08:00",
      body,
    });
    const digest = reference.snapshotId.slice("sha256:".length);
    expect(await readFile(join(directory, "raw", `${digest}.pdf`)))
      .toEqual(body);
    metadata.close();
  });
});
