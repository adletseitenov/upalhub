import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // scripts/**: D6 (Stage5 Task1) backfill-modality.ts needs its pure logic
  // TDD-covered too — kept out of src/ (it's a standalone CLI, not app code)
  // but still exercised by `npm test`.
  test: { environment: "node", include: ["src/**/*.test.ts", "scripts/**/*.test.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
