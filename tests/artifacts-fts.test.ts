import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("artifact FTS config", () => {
  it("ARTIFACT_FTS_MAX_SIZE defaults to 102400", async () => {
    const { ARTIFACT_FTS_MAX_SIZE } = await import("../src/config/index.ts");
    assert.equal(ARTIFACT_FTS_MAX_SIZE, 102400);
  });
});
