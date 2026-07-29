import { join } from "node:path";
import { BaiduProvider } from "@verified-financial/provider-baidu";
import { CninfoProvider } from "@verified-financial/provider-cninfo";
import type { SourceProvider } from "@verified-financial/provider-contract";
import { EastmoneyProvider } from "@verified-financial/provider-eastmoney";
import { HkexProvider } from "@verified-financial/provider-hkex";
import { TencentProvider } from "@verified-financial/provider-tencent";
import { FinancialGateway } from "@verified-financial/sdk";
import {
  ContentAddressedSnapshotStore,
  MetadataStore,
} from "@verified-financial/storage";

export interface LocalGateway {
  gateway: FinancialGateway;
  close(): void;
}

export function createDefaultProviders(): SourceProvider[] {
  return [
    new EastmoneyProvider(),
    new CninfoProvider(),
    new HkexProvider(),
    new TencentProvider(),
    new BaiduProvider(),
  ];
}

export function createLocalGateway(
  dataDirectory: string,
  providers: SourceProvider[] = createDefaultProviders(),
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
