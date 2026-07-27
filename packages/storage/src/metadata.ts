import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ProviderIssue,
  StoredSnapshotRef,
} from "@verified-financial/provider-contract";
import {
  ObservationSchema,
  VerifiedFactSetSchema,
  type CanonicalFact,
  type Observation,
  type VerifiedFactSet,
} from "@verified-financial/schema";
import Database from "better-sqlite3";

interface FactSetRow {
  fact_set_json: string;
}

interface ExplanationRow {
  fact_set_id: string;
  fact_set_json: string;
}

interface ObservationRow {
  observation_json: string;
}

export interface FactExplanation {
  factSetId: string;
  fact: CanonicalFact;
  verification: CanonicalFact["verification"];
  observations: Observation[];
  rawSnapshotIds: string[];
}

export class MetadataStore {
  readonly databasePath: string;
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        media_type TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        storage_path TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_requests (
        request_id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL,
        issues_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS companies (
        company_id TEXT PRIMARY KEY,
        company_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS instruments (
        instrument_id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        instrument_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fact_sets (
        fact_set_id TEXT PRIMARY KEY,
        fact_set_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fact_set_facts (
        fact_set_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        PRIMARY KEY (fact_set_id, fact_id)
      );
      CREATE TABLE IF NOT EXISTS observations (
        observation_id TEXT PRIMARY KEY,
        observation_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fact_observations (
        fact_id TEXT NOT NULL,
        observation_id TEXT NOT NULL,
        PRIMARY KEY (fact_id, observation_id)
      );
      CREATE TABLE IF NOT EXISTS validation_runs (
        verification_id TEXT PRIMARY KEY,
        verification_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mapping_versions (
        fact_set_id TEXT NOT NULL,
        mapping_version TEXT NOT NULL,
        PRIMARY KEY (fact_set_id, mapping_version)
      );
    `);
  }

  putSnapshot(reference: StoredSnapshotRef, storagePath: string): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO snapshots (
        snapshot_id, provider_id, source_url, media_type, fetched_at,
        byte_length, storage_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      reference.snapshotId,
      reference.providerId,
      reference.sourceUrl,
      reference.mediaType,
      reference.fetchedAt,
      reference.byteLength,
      storagePath,
    );
  }

  startProviderRequest(
    providerId: string,
    request: unknown,
    startedAt: string,
  ): number {
    const result = this.database.prepare(`
      INSERT INTO provider_requests (
        provider_id, request_json, status, issues_json, started_at
      ) VALUES (?, ?, 'running', '[]', ?)
    `).run(providerId, JSON.stringify(request), startedAt);
    return Number(result.lastInsertRowid);
  }

  finishProviderRequest(
    requestId: number,
    status: "succeeded" | "failed",
    issues: ProviderIssue[],
    completedAt: string,
  ): void {
    this.database.prepare(`
      UPDATE provider_requests
      SET status = ?, issues_json = ?, completed_at = ?
      WHERE request_id = ?
    `).run(status, JSON.stringify(issues), completedAt, requestId);
  }

  putFactSet(
    factSet: VerifiedFactSet,
    observations: readonly Observation[],
    mappingVersions: readonly string[],
  ): void {
    const parsed = VerifiedFactSetSchema.parse(factSet);
    const parsedObservations = ObservationSchema.array().parse(observations);
    const transaction = this.database.transaction(() => {
      this.database.prepare(`
        INSERT OR REPLACE INTO companies (company_id, company_json)
        VALUES (?, ?)
      `).run(parsed.company.companyId, JSON.stringify(parsed.company));
      const putInstrument = this.database.prepare(`
        INSERT OR REPLACE INTO instruments (
          instrument_id, company_id, instrument_json
        ) VALUES (?, ?, ?)
      `);
      for (const instrument of parsed.instruments) {
        putInstrument.run(
          instrument.instrumentId,
          instrument.companyId,
          JSON.stringify(instrument),
        );
      }
      this.database.prepare(`
        INSERT OR IGNORE INTO fact_sets (
          fact_set_id, fact_set_json, created_at
        ) VALUES (?, ?, ?)
      `).run(parsed.factSetId, JSON.stringify(parsed), parsed.generatedAt);
      const putFact = this.database.prepare(`
        INSERT OR IGNORE INTO fact_set_facts (fact_set_id, fact_id)
        VALUES (?, ?)
      `);
      const putFactObservation = this.database.prepare(`
        INSERT OR IGNORE INTO fact_observations (fact_id, observation_id)
        VALUES (?, ?)
      `);
      for (const fact of parsed.facts) {
        putFact.run(parsed.factSetId, fact.factId);
        for (const observationId of fact.observationIds) {
          putFactObservation.run(fact.factId, observationId);
        }
      }
      const putObservation = this.database.prepare(`
        INSERT OR REPLACE INTO observations (
          observation_id, observation_json
        ) VALUES (?, ?)
      `);
      for (const observation of parsedObservations) {
        putObservation.run(
          observation.observationId,
          JSON.stringify(observation),
        );
      }
      const putValidation = this.database.prepare(`
        INSERT OR REPLACE INTO validation_runs (
          verification_id, verification_json
        ) VALUES (?, ?)
      `);
      for (const validation of parsed.validations) {
        putValidation.run(
          validation.verificationId,
          JSON.stringify(validation),
        );
      }
      const putMappingVersion = this.database.prepare(`
        INSERT OR IGNORE INTO mapping_versions (
          fact_set_id, mapping_version
        ) VALUES (?, ?)
      `);
      for (const mappingVersion of new Set(mappingVersions)) {
        putMappingVersion.run(parsed.factSetId, mappingVersion);
      }
    });
    transaction();
  }

  getFactSet(factSetId: string): VerifiedFactSet | undefined {
    const row = this.database.prepare(`
      SELECT fact_set_json
      FROM fact_sets
      WHERE fact_set_id = ?
    `).get(factSetId) as FactSetRow | undefined;
    return row === undefined
      ? undefined
      : VerifiedFactSetSchema.parse(JSON.parse(row.fact_set_json));
  }

  explainFact(factId: string): FactExplanation | undefined {
    const row = this.database.prepare(`
      SELECT fs.fact_set_id, fs.fact_set_json
      FROM fact_sets fs
      JOIN fact_set_facts fsf ON fsf.fact_set_id = fs.fact_set_id
      WHERE fsf.fact_id = ?
      ORDER BY fs.created_at DESC, fs.fact_set_id DESC
      LIMIT 1
    `).get(factId) as ExplanationRow | undefined;
    if (row === undefined) return undefined;
    const factSet = VerifiedFactSetSchema.parse(JSON.parse(row.fact_set_json));
    const fact = factSet.facts.find((candidate) => candidate.factId === factId);
    if (fact === undefined) throw new Error("FACT_SET_INDEX_CORRUPTED");
    const observationRows = this.database.prepare(`
      SELECT o.observation_json
      FROM observations o
      JOIN fact_observations fo ON fo.observation_id = o.observation_id
      WHERE fo.fact_id = ?
      ORDER BY o.observation_id
    `).all(factId) as ObservationRow[];
    const observations = observationRows.map((observationRow) =>
      ObservationSchema.parse(JSON.parse(observationRow.observation_json))
    );
    return {
      factSetId: row.fact_set_id,
      fact,
      verification: fact.verification,
      observations,
      rawSnapshotIds: [...new Set(
        observations.map(
          (observation) => observation.provenance.rawSnapshotId,
        ),
      )].sort(),
    };
  }

  doctor(): {
    databasePath: string;
    factSetCount: number;
    snapshotCount: number;
  } {
    const factSetCount = this.database.prepare(
      "SELECT COUNT(*) AS count FROM fact_sets",
    ).get() as { count: number };
    const snapshotCount = this.database.prepare(
      "SELECT COUNT(*) AS count FROM snapshots",
    ).get() as { count: number };
    return {
      databasePath: this.databasePath,
      factSetCount: factSetCount.count,
      snapshotCount: snapshotCount.count,
    };
  }

  close(): void {
    this.database.close();
  }
}
