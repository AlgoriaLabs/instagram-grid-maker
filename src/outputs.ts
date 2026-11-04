// Keeps each job's files (tiles, ZIP, preview, guide) on disk under an unguessable token, serves them at
// GET /files/<token>/<name>, and deletes them once they are older than the job retention, so URLs in a result stay
// valid for as long as the job does [S8].

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".md": "text/markdown; charset=utf-8",
  ".zip": "application/zip",
};

export interface OutputFile {
  name: string;
  data: Buffer | string;
}

export class OutputStore {
  constructor(
    private readonly dir: string,
    private readonly origin: string,
    /** Files are kept at least this long. */
    readonly keepSeconds: number,
  ) {}

  async save(files: OutputFile[]): Promise<{ token: string; url: (name: string) => string; expiresAt: string }> {
    const token = randomBytes(16).toString("base64url");
    const folder = path.join(this.dir, token);
    await mkdir(folder, { recursive: true });
    for (const file of files) {
      if (!NAME.test(file.name) || file.name.includes("..")) throw new Error(`bad output file name: ${file.name}`);
      await writeFile(path.join(folder, file.name), file.data);
    }
    return {
      token,
      url: (name) => `${this.origin}/files/${token}/${name}`,
      expiresAt: new Date(Date.now() + this.keepSeconds * 1000).toISOString(),
    };
  }

  /** Adds files to a folder save() made. */
  async add(token: string, files: OutputFile[]): Promise<void> {
    if (!TOKEN.test(token)) throw new Error("bad output token");
    for (const file of files) {
      if (!NAME.test(file.name) || file.name.includes("..")) throw new Error(`bad output file name: ${file.name}`);
      await writeFile(path.join(this.dir, token, file.name), file.data);
    }
  }

  /** Answers GET and HEAD /files/<token>/<name>; undefined for any other request. */
  async serve(request: Request): Promise<Response | undefined> {
    if (request.method !== "GET" && request.method !== "HEAD") return undefined;
    const match = /^\/files\/([^/]+)\/([^/]+)$/.exec(new URL(request.url).pathname);
    if (!match) return undefined;
    const [, token, name] = match as unknown as [string, string, string];
    if (!TOKEN.test(token) || !NAME.test(name) || name.includes("..")) return notFound();
    const file = path.join(this.dir, token, name);
    try {
      const info = await stat(file);
      if (!info.isFile() || Date.now() - info.mtimeMs > this.keepSeconds * 1000) return notFound();
      const type = TYPES[path.extname(name)] ?? "application/octet-stream";
      const headers = {
        "Content-Type": type,
        "Content-Length": String(info.size),
        "Cache-Control": "private, max-age=3600",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
        ...(type.startsWith("image/") ? {} : { "Content-Disposition": `attachment; filename="${name}"` }),
      };
      return new Response(request.method === "HEAD" ? null : new Uint8Array(await readFile(file)), { status: 200, headers });
    } catch {
      return notFound();
    }
  }

  /** Deletes job folders older than keepSeconds. */
  async sweep(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - this.keepSeconds * 1000;
    for (const entry of entries) {
      if (!TOKEN.test(entry)) continue;
      const folder = path.join(this.dir, entry);
      try {
        if ((await stat(folder)).mtimeMs < cutoff) await rm(folder, { recursive: true, force: true });
      } catch {
        // Gone already.
      }
    }
  }
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not_found", message: "This file does not exist or has expired." }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}
