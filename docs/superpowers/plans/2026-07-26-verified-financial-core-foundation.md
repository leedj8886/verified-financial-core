# Verified Financial Core Foundation Implementation Plan

> **Execution mode:** Execute this plan inline, task-by-task, without worktrees,
> subagent delegation, or Superpowers skills unless the user explicitly requests
> them. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the offline, provider-independent TypeScript foundation that defines canonical financial facts, validates compatible observations, calculates deterministic derivations, and emits reproducible `VerifiedFactSet` objects.

**Architecture:** The pnpm workspace starts with two publishable packages: `@verified-financial/schema` owns runtime-safe Zod contracts and the canonical concept registry; `@verified-financial/core` owns compatibility, source independence, validation, derivations, deterministic IDs, and FactSet assembly. Neither package performs network or filesystem I/O, so all behavior is deterministic and testable with inline fixtures.

**Tech Stack:** TypeScript strict ESM, Node.js 24 (minimum 22), pnpm workspaces, Zod, decimal.js, Vitest, fast-check, tsup.

---

## Program decomposition

The approved design contains independently testable subsystems. Execute them as separate plans in this order:

1. This plan: schema and deterministic financial core.
2. `verified-financial-storage-gateway`: content-addressed snapshots, SQLite, provider contract, SDK orchestration, and JSON CLI.
3. `verified-financial-market-providers`: Eastmoney, Tencent, Baidu, fixtures, and public-market Golden Corpus.
4. `verified-financial-official-providers`: CNINFO, HKEX, optional Tushare, and constrained official key-fact extraction.
5. `verified-financial-client-adapters`: Dexter SDK migration and AI Berkshire CLI integration.

Do not start a successor plan until the current package APIs and quality gate pass. Research CI and Cross-Agent Arena remain outside the MVP implementation sequence; they consume the frozen FactSet contract.

## Planned file map

```text
package.json                         workspace scripts and pinned toolchain
.node-version                       Node.js major-version contract
.npmrc                              project-local official npm registry
AGENTS.md                            project execution constraints
pnpm-workspace.yaml                  workspace package discovery
tsconfig.base.json                   shared strict compiler settings
vitest.config.ts                     package test projects
.gitignore                           generated and local state exclusions
packages/schema/package.json         schema package metadata
packages/schema/tsconfig.json        schema compiler settings
packages/schema/tsup.config.ts       ESM and declaration build
packages/schema/src/value.ts         decimal-string schema
packages/schema/src/concepts.ts      concept registry and concept IDs
packages/schema/src/identity.ts      Company and Instrument contracts
packages/schema/src/period.ts        reporting period and availability
packages/schema/src/accounting.ts    accounting-basis contract
packages/schema/src/provenance.ts    raw lineage contracts
packages/schema/src/facts.ts         Observation, Fact, FactSet, and request
packages/schema/src/index.ts         public exports
packages/schema/src/*.test.ts        colocated schema tests
packages/core/package.json           core package metadata
packages/core/tsconfig.json          core compiler settings
packages/core/tsup.config.ts         ESM and declaration build
packages/core/src/compatibility.ts   scope, period, and basis compatibility
packages/core/src/independence.ts    independent upstream grouping
packages/core/src/verification.ts    discrepancy and status decisions
packages/core/src/derivations.ts     TTM, FCF, ROE, market cap, and PE
packages/core/src/ids.ts             stable canonical hashes and IDs
packages/core/src/fact-set.ts        FactSet assembly and overall status
packages/core/src/index.ts           public exports
packages/core/src/test-fixtures.ts   typed factories used only by tests
packages/core/src/*.test.ts          colocated core tests
tests/golden/foundation/*.json       provider-neutral Golden fixtures
```

### Task 1: Scaffold the strict TypeScript workspace

**Files:**
- Create: `package.json`
- Create: `.node-version`
- Create: `.npmrc`
- Create: `AGENTS.md`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `packages/schema/package.json`
- Create: `packages/schema/tsconfig.json`
- Create: `packages/schema/tsup.config.ts`
- Create: `packages/schema/src/index.ts`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/tsup.config.ts`
- Create: `packages/core/src/index.ts`

- [x] **Step 1: Add the workspace manifest**

Create `package.json`:

```json
{
  "name": "verified-financial-core",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "packageManager": "pnpm@8.15.6",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm --filter @verified-financial/schema build && vitest run",
    "test:watch": "pnpm --filter @verified-financial/schema build && vitest",
    "typecheck": "pnpm -r typecheck",
    "check": "pnpm typecheck && pnpm test && pnpm build"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "fast-check": "^4.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

Create `.node-version`:

```text
24.16.0
```

Create `.npmrc`:

```ini
registry=https://registry.npmjs.org/
```

Create `AGENTS.md` with the repository constraints from the approved design:

```md
# Project Agent Instructions

- All runtime and library code in this repository must use TypeScript.
- Work directly in this repository with inline execution.
- Do not create a Git worktree unless the user explicitly requests one.
- Do not invoke Superpowers skills unless the user explicitly requests them.
- Tushare must remain an optional provider; the core and default tests cannot
  require a Tushare token or interface ledger.
- Dependency installation for this repository uses the project-local official
  npm registry configured in `.npmrc`; do not change the user's global registry.
- Keep Research CI downstream of `VerifiedFactSet`; it must not implement an
  independent financial-data layer.
- Before claiming completion, run the smallest relevant tests plus typecheck
  and build for the changed packages.
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
  - apps/*
  - adapters/*
```

Create `.gitignore`:

```gitignore
node_modules/
.pnpm-store/
dist/
coverage/
*.tsbuildinfo
.DS_Store
.env
.env.*
!.env.example
data/
```

- [x] **Step 2: Add shared TypeScript and Vitest configuration**

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "useUnknownInCatchVariables": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  }
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts"],
    passWithNoTests: true,
  },
});
```

- [x] **Step 3: Add the schema package shell**

Create `packages/schema/package.json`:

```json
{
  "name": "@verified-financial/schema",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "pnpm --filter @verified-financial/schema build && tsup",
    "test": "pnpm --filter @verified-financial/schema build && vitest run",
    "typecheck": "pnpm --filter @verified-financial/schema build && tsc --noEmit"
  },
  "dependencies": {
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

Create `packages/schema/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

Create `packages/schema/tsup.config.ts`:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
});
```

Create `packages/schema/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "schema",
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
```

Create an empty `packages/schema/src/index.ts`.

- [x] **Step 4: Add the core package shell**

Create `packages/core/package.json`:

```json
{
  "name": "@verified-financial/core",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@verified-financial/schema": "workspace:*",
    "decimal.js": "^10.5.0"
  },
  "devDependencies": {
    "fast-check": "^4.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

Create `packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

Create `packages/core/tsup.config.ts`:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["@verified-financial/schema"],
});
```

Create `packages/core/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "core",
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
```

Create an empty `packages/core/src/index.ts`.

- [x] **Step 5: Verify the runtime prerequisite**

Run:

```bash
node --version
pnpm --version
```

Expected: Node prints `v24.16.0` and pnpm prints `8.15.6`. The user's
interactive shell already provides both through NVM. Codex's login-only shell
resolves stale `/usr/local/bin` copies (`v16.17.0` / `7.5.2`), so Codex must run
implementation commands through the interactive zsh environment; no runtime
installation or global package-manager change is required.

- [x] **Step 6: Install and verify the empty workspace**

Run:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Expected:

- install creates `pnpm-lock.yaml`;
- both packages typecheck;
- Vitest exits successfully with no test files;
- both packages emit ESM and declaration files under `dist/`.

- [x] **Step 7: Commit the workspace scaffold**

```bash
git add AGENTS.md package.json .node-version .npmrc pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vitest.config.ts .gitignore packages
git commit -m "chore: scaffold TypeScript financial core workspace"
```

### Task 2: Define exact values and canonical concepts

**Files:**
- Create: `packages/schema/src/value.ts`
- Create: `packages/schema/src/value.test.ts`
- Create: `packages/schema/src/concepts.ts`
- Create: `packages/schema/src/concepts.test.ts`
- Modify: `packages/schema/src/index.ts`

- [x] **Step 1: Write failing decimal-string tests**

Create `packages/schema/src/value.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DecimalStringSchema } from "./value.js";

describe("DecimalStringSchema", () => {
  it.each(["0", "-12", "123.4500", "1e8", "-2.5E-3"])("accepts %s", (value) => {
    expect(DecimalStringSchema.parse(value)).toBe(value);
  });

  it.each([1, Number.NaN, "", "1,000", "¥12", "Infinity"])("rejects %p", (value) => {
    expect(() => DecimalStringSchema.parse(value)).toThrow();
  });
});
```

- [x] **Step 2: Run the value test and verify RED**

Run:

```bash
pnpm --filter @verified-financial/schema test -- src/value.test.ts
```

Expected: FAIL because `./value.js` does not exist.

- [x] **Step 3: Implement the decimal-string schema**

Create `packages/schema/src/value.ts`:

```ts
import { z } from "zod";

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export const DecimalStringSchema = z
  .string()
  .min(1)
  .regex(DECIMAL_PATTERN, "Expected an exact decimal string");

export type DecimalString = z.infer<typeof DecimalStringSchema>;
```

- [x] **Step 4: Run the value test and verify GREEN**

Run:

```bash
pnpm --filter @verified-financial/schema test -- src/value.test.ts
```

Expected: all decimal-string cases PASS.

- [x] **Step 5: Write failing concept-registry tests**

Create `packages/schema/src/concepts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ConceptIdSchema,
  CONCEPT_REGISTRY,
  getConceptDefinition,
} from "./concepts.js";

describe("canonical concept registry", () => {
  it("contains the MVP concepts with fixed semantics", () => {
    expect(getConceptDefinition("income.revenue")).toEqual({
      conceptId: "income.revenue",
      valueType: "decimal",
      scope: "company",
      periodKind: "duration",
      canonicalUnit: "currency",
      allowedPresentations: ["quarter", "ytd", "annual", "ttm"],
    });
    expect(CONCEPT_REGISTRY["market.price.close"].scope).toBe("instrument");
    expect(CONCEPT_REGISTRY["balance.assets"].periodKind).toBe("instant");
  });

  it("rejects provider-private fields", () => {
    expect(() => ConceptIdSchema.parse("TOTAL_OPERATE_INCOME")).toThrow();
  });
});
```

- [x] **Step 6: Run the concept test and verify RED**

Run:

```bash
pnpm --filter @verified-financial/schema test -- src/concepts.test.ts
```

Expected: FAIL because `./concepts.js` does not exist.

- [x] **Step 7: Implement the versioned concept registry**

Create `packages/schema/src/concepts.ts`:

```ts
import { z } from "zod";

export const CONCEPT_REGISTRY_VERSION = "1.0.0";

const conceptDefinitions = {
  "market.price.close": ["decimal", "instrument", "instant", "currency", ["quarter", "ytd", "annual", "ttm"]],
  "market.shares.outstanding": ["decimal", "instrument", "instant", "shares", ["quarter", "ytd", "annual", "ttm"]],
  "market.cap": ["decimal", "instrument", "instant", "currency", ["quarter", "ytd", "annual", "ttm"]],
  "valuation.peTtm": ["decimal", "instrument", "instant", "ratio", ["ttm"]],
  "valuation.pb": ["decimal", "instrument", "instant", "ratio", ["annual", "ttm"]],
  "income.revenue": ["decimal", "company", "duration", "currency", ["quarter", "ytd", "annual", "ttm"]],
  "income.operatingProfit": ["decimal", "company", "duration", "currency", ["quarter", "ytd", "annual", "ttm"]],
  "income.netProfit": ["decimal", "company", "duration", "currency", ["quarter", "ytd", "annual", "ttm"]],
  "income.netProfitParent": ["decimal", "company", "duration", "currency", ["quarter", "ytd", "annual", "ttm"]],
  "income.epsBasic": ["decimal", "instrument", "duration", "currency-per-share", ["quarter", "ytd", "annual", "ttm"]],
  "balance.assets": ["decimal", "company", "instant", "currency", ["quarter", "ytd", "annual"]],
  "balance.liabilities": ["decimal", "company", "instant", "currency", ["quarter", "ytd", "annual"]],
  "balance.equity": ["decimal", "company", "instant", "currency", ["quarter", "ytd", "annual"]],
  "balance.cash": ["decimal", "company", "instant", "currency", ["quarter", "ytd", "annual"]],
  "cashFlow.operatingCashFlow": ["decimal", "company", "duration", "currency", ["quarter", "ytd", "annual", "ttm"]],
  "cashFlow.capex": ["decimal", "company", "duration", "currency", ["quarter", "ytd", "annual", "ttm"]],
  "cashFlow.freeCashFlow": ["decimal", "company", "duration", "currency", ["quarter", "ytd", "annual", "ttm"]],
  "profitability.roe": ["decimal", "company", "duration", "ratio", ["annual", "ttm"]],
  "distribution.dividendPerShare": ["decimal", "instrument", "duration", "currency-per-share", ["annual"]],
} as const;

