import { z } from "zod";
import {
  VERIFIED_FACT_SET_SCHEMA_VERSION,
  VerifiedFactSetSchema,
} from "./facts.js";

export const VERIFIED_FACT_SET_JSON_SCHEMA_ID =
  `urn:verified-financial-core:schema:verified-fact-set:${VERIFIED_FACT_SET_SCHEMA_VERSION}`;

export const VERIFIED_FACT_SET_JSON_SCHEMA = Object.freeze({
  ...z.toJSONSchema(VerifiedFactSetSchema, {
    target: "draft-07",
    unrepresentable: "any",
  }),
  $id: VERIFIED_FACT_SET_JSON_SCHEMA_ID,
  title: "VerifiedFactSet",
  description:
    "Frozen, traceable financial fact package consumed by Gateway clients and Research CI.",
});

export type VerifiedFactSetJsonSchema =
  typeof VERIFIED_FACT_SET_JSON_SCHEMA;
