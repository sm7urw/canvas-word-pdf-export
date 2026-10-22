import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "cpe-flow-"));
const out = join(dir, "flow.mjs");
execFileSync("npx", ["esbuild", "src/flow.ts", "--bundle", "--format=esm", `--outfile=${out}`], { stdio: "ignore" });
const { orderByArrows, direction } = await import(pathToFileURL(out).href);

const n = (id, x, y, extra = {}) => ({ id, type: "text", x, y, width: 100, height: 50, ...extra });
const e = (from, to, extra = {}) => ({ id: `${from}${to}`, fromNode: from, toNode: to, ...extra });
const ids = (items) => items.map((i) => i.node.id).join("");

test("follows a chain regardless of array order", () => {
  const nodes = [n("C", 600, 0), n("A", 0, 0), n("B", 300, 0)];
  assert.equal(ids(orderByArrows(nodes, [e("A", "B"), e("B", "C")])), "ABC");
});

test("branches go left-to-right and a merge waits for all parents", () => {
  const nodes = [n("A", 200, 0), n("B", 0, 200), n("C", 400, 200), n("D", 200, 400)];
  const edges = [e("A", "B"), e("A", "C", { label: "yes" }), e("B", "D"), e("C", "D", { label: "then" })];
  const items = orderByArrows(nodes, edges);
  assert.equal(ids(items), "ABCD");
  assert.equal(items[2].edgeLabel, "yes");
  assert.equal(items[3].edgeLabel, "then");
});

test("cycles do not loop forever and still include every node", () => {
  const nodes = [n("A", 0, 0), n("B", 300, 0), n("C", 600, 0)];
  assert.equal(ids(orderByArrows(nodes, [e("A", "B"), e("B", "C"), e("C", "A")])), "ABC");
});

test("an arrow only at the from-end flips the direction", () => {
  assert.deepEqual(direction(e("A", "B", { fromEnd: "arrow", toEnd: "none" })), ["B", "A"]);
  assert.deepEqual(direction(e("A", "B")), ["A", "B"]);
  const nodes = [n("A", 600, 0), n("B", 0, 0)];
  assert.equal(ids(orderByArrows(nodes, [e("A", "B", { fromEnd: "arrow", toEnd: "none" })])), "BA");
});

test("unconnected nodes are ordered by position, rows first", () => {
  const nodes = [n("D", 500, 300), n("B", 300, 5), n("A", 0, 0), n("C", 0, 300)];
  assert.equal(ids(orderByArrows(nodes, [])), "ABCD");
});

test("group title is emitted once, on the first node inside the group", () => {
  const nodes = [
    { id: "G", type: "group", x: -20, y: -20, width: 500, height: 200, label: "Part one" },
    n("A", 0, 0),
    n("B", 300, 0),
    n("C", 0, 600),
  ];
  const items = orderByArrows(nodes, [e("A", "B"), e("B", "C")]);
  assert.equal(ids(items), "ABC");
  assert.equal(items[0].groupHeading, "Part one");
  assert.equal(items[1].groupHeading, undefined);
  assert.equal(items[2].groupHeading, undefined);
});

test("edges to unknown nodes are ignored", () => {
  assert.equal(ids(orderByArrows([n("A", 0, 0)], [e("A", "X")])), "A");
});