export type ConceptId = keyof typeof conceptDefinitions;

export const ConceptIdSchema = z.enum(
  Object.keys(conceptDefinitions) as [ConceptId, ...ConceptId[]],
);

export interface ConceptDefinition {
  conceptId: ConceptId;
  valueType: "decimal" | "text" | "date" | "boolean";
  scope: "company" | "instrument";
  periodKind: "instant" | "duration";
  canonicalUnit: string;
  allowedPresentations: readonly ("quarter" | "ytd" | "annual" | "ttm")[];
}

function buildConceptRegistry(): Record<ConceptId, ConceptDefinition> {
  const registry = {} as Record<ConceptId, ConceptDefinition>;
  for (const conceptId of Object.keys(conceptDefinitions) as ConceptId[]) {
    const definition = conceptDefinitions[conceptId];
    registry[conceptId] = {
      conceptId,
      valueType: definition[0],
      scope: definition[1],
      periodKind: definition[2],
      canonicalUnit: definition[3],
      allowedPresentations: definition[4],
    };
  }
  return registry;
}

export const CONCEPT_REGISTRY = buildConceptRegistry();

export function getConceptDefinition(conceptId: ConceptId): ConceptDefinition {
  return CONCEPT_REGISTRY[conceptId];
}
```

- [x] **Step 8: Export and verify values and concepts**

Replace `packages/schema/src/index.ts` with:

```ts
export * from "./concepts.js";
export * from "./value.js";
```

Run:

```bash
pnpm --filter @verified-financial/schema test
pnpm --filter @verified-financial/schema typecheck
```

Expected: all schema tests PASS and typecheck exits 0.

- [x] **Step 9: Commit exact values and concepts**

```bash
git add packages/schema/src
git commit -m "feat(schema): define exact values and canonical concepts"
```

### Task 3: Define company and instrument identity

**Files:**
- Create: `packages/schema/src/identity.ts`
- Create: `packages/schema/src/identity.test.ts`
- Modify: `packages/schema/src/index.ts`

- [x] **Step 1: Write failing identity tests**

Create `packages/schema/src/identity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CompanySchema,
  InstrumentSchema,
  canonicalInstrumentId,
} from "./identity.js";

describe("financial identity", () => {
  it("creates MIC-qualified instrument IDs", () => {
    expect(canonicalInstrumentId("XSHG", "600519")).toBe("XSHG:600519");
    expect(canonicalInstrumentId("XHKG", "700")).toBe("XHKG:00700");
  });

  it("keeps company and instrument identities separate", () => {
    const company = CompanySchema.parse({
      companyId: "company:cn-shenhua",
      legalName: "中国神华能源股份有限公司",
      jurisdiction: "CN",
    });
    const instrument = InstrumentSchema.parse({
      instrumentId: "XHKG:01088",
      companyId: company.companyId,
      exchangeMic: "XHKG",
      symbol: "01088",
      shareClass: "H",
      tradingCurrency: "HKD",
    });
    expect(instrument.companyId).toBe(company.companyId);
  });

  it("rejects an H-share on an A-share exchange", () => {
    expect(() => InstrumentSchema.parse({
      instrumentId: "XSHG:01088",
      companyId: "company:cn-shenhua",
      exchangeMic: "XSHG",
      symbol: "01088",
      shareClass: "H",
      tradingCurrency: "HKD",
    })).toThrow();
  });
});
```

- [x] **Step 2: Run the identity test and verify RED**

Run:

```bash
pnpm --filter @verified-financial/schema test -- src/identity.test.ts
```

Expected: FAIL because `./identity.js` does not exist.

- [x] **Step 3: Implement identity schemas and invariants**

Create `packages/schema/src/identity.ts`:

```ts
import { z } from "zod";

export const ExchangeMicSchema = z.enum(["XSHG", "XSHE", "XBSE", "XHKG"]);
export type ExchangeMic = z.infer<typeof ExchangeMicSchema>;

export const CompanySchema = z.object({
  companyId: z.string().min(1),
  legalName: z.string().min(1),
  jurisdiction: z.string().length(2),
});
export type Company = z.infer<typeof CompanySchema>;

export const InstrumentSchema = z.object({
  instrumentId: z.string().min(1),
  companyId: z.string().min(1),
  exchangeMic: ExchangeMicSchema,
  symbol: z.string().min(1),
  shareClass: z.enum(["A", "H"]),
  tradingCurrency: z.enum(["CNY", "HKD"]),
}).superRefine((instrument, context) => {
  const expectedId = canonicalInstrumentId(instrument.exchangeMic, instrument.symbol);
  if (instrument.instrumentId !== expectedId) {
    context.addIssue({ code: "custom", message: `Expected instrumentId ${expectedId}` });
  }
  const isHShare = instrument.exchangeMic === "XHKG";
  if (isHShare !== (instrument.shareClass === "H")) {
    context.addIssue({ code: "custom", message: "Share class does not match exchange" });
  }
  const expectedCurrency = isHShare ? "HKD" : "CNY";
  if (instrument.tradingCurrency !== expectedCurrency) {
    context.addIssue({ code: "custom", message: `Expected trading currency ${expectedCurrency}` });
  }
});
export type Instrument = z.infer<typeof InstrumentSchema>;

export function canonicalInstrumentId(exchangeMic: ExchangeMic, symbol: string): string {
  const normalized = exchangeMic === "XHKG"
    ? symbol.replace(/^0+/, "").padStart(5, "0")
    : symbol.padStart(6, "0");
  return `${exchangeMic}:${normalized}`;
}
```

- [x] **Step 4: Export and verify identity**

Add to `packages/schema/src/index.ts`:

```ts
export * from "./identity.js";
```

Run:

```bash
pnpm --filter @verified-financial/schema test
pnpm --filter @verified-financial/schema typecheck
```

Expected: all schema tests PASS.

- [x] **Step 5: Commit identity contracts**

```bash
git add packages/schema/src
git commit -m "feat(schema): separate company and instrument identity"
```

### Task 4: Define periods, accounting basis, and provenance

**Files:**
- Create: `packages/schema/src/period.ts`
- Create: `packages/schema/src/period.test.ts`
- Create: `packages/schema/src/accounting.ts`
- Create: `packages/schema/src/provenance.ts`
- Create: `packages/schema/src/provenance.test.ts`
- Modify: `packages/schema/src/index.ts`

- [x] **Step 1: Write failing period and as-of tests**

Create `packages/schema/src/period.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AvailabilitySchema,
  ReportingPeriodSchema,
  isAvailableAsOf,
} from "./period.js";

describe("reporting period and availability", () => {
  it("keeps report end date separate from publication time", () => {
    const period = ReportingPeriodSchema.parse({
      kind: "duration",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      fiscalYear: 2025,
      presentation: "annual",
    });
    const availability = AvailabilitySchema.parse({
      filingDate: "2026-03-20",
      publishedAt: "2026-03-20T18:00:00+08:00",
      fetchedAt: "2026-07-26T10:00:00+08:00",
    });
    expect(period.endDate).toBe("2025-12-31");
    expect(isAvailableAsOf(availability, "2026-03-19T23:59:59+08:00")).toBe(false);
    expect(isAvailableAsOf(availability, "2026-03-21T00:00:00+08:00")).toBe(true);
  });

  it("requires startDate only for duration periods", () => {
    expect(() => ReportingPeriodSchema.parse({
      kind: "duration",
      endDate: "2025-12-31",
      fiscalYear: 2025,
      presentation: "annual",
    })).toThrow();
    expect(ReportingPeriodSchema.parse({
      kind: "instant",
      endDate: "2025-12-31",
      fiscalYear: 2025,
      presentation: "annual",
    }).kind).toBe("instant");
  });

  it("requires fiscalQuarter for quarter and YTD presentations", () => {
    expect(() => ReportingPeriodSchema.parse({
      kind: "duration",
      startDate: "2026-01-01",
      endDate: "2026-03-31",
      fiscalYear: 2026,
      presentation: "ytd",
    })).toThrow();
  });

  it("rejects fiscalQuarter on annual periods", () => {
    expect(() => ReportingPeriodSchema.parse({
      kind: "duration",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      fiscalYear: 2025,
      fiscalQuarter: 4,
      presentation: "annual",
    })).toThrow("Annual periods cannot have fiscalQuarter");
  });
});
```

- [x] **Step 2: Run the period test and verify RED**

Run:

```bash
pnpm --filter @verified-financial/schema test -- src/period.test.ts
```

Expected: FAIL because `./period.js` does not exist.

- [x] **Step 3: Implement periods and availability**

Create `packages/schema/src/period.ts`:

```ts
import { z } from "zod";

const IsoDateSchema = z.string().date();
const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const PresentationSchema = z.enum(["quarter", "ytd", "annual", "ttm"]);
export type Presentation = z.infer<typeof PresentationSchema>;

export const ReportingPeriodSchema = z.object({
  kind: z.enum(["instant", "duration"]),
  startDate: IsoDateSchema.optional(),
  endDate: IsoDateSchema,
  fiscalYear: z.number().int(),
  fiscalQuarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  presentation: PresentationSchema,
}).superRefine((period, context) => {
  if (period.kind === "duration" && period.startDate === undefined) {
    context.addIssue({ code: "custom", message: "Duration periods require startDate" });
  }
  if (period.kind === "instant" && period.startDate !== undefined) {
    context.addIssue({ code: "custom", message: "Instant periods cannot have startDate" });
  }
  if ((period.presentation === "quarter" || period.presentation === "ytd")
      && period.fiscalQuarter === undefined) {
    context.addIssue({ code: "custom", message: "Quarter and YTD periods require fiscalQuarter" });
  }
  if (period.presentation === "annual" && period.fiscalQuarter !== undefined) {
    context.addIssue({ code: "custom", message: "Annual periods cannot have fiscalQuarter" });
  }
});
export type ReportingPeriod = z.infer<typeof ReportingPeriodSchema>;

export const AvailabilitySchema = z.object({
  filingDate: IsoDateSchema.optional(),
  publishedAt: IsoDateTimeSchema.optional(),
  sourceAsOf: IsoDateTimeSchema.optional(),
  fetchedAt: IsoDateTimeSchema,
});
export type Availability = z.infer<typeof AvailabilitySchema>;

export function isAvailableAsOf(availability: Availability, asOf: string): boolean {
  return availability.publishedAt !== undefined
    && Date.parse(availability.publishedAt) <= Date.parse(asOf);
}
```

- [x] **Step 4: Write failing provenance tests**

Create `packages/schema/src/provenance.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ProvenanceSchema } from "./provenance.js";

describe("provenance", () => {
  it("separates adapter identity from the real upstream", () => {
    const provenance = ProvenanceSchema.parse({
      providerId: "legacy-akshare-adapter",
      upstreamSourceId: "eastmoney",
      sourceType: "aggregator",
      sourceUrl: "https://example.invalid/source",
      rawSnapshotId: "sha256:abc",
      rawField: "TOTAL_OPERATE_INCOME",
      extractionMethod: "api",
      fetchedAt: "2026-07-26T10:00:00+08:00",
      transformations: [],
    });
    expect(provenance.providerId).not.toBe(provenance.upstreamSourceId);
  });

  it("rejects missing raw lineage", () => {
    expect(() => ProvenanceSchema.parse({
      providerId: "eastmoney-direct",
      upstreamSourceId: "eastmoney",
      sourceType: "aggregator",
      sourceUrl: "https://example.invalid/source",
      rawField: "f116",
      extractionMethod: "api",
      fetchedAt: "2026-07-26T10:00:00+08:00",
      transformations: [],
    })).toThrow();
  });
});
```

- [x] **Step 5: Implement accounting and provenance**

Create `packages/schema/src/accounting.ts`:

```ts
import { z } from "zod";

