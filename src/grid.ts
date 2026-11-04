// The image work: fits one picture onto a 3-column canvas and cuts it into the tiles of an Instagram profile grid.
//
// Instagram's profile grid shows every post as a 3:4 cell (since January 2025), cropped from the middle of the post.
// In "profile-grid" layout the visible middle of each tile lines up with its neighbours, and the strips Instagram
// hides are taken from the neighbouring part of the picture, so the grid is seamless whatever the upload ratio.
// In "edge-to-edge" layout the tiles meet at their full edges (a seamless carousel, or the older square grid).

import sharp, { type Metadata, type OverlayOptions } from "sharp";

export const FORMATS = {
  "4:5": { width: 1080, height: 1350 },
  "3:4": { width: 1080, height: 1440 },
  "1:1": { width: 1080, height: 1080 },
} as const;

export type Format = keyof typeof FORMATS;
export type Layout = "profile-grid" | "edge-to-edge";
export type Fit = "cover" | "contain";
export type Focus = "center" | "top" | "bottom" | "left" | "right" | "attention" | "entropy";

export interface GridOptions {
  tiles: 3 | 6;
  format: Format;
  layout: Layout;
  fit: Fit;
  focus: Focus;
  /** #rrggbb: fills transparent pixels and, with fit "contain", the bars around the picture. */
  background: string;
  /** JPEG quality, 60–100. */
  quality: number;
}

export interface Tile {
  /** 1 is posted first. The last one posted ends up top left. */
  postOrder: number;
  /** 1-based, from the top left of the finished grid. */
  row: number;
  col: number;
  filename: string;
  width: number;
  height: number;
  data: Buffer;
}

export interface Geometry {
  columns: 3;
  rows: 1 | 2;
  tileWidth: number;
  tileHeight: number;
  /** The part of each tile the profile grid shows, centred in the tile. */
  visibleWidth: number;
  /** Hidden strip on each side of a tile, in pixels. */
  bleed: number;
  canvasWidth: number;
  canvasHeight: number;
}

export interface GridResult {
  geometry: Geometry;
  source: { width: number; height: number; format: string };
  tiles: Tile[];
  /** The finished grid as the profile shows it, with Instagram's thin gaps. */
  preview: Buffer;
  warnings: string[];
}

/** The profile grid's cell ratio, width / height. */
export const GRID_CELL_RATIO = 3 / 4;
/** Larger pictures are refused before they are decoded: about 100 megapixels. */
const MAX_INPUT_PIXELS = 100_000_000;

export function geometry(tiles: 3 | 6, format: Format, layout: Layout): Geometry {
  const { width, height } = FORMATS[format];
  const bleed = layout === "profile-grid" && width / height > GRID_CELL_RATIO ? Math.round((width - height * GRID_CELL_RATIO) / 2) : 0;
  const visibleWidth = width - 2 * bleed;
  const rows = tiles === 3 ? 1 : 2;
  return {
    columns: 3,
    rows,
    tileWidth: width,
    tileHeight: height,
    visibleWidth,
    bleed,
    // Tile c starts at c * visibleWidth: neighbours overlap by their hidden strips.
    canvasWidth: 2 * visibleWidth + width,
    canvasHeight: rows * height,
  };
}

/** Post order for a cell: the grid fills newest first from the top left, so the bottom right goes up first. */
export function postOrder(row: number, col: number, g: Pick<Geometry, "rows" | "columns">): number {
  const total = g.rows * g.columns;
  return total - ((row - 1) * g.columns + (col - 1));
}

export function tileFilename(order: number, total: number, row: number, col: number): string {
  return `post-${order}-of-${total}_row${row}-col${col}.jpg`;
}

