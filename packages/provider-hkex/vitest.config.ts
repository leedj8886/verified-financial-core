import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "provider-hkex",
    environment: "node",
  },
});