export const AccountingBasisSchema = z.object({
  standard: z.enum(["CAS", "IFRS", "OTHER"]),
  scope: z.enum(["consolidated", "standalone"]),
  presentation: z.enum(["reported", "adjusted"]),
  attribution: z.enum(["parent", "all-shareholders"]).optional(),
  currency: z.string().min(3).max(3),
});
export type AccountingBasis = z.infer<typeof AccountingBasisSchema>;
```

Create `packages/schema/src/provenance.ts`:

```ts
import { z } from "zod";

export const TransformationStepSchema = z.object({
  transformId: z.string().min(1),
  version: z.string().min(1),
  detail: z.string().min(1),
});
export type TransformationStep = z.infer<typeof TransformationStepSchema>;

export const ProvenanceSchema = z.object({
  providerId: z.string().min(1),
  upstreamSourceId: z.string().min(1),
  sourceType: z.enum(["official", "first-party", "aggregator"]),
  documentId: z.string().min(1).optional(),
  sourceUrl: z.string().url(),
  rawSnapshotId: z.string().min(1),
  rawField: z.string().min(1),
  extractionMethod: z.enum(["api", "html", "pdf", "derived"]),
  fetchedAt: z.string().datetime({ offset: true }),
  transformations: z.array(TransformationStepSchema),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;
```

- [x] **Step 6: Export and verify temporal and lineage contracts**

Add to `packages/schema/src/index.ts`:

```ts
export * from "./accounting.js";
export * from "./period.js";
export * from "./provenance.js";
```

Run:

```bash
pnpm --filter @verified-financial/schema test
pnpm --filter @verified-financial/schema typecheck
```

Expected: all schema tests PASS.

- [x] **Step 7: Commit periods, accounting, and provenance**

```bash
git add packages/schema/src
git commit -m "feat(schema): define periods accounting and provenance"
```

### Task 5: Define observations, facts, requests, and FactSets

**Files:**
- Create: `packages/schema/src/facts.ts`
- Create: `packages/schema/src/facts.test.ts`
- Modify: `packages/schema/src/index.ts`

- [x] **Step 1: Write failing FactSet contract tests**

Create `packages/schema/src/facts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  FactRequestSchema,
  ObservationSchema,
  VerificationResultSchema,
  VerifiedFactSetSchema,
} from "./facts.js";

const period = {
  kind: "duration",
  startDate: "2025-01-01",
  endDate: "2025-12-31",
  fiscalYear: 2025,
  presentation: "annual",
} as const;

const basis = {
  standard: "CAS",
  scope: "consolidated",
  presentation: "reported",
  attribution: "parent",
  currency: "CNY",
} as const;

const observation = {
  observationId: "obs:1",
  companyId: "company:600519",
  concept: "income.revenue",
  value: "100.1",
  unit: "CNY",
  scale: "1",
  period,
  basis,
  availability: {
    publishedAt: "2026-03-20T18:00:00+08:00",
    fetchedAt: "2026-07-26T10:00:00+08:00",
  },
  provenance: {
    providerId: "eastmoney-direct",
    upstreamSourceId: "eastmoney",
    sourceType: "aggregator",
    sourceUrl: "https://example.invalid",
    rawSnapshotId: "sha256:abc",
    rawField: "TOTAL_OPERATE_INCOME",
    extractionMethod: "api",
    fetchedAt: "2026-07-26T10:00:00+08:00",
    transformations: [],
  },
} as const;

describe("financial fact contracts", () => {
  it("rejects binary floating-point values", () => {
    expect(() => ObservationSchema.parse({
      ...observation,
      value: 100.1,
    })).toThrow();
  });

  it("enforces canonical concept scope, period kind, unit, and presentation", () => {
    expect(() => ObservationSchema.parse({
      ...observation,
      instrumentId: "XSHG:600519",
    })).toThrow("Company-scoped concepts cannot have instrumentId");
    expect(() => ObservationSchema.parse({
      ...observation,
      unit: "shares",
    })).toThrow("Expected canonical unit CNY");
    expect(() => ObservationSchema.parse({
      ...observation,
      period: {
        kind: "instant",
        endDate: "2025-12-31",
        fiscalYear: 2025,
        presentation: "annual",
      },
    })).toThrow("Expected duration period");
    expect(() => ObservationSchema.parse({
      ...observation,
      concept: "distribution.dividendPerShare",
      instrumentId: "XSHG:600519",
      unit: "CNY-per-share",
      period: {
        ...period,
        fiscalQuarter: 1,
        presentation: "quarter",
      },
    })).toThrow("Presentation quarter is not allowed");
  });

  it("requires explicit required fact requirements", () => {
    expect(FactRequestSchema.parse({
      instrument: "XSHG:600519",
      requirements: [{
        conceptId: "income.revenue",
        required: true,
        period: { fiscalYear: 2025, presentation: "annual" },
      }],
      asOf: "2026-07-26T23:59:59+08:00",
    }).requirements[0]?.required).toBe(true);
  });

  it("rejects a period presentation unsupported by the concept", () => {
    expect(() => FactRequestSchema.parse({
      instrument: "XSHG:600519",
      requirements: [{
        conceptId: "distribution.dividendPerShare",
        required: true,
        period: {
          fiscalYear: 2025,
          fiscalQuarter: 1,
          presentation: "quarter",
        },
      }],
      asOf: "2026-07-26T23:59:59+08:00",
    })).toThrow("Presentation quarter is not allowed");
  });

  it("keeps verification status and usability consistent", () => {
    expect(() => VerificationResultSchema.parse({
      verificationId: "vr:invalid",
      status: "failed",
      usable: true,
      observationIds: ["obs:1"],
      independentUpstreamSourceIds: ["eastmoney"],
      reasonCodes: ["UNRESOLVED_SOURCE_CONFLICT"],
    })).toThrow("Failed verification cannot be usable");
  });

  it("accepts an explicit failed empty FactSet", () => {
    const factSet = VerifiedFactSetSchema.parse({
      schemaVersion: "1.0.0",
      factSetId: "fs:empty",
      request: {
        instrument: "XSHG:600519",
        requirements: [{
          conceptId: "income.revenue",
          required: true,
          period: { fiscalYear: 2025, presentation: "annual" },
        }],
        asOf: "2026-07-26T23:59:59+08:00",
      },
      generatedAt: "2026-07-26T10:00:00+08:00",
      company: {
        companyId: "company:600519",
        legalName: "贵州茅台酒股份有限公司",
        jurisdiction: "CN",
      },
      instruments: [],
      facts: [],
      unmapped: [],
      validations: [],
      rawSnapshotIds: [],
      reasonCodes: ["EMPTY_FACT_SET"],
      summary: {
        verified: 0,
        warnings: 0,
        failed: 1,
        unmapped: 0,
        overallStatus: "failed",
      },
    });
    expect(factSet.summary.overallStatus).toBe("failed");
  });
});
```

- [x] **Step 2: Run the fact contract test and verify RED**

Run:

```bash
pnpm --filter @verified-financial/schema test -- src/facts.test.ts
```

Expected: FAIL because `./facts.js` does not exist.

- [x] **Step 3: Implement fact contracts**

Create `packages/schema/src/facts.ts` with these exported schemas and inferred types:

```ts
import { z } from "zod";
import {
  AccountingBasisSchema,
  type AccountingBasis,
} from "./accounting.js";
import {
  ConceptIdSchema,
  getConceptDefinition,
  type ConceptId,
} from "./concepts.js";
import { CompanySchema, InstrumentSchema } from "./identity.js";
import {
  AvailabilitySchema,
  ReportingPeriodSchema,
  type ReportingPeriod,
} from "./period.js";
import { ProvenanceSchema } from "./provenance.js";
import { DecimalStringSchema } from "./value.js";

export const FactStatusSchema = z.enum(["verified", "warning", "failed"]);
export type FactStatus = z.infer<typeof FactStatusSchema>;

export const FactPeriodSelectorSchema = z.object({
  fiscalYear: z.number().int(),
  fiscalQuarter: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
  ]).optional(),
  presentation: z.enum(["quarter", "ytd", "annual", "ttm"]),
}).superRefine((period, context) => {
  const quarterRequired = period.presentation === "quarter"
    || period.presentation === "ytd";
  if (quarterRequired && period.fiscalQuarter === undefined) {
    context.addIssue({
      code: "custom",
      message: "Quarter and YTD requirements need fiscalQuarter",
    });
  }
  if (period.presentation === "annual" && period.fiscalQuarter !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Annual requirements cannot specify fiscalQuarter",
    });
  }
});
export type FactPeriodSelector = z.infer<typeof FactPeriodSelectorSchema>;

export const FactRequirementSchema = z.object({
  conceptId: ConceptIdSchema,
  required: z.boolean(),
  period: FactPeriodSelectorSchema.optional(),
}).superRefine((requirement, context) => {
  if (requirement.period === undefined) {
    return;
  }
  const definition = getConceptDefinition(requirement.conceptId);
  if (!definition.allowedPresentations.includes(requirement.period.presentation)) {
    context.addIssue({
      code: "custom",
      message: `Presentation ${requirement.period.presentation} is not allowed for ${requirement.conceptId}`,
    });
  }
});
export type FactRequirement = z.infer<typeof FactRequirementSchema>;

export const FactRequestSchema = z.object({
  instrument: z.string().min(1),
  requirements: z.array(FactRequirementSchema).min(1),
  asOf: z.string().datetime({ offset: true }),
  freshness: z.object({
    maxAgeSeconds: z.number().int().nonnegative(),
    allowStaleOnProviderFailure: z.boolean(),
    offline: z.boolean().optional(),
  }).optional(),
});
export type FactRequest = z.infer<typeof FactRequestSchema>;

interface ConceptSemanticCandidate {
  concept: ConceptId;
  instrumentId?: string | undefined;
  unit: string;
  period: ReportingPeriod;
  basis: AccountingBasis;
}

function validateConceptSemantics(
  candidate: ConceptSemanticCandidate,
  context: z.RefinementCtx,
): void {
  const definition = getConceptDefinition(candidate.concept);
  if (definition.scope === "instrument" && candidate.instrumentId === undefined) {
    context.addIssue({
      code: "custom",
      message: "Instrument-scoped concepts require instrumentId",
    });
  }
  if (definition.scope === "company" && candidate.instrumentId !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Company-scoped concepts cannot have instrumentId",
    });
  }
  if (candidate.period.kind !== definition.periodKind) {
    context.addIssue({
      code: "custom",
      message: `Expected ${definition.periodKind} period`,
    });
  }
  if (!definition.allowedPresentations.includes(candidate.period.presentation)) {
    context.addIssue({
      code: "custom",
      message: `Presentation ${candidate.period.presentation} is not allowed for ${candidate.concept}`,
    });
  }
  const expectedUnit = definition.canonicalUnit === "currency"
    ? candidate.basis.currency
    : definition.canonicalUnit === "currency-per-share"
      ? `${candidate.basis.currency}-per-share`
      : definition.canonicalUnit;
  if (candidate.unit !== expectedUnit) {
    context.addIssue({
      code: "custom",
      message: `Expected canonical unit ${expectedUnit}`,
    });
  }
}

export const ObservationSchema = z.object({
  observationId: z.string().min(1),
  companyId: z.string().min(1),
  instrumentId: z.string().min(1).optional(),
  concept: ConceptIdSchema,
  value: DecimalStringSchema,
  unit: z.string().min(1),
  scale: DecimalStringSchema,
  period: ReportingPeriodSchema,
  basis: AccountingBasisSchema,
  availability: AvailabilitySchema,
  provenance: ProvenanceSchema,
}).superRefine(validateConceptSemantics);
export type Observation = z.infer<typeof ObservationSchema>;

export const UnmappedObservationSchema = z.object({
  unmappedId: z.string().min(1),
  providerId: z.string().min(1),
  upstreamSourceId: z.string().min(1),
  rawSnapshotId: z.string().min(1),
  rawField: z.string().min(1),
  rawValue: z.unknown(),
  reasonCode: z.literal("UNMAPPED_SOURCE_FIELD"),
});
export type UnmappedObservation = z.infer<typeof UnmappedObservationSchema>;

