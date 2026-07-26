import { z } from "zod";

export const AccountingBasisSchema = z.object({
  standard: z.enum(["CAS", "IFRS", "OTHER"]),
  scope: z.enum(["consolidated", "standalone"]),
  presentation: z.enum(["reported", "adjusted"]),
  attribution: z.enum(["parent", "all-shareholders"]).optional(),
  currency: z.string().min(3).max(3),
});
export type AccountingBasis = z.infer<typeof AccountingBasisSchema>;
