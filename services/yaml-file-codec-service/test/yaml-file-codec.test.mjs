import assert from "node:assert/strict";
import test from "node:test";

import { decodeYaml, encodeYaml } from "../dist/index.mjs";

test("YAML frontmatter subset round-trips nested JSON records", () => {
  const record = {
    title: "Proof paths",
    draft: false,
    tags: ["files", "markdown"],
    owner: { name: "Red Cup", active: true },
    empty: [],
  };
  assert.deepEqual(decodeYaml(encodeYaml(record)), record);
});

test("YAML decoder preserves block scalars and ISO dates as strings", () => {
  const decoded = decodeYaml("date: 2026-07-29\nsummary: |\n  First line.\n  Second line.\n");
  assert.equal(decoded.date, "2026-07-29");
  assert.equal(decoded.summary, "First line.\nSecond line.\n");
});