export const VerificationResultSchema = z.object({
  verificationId: z.string().min(1),
  status: FactStatusSchema,
  usable: z.boolean(),
  observationIds: z.array(z.string().min(1)),
  independentUpstreamSourceIds: z.array(z.string().min(1)),
  discrepancyPercent: DecimalStringSchema.optional(),
  chosenObservationId: z.string().min(1).optional(),
  reasonCodes: z.array(z.string().min(1)),
}).superRefine((result, context) => {
  if (result.status === "failed" && result.usable) {
    context.addIssue({
      code: "custom",
      message: "Failed verification cannot be usable",
    });
  }
  if (result.status !== "failed" && !result.usable) {
    context.addIssue({
      code: "custom",
      message: "Verified or warning verification must be usable",
    });
  }
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const DerivationSchema = z.object({
  formulaId: z.string().min(1),
  formulaVersion: z.string().min(1),
  inputFactIds: z.array(z.string().min(1)).min(1),
  expression: z.string().min(1),
  rounding: z.string().min(1).optional(),
});
export type Derivation = z.infer<typeof DerivationSchema>;

export const CanonicalFactSchema = z.object({
  factId: z.string().min(1),
  companyId: z.string().min(1),
  instrumentId: z.string().min(1).optional(),
  concept: ConceptIdSchema,
  value: DecimalStringSchema,
  unit: z.string().min(1),
  period: ReportingPeriodSchema,
  basis: AccountingBasisSchema,
  status: FactStatusSchema,
  usable: z.boolean(),
  reasonCodes: z.array(z.string().min(1)),
  observationIds: z.array(z.string().min(1)).min(1),
  verification: VerificationResultSchema,
  derivation: DerivationSchema.optional(),
}).superRefine(validateConceptSemantics).superRefine((fact, context) => {
  if (fact.status !== fact.verification.status
      || fact.usable !== fact.verification.usable) {
    context.addIssue({
      code: "custom",
      message: "Fact status and usability must match verification",
    });
  }
});
export type CanonicalFact = z.infer<typeof CanonicalFactSchema>;

export const VerifiedFactSetSchema = z.object({
  schemaVersion: z.string().min(1),
  factSetId: z.string().min(1),
  request: FactRequestSchema,
  generatedAt: z.string().datetime({ offset: true }),
  company: CompanySchema,
  instruments: z.array(InstrumentSchema),
  facts: z.array(CanonicalFactSchema),
  unmapped: z.array(UnmappedObservationSchema),
  validations: z.array(VerificationResultSchema),
  rawSnapshotIds: z.array(z.string().min(1)),
  reasonCodes: z.array(z.string().min(1)),
  summary: z.object({
    verified: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    unmapped: z.number().int().nonnegative(),
    overallStatus: FactStatusSchema,
  }),
});
export type VerifiedFactSet = z.infer<typeof VerifiedFactSetSchema>;
```

- [x] **Step 4: Export and verify fact contracts**

Add to `packages/schema/src/index.ts`:

```ts
export * from "./facts.js";
```

Run:

```bash
pnpm --filter @verified-financial/schema test
pnpm --filter @verified-financial/schema typecheck
```

Expected: all schema tests PASS.

- [x] **Step 5: Commit fact contracts**

```bash
git add packages/schema/src
git commit -m "feat(schema): define observations facts and fact sets"
```

### Task 6: Enforce observation compatibility and source independence

**Files:**
- Create: `packages/core/src/test-fixtures.ts`
- Create: `packages/core/src/compatibility.ts`
- Create: `packages/core/src/compatibility.test.ts`
- Create: `packages/core/src/independence.ts`
- Create: `packages/core/src/independence.test.ts`
- Modify: `packages/core/src/index.ts`

- [x] **Step 1: Add complete typed test factories**

Create `packages/core/src/test-fixtures.ts`:

```ts
import {
  CanonicalFactSchema,
  FactRequestSchema,
  ObservationSchema,
  UnmappedObservationSchema,
  getConceptDefinition,
  type AccountingBasis,
  type Availability,
  type CanonicalFact,
  type ConceptId,
  type FactRequest,
  type Observation,
  type ReportingPeriod,
  type UnmappedObservation,
} from "@verified-financial/schema";

interface ObservationOverrides {
  observationId?: string;
  companyId?: string;
  instrumentId?: string;
  concept?: ConceptId;
  value?: string;
  unit?: string;
  scale?: string;
  period?: Partial<ReportingPeriod>;
  basis?: Partial<AccountingBasis>;
  availability?: Partial<Availability>;
  providerId?: string;
  upstreamSourceId?: string;
  sourceType?: "official" | "first-party" | "aggregator";
}

export function makeObservation(
  overrides: ObservationOverrides = {},
): Observation {
  const concept = overrides.concept ?? "income.revenue";
  const definition = getConceptDefinition(concept);
  const periodKind = overrides.period?.kind ?? definition.periodKind;
  const instrumentId = overrides.instrumentId
    ?? (definition.scope === "instrument" ? "XSHG:600519" : undefined);
  const currency = overrides.basis?.currency ?? "CNY";
  const unit = definition.canonicalUnit === "currency"
    ? currency
    : definition.canonicalUnit === "currency-per-share"
      ? `${currency}-per-share`
      : definition.canonicalUnit;
  return ObservationSchema.parse({
    observationId: overrides.observationId ?? "obs:eastmoney",
    companyId: overrides.companyId ?? "company:600519",
    ...(instrumentId === undefined ? {} : { instrumentId }),
    concept,
    value: overrides.value ?? "100",
    unit: overrides.unit ?? unit,
    scale: overrides.scale ?? "1",
    period: {
      kind: periodKind,
      ...(periodKind === "duration" ? { startDate: "2025-01-01" } : {}),
      endDate: "2025-12-31",
      fiscalYear: 2025,
      presentation: "annual",
      ...overrides.period,
    },
    basis: {
      standard: "CAS",
      scope: "consolidated",
      presentation: "reported",
      attribution: "parent",
      currency: "CNY",
      ...overrides.basis,
    },
    availability: {
      publishedAt: "2026-03-20T18:00:00+08:00",
      fetchedAt: "2026-07-26T10:00:00+08:00",
      ...overrides.availability,
    },
    provenance: {
      providerId: overrides.providerId ?? "eastmoney-direct",
      upstreamSourceId: overrides.upstreamSourceId ?? "eastmoney",
      sourceType: overrides.sourceType ?? "aggregator",
      sourceUrl: `https://example.invalid/${overrides.providerId ?? "eastmoney-direct"}`,
      rawSnapshotId: `sha256:${overrides.providerId ?? "eastmoney-direct"}`,
      rawField: "RAW_FIELD",
      extractionMethod: "api",
      fetchedAt: "2026-07-26T10:00:00+08:00",
      transformations: [],
    },
  });
}

interface FactOverrides extends ObservationOverrides {
  factId?: string;
  status?: "verified" | "warning" | "failed";
  usable?: boolean;
  fiscalYear?: number;
  fiscalQuarter?: 1 | 2 | 3 | 4;
  presentation?: "quarter" | "ytd" | "annual" | "ttm";
  currency?: string;
}

export function makeFact(overrides: FactOverrides = {}): CanonicalFact {
  const observation = makeObservation({
    ...overrides,
    basis: {
      ...overrides.basis,
      ...(overrides.currency === undefined ? {} : { currency: overrides.currency }),
    },
    period: {
      ...overrides.period,
      ...(overrides.fiscalYear === undefined ? {} : { fiscalYear: overrides.fiscalYear }),
      ...(overrides.fiscalQuarter === undefined ? {} : { fiscalQuarter: overrides.fiscalQuarter }),
      ...(overrides.presentation === undefined ? {} : { presentation: overrides.presentation }),
    },
  });
  const status = overrides.status ?? "verified";
  const usable = overrides.usable ?? status !== "failed";
  const factId = overrides.factId ?? `fact:${observation.observationId}`;
  return CanonicalFactSchema.parse({
    factId,
    companyId: observation.companyId,
    ...(observation.instrumentId === undefined ? {} : { instrumentId: observation.instrumentId }),
    concept: observation.concept,
    value: observation.value,
    unit: observation.unit,
    period: observation.period,
    basis: observation.basis,
    status,
    usable,
    reasonCodes: [],
    observationIds: [observation.observationId],
    verification: {
      verificationId: `vr:${factId}`,
      status,
      usable,
      observationIds: [observation.observationId],
      independentUpstreamSourceIds: [observation.provenance.upstreamSourceId],
      chosenObservationId: observation.observationId,
      reasonCodes: [],
    },
  });
}

export function makeRequest(
  requirements: FactRequest["requirements"] = [
    {
      conceptId: "income.revenue",
      required: true,
      period: { fiscalYear: 2025, presentation: "annual" },
    },
  ],
): FactRequest {
  return FactRequestSchema.parse({
    instrument: "XSHG:600519",
    requirements,
    asOf: "2026-07-26T23:59:59+08:00",
  });
}

export function makeUnmapped(
  overrides: Partial<UnmappedObservation> = {},
): UnmappedObservation {
  return UnmappedObservationSchema.parse({
    unmappedId: "unmapped:1",
    providerId: "eastmoney-direct",
    upstreamSourceId: "eastmoney",
    rawSnapshotId: "sha256:eastmoney-direct",
    rawField: "UNKNOWN_FIELD",
    rawValue: "1",
    reasonCode: "UNMAPPED_SOURCE_FIELD",
    ...overrides,
  });
}
```

- [x] **Step 2: Write failing compatibility tests**

Create `packages/core/src/compatibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { compareCompatibility } from "./compatibility.js";
import { makeObservation } from "./test-fixtures.js";

it("rejects A/H instrument mixing", () => {
  const aPrice = makeObservation({
    concept: "market.price.close",
    instrumentId: "XSHG:601088",
    unit: "CNY",
  });
  const hPrice = makeObservation({
    concept: "market.price.close",
    instrumentId: "XHKG:01088",
    unit: "HKD",
    basis: { currency: "HKD" },
  });
  expect(compareCompatibility(aPrice, hPrice)).toEqual({
    compatible: false,
    reasonCodes: ["INSTRUMENT_MISMATCH", "UNIT_MISMATCH", "CURRENCY_MISMATCH"],
  });
});

it("rejects reported and adjusted profit", () => {
  const reported = makeObservation({
    concept: "income.netProfitParent",
    basis: { presentation: "reported" },
  });
  const adjusted = makeObservation({
    concept: "income.netProfitParent",
    basis: { presentation: "adjusted" },
  });
  expect(compareCompatibility(reported, adjusted).reasonCodes)
    .toContain("ACCOUNTING_PRESENTATION_MISMATCH");
});

it("accepts compatible observations from different upstreams", () => {
  const left = makeObservation({ upstreamSourceId: "eastmoney" });
  const right = makeObservation({ upstreamSourceId: "cninfo" });
  expect(compareCompatibility(left, right)).toEqual({
    compatible: true,
    reasonCodes: [],
  });
});
```

- [x] **Step 3: Run compatibility tests and verify RED**

Run:

```bash
pnpm --filter @verified-financial/core test -- src/compatibility.test.ts
```

Expected: FAIL because `compareCompatibility` does not exist.

- [x] **Step 4: Implement explicit compatibility dimensions**

Create `packages/core/src/compatibility.ts`:

```ts
import type { Observation } from "@verified-financial/schema";

export interface CompatibilityResult {
  compatible: boolean;
  reasonCodes: string[];
}

export function compareCompatibility(
  left: Observation,
  right: Observation,
): CompatibilityResult {
  const reasonCodes: string[] = [];
  if (left.concept !== right.concept) reasonCodes.push("CONCEPT_MISMATCH");
  if (left.companyId !== right.companyId) reasonCodes.push("COMPANY_MISMATCH");
  if (left.instrumentId !== right.instrumentId) reasonCodes.push("INSTRUMENT_MISMATCH");
  if (left.unit !== right.unit || left.scale !== right.scale) reasonCodes.push("UNIT_MISMATCH");
  if (left.period.kind !== right.period.kind
      || left.period.startDate !== right.period.startDate
      || left.period.endDate !== right.period.endDate
      || left.period.presentation !== right.period.presentation) {
    reasonCodes.push("PERIOD_MISMATCH");
  }
  if (left.basis.standard !== right.basis.standard) reasonCodes.push("ACCOUNTING_STANDARD_MISMATCH");
  if (left.basis.scope !== right.basis.scope) reasonCodes.push("ACCOUNTING_SCOPE_MISMATCH");
  if (left.basis.presentation !== right.basis.presentation) {
    reasonCodes.push("ACCOUNTING_PRESENTATION_MISMATCH");
  }
  if (left.basis.attribution !== right.basis.attribution) reasonCodes.push("ATTRIBUTION_MISMATCH");
  if (left.basis.currency !== right.basis.currency) reasonCodes.push("CURRENCY_MISMATCH");
  return { compatible: reasonCodes.length === 0, reasonCodes };
}
```

- [x] **Step 5: Write failing source-independence tests**

Create `packages/core/src/independence.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { independentUpstreamSourceIds } from "./independence.js";
import { makeObservation } from "./test-fixtures.js";

describe("upstream independence", () => {
  it("counts wrappers over Eastmoney once", () => {
    const observations = [
      makeObservation({ providerId: "eastmoney-direct", upstreamSourceId: "eastmoney" }),
      makeObservation({ providerId: "legacy-akshare", upstreamSourceId: "eastmoney" }),
      makeObservation({ providerId: "cninfo-direct", upstreamSourceId: "cninfo" }),
    ];
    expect(independentUpstreamSourceIds(observations)).toEqual(["cninfo", "eastmoney"]);
  });
});
```

- [x] **Step 6: Implement upstream grouping**

Create `packages/core/src/independence.ts`:

```ts
import type { Observation } from "@verified-financial/schema";

export function independentUpstreamSourceIds(
  observations: readonly Observation[],
): string[] {
  return [...new Set(observations.map(
    (observation) => observation.provenance.upstreamSourceId,
  ))].sort();
}
```

- [x] **Step 7: Export and verify compatibility**

Add to `packages/core/src/index.ts`:

```ts
export * from "./compatibility.js";
export * from "./independence.js";
```

Run:

```bash
pnpm --filter @verified-financial/core test
pnpm --filter @verified-financial/core typecheck
```

Expected: all compatibility and independence tests PASS.

- [x] **Step 8: Commit compatibility rules**

```bash
git add packages/core/src
git commit -m "feat(core): enforce observation compatibility and source independence"
```

### Task 7: Implement cross-source verification

**Files:**
- Create: `packages/core/src/verification.ts`
- Create: `packages/core/src/verification.test.ts`
- Modify: `packages/core/src/index.ts`

- [x] **Step 1: Write failing verification tests**

Create `packages/core/src/verification.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  verifyAndMaterializeFact,
  verifyObservations,
} from "./verification.js";
import { makeObservation } from "./test-fixtures.js";

describe("cross-source verification", () => {
  it("verifies two independent sources within 1 percent", () => {
    const result = verifyObservations([
      makeObservation({ observationId: "eastmoney", value: "100" }),
      makeObservation({
        observationId: "cninfo",
        value: "100.5",
        upstreamSourceId: "cninfo",
        sourceType: "official",
      }),
    ]);
    expect(result.status).toBe("verified");
    expect(result.discrepancyPercent).toBe("0.5");
  });

  it("warns for one real upstream despite two providers", () => {
    const result = verifyObservations([
      makeObservation({ providerId: "eastmoney-direct", upstreamSourceId: "eastmoney" }),
      makeObservation({ providerId: "legacy-akshare", upstreamSourceId: "eastmoney" }),
    ]);
    expect(result.status).toBe("warning");
    expect(result.reasonCodes).toContain("SINGLE_INDEPENDENT_SOURCE");
  });

  it("warns between 1 and 5 percent", () => {
    const result = verifyObservations([
      makeObservation({ value: "100" }),
      makeObservation({ value: "103", upstreamSourceId: "cninfo" }),
    ]);
    expect(result.status).toBe("warning");
    expect(result.usable).toBe(true);
  });

  it("fails above 5 percent without official adjudication", () => {
    const result = verifyObservations([
      makeObservation({ value: "100" }),
      makeObservation({ value: "110", upstreamSourceId: "tushare" }),
    ]);
    expect(result.status).toBe("failed");
    expect(result.usable).toBe(false);
  });

  it("uses the official value but preserves a material conflict", () => {
    const result = verifyObservations([
      makeObservation({ observationId: "eastmoney", value: "100" }),
      makeObservation({
        observationId: "cninfo",
        value: "110",
        upstreamSourceId: "cninfo",
        sourceType: "official",
      }),
    ]);
    expect(result).toMatchObject({
      status: "warning",
      usable: true,
      chosenObservationId: "cninfo",
      reasonCodes: ["OFFICIAL_OVERRIDE_SOURCE_CONFLICT"],
    });
  });

  it("materializes the chosen observation at canonical scale", () => {
    const fact = verifyAndMaterializeFact([
      makeObservation({
        observationId: "eastmoney",
        value: "100",
        scale: "1000",
      }),
      makeObservation({
        observationId: "cninfo",
        value: "110",
        scale: "1000",
        upstreamSourceId: "cninfo",
        sourceType: "official",
      }),
    ]);
    expect(fact).toMatchObject({
      concept: "income.revenue",
      value: "110000",
      status: "warning",
      usable: true,
      reasonCodes: ["OFFICIAL_OVERRIDE_SOURCE_CONFLICT"],
    });
  });

  it("is independent of provider return order", () => {
    const observations = [
      makeObservation({ observationId: "eastmoney", value: "100" }),
      makeObservation({
        observationId: "cninfo",
        value: "100.5",
        upstreamSourceId: "cninfo",
        sourceType: "official",
      }),
    ];
    expect(verifyObservations(observations))
      .toEqual(verifyObservations([...observations].reverse()));
  });
});
```

- [x] **Step 2: Run verification tests and verify RED**

Run:

```bash
pnpm --filter @verified-financial/core test -- src/verification.test.ts
```

Expected: FAIL because `verifyObservations` does not exist.

- [x] **Step 3: Implement Decimal-based verification**

Create `packages/core/src/verification.ts` with:

```ts
import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import type {
  CanonicalFact,
  Observation,
  VerificationResult,
} from "@verified-financial/schema";
import { CanonicalFactSchema } from "@verified-financial/schema";
import { compareCompatibility } from "./compatibility.js";
import { independentUpstreamSourceIds } from "./independence.js";

function discrepancyPercent(left: Observation, right: Observation): Decimal {
  const leftValue = new Decimal(left.value).mul(left.scale);
  const rightValue = new Decimal(right.value).mul(right.scale);
  const denominator = Decimal.min(leftValue.abs(), rightValue.abs());
  if (denominator.isZero()) {
    return leftValue.eq(rightValue) ? new Decimal(0) : new Decimal(Infinity);
  }
  return leftValue.minus(rightValue).abs().div(denominator).mul(100);
}

function sourceRank(observation: Observation): number {
  if (observation.provenance.sourceType === "official") return 0;
  if (observation.provenance.sourceType === "first-party") return 1;
  return 2;
}

function maximumDiscrepancyPercent(
  observations: readonly Observation[],
): Decimal {
  let maximum = new Decimal(0);
  for (let left = 0; left < observations.length; left += 1) {
    for (let right = left + 1; right < observations.length; right += 1) {
      maximum = Decimal.max(
        maximum,
        discrepancyPercent(observations[left]!, observations[right]!),
      );
    }
  }
  return maximum;
}

export function verifyObservations(
  observations: readonly Observation[],
): VerificationResult {
  if (observations.length === 0) {
    throw new Error("verifyObservations requires at least one observation");
  }
  const ordered = [...observations].sort(
    (left, right) => sourceRank(left) - sourceRank(right)
      || left.provenance.upstreamSourceId.localeCompare(
        right.provenance.upstreamSourceId,
      )
      || left.observationId.localeCompare(right.observationId),
  );
  const primary = ordered[0]!;
  const incompatibleReasons = ordered.slice(1).flatMap(
    (observation) => compareCompatibility(primary, observation).reasonCodes,
  );
  const upstreams = independentUpstreamSourceIds(ordered);
  const official = ordered.find(
    (observation) => observation.provenance.sourceType === "official",
  );
  const maximum = maximumDiscrepancyPercent(ordered);

  let status: VerificationResult["status"] = "verified";
  let usable = true;
  let reasonCodes: string[] = [];
  let chosenObservationId = official?.observationId ?? primary.observationId;

  if (incompatibleReasons.length > 0) {
    status = "failed";
    usable = false;
    reasonCodes = [...new Set(incompatibleReasons)];
  } else if (upstreams.length < 2) {
    status = "warning";
    reasonCodes = ["SINGLE_INDEPENDENT_SOURCE"];
  } else if (maximum.gt(5) && official === undefined) {
    status = "failed";
    usable = false;
    reasonCodes = ["UNRESOLVED_SOURCE_CONFLICT"];
  } else if (maximum.gt(5) && official !== undefined) {
    status = "warning";
    reasonCodes = ["OFFICIAL_OVERRIDE_SOURCE_CONFLICT"];
  } else if (maximum.gt(1)) {
    status = "warning";
    reasonCodes = ["SOURCE_DISCREPANCY"];
  }

  const observationIds = ordered.map(
    (item) => item.observationId,
  ).sort();
  const verificationPayload = JSON.stringify({
    observationIds,
    status,
    chosenObservationId,
  });

  const verificationId = `vr:${createHash("sha256").update(verificationPayload).digest("hex")}`;
  return {
    verificationId,
    status,
    usable,
    observationIds,
    independentUpstreamSourceIds: upstreams,
    ...(maximum.isFinite() ? { discrepancyPercent: maximum.toString() } : {}),
    chosenObservationId,
    reasonCodes,
  };
}

export function verifyAndMaterializeFact(
  observations: readonly Observation[],
): CanonicalFact {
  const verification = verifyObservations(observations);
  const chosen = observations.find(
    (observation) =>
      observation.observationId === verification.chosenObservationId,
  );
  if (chosen === undefined) {
    throw new Error("CHOSEN_OBSERVATION_NOT_FOUND");
  }
  const value = new Decimal(chosen.value).mul(chosen.scale).toString();
  const factPayload = JSON.stringify({
    verificationId: verification.verificationId,
    chosenObservationId: chosen.observationId,
    value,
  });
  const factId = `fact:${createHash("sha256").update(factPayload).digest("hex")}`;
  return CanonicalFactSchema.parse({
    factId,
    companyId: chosen.companyId,
    ...(chosen.instrumentId === undefined
      ? {}
      : { instrumentId: chosen.instrumentId }),
    concept: chosen.concept,
    value,
    unit: chosen.unit,
    period: chosen.period,
    basis: chosen.basis,
    status: verification.status,
    usable: verification.usable,
    reasonCodes: verification.reasonCodes,
    observationIds: verification.observationIds,
    verification,
  });
}
```

- [x] **Step 4: Export and verify the engine**

Add to `packages/core/src/index.ts`:

```ts
export * from "./verification.js";
```

Run:

```bash
pnpm --filter @verified-financial/core test
pnpm --filter @verified-financial/core typecheck
```

Expected: all verification tests PASS with exact Decimal comparisons.

- [x] **Step 5: Commit verification**

```bash
git add packages/core/src
git commit -m "feat(core): verify compatible observations across sources"
```

### Task 8: Implement deterministic financial derivations

**Files:**
- Create: `packages/core/src/derivations.ts`
- Create: `packages/core/src/derivations.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing derivation tests**

Create `packages/core/src/derivations.test.ts`:

```ts
import { Decimal } from "decimal.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  deriveFreeCashFlow,
  deriveMarketCap,
  derivePe,
  deriveRoe,
  deriveTtmFlow,
} from "./derivations.js";
import { makeFact } from "./test-fixtures.js";

describe("deterministic financial derivations", () => {
  it("calculates TTM from compatible YTD facts", () => {
    const result = deriveTtmFlow({
      currentYtd: makeFact({ factId: "current", value: "80", fiscalYear: 2026, fiscalQuarter: 1, presentation: "ytd" }),
      previousAnnual: makeFact({ factId: "annual", value: "300", fiscalYear: 2025, presentation: "annual" }),
      previousYtd: makeFact({ factId: "previous", value: "70", fiscalYear: 2025, fiscalQuarter: 1, presentation: "ytd" }),
    });
    expect(result.value).toBe("310");
    expect(result.derivation).toMatchObject({
      formulaId: "ttm.flow.v1",
      inputFactIds: ["current", "annual", "previous"],
    });
  });

  it("rejects incompatible TTM inputs", () => {
    expect(() => deriveTtmFlow({
      currentYtd: makeFact({ currency: "CNY", fiscalYear: 2026, fiscalQuarter: 1, presentation: "ytd" }),
      previousAnnual: makeFact({ currency: "HKD", fiscalYear: 2025, presentation: "annual" }),
      previousYtd: makeFact({ currency: "CNY", fiscalYear: 2025, fiscalQuarter: 1, presentation: "ytd" }),
    })).toThrow("INCOMPATIBLE_DERIVATION_INPUTS");
  });

  it("defines FCF as OCF minus capex", () => {
    expect(deriveFreeCashFlow(
      makeFact({ factId: "ocf", concept: "cashFlow.operatingCashFlow", value: "120" }),
      makeFact({ factId: "capex", concept: "cashFlow.capex", value: "35" }),
    ).value).toBe("85");
  });

  it("uses average equity for ROE", () => {
    expect(deriveRoe({
      netProfit: makeFact({ factId: "profit", concept: "income.netProfitParent", value: "20" }),
      openingEquity: makeFact({
        factId: "opening",
        concept: "balance.equity",
        value: "90",
        period: { endDate: "2024-12-31", fiscalYear: 2024 },
      }),
      closingEquity: makeFact({
        factId: "closing",
        concept: "balance.equity",
        value: "110",
      }),
    }).value).toBe("0.2");
  });

  it("calculates market cap and PE without binary floats", () => {
    expect(deriveMarketCap(
      makeFact({ concept: "market.price.close", value: "10.5", unit: "CNY" }),
      makeFact({ concept: "market.shares.outstanding", value: "1000000000", unit: "shares" }),
    ).value).toBe("10500000000");
    expect(derivePe(
      makeFact({ concept: "market.price.close", value: "10.5", unit: "CNY" }),
      makeFact({
        concept: "income.epsBasic",
        value: "0.5",
        unit: "CNY-per-share",
        presentation: "ttm",
      }),
    )).toMatchObject({
      concept: "valuation.peTtm",
      value: "21",
      period: { presentation: "ttm" },
    });
  });
});
```

- [ ] **Step 2: Run derivation tests and verify RED**

Run:

```bash
pnpm --filter @verified-financial/core test -- src/derivations.test.ts
```

Expected: FAIL because the derivation functions do not exist.

- [ ] **Step 3: Implement formula-versioned derivations**

Create `packages/core/src/derivations.ts`:

```ts
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import {
  CanonicalFactSchema,
  type AccountingBasis,
  type CanonicalFact,
  type ConceptId,
  type Derivation,
  type ReportingPeriod,
} from "@verified-financial/schema";

export const FORMULAS = {
  ttmFlow: {
    formulaId: "ttm.flow.v1",
    formulaVersion: "1.0.0",
    expression: "currentYtd + previousAnnual - previousYtd",
  },
  freeCashFlow: {
    formulaId: "fcf.ocf-minus-capex.v1",
    formulaVersion: "1.0.0",
    expression: "operatingCashFlow - capex",
  },
  roe: {
    formulaId: "roe.average-equity.v1",
    formulaVersion: "1.0.0",
    expression: "netProfit / ((openingEquity + closingEquity) / 2)",
  },
  marketCap: {
    formulaId: "market-cap.price-times-shares.v1",
    formulaVersion: "1.0.0",
    expression: "price * shares",
  },
  pe: {
    formulaId: "pe.price-divided-by-eps.v1",
    formulaVersion: "1.0.0",
    expression: "price / eps",
  },
} as const;

interface DerivedFactInput {
  concept: ConceptId;
  value: Decimal;
  unit: string;
  period: ReportingPeriod;
  basis: AccountingBasis;
  inputs: CanonicalFact[];
  formula: (typeof FORMULAS)[keyof typeof FORMULAS];
}

function sameBasis(left: AccountingBasis, right: AccountingBasis): boolean {
  return left.standard === right.standard
    && left.scope === right.scope
    && left.presentation === right.presentation
    && left.attribution === right.attribution
    && left.currency === right.currency;
}

function assertUsableAndSameEntity(inputs: CanonicalFact[]): void {
  const first = inputs[0];
  if (first === undefined || inputs.some((fact) => !fact.usable)) {
    throw new Error("INCOMPATIBLE_DERIVATION_INPUTS");
  }
  const incompatible = inputs.some((fact) =>
    fact.companyId !== first.companyId
    || fact.instrumentId !== first.instrumentId
    || !sameBasis(fact.basis, first.basis));
  if (incompatible) throw new Error("INCOMPATIBLE_DERIVATION_INPUTS");
}

function derivedFact(input: DerivedFactInput): CanonicalFact {
  assertUsableAndSameEntity(input.inputs);
  const first = input.inputs[0]!;
  const inputFactIds = input.inputs.map((fact) => fact.factId);
  const observationIds = [...new Set(input.inputs.flatMap(
    (fact) => fact.observationIds,
  ))].sort();
  const independentUpstreamSourceIds = [...new Set(input.inputs.flatMap(
    (fact) => fact.verification.independentUpstreamSourceIds,
  ))].sort();
  const status = input.inputs.some((fact) => fact.status === "warning")
    ? "warning"
    : "verified";
  const reasonCodes = status === "warning"
    ? ["DERIVED_FROM_WARNING_INPUT"]
    : [];
  const derivation: Derivation = {
    formulaId: input.formula.formulaId,
    formulaVersion: input.formula.formulaVersion,
    inputFactIds,
    expression: input.formula.expression,
  };
  const digest = createHash("sha256").update(JSON.stringify({
    concept: input.concept,
    value: input.value.toString(),
    unit: input.unit,
    period: input.period,
    basis: input.basis,
    derivation,
  })).digest("hex");
  return CanonicalFactSchema.parse({
    factId: `fact:${digest}`,
    companyId: first.companyId,
    ...(first.instrumentId === undefined ? {} : { instrumentId: first.instrumentId }),
    concept: input.concept,
    value: input.value.toString(),
    unit: input.unit,
    period: input.period,
    basis: input.basis,
    status,
    usable: true,
    reasonCodes,
    observationIds,
    verification: {
      verificationId: `vr:derived:${digest}`,
      status,
      usable: true,
      observationIds,
      independentUpstreamSourceIds,
      reasonCodes,
    },
    derivation,
  });
}

function addOneDay(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function subtractOneDay(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function samePeriod(left: ReportingPeriod, right: ReportingPeriod): boolean {
  return left.kind === right.kind
    && left.startDate === right.startDate
    && left.endDate === right.endDate
    && left.fiscalYear === right.fiscalYear
    && left.fiscalQuarter === right.fiscalQuarter
    && left.presentation === right.presentation;
}

export function deriveTtmFlow(input: {
  currentYtd: CanonicalFact;
  previousAnnual: CanonicalFact;
  previousYtd: CanonicalFact;
}): CanonicalFact {
  const facts = [input.currentYtd, input.previousAnnual, input.previousYtd];
  assertUsableAndSameEntity(facts);
  const valid = facts.every((fact) => fact.concept === input.currentYtd.concept)
    && facts.every((fact) => fact.unit === input.currentYtd.unit)
    && input.currentYtd.period.presentation === "ytd"
    && input.previousAnnual.period.presentation === "annual"
    && input.previousYtd.period.presentation === "ytd"
    && input.currentYtd.period.fiscalYear === input.previousAnnual.period.fiscalYear + 1
    && input.previousAnnual.period.fiscalYear === input.previousYtd.period.fiscalYear
    && input.currentYtd.period.fiscalQuarter === input.previousYtd.period.fiscalQuarter;
  if (!valid) throw new Error("INCOMPATIBLE_DERIVATION_INPUTS");
  const value = new Decimal(input.currentYtd.value)
    .plus(input.previousAnnual.value)
    .minus(input.previousYtd.value);
  return derivedFact({
    concept: input.currentYtd.concept,
    value,
    unit: input.currentYtd.unit,
    period: {
      kind: "duration",
      startDate: addOneDay(input.previousYtd.period.endDate),
      endDate: input.currentYtd.period.endDate,
      fiscalYear: input.currentYtd.period.fiscalYear,
      ...(input.currentYtd.period.fiscalQuarter === undefined
        ? {}
        : { fiscalQuarter: input.currentYtd.period.fiscalQuarter }),
      presentation: "ttm",
    },
    basis: input.currentYtd.basis,
    inputs: facts,
    formula: FORMULAS.ttmFlow,
  });
}

export function deriveFreeCashFlow(
  operatingCashFlow: CanonicalFact,
  capex: CanonicalFact,
): CanonicalFact {
  const inputs = [operatingCashFlow, capex];
  assertUsableAndSameEntity(inputs);
  if (operatingCashFlow.concept !== "cashFlow.operatingCashFlow"
      || capex.concept !== "cashFlow.capex"
      || operatingCashFlow.unit !== capex.unit
      || !samePeriod(operatingCashFlow.period, capex.period)) {
    throw new Error("INCOMPATIBLE_DERIVATION_INPUTS");
  }
  return derivedFact({
    concept: "cashFlow.freeCashFlow",
    value: new Decimal(operatingCashFlow.value).minus(capex.value),
    unit: operatingCashFlow.unit,
    period: operatingCashFlow.period,
    basis: operatingCashFlow.basis,
    inputs,
    formula: FORMULAS.freeCashFlow,
  });
}

export function deriveRoe(input: {
  netProfit: CanonicalFact;
  openingEquity: CanonicalFact;
  closingEquity: CanonicalFact;
}): CanonicalFact {
  const inputs = [input.netProfit, input.openingEquity, input.closingEquity];
  assertUsableAndSameEntity(inputs);
  if (!["income.netProfit", "income.netProfitParent"].includes(input.netProfit.concept)
      || input.openingEquity.concept !== "balance.equity"
      || input.closingEquity.concept !== "balance.equity"
      || inputs.some((fact) => fact.unit !== input.netProfit.unit)
      || input.netProfit.period.kind !== "duration"
      || input.netProfit.period.startDate === undefined
      || input.openingEquity.period.kind !== "instant"
      || input.closingEquity.period.kind !== "instant"
      || input.openingEquity.period.endDate
        !== subtractOneDay(input.netProfit.period.startDate)
      || input.closingEquity.period.endDate !== input.netProfit.period.endDate) {
    throw new Error("INCOMPATIBLE_DERIVATION_INPUTS");
  }
  const averageEquity = new Decimal(input.openingEquity.value)
    .plus(input.closingEquity.value)
    .div(2);
  if (averageEquity.isZero()) throw new Error("INCOMPATIBLE_DERIVATION_INPUTS");
  return derivedFact({
    concept: "profitability.roe",
    value: new Decimal(input.netProfit.value).div(averageEquity),
    unit: "ratio",
    period: input.netProfit.period,
    basis: input.netProfit.basis,
    inputs,
    formula: FORMULAS.roe,
  });
}

export function deriveMarketCap(
  price: CanonicalFact,
  shares: CanonicalFact,
): CanonicalFact {
  const inputs = [price, shares];
  assertUsableAndSameEntity(inputs);
  if (price.concept !== "market.price.close"
      || shares.concept !== "market.shares.outstanding"
      || price.instrumentId === undefined
      || shares.instrumentId !== price.instrumentId
      || shares.unit !== "shares"
      || price.unit !== price.basis.currency
      || !samePeriod(price.period, shares.period)) {
    throw new Error("INCOMPATIBLE_DERIVATION_INPUTS");
  }
  return derivedFact({
    concept: "market.cap",
    value: new Decimal(price.value).mul(shares.value),
    unit: price.unit,
    period: price.period,
    basis: price.basis,
    inputs,
    formula: FORMULAS.marketCap,
  });
}

export function derivePe(
  price: CanonicalFact,
  eps: CanonicalFact,
): CanonicalFact {
  const inputs = [price, eps];
  assertUsableAndSameEntity(inputs);
  if (price.concept !== "market.price.close"
      || eps.concept !== "income.epsBasic"
      || price.instrumentId === undefined
      || eps.instrumentId !== price.instrumentId
      || eps.period.presentation !== "ttm"
      || eps.unit !== `${price.unit}-per-share`
      || eps.period.endDate !== price.period.endDate) {
    throw new Error("INCOMPATIBLE_DERIVATION_INPUTS");
  }
  const denominator = new Decimal(eps.value);
  if (denominator.isZero()) throw new Error("INCOMPATIBLE_DERIVATION_INPUTS");
  return derivedFact({
    concept: "valuation.peTtm",
    value: new Decimal(price.value).div(denominator),
    unit: "ratio",
    period: { ...price.period, presentation: "ttm" },
    basis: price.basis,
    inputs,
    formula: FORMULAS.pe,
  });
}
```

Canonical source mappings normalize capex to a positive cash outflow before
`deriveFreeCashFlow` is called; this function therefore always subtracts capex.

- [ ] **Step 4: Run focused derivation tests**

Run:

```bash
pnpm --filter @verified-financial/core test -- src/derivations.test.ts
```

Expected: all TTM, FCF, ROE, market-cap, and PE cases PASS.

- [ ] **Step 5: Add property tests for exact arithmetic**

Add the following test to `derivations.test.ts`; `Decimal` and `fc` are already
imported in Step 1:

```ts
it("TTM obeys current YTD + annual - previous YTD", () => {
  fc.assert(fc.property(
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    (current, annual, previous) => {
      const result = deriveTtmFlow({
        currentYtd: makeFact({ value: String(current), fiscalYear: 2026, fiscalQuarter: 1, presentation: "ytd" }),
        previousAnnual: makeFact({ value: String(annual), fiscalYear: 2025, presentation: "annual" }),
        previousYtd: makeFact({ value: String(previous), fiscalYear: 2025, fiscalQuarter: 1, presentation: "ytd" }),
      });
      expect(result.value).toBe(new Decimal(current).plus(annual).minus(previous).toString());
    },
  ));
});
```

- [ ] **Step 6: Export and run the core package gate**

Add to `packages/core/src/index.ts`:

```ts
export * from "./derivations.js";
```

Run:

```bash
pnpm --filter @verified-financial/core test
pnpm --filter @verified-financial/core typecheck
```

Expected: all core tests PASS.

- [ ] **Step 7: Commit derivations**

```bash
git add packages/core/src
git commit -m "feat(core): add versioned financial derivations"
```

### Task 9: Generate deterministic IDs and assemble FactSets

**Files:**
- Create: `packages/core/src/ids.ts`
- Create: `packages/core/src/ids.test.ts`
- Create: `packages/core/src/fact-set.ts`
- Create: `packages/core/src/fact-set.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing canonical-hash tests**

Create `packages/core/src/ids.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canonicalJson, stableId } from "./ids.js";