export async function makeGrid(input: Buffer, options: GridOptions): Promise<GridResult> {
  const warnings: string[] = [];
  const g = geometry(options.tiles, options.format, options.layout);

  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new Error("The input is not an image this service can read. Send a JPEG, PNG, WebP, AVIF, GIF or TIFF.");
  }
  if (!meta.width || !meta.height) throw new Error("The image has no readable size.");
  // EXIF orientation 5–8 swaps width and height once the picture is turned upright.
  const turned = (meta.orientation ?? 1) >= 5;
  const source = { width: turned ? meta.height : meta.width, height: turned ? meta.width : meta.height, format: meta.format ?? "unknown" };

  const scale = options.fit === "cover"
    ? Math.max(g.canvasWidth / source.width, g.canvasHeight / source.height)
    : Math.min(g.canvasWidth / source.width, g.canvasHeight / source.height);
  if (scale > 1.25) {
    warnings.push(
      `The image (${source.width}x${source.height}) is enlarged ${scale.toFixed(1)}x to fill a ${g.canvasWidth}x${g.canvasHeight} grid, so tiles may look soft. A source of at least ${g.canvasWidth}x${g.canvasHeight} gives sharp tiles.`,
    );
  }
  const sourceRatio = source.width / source.height;
  const canvasRatio = g.canvasWidth / g.canvasHeight;
  if (options.fit === "cover" && Math.abs(sourceRatio - canvasRatio) / canvasRatio > 0.15) {
    warnings.push(
      `The image's shape (${sourceRatio.toFixed(2)}:1) differs from the grid's (${canvasRatio.toFixed(2)}:1), so part of it is cropped (focus: ${options.focus}). Use fit "contain" to keep all of it.`,
    );
  }

  const position = options.focus === "attention" ? sharp.strategy.attention : options.focus === "entropy" ? sharp.strategy.entropy : options.focus;
  const { data: canvas, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .flatten({ background: options.background })
    .resize(g.canvasWidth, g.canvasHeight, { fit: options.fit, position, background: options.background, kernel: "lanczos3" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const raw = { raw: { width: info.width, height: info.height, channels: info.channels } } as const;

  const total = g.rows * g.columns;
  const tiles: Tile[] = [];
  for (let row = 1; row <= g.rows; row++) {
    for (let col = 1; col <= g.columns; col++) {
      const data = await sharp(canvas, raw)
        .extract({ left: (col - 1) * g.visibleWidth, top: (row - 1) * g.tileHeight, width: g.tileWidth, height: g.tileHeight })
        .jpeg({ quality: options.quality, mozjpeg: true, chromaSubsampling: "4:4:4" })
        .withMetadata({ density: 72 })
        .toBuffer();
      const order = postOrder(row, col, g);
      tiles.push({ postOrder: order, row, col, filename: tileFilename(order, total, row, col), width: g.tileWidth, height: g.tileHeight, data });
    }
  }
  tiles.sort((a, b) => a.postOrder - b.postOrder);

  return { geometry: g, source, tiles, preview: await previewImage(canvas, raw, g), warnings };
}

/** The grid as the profile shows it: each tile's visible 3:4 middle, with 3 px white gaps. */
async function previewImage(canvas: Buffer, raw: { raw: { width: number; height: number; channels: 1 | 2 | 3 | 4 } }, g: Geometry): Promise<Buffer> {
  const gap = 3;
  // The cell the grid shows: the visible width, and a 3:4 slice of the height (taller tiles lose top and bottom).
  const cellHeight = Math.min(g.tileHeight, Math.round(g.visibleWidth / GRID_CELL_RATIO));
  const cropTop = Math.round((g.tileHeight - cellHeight) / 2);
  const cells: OverlayOptions[] = [];
  for (let row = 0; row < g.rows; row++) {
    for (let col = 0; col < g.columns; col++) {
      const cell = await sharp(canvas, raw)
        .extract({ left: col * g.visibleWidth + g.bleed, top: row * g.tileHeight + cropTop, width: g.visibleWidth, height: cellHeight })
        .png()
        .toBuffer();
      cells.push({ input: cell, left: col * (g.visibleWidth + gap), top: row * (cellHeight + gap) });
    }
  }
  // sharp resizes before it composites within one pipeline, so these are two steps.
  const full = await sharp({
    create: { width: 3 * g.visibleWidth + 2 * gap, height: g.rows * cellHeight + (g.rows - 1) * gap, channels: 3, background: "#ffffff" },
  })
    .composite(cells)
    .png({ compressionLevel: 1 })
    .toBuffer();
  return sharp(full).resize({ width: 1080 }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
}
