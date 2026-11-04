// Instagram Grid Maker: a paid service on Stellar, built with the Provider Kit (Provider Standard v1).
//
// Settings come from .env: public values, and on mainnet the facilitator's API key. This service never needs a Stellar
// secret key. Paid jobs are kept in SQLite (JOB_DB_PATH), so they survive a restart, and a client that lost its
// response can still collect the result. The tiles each job makes are kept under OUTPUT_DIR and served at
// /files/<token>/<name> for as long as the job is retained [S8]. `provider-kit launch` starts this file with
// PUBLIC_ORIGIN set to the public address, to read the manifest it will serve there.

import { createProvider, httpFacilitator, listen, sqliteStore, type Provider, type ProviderConfig } from "@stellar-agent-services/provider-kit";
import { OutputStore } from "./outputs.js";
import { makeGridService } from "./services/make-grid.js";

const port = Number(process.env["PORT"] ?? "8787");
const origin = (process.env["PUBLIC_ORIGIN"] ?? `http://localhost:${port}`).replace(/\/+$/, "");
const dev = origin.startsWith("http://localhost");
// stellar:testnet takes test money; stellar:pubnet is mainnet, real USDC.
const network = (process.env["STELLAR_NETWORK"] ?? "stellar:testnet") as ProviderConfig["network"];
const payTo = process.env["PAY_TO"];
if (!payTo) throw new Error(`PAY_TO is empty: ./deploy.sh (provider-kit launch) sets up your own wallet${network === "stellar:testnet" ? ", and npm run dev makes a throwaway testnet account meanwhile" : ""}.`);
const agentId = process.env["AGENT_ID"];
const rpcUrl = process.env["SOROBAN_RPC_URL"];
const price = process.env["GRID_PRICE_USDC"] || "0.01";
/** How long finished jobs, and their files, stay retrievable [J15]. */
const retentionSeconds = 86_400;

// The facilitator verifies and settles payments: x402.org's on testnet, OpenZeppelin's on mainnet, which wants an API
// key. FACILITATOR_AUTH is sent as the Authorization header: "Bearer <key>".
const facilitatorUrl = process.env["FACILITATOR_URL"] || (network === "stellar:pubnet" ? "https://channels.openzeppelin.com/x402" : "https://x402.org/facilitator");
const facilitatorAuth = process.env["FACILITATOR_AUTH"];
if (network === "stellar:pubnet" && !facilitatorAuth && !process.env["FACILITATOR_URL"]) {
  throw new Error('FACILITATOR_AUTH is empty: get an API key at https://channels.openzeppelin.com/gen, and set FACILITATOR_AUTH="Bearer <key>" in .env.');
}

// Files live an hour longer than their job, so a result fetched at the end of retention still has working links.
const outputs = new OutputStore(process.env["OUTPUT_DIR"] ?? "./outputs", origin, retentionSeconds + 3600);

const provider = createProvider({
  baseUrl: origin,
  dev,
  network,
  payTo,
  facilitator: httpFacilitator(facilitatorUrl, { dev, ...(facilitatorAuth ? { headers: { Authorization: facilitatorAuth } } : {}) }),
  // On mainnet, search matches only this name and description: use the words buyers type.
  provider: {
    name: "Instagram Grid Maker",
    description:
      "Instagram grid maker: splits one image into a seamless 3 or 6 tile Instagram profile grid (puzzle feed, banner, carousel), sized for upload at 1080x1350 (4:5), 1080x1440 (3:4) or 1080x1080 (1:1), with posting order, a ZIP, a preview and a Markdown posting guide. Image split, crop and resize for social media.",
    dataUse: { storesInputs: false, trainsOnInputs: false },
    ...(agentId ? { agentId: Number(agentId) } : {}),
  },
  services: [makeGridService(outputs, price)],
  store: sqliteStore(process.env["JOB_DB_PATH"] ?? "./jobs.sqlite"),
  retentionSeconds,
  // Behind Caddy, the client's address is the first X-Forwarded-For entry. A paid job takes two requests.
  rateLimit: {
    requests: 60,
    windowSeconds: 60,
    key: (request) => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
  },
  // Decides payment_uncertain jobs from the chain. Testnet defaults to the public RPC; mainnet needs one.
  ...(rpcUrl ? { rpc: rpcUrl } : {}),
});

// Fails fast if the facilitator can't settle this network, and resumes jobs a restart left behind.
await provider.ready();

const landing = JSON.stringify({
  name: "Instagram Grid Maker",
  manifest: provider.manifestUrl,
  standard: "https://github.com/AlgoriaLabs/stellar-agent-services",
  // The deployed git commit, set by deploy/ship.sh: deploys wait until it shows here.
  revision: process.env.APP_REVISION || "unknown",
});

// The kit's server, with the job files and a small landing answer in front of the provider's own routes.
const site: Provider = {
  manifest: provider.manifest,
  manifestUrl: provider.manifestUrl,
  ready: () => provider.ready(),
  close: () => provider.close(),
  fetch: async (request) => {
    const file = await outputs.serve(request);
    if (file) return file;
    if (request.method === "GET" && new URL(request.url).pathname === "/") {
      return new Response(landing, { headers: { "Content-Type": "application/json" } });
    }
    return provider.fetch(request);
  },
};

const server = await listen(site, { port });
const sweep = setInterval(() => void outputs.sweep(), 3_600_000);
sweep.unref();
void outputs.sweep();

console.log(`Listening on ${origin} (${network})`);
console.log(`Manifest: ${provider.manifestUrl}`);
console.log(`payTo:    ${payTo}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void server.close().then(() => process.exit(0)));
}
