// make-grid: splits one image into a 3 or 6 tile Instagram profile grid and returns the tiles, a ZIP, a preview and a
// Markdown posting guide. Charged only if it succeeds, so a bad URL or an unreadable image costs the caller nothing.
// The handler sees only the validated input, never payment data.

import { defineService } from "@stellar-agent-services/provider-kit";
import { zipSync } from "fflate";
import { decodeBase64Image, fetchImage } from "../fetch-image.js";
import { FORMATS, makeGrid, type Fit, type Focus, type Format, type GridOptions, type Layout } from "../grid.js";
import { guideMarkdown } from "../guide.js";
import type { OutputStore } from "../outputs.js";

type Input = {
  imageUrl?: string;
  imageBase64?: string;
  tiles?: 3 | 6;
  format?: Format;
  layout?: Layout;
  fit?: Fit;
  focus?: Focus;
  background?: string;
  quality?: number;
  includeBase64?: boolean;
};

type TileOut = {
  postOrder: number;
  row: number;
  col: number;
  filename: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
  base64?: string;
};

type Output = {
  tiles: TileOut[];
  zipUrl: string;
  previewUrl: string;
  guideUrl: string;
  guideMarkdown: string;
  expiresAt: string;
  settings: {
    tiles: number;
    rows: number;
    format: string;
    layout: string;
    fit: string;
    focus: string;
    tileWidth: number;
    tileHeight: number;
    visibleWidth: number;
    sourceWidth: number;
    sourceHeight: number;
    sourceFormat: string;
  };
  warnings: string[];
};

/** Base64 of a 10 MiB body, the most the standard allows [§3.1]. */
const MAX_INPUT_BYTES = 10 * 1024 * 1024;

const tileSchema = {
  type: "object",
  required: ["postOrder", "row", "col", "filename", "url", "width", "height", "bytes"],
  properties: {
    postOrder: { type: "integer", minimum: 1, maximum: 6, description: "Post the tiles in this order, 1 first" },
    row: { type: "integer", minimum: 1, maximum: 2, description: "Row in the finished grid, from the top" },
    col: { type: "integer", minimum: 1, maximum: 3, description: "Column in the finished grid, from the left" },
    filename: { type: "string", maxLength: 100 },
    url: { type: "string", format: "uri", maxLength: 300, description: "HTTPS download link, valid until expiresAt" },
    width: { type: "integer" },
    height: { type: "integer" },
    bytes: { type: "integer" },
    base64: { type: "string", contentEncoding: "base64", contentMediaType: "image/jpeg", description: "The JPEG itself, when includeBase64 was true" },
  },
};

