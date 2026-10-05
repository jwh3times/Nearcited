import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TuningSchema } from "@nearcited/shared";
import { describe, expect, it } from "vitest";

const privateTuning = fileURLToPath(new URL("../../../private/tuning.json", import.meta.url));

// Runs wherever the private companion is checked out: a maintainer's machine and the deploy
// workflow. A public clone and CI have no such file and skip it.
describe.skipIf(!existsSync(privateTuning))("private/tuning.json", () => {
  it("satisfies the tuning schema", () => {
    const result = TuningSchema.safeParse(JSON.parse(readFileSync(privateTuning, "utf8")));
    // Report the paths that failed, never the values: they are confidential.
    const problems = result.success
      ? []
      : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.code}`);
    expect(problems).toEqual([]);
  });
});