describe("deterministic IDs", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } }))
      .toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  it("produces the same ID for semantically identical objects", () => {
    expect(stableId("fs", { b: 2, a: 1 }))
      .toBe(stableId("fs", { a: 1, b: 2 }));
  });

  it("rejects values that JSON cannot represent", () => {
    expect(() => canonicalJson(undefined)).toThrow("UNSUPPORTED_CANONICAL_JSON");
  });
});
```

- [ ] **Step 2: Run ID tests and verify RED**

Run:

```bash
pnpm --filter @verified-financial/core test -- src/ids.test.ts
```

Expected: FAIL because `ids.ts` does not exist.

- [ ] **Step 3: Implement canonical hashing**

Create `packages/core/src/ids.ts`:

```ts
import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) {
    throw new Error("UNSUPPORTED_CANONICAL_JSON");
  }
  return serialized;
}

export function stableId(prefix: string, value: unknown): string {
  const digest = createHash("sha256").update(canonicalJson(value)).digest("hex");
  return `${prefix}:${digest}`;
}
```

- [ ] **Step 4: Write failing FactSet assembly tests**

Create `packages/core/src/fact-set.test.ts`:

```ts
import type { FactRequest } from "@verified-financial/schema";
import { describe, expect, it } from "vitest";
import {
  buildFactSet,
  type BuildFactSetInput,
} from "./fact-set.js";
import {
  makeFact,
  makeRequest,
  makeUnmapped,
} from "./test-fixtures.js";