export function makeGridService(outputs: OutputStore, price: string) {
  return defineService<Input, Output>({
    name: "make-grid",
    title: "Instagram grid maker",
    description:
      "Splits one image into a seamless 3 or 6 tile Instagram profile grid (1 or 2 rows of 3), sized for upload: 1080x1350 (4:5), 1080x1440 (3:4) or 1080x1080 (1:1). Returns each tile as a JPEG link in posting order, a ZIP, a preview of the finished grid and a short Markdown posting guide. Use it for puzzle feeds, banner grids and launch posts. Takes a public HTTPS image URL or base64 (JPEG, PNG, WebP, AVIF, GIF, TIFF; up to 25 MB by URL, about 7 MB as base64). Crops to fill by default, or letterboxes with fit \"contain\". Links last 24 hours. It does not post to Instagram.",
    price,
    charge: "on-success",
    expectedDurationSeconds: 6,
    timeoutSeconds: 25,
    maxInputBytes: MAX_INPUT_BYTES,
    capacity: { concurrency: 2, maxQueued: 20, maxQueueWaitSeconds: 20 },
    tags: ["instagram", "image", "grid", "split", "social-media", "carousel", "crop", "resize"],
    inputSchema: {
      type: "object",
      properties: {
        imageUrl: { type: "string", format: "uri", pattern: "^https://", maxLength: 2048, description: "Public HTTPS URL of the image. Give this or imageBase64." },
        imageBase64: {
          type: "string",
          contentEncoding: "base64",
          contentMediaType: "image/*",
          minLength: 16,
          maxLength: 10_400_000,
          description: "The image as base64, optionally as a data: URL. Give this or imageUrl.",
        },
        tiles: { type: "integer", enum: [3, 6], default: 3, description: "3 tiles (1 row) or 6 tiles (2 rows)" },
        format: { type: "string", enum: Object.keys(FORMATS), default: "4:5", description: "Tile shape: 4:5 is 1080x1350, 3:4 is 1080x1440, 1:1 is 1080x1080" },
        layout: {
          type: "string",
          enum: ["profile-grid", "edge-to-edge"],
          default: "profile-grid",
          description: "profile-grid: seamless on the profile's 3:4 grid, whatever the tile shape. edge-to-edge: tiles meet at their full edges, for a carousel.",
        },
        fit: { type: "string", enum: ["cover", "contain"], default: "cover", description: "cover crops to fill the grid; contain keeps the whole image, with bars" },
        focus: {
          type: "string",
          enum: ["center", "top", "bottom", "left", "right", "attention", "entropy"],
          default: "center",
          description: "What to keep when cover crops: a side, or attention / entropy for the most interesting part",
        },
        background: { type: "string", pattern: "^#[0-9a-fA-F]{6}$", default: "#ffffff", description: "Colour for bars and transparent pixels" },
        quality: { type: "integer", minimum: 60, maximum: 100, default: 92, description: "JPEG quality" },
        includeBase64: { type: "boolean", default: false, description: "Also return each tile inline as base64" },
      },
      anyOf: [{ required: ["imageUrl"] }, { required: ["imageBase64"] }],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["tiles", "zipUrl", "previewUrl", "guideUrl", "guideMarkdown", "expiresAt", "settings", "warnings"],
      properties: {
        tiles: { type: "array", minItems: 3, maxItems: 6, items: tileSchema, description: "In posting order" },
        zipUrl: { type: "string", format: "uri", description: "All tiles and the guide as one ZIP" },
        previewUrl: { type: "string", format: "uri", description: "JPEG of the finished grid as the profile shows it" },
        guideUrl: { type: "string", format: "uri", description: "The guide as a .md file" },
        guideMarkdown: { type: "string", description: "Quick posting guide, in Markdown" },
        expiresAt: { type: "string", format: "date-time", description: "When the links stop working" },
        settings: {
          type: "object",
          required: ["tiles", "rows", "format", "layout", "fit", "focus", "tileWidth", "tileHeight", "visibleWidth", "sourceWidth", "sourceHeight", "sourceFormat"],
          properties: {
            tiles: { type: "integer" },
            rows: { type: "integer" },
            format: { type: "string" },
            layout: { type: "string" },
            fit: { type: "string" },
            focus: { type: "string" },
            tileWidth: { type: "integer" },
            tileHeight: { type: "integer" },
            visibleWidth: { type: "integer", description: "Width of the part the profile grid shows" },
            sourceWidth: { type: "integer" },
            sourceHeight: { type: "integer" },
            sourceFormat: { type: "string" },
          },
        },
        warnings: { type: "array", items: { type: "string" }, description: "Upscaling or cropping notes" },
      },
    },
    examples: [
      {
        input: { imageUrl: "https://images.example.com/banner.jpg", tiles: 3, format: "4:5" },
        output: {
          tiles: [1, 2, 3].map((order) => ({
            postOrder: order,
            row: 1,
            col: 4 - order,
            filename: `post-${order}-of-3_row1-col${4 - order}.jpg`,
            url: `https://grid.example.com/files/Qm9vb2FhYWFhYWFhYWFhYQ/post-${order}-of-3_row1-col${4 - order}.jpg`,
            width: 1080,
            height: 1350,
            bytes: 412345,
          })),
          zipUrl: "https://grid.example.com/files/Qm9vb2FhYWFhYWFhYWFhYQ/instagram-grid.zip",
          previewUrl: "https://grid.example.com/files/Qm9vb2FhYWFhYWFhYWFhYQ/preview.jpg",
          guideUrl: "https://grid.example.com/files/Qm9vb2FhYWFhYWFhYWFhYQ/guide.md",
          guideMarkdown: "# Your Instagram grid: 3 posts\n\n1 row of 3 ...\n\n## Post in this order\n\n| Post | Ends up at | File |\n...",
          expiresAt: "2026-11-05T13:00:00.000Z",
          settings: {
            tiles: 3, rows: 1, format: "4:5", layout: "profile-grid", fit: "cover", focus: "center",
            tileWidth: 1080, tileHeight: 1350, visibleWidth: 1012, sourceWidth: 4000, sourceHeight: 2000, sourceFormat: "jpeg",
          },
          warnings: [],
        },
      },
    ],
    handler: async (input, { signal }) => {
      if (input.imageUrl && input.imageBase64) throw new Error("Give imageUrl or imageBase64, not both.");
      const image = input.imageUrl ? await fetchImage(input.imageUrl, signal) : decodeBase64Image(input.imageBase64!);
      signal.throwIfAborted();

      const options: GridOptions = {
        tiles: input.tiles ?? 3,
        format: input.format ?? "4:5",
        layout: input.layout ?? "profile-grid",
        fit: input.fit ?? "cover",
        focus: input.focus ?? "center",
        background: input.background ?? "#ffffff",
        quality: input.quality ?? 92,
      };
      const grid = await makeGrid(image, options);
      signal.throwIfAborted();

      // The guide links to files under a token chosen before they are written.
      const files = [...grid.tiles.map((t) => ({ name: t.filename, data: t.data })), { name: "preview.jpg", data: grid.preview }];
      const saved = await outputs.save(files);
      const guide = guideMarkdown(grid, options, {
        tileUrl: saved.url,
        zipUrl: saved.url("instagram-grid.zip"),
        previewUrl: saved.url("preview.jpg"),
        expiresAt: saved.expiresAt,
      });
      const zip = Buffer.from(
        zipSync(
          {
            "GUIDE.md": [new TextEncoder().encode(guide), { level: 6 }],
            "preview.jpg": [grid.preview, { level: 0 }],
            ...Object.fromEntries(grid.tiles.map((t) => [t.filename, [t.data, { level: 0 }]])),
          },
          { mtime: new Date() },
        ),
      );
      await outputs.add(saved.token, [{ name: "guide.md", data: guide }, { name: "instagram-grid.zip", data: zip }]);

      return {
        tiles: grid.tiles.map((t) => ({
          postOrder: t.postOrder,
          row: t.row,
          col: t.col,
          filename: t.filename,
          url: saved.url(t.filename),
          width: t.width,
          height: t.height,
          bytes: t.data.length,
          ...(input.includeBase64 ? { base64: t.data.toString("base64") } : {}),
        })),
        zipUrl: saved.url("instagram-grid.zip"),
        previewUrl: saved.url("preview.jpg"),
        guideUrl: saved.url("guide.md"),
        guideMarkdown: guide,
        expiresAt: saved.expiresAt,
        settings: {
          tiles: options.tiles,
          rows: grid.geometry.rows,
          format: options.format,
          layout: options.layout,
          fit: options.fit,
          focus: options.focus,
          tileWidth: grid.geometry.tileWidth,
          tileHeight: grid.geometry.tileHeight,
          visibleWidth: grid.geometry.visibleWidth,
          sourceWidth: grid.source.width,
          sourceHeight: grid.source.height,
          sourceFormat: grid.source.format,
        },
        warnings: grid.warnings,
      };
    },
  });
}
