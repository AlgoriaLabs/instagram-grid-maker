// Writes the quick posting guide, as Markdown, for a finished grid.

import type { GridOptions, GridResult } from "./grid.js";

export interface GuideLinks {
  tileUrl: (filename: string) => string;
  zipUrl: string;
  previewUrl: string;
  expiresAt: string;
}

const FORMAT_NOTES: Record<GridOptions["format"], string> = {
  "4:5": "4:5 portrait (1080x1350), the tallest ratio every Instagram app accepts without cropping.",
  "3:4": "3:4 portrait (1080x1440), the same shape as the profile grid's cells. If your app crops it to 4:5 on upload, make the grid again with format 4:5.",
  "1:1": "1:1 square (1080x1080).",
};

export function guideMarkdown(result: GridResult, options: GridOptions, links: GuideLinks): string {
  const g = result.geometry;
  const total = result.tiles.length;
  const rows = result.tiles
    .map((tile) => `| ${tile.postOrder} | row ${tile.row}, column ${tile.col} | [${tile.filename}](${links.tileUrl(tile.filename)}) |`)
    .join("\n");
  const map = Array.from({ length: g.rows }, (_, r) =>
    "| " + Array.from({ length: 3 }, (_, c) => `post ${result.tiles.find((t) => t.row === r + 1 && t.col === c + 1)!.postOrder}`).join(" | ") + " |",
  ).join("\n");
  const layoutNote =
    options.layout === "profile-grid"
      ? g.bleed > 0
        ? `Seamless on the **profile grid**. Instagram shows the middle ${g.visibleWidth}x${g.tileHeight} of each post there, so the outer ${g.bleed} px on each side of a tile repeat its neighbour's edge and stay hidden. Opened one by one, tiles overlap slightly at their sides; that is expected.`
        : "Seamless on the **profile grid**: the tiles have the grid's own 3:4 shape, so nothing is hidden."
      : "Seamless **edge to edge**: tiles meet at their full edges. Best for a swipeable carousel. On today's 3:4 profile grid, Instagram hides the sides of wider tiles, so the picture may not line up there.";

  return `# Your Instagram grid: ${total} posts

${result.tiles.length / 3} row${g.rows > 1 ? "s" : ""} of 3, ${FORMAT_NOTES[options.format]}

[Preview of the finished grid](${links.previewUrl}) · [All tiles as a ZIP](${links.zipUrl})

Links work until ${links.expiresAt}. Download what you need before then.

## Post in this order

Instagram puts the newest post at the top left, so start at the bottom right and finish at the top left.

| Post | Ends up at | File |
| --- | --- | --- |
${rows}

How the finished grid reads:

| Left | Middle | Right |
| --- | --- | --- |
${map}

## Steps

1. Download the tiles (the ZIP holds all of them, numbered in posting order).
2. Post \`post-1\` first as a **single photo**, not a carousel. In the crop screen, tap the expand icon so the whole
   tile is kept and Instagram doesn't crop it to a square.
3. Post the rest one by one, in number order, until \`post-${total}\` (the top left tile) is up.
4. Open your profile and check the grid against the preview.

## Tips

- **Unpin pinned posts** first: pinned posts sit at the top of the grid and push the tiles out of line. Pin nothing
  until the grid is up.
- **Post them close together**, so no other post lands in the middle. Scheduling all ${total} in Meta Business Suite,
  a minute apart, works well.
- **Don't add filters or edits** in Instagram: one edited tile breaks the seam.
- **Captions:** give the first posts a short caption, and put the main caption on the last post (top left), which is
  the one people see first.
- Each later post shifts the grid by one cell. Posting in groups of 3 keeps the picture lined up.
- ${layoutNote}
${result.warnings.length > 0 ? `\n## Notes\n\n${result.warnings.map((w) => `- ${w}`).join("\n")}\n` : ""}`;
}