function makeBuildInput(
  overrides: Partial<BuildFactSetInput> = {},
): BuildFactSetInput {
  const fact = makeFact();
  return {
    schemaVersion: "1.0.0",
    request: makeRequest(),
    generatedAt: "2026-07-26T10:00:00+08:00",
    company: {
      companyId: "company:600519",
      legalName: "贵州茅台酒股份有限公司",
      jurisdiction: "CN",
    },
    instruments: [{
      instrumentId: "XSHG:600519",
      companyId: "company:600519",
      exchangeMic: "XSHG",
      symbol: "600519",
      shareClass: "A",
      tradingCurrency: "CNY",
    }],
    facts: [fact],
    unmapped: [],
    validations: [fact.verification],
    rawSnapshotIds: ["sha256:eastmoney-direct"],
    mappingVersions: ["foundation-fixture@1.0.0"],
    validationRulesVersion: "1.0.0",
    ...overrides,
  };
}

describe("FactSet assembly", () => {
  it("fails when a required fact requirement has no usable fact", () => {
    const factSet = buildFactSet(makeBuildInput({
      request: makeRequest([
        {
          conceptId: "income.revenue",
          required: true,
          period: { fiscalYear: 2025, presentation: "annual" },
        },
        {
          conceptId: "income.netProfitParent",
          required: true,
          period: { fiscalYear: 2025, presentation: "annual" },
        },
      ]),
      facts: [makeFact({ concept: "income.revenue", status: "verified", usable: true })],
    }));
    expect(factSet.summary.overallStatus).toBe("failed");
    expect(factSet.summary.failed).toBe(1);
  });

  it("warns when optional output is unresolved", () => {
    const factSet = buildFactSet(makeBuildInput({
      request: makeRequest([
        {
          conceptId: "income.revenue",
          required: true,
          period: { fiscalYear: 2025, presentation: "annual" },
        },
        {
          conceptId: "balance.cash",
          required: false,
          period: { fiscalYear: 2025, presentation: "annual" },
        },
      ]),
      facts: [makeFact({ concept: "income.revenue", status: "verified", usable: true })],
      unmapped: [makeUnmapped({ rawField: "MONETARYFUNDS" })],
    }));
    expect(factSet.summary.overallStatus).toBe("warning");
  });

  it("matches every requested period independently", () => {
    const factSet = buildFactSet(makeBuildInput({
      request: makeRequest([
        {
          conceptId: "income.revenue",
          required: true,
          period: { fiscalYear: 2024, presentation: "annual" },
        },
        {
          conceptId: "income.revenue",
          required: true,
          period: { fiscalYear: 2025, presentation: "annual" },
        },
      ]),
      facts: [makeFact({
        concept: "income.revenue",
        fiscalYear: 2025,
        presentation: "annual",
      })],
    }));
    expect(factSet.summary.overallStatus).toBe("failed");
    expect(factSet.summary.failed).toBe(1);
  });

  it("is reproducible across generatedAt values", () => {
    const input = makeBuildInput();
    const first = buildFactSet({ ...input, generatedAt: "2026-07-26T10:00:00+08:00" });
    const second = buildFactSet({ ...input, generatedAt: "2026-07-26T11:00:00+08:00" });
    expect(first.factSetId).toBe(second.factSetId);
  });

  it("normalizes unordered collections before hashing", () => {
    const revenue = makeFact({ factId: "fact:revenue" });
    const cash = makeFact({
      factId: "fact:cash",
      observationId: "obs:cash",
      concept: "balance.cash",
    });
    const requirements: FactRequest["requirements"] = [
      {
        conceptId: "income.revenue",
        required: true,
        period: { fiscalYear: 2025, presentation: "annual" },
      },
      {
        conceptId: "balance.cash",
        required: false,
        period: { fiscalYear: 2025, presentation: "annual" },
      },
    ];
    const first = buildFactSet(makeBuildInput({
      request: makeRequest([...requirements]),
      facts: [revenue, cash],
      validations: [revenue.verification, cash.verification],
      rawSnapshotIds: ["sha256:b", "sha256:a", "sha256:b"],
    }));
    const second = buildFactSet(makeBuildInput({
      request: makeRequest([...requirements].reverse()),
      facts: [cash, revenue],
      validations: [cash.verification, revenue.verification],
      rawSnapshotIds: ["sha256:a", "sha256:b"],
    }));
    expect(first.factSetId).toBe(second.factSetId);
    expect(second.facts.map((fact) => fact.factId))
      .toEqual(["fact:cash", "fact:revenue"]);
  });

  it("returns a failed machine-readable empty FactSet", () => {
    const factSet = buildFactSet(makeBuildInput({
      facts: [],
      validations: [],
      rawSnapshotIds: [],
    }));
    expect(factSet).toMatchObject({
      reasonCodes: ["EMPTY_FACT_SET"],
      summary: { overallStatus: "failed" },
    });
  });
});
```

- [ ] **Step 5: Implement FactSet assembly**

Create `packages/core/src/fact-set.ts` with:

```ts
import {
  VerifiedFactSetSchema,
  type CanonicalFact,
  type Company,
  type FactRequirement,
  type FactRequest,
  type Instrument,
  type UnmappedObservation,
  type VerificationResult,
  type VerifiedFactSet,
} from "@verified-financial/schema";
import { CONCEPT_REGISTRY_VERSION } from "@verified-financial/schema";
import { canonicalJson, stableId } from "./ids.js";
import { FORMULAS } from "./derivations.js";

