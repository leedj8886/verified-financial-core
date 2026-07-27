import { join } from "node:path";
import type { SourceProvider } from "@verified-financial/provider-contract";
import { FinancialGateway } from "@verified-financial/sdk";
import {
  ContentAddressedSnapshotStore,
  MetadataStore,
} from "@verified-financial/storage";

export interface LocalGateway {
  gateway: FinancialGateway;
  close(): void;
}

export function createLocalGateway(
  dataDirectory: string,
  providers: SourceProvider[] = [],
): LocalGateway {
  const metadata = new MetadataStore(join(dataDirectory, "metadata.sqlite"));
  const snapshots = new ContentAddressedSnapshotStore(
    join(dataDirectory, "raw"),
    metadata,
  );
  return {
    gateway: new FinancialGateway({
      providers,
      metadata,
      snapshots,
    }),
    close() {
      metadata.close();
    },
  };
}
