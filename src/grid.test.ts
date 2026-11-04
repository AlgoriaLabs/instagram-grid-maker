// Offline tests for the grid maths, the image cutting, the guide, the output store and the URL guard. No network.
// Run with `npm test`.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { decodeBase64Image, fetchImage, isPublicAddress } from "./fetch-image.js";
import { geometry, makeGrid, postOrder, type Format, type GridOptions, type Layout } from "./grid.js";
import { guideMarkdown } from "./guide.js";
import { OutputStore } from "./outputs.js";

/** A horizontal gradient with vertical bands: every column has a distinct colour, so seams can be checked exactly. */
async function gradient(width: number, height: number): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      data[i] = Math.round((x / (width - 1)) * 255);
      data[i + 1] = Math.round((y / (height - 1)) * 255);
      data[i + 2] = 128;
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

const base: GridOptions = { tiles: 3, format: "4:5", layout: "profile-grid", fit: "cover", focus: "center", background: "#ffffff", quality: 95 };

test("geometry: 4:5 profile grid hides 34 px each side", () => {
  const g = geometry(3, "4:5", "profile-grid");
  assert.equal(g.bleed, 34);
  assert.equal(g.visibleWidth, 1012);
  assert.equal(g.canvasWidth, 2 * 1012 + 1080);
  assert.equal(g.canvasHeight, 1350);
});

test("geometry: 3:4 has no hidden strip, edge-to-edge never has one", () => {
  assert.equal(geometry(6, "3:4", "profile-grid").bleed, 0);
  assert.equal(geometry(6, "1:1", "edge-to-edge").bleed, 0);
  assert.equal(geometry(6, "1:1", "profile-grid").visibleWidth, 810);
  assert.equal(geometry(6, "4:5", "profile-grid").canvasHeight, 2700);
});

test("post order: bottom right first, top left last", () => {
  const g = { rows: 2 as const, columns: 3 as const };
  assert.equal(postOrder(2, 3, g), 1);
  assert.equal(postOrder(2, 1, g), 3);
  assert.equal(postOrder(1, 3, g), 4);
  assert.equal(postOrder(1, 1, g), 6);
});

for (const [tiles, format, layout] of [
  [3, "4:5", "profile-grid"],
  [6, "4:5", "profile-grid"],
  [6, "3:4", "profile-grid"],
  [3, "1:1", "edge-to-edge"],
  [6, "1:1", "profile-grid"],
] as [3 | 6, Format, Layout][]) {
  test(`makeGrid: ${tiles} tiles, ${format}, ${layout}`, async () => {
    const result = await makeGrid(await gradient(3000, 2400), { ...base, tiles, format, layout });
    const g = result.geometry;
    assert.equal(result.tiles.length, tiles);
    assert.deepEqual(result.tiles.map((t) => t.postOrder), Array.from({ length: tiles }, (_, i) => i + 1));
    for (const tile of result.tiles) {
      const meta = await sharp(tile.data).metadata();
      assert.equal(meta.format, "jpeg");
      assert.equal(meta.width, g.tileWidth);
      assert.equal(meta.height, g.tileHeight);
    }
    // Seam check: the last visible column of a tile and the first visible column of its right neighbour are adjacent
    // canvas columns, so their red values differ by about one gradient step.
    const step = 255 / g.canvasWidth;
    for (const tile of result.tiles.filter((t) => t.col < 3)) {
      const right = result.tiles.find((t) => t.row === tile.row && t.col === tile.col + 1)!;
      const a = await sharp(tile.data).extract({ left: g.bleed + g.visibleWidth - 1, top: 100, width: 1, height: 1 }).raw().toBuffer();
      const b = await sharp(right.data).extract({ left: g.bleed, top: 100, width: 1, height: 1 }).raw().toBuffer();
      assert.ok(Math.abs(a[0]! - b[0]!) <= step + 3, `seam between col ${tile.col} and ${tile.col + 1}: ${a[0]} vs ${b[0]}`);
    }
    const preview = await sharp(result.preview).metadata();
    assert.equal(preview.width, 1080);
  });
}

test("makeGrid warns about upscaling and refuses non-images", async () => {
  const small = await makeGrid(await gradient(300, 200), base);
  assert.ok(small.warnings.some((w) => w.includes("enlarged")));
  await assert.rejects(makeGrid(Buffer.from("not an image"), base), /not an image/);
});

test("guide lists every tile in order, with links", async () => {
  const result = await makeGrid(await gradient(3000, 2400), { ...base, tiles: 6 });
  const md = guideMarkdown(result, { ...base, tiles: 6 }, {
    tileUrl: (name) => `https://x.test/files/t/${name}`,
    zipUrl: "https://x.test/z.zip",
    previewUrl: "https://x.test/p.jpg",
    expiresAt: "2026-01-01T00:00:00.000Z",
  });
  assert.match(md, /# Your Instagram grid: 6 posts/);
  assert.match(md, /\| 1 \| row 2, column 3 \| \[post-1-of-6_row2-col3\.jpg\]/);
  assert.match(md, /\| 6 \| row 1, column 1 \|/);
  assert.match(md, /Unpin pinned posts/);
});

test("output store saves, serves and refuses traversal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grid-out-"));
  try {
    const store = new OutputStore(dir, "https://x.test", 3600);
    const saved = await store.save([{ name: "a.jpg", data: Buffer.from([1, 2, 3]) }]);
    await store.add(saved.token, [{ name: "guide.md", data: "# hi" }]);
    assert.equal(saved.url("a.jpg"), `https://x.test/files/${saved.token}/a.jpg`);
    const ok = await store.serve(new Request(`http://localhost/files/${saved.token}/a.jpg`));
    assert.equal(ok?.status, 200);
    assert.equal(ok?.headers.get("content-type"), "image/jpeg");
    const md = await store.serve(new Request(`http://localhost/files/${saved.token}/guide.md`));
    assert.equal(await md?.text(), "# hi");
    assert.equal((await store.serve(new Request(`http://localhost/files/${saved.token}/..%2Fx`)))?.status, 404);
    assert.equal((await store.serve(new Request("http://localhost/files/short/a.jpg")))?.status, 404);
    assert.equal(await store.serve(new Request("http://localhost/.well-known/x")), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("URL guard: only public addresses, only https", async () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "172.20.0.1", "100.64.1.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(address), true, address);
  await assert.rejects(fetchImage("http://example.com/a.jpg"), /https/);
  await assert.rejects(fetchImage("https://169.254.169.254/latest"), /public/);
  await assert.rejects(fetchImage("https://[::1]/a.jpg"), /public/);
  await assert.rejects(fetchImage("https://localhost/a.jpg"), /public/);
  await assert.rejects(fetchImage("https://example.com:8443/a.jpg"), /port/);
});

test("base64 decoding accepts data URLs and refuses junk", () => {
  assert.deepEqual(decodeBase64Image("data:image/png;base64,AQID"), Buffer.from([1, 2, 3]));
  assert.deepEqual(decodeBase64Image("AQID"), Buffer.from([1, 2, 3]));
  assert.throws(() => decodeBase64Image("@@@"), /base64/);
});