export interface BuildFactSetInput {
  schemaVersion: string;
  request: FactRequest;
  generatedAt: string;
  company: Company;
  instruments: Instrument[];
  facts: CanonicalFact[];
  unmapped: UnmappedObservation[];
  validations: VerificationResult[];
  rawSnapshotIds: string[];
  mappingVersions: string[];
  validationRulesVersion: string;
}

function matchesRequirement(
  fact: CanonicalFact,
  requirement: FactRequirement,
): boolean {
  if (fact.concept !== requirement.conceptId) {
    return false;
  }
  if (requirement.period === undefined) {
    return true;
  }
  return fact.period.fiscalYear === requirement.period.fiscalYear
    && fact.period.presentation === requirement.period.presentation
    && fact.period.fiscalQuarter === requirement.period.fiscalQuarter;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function buildFactSet(input: BuildFactSetInput): VerifiedFactSet {
  const normalizedRequest: FactRequest = {
    ...input.request,
    requirements: [...input.request.requirements].sort(
      (left, right) => canonicalJson(left).localeCompare(canonicalJson(right)),
    ),
  };
  const facts = [...input.facts].sort(
    (left, right) => left.factId.localeCompare(right.factId),
  );
  const unmapped = [...input.unmapped].sort(
    (left, right) => left.unmappedId.localeCompare(right.unmappedId),
  );
  const validations = [...input.validations].sort(
    (left, right) => left.verificationId.localeCompare(right.verificationId),
  );
  const instruments = [...input.instruments].sort(
    (left, right) => left.instrumentId.localeCompare(right.instrumentId),
  );
  const rawSnapshotIds = sortedUnique(input.rawSnapshotIds);
  const mappingVersions = sortedUnique(input.mappingVersions);
  const missingRequired = normalizedRequest.requirements.filter(
    (requirement) => requirement.required
      && !facts.some(
        (fact) => fact.usable && matchesRequirement(fact, requirement),
      ),
  );
  const verified = facts.filter((fact) => fact.status === "verified").length;
  const warnings = facts.filter((fact) => fact.status === "warning").length;
  const failedFacts = facts.filter((fact) => fact.status === "failed").length;
  const missingWithoutFact = missingRequired.filter(
    (requirement) => !facts.some(
      (fact) => matchesRequirement(fact, requirement),
    ),
  ).length;
  const failed = failedFacts + missingWithoutFact;
  const hasOptionalGap = unmapped.length > 0
    || normalizedRequest.requirements.some(
      (requirement) => !requirement.required
        && !facts.some(
          (fact) => fact.usable && matchesRequirement(fact, requirement),
        ),
    );
  const isEmpty = facts.length === 0;
  const overallStatus = isEmpty || missingRequired.length > 0
    ? "failed"
    : warnings > 0 || failedFacts > 0 || hasOptionalGap
      ? "warning"
      : "verified";

  const identityPayload = {
    schemaVersion: input.schemaVersion,
    request: normalizedRequest,
    company: input.company,
    instruments,
    facts,
    unmapped,
    validations,
    rawSnapshotIds,
    conceptRegistryVersion: CONCEPT_REGISTRY_VERSION,
    mappingVersions,
    formulas: FORMULAS,
    validationRulesVersion: input.validationRulesVersion,
  };

  return VerifiedFactSetSchema.parse({
    schemaVersion: input.schemaVersion,
    factSetId: stableId("fs", identityPayload),
    request: normalizedRequest,
    generatedAt: input.generatedAt,
    company: input.company,
    instruments,
    facts,
    unmapped,
    validations,
    rawSnapshotIds,
    reasonCodes: isEmpty ? ["EMPTY_FACT_SET"] : [],
    summary: {
      verified,
      warnings,
      failed,
      unmapped: unmapped.length,
      overallStatus,
    },
  });
}
```

- [ ] **Step 6: Export and verify deterministic FactSets**

Add to `packages/core/src/index.ts`:

```ts
export * from "./fact-set.js";
export * from "./ids.js";
```

Run:

```bash
pnpm --filter @verified-financial/core test
pnpm --filter @verified-financial/core typecheck
```

Expected: all ID and FactSet tests PASS.

- [ ] **Step 7: Commit FactSet assembly**

```bash
git add packages/core/src
git commit -m "feat(core): assemble reproducible verified fact sets"
```

### Task 10: Add provider-neutral Golden Corpus and package quality gate

**Files:**
- Create: `tests/golden/foundation/verified-revenue.json`
- Create: `tests/golden/foundation/single-source-warning.json`
- Create: `tests/golden/foundation/official-conflict.json`
- Create: `tests/golden/foundation/future-publication.json`
- Create: `packages/core/src/golden.test.ts`
- Modify: `package.json`
- Modify: `packages/schema/package.json`
- Modify: `packages/core/package.json`

- [ ] **Step 1: Add provider-neutral Golden fixtures**

Create `tests/golden/foundation/verified-revenue.json`:

```json
[
  {
    "observationId": "obs:golden:verified:eastmoney",
    "companyId": "company:golden",
    "concept": "income.revenue",
    "value": "100",
    "unit": "CNY",
    "scale": "1",
    "period": {
      "kind": "duration",
      "startDate": "2025-01-01",
      "endDate": "2025-12-31",
      "fiscalYear": 2025,
      "presentation": "annual"
    },
    "basis": {
      "standard": "CAS",
      "scope": "consolidated",
      "presentation": "reported",
      "attribution": "parent",
      "currency": "CNY"
    },
    "availability": {
      "publishedAt": "2026-03-18T18:00:00+08:00",
      "fetchedAt": "2026-07-26T10:00:00+08:00"
    },
    "provenance": {
      "providerId": "eastmoney-direct",
      "upstreamSourceId": "eastmoney",
      "sourceType": "aggregator",
      "sourceUrl": "https://example.invalid/eastmoney/verified-revenue",
      "rawSnapshotId": "sha256:golden-verified-eastmoney",
      "rawField": "TOTAL_OPERATE_INCOME",
      "extractionMethod": "api",
      "fetchedAt": "2026-07-26T10:00:00+08:00",
      "transformations": []
    }
  },
  {
    "observationId": "obs:golden:verified:cninfo",
    "companyId": "company:golden",
    "concept": "income.revenue",
    "value": "100.5",
    "unit": "CNY",
    "scale": "1",
    "period": {
      "kind": "duration",
      "startDate": "2025-01-01",
      "endDate": "2025-12-31",
      "fiscalYear": 2025,
      "presentation": "annual"
    },
    "basis": {
      "standard": "CAS",
      "scope": "consolidated",
      "presentation": "reported",
      "attribution": "parent",
      "currency": "CNY"
    },
    "availability": {
      "filingDate": "2026-03-18",
      "publishedAt": "2026-03-18T20:00:00+08:00",
      "fetchedAt": "2026-07-26T10:00:00+08:00"
    },
    "provenance": {
      "providerId": "cninfo-direct",
      "upstreamSourceId": "cninfo",
      "sourceType": "official",
      "documentId": "golden-filing-verified-revenue",
      "sourceUrl": "https://example.invalid/cninfo/verified-revenue",
      "rawSnapshotId": "sha256:golden-verified-cninfo",
      "rawField": "营业收入",
      "extractionMethod": "pdf",
      "fetchedAt": "2026-07-26T10:00:00+08:00",
      "transformations": []
    }
  }
]
```

Create `tests/golden/foundation/single-source-warning.json`:

```json
[
  {
    "observationId": "obs:golden:single:eastmoney",
    "companyId": "company:golden",
    "concept": "income.revenue",
    "value": "100",
    "unit": "CNY",
    "scale": "1",
    "period": {
      "kind": "duration",
      "startDate": "2025-01-01",
      "endDate": "2025-12-31",
      "fiscalYear": 2025,
      "presentation": "annual"
    },
    "basis": {
      "standard": "CAS",
      "scope": "consolidated",
      "presentation": "reported",
      "attribution": "parent",
      "currency": "CNY"
    },
    "availability": {
      "publishedAt": "2026-03-18T18:00:00+08:00",
      "fetchedAt": "2026-07-26T10:00:00+08:00"
    },
    "provenance": {
      "providerId": "eastmoney-direct",
      "upstreamSourceId": "eastmoney",
      "sourceType": "aggregator",
      "sourceUrl": "https://example.invalid/eastmoney/single-source",
      "rawSnapshotId": "sha256:golden-single-eastmoney",
      "rawField": "TOTAL_OPERATE_INCOME",
      "extractionMethod": "api",
      "fetchedAt": "2026-07-26T10:00:00+08:00",
      "transformations": []
    }
  }
]
```

Create `tests/golden/foundation/official-conflict.json`:

```json
[
  {
    "observationId": "obs:golden:conflict:eastmoney",
    "companyId": "company:golden",
    "concept": "income.revenue",
    "value": "100",
    "unit": "CNY",
    "scale": "1",
    "period": {
      "kind": "duration",
      "startDate": "2025-01-01",
      "endDate": "2025-12-31",
      "fiscalYear": 2025,
      "presentation": "annual"
    },
    "basis": {
      "standard": "CAS",
      "scope": "consolidated",
      "presentation": "reported",
      "attribution": "parent",
      "currency": "CNY"
    },
    "availability": {
      "publishedAt": "2026-03-18T18:00:00+08:00",
      "fetchedAt": "2026-07-26T10:00:00+08:00"
    },
    "provenance": {
      "providerId": "eastmoney-direct",
      "upstreamSourceId": "eastmoney",
      "sourceType": "aggregator",
      "sourceUrl": "https://example.invalid/eastmoney/official-conflict",
      "rawSnapshotId": "sha256:golden-conflict-eastmoney",
      "rawField": "TOTAL_OPERATE_INCOME",
      "extractionMethod": "api",
      "fetchedAt": "2026-07-26T10:00:00+08:00",
      "transformations": []
    }
  },
  {
    "observationId": "obs:golden:conflict:cninfo",
    "companyId": "company:golden",
    "concept": "income.revenue",
    "value": "110",
    "unit": "CNY",
    "scale": "1",
    "period": {
      "kind": "duration",
      "startDate": "2025-01-01",
      "endDate": "2025-12-31",
      "fiscalYear": 2025,
      "presentation": "annual"
    },
    "basis": {
      "standard": "CAS",
      "scope": "consolidated",
      "presentation": "reported",
      "attribution": "parent",
      "currency": "CNY"
    },
    "availability": {
      "filingDate": "2026-03-18",
      "publishedAt": "2026-03-18T20:00:00+08:00",
      "fetchedAt": "2026-07-26T10:00:00+08:00"
    },
    "provenance": {
      "providerId": "cninfo-direct",
      "upstreamSourceId": "cninfo",
      "sourceType": "official",
      "documentId": "golden-filing-official-conflict",
      "sourceUrl": "https://example.invalid/cninfo/official-conflict",
      "rawSnapshotId": "sha256:golden-conflict-cninfo",
      "rawField": "营业收入",
      "extractionMethod": "pdf",
      "fetchedAt": "2026-07-26T10:00:00+08:00",
      "transformations": []
    }
  }
]
```

Create `tests/golden/foundation/future-publication.json`:

```json
[
  {
    "observationId": "obs:golden:future:cninfo",
    "companyId": "company:golden",
    "concept": "income.revenue",
    "value": "100.5",
    "unit": "CNY",
    "scale": "1",
    "period": {
      "kind": "duration",
      "startDate": "2025-01-01",
      "endDate": "2025-12-31",
      "fiscalYear": 2025,
      "presentation": "annual"
    },
    "basis": {
      "standard": "CAS",
      "scope": "consolidated",
      "presentation": "reported",
      "attribution": "parent",
      "currency": "CNY"
    },
    "availability": {
      "filingDate": "2026-03-20",
      "publishedAt": "2026-03-20T18:00:00+08:00",
      "fetchedAt": "2026-07-26T10:00:00+08:00"
    },
    "provenance": {
      "providerId": "cninfo-direct",
      "upstreamSourceId": "cninfo",
      "sourceType": "official",
      "documentId": "golden-filing-future-publication",
      "sourceUrl": "https://example.invalid/cninfo/future-publication",
      "rawSnapshotId": "sha256:golden-future-cninfo",
      "rawField": "营业收入",
      "extractionMethod": "pdf",
      "fetchedAt": "2026-07-26T10:00:00+08:00",
      "transformations": []
    }
  }
]
```

These fixtures use only a fictional company and `example.invalid` source URLs;
never put tokens, cookies, or live payloads in the foundation corpus.

- [ ] **Step 2: Write Golden behavior tests**

Create `packages/core/src/golden.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ObservationSchema,
  type Observation,
} from "@verified-financial/schema";
import { isAvailableAsOf } from "@verified-financial/schema";
import { verifyObservations } from "./verification.js";

