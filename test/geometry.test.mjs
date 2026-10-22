import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Bundle the TS module to ESM for testing
const dir = mkdtempSync(join(tmpdir(), "cpe-test-"));
const out = join(dir, "geometry.mjs");
execFileSync("npx", ["esbuild", "src/geometry.ts", "--format=esm", `--outfile=${out}`], { stdio: "ignore" });
const g = await import(pathToFileURL(out).href);

const A = { x: 0, y: 0, width: 100, height: 50 };
const B = { x: 300, y: 0, width: 100, height: 50 };

test("anchor points are side midpoints", () => {
  assert.deepEqual(g.anchor(A, "right"), { x: 100, y: 25 });
  assert.deepEqual(g.anchor(A, "top"), { x: 50, y: 0 });
  assert.deepEqual(g.anchor(A, "bottom"), { x: 50, y: 50 });
  assert.deepEqual(g.anchor(A, "left"), { x: 0, y: 25 });
});

test("auto sides face each other", () => {
  assert.deepEqual(g.autoSides(A, B), ["right", "left"]);
  assert.deepEqual(g.autoSides(B, A), ["left", "right"]);
  assert.deepEqual(g.autoSides(A, { x: 0, y: 400, width: 100, height: 50 }), ["bottom", "top"]);
});

test("edge geometry: straight horizontal edge has midpoint halfway", () => {
  const e = g.edgeGeometry(A, "right", B, "left");
  assert.deepEqual(e.p0, { x: 100, y: 25 });
  assert.deepEqual(e.p3, { x: 300, y: 25 });
  assert.equal(e.mid.x, 200);
  assert.equal(e.mid.y, 25);
});

test("arrow head tip is at the target and points along dir", () => {
  const [tip, l, r] = g.arrowHead({ x: 10, y: 10 }, { x: 5, y: 0 }, 14);
  assert.deepEqual(tip, { x: 10, y: 10 });
  assert.equal(l.x, -4);
  assert.equal(r.x, -4);
  assert.equal(l.y, 10 + 7);
  assert.equal(r.y, 10 - 7);
});

test("fit layout caps huge canvases and keeps aspect ratio", () => {
  const l = g.pageLayout("fit", 28000, 14000);
  assert.equal(l.scale, 0.5);
  assert.equal(l.scaledWidth, 14000);
  assert.equal(l.scaledHeight, 7000);
});

test("A4 layout scales canvas into the printable area", () => {
  const l = g.pageLayout("a4-landscape", 3000, 1000);
  assert.ok(l.scaledWidth <= 1122 - 48);
  assert.ok(l.scaledHeight <= 793 - 48);
  assert.equal(l.pageSize, "A4 landscape");
});
