// Downloads the caller's image from a public HTTPS URL, safely: only port 443, only public IP addresses (checked on the
// address actually connected to, so DNS rebinding can't reach the VM's metadata service or the private network), a few
// redirects, a size cap and a deadline.

import dns from "node:dns";
import https from "node:https";
import net from "node:net";

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(address, prefix, "ipv6");

/** True for an address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]!);
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) return !/^::ffff:/i.test(address) && !blocked.check(address, "ipv6");
  return false;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** dns.lookup that refuses names resolving to any non-public address. */
function publicLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "");
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((entry) => !isPublicAddress(entry.address))) {
      return callback(Object.assign(new Error(`${hostname} does not resolve to a public address`), { code: "EBLOCKED" }), "");
    }
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("imageUrl is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new Error("imageUrl must be an https:// URL.");
  if (url.port !== "" && url.port !== "443") throw new Error("imageUrl must use the default HTTPS port.");
  if (url.username || url.password) throw new Error("imageUrl must not contain credentials.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isPublicAddress(host)) throw new Error("imageUrl must point to a public address.");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("imageUrl must point to a public host.");
  }
  return url;
}

function getOnce(url: URL, signal: AbortSignal): Promise<{ redirect?: string; data?: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        lookup: publicLookup as unknown as typeof dns.lookup,
        signal,
        headers: { "User-Agent": "instagram-grid-maker/0.1 (+Stellar agent service)", Accept: "image/*" },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          return resolve({ redirect: new URL(response.headers.location, url).toString() });
        }
        if (status !== 200) {
          response.resume();
          return reject(new Error(`imageUrl answered HTTP ${status}.`));
        }
        const type = (response.headers["content-type"] ?? "").toLowerCase();
        if (type && !type.startsWith("image/") && !type.startsWith("application/octet-stream") && !type.startsWith("binary/")) {
          response.resume();
          return reject(new Error(`imageUrl is not an image (Content-Type: ${type}).`));
        }
        const declared = Number(response.headers["content-length"] ?? "0");
        if (declared > MAX_IMAGE_BYTES) {
          response.destroy();
          return reject(new Error(`The image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_IMAGE_BYTES) {
            response.destroy();
            reject(new Error(`The image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ data: Buffer.concat(chunks) }));
        response.on("error", reject);
      },
    );
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EBLOCKED") reject(new Error("imageUrl must point to a public host."));
      else if (error.name === "AbortError") reject(new Error("Downloading imageUrl took too long."));
      else reject(new Error(`Could not download imageUrl: ${error.message}`));
    });
  });
}

export async function fetchImage(raw: string, outer?: AbortSignal): Promise<Buffer> {
  const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  let url = checkUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await getOnce(url, signal);
    if (result.data) return result.data;
    url = checkUrl(result.redirect!);
  }
  throw new Error("imageUrl redirected too many times.");
}

/** Decodes imageBase64, with or without a data: URL prefix. */
export function decodeBase64Image(value: string): Buffer {
  const body = value.replace(/^data:[^;,]*;base64,/i, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(body)) throw new Error("imageBase64 is not valid base64.");
  const data = Buffer.from(body, body.includes("-") || body.includes("_") ? "base64url" : "base64");
  if (data.length === 0) throw new Error("imageBase64 is empty.");
  return data;
}