function loadFixture(name: string): Observation[] {
  const path = fileURLToPath(
    new URL(`../../../tests/golden/foundation/${name}.json`, import.meta.url),
  );
  return ObservationSchema.array().parse(
    JSON.parse(readFileSync(path, "utf8")),
  );
}

describe("foundation Golden Corpus", () => {
  it("verifies compatible revenue", () => {
    expect(verifyObservations(loadFixture("verified-revenue")).status).toBe("verified");
  });

  it("warns for a single source", () => {
    expect(verifyObservations(loadFixture("single-source-warning")).status).toBe("warning");
  });

  it("preserves an official conflict", () => {
    expect(verifyObservations(loadFixture("official-conflict"))).toMatchObject({
      status: "warning",
      reasonCodes: ["OFFICIAL_OVERRIDE_SOURCE_CONFLICT"],
    });
  });

  it("excludes future publications before verification", () => {
    const asOf = "2026-03-19T23:59:59+08:00";
    const eligible = loadFixture("future-publication").filter(
      (item) => isAvailableAsOf(item.availability, asOf),
    );
    expect(eligible).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run Golden tests**

Run:

```bash
pnpm --filter @verified-financial/core test -- src/golden.test.ts
```

Expected: four Golden cases PASS.

- [ ] **Step 4: Add coverage thresholds**

Replace the root `package.json` with:

```json
{
  "name": "verified-financial-core",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "packageManager": "pnpm@8.15.6",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm --filter @verified-financial/schema build && vitest run",
    "test:coverage": "pnpm --filter @verified-financial/schema build && vitest run --coverage",
    "test:watch": "pnpm --filter @verified-financial/schema build && vitest",
    "typecheck": "pnpm -r typecheck",
    "check": "pnpm typecheck && pnpm test && pnpm build"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@vitest/coverage-v8": "^3.2.0",
    "fast-check": "^4.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

to the root scripts.

Replace `packages/schema/vitest.config.ts` with:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "schema",
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
```

Replace `packages/core/vitest.config.ts` with:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "core",
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
```

- [ ] **Step 5: Run the full foundation quality gate**

Run:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
git diff --check
```

Expected:

- all package typechecks exit 0;
- all tests pass;
- coverage meets the configured thresholds;
- both packages build ESM and declarations;
- `git diff --check` prints no errors.

- [ ] **Step 6: Verify runtime package exports**

Run:

```bash
node --input-type=module -e '
import { CONCEPT_REGISTRY } from "./packages/schema/dist/index.js";
import { stableId } from "./packages/core/dist/index.js";
if (!CONCEPT_REGISTRY["income.revenue"]) process.exit(1);
if (!stableId("test", {a: 1}).startsWith("test:")) process.exit(1);
'
```

Expected: exit code 0 with no output.

- [ ] **Step 7: Commit the Golden Corpus and quality gate**

```bash
git add package.json pnpm-lock.yaml packages tests
git commit -m "test: add foundation Golden Corpus and quality gate"
```

## Foundation completion checkpoint

Before writing or executing the storage/Gateway plan, verify:

```bash
git status --short --branch
pnpm check
pnpm test:coverage
node --input-type=module -e '
import { CONCEPT_REGISTRY } from "./packages/schema/dist/index.js";
import { stableId } from "./packages/core/dist/index.js";
console.log(CONCEPT_REGISTRY["income.revenue"].conceptId, stableId("ok", {v: 1}));
'
```

Expected:

- the worktree is clean;
- `pnpm check` passes;
- coverage thresholds pass;
- runtime output begins with `income.revenue ok:`;
- the foundation has no network, filesystem-storage, SQLite, Python, Conda,
  Tushare Token, Dexter, or AI Berkshire runtime dependency.
