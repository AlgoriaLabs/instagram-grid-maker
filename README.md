# Instagram Grid Maker

A paid agent service on Stellar **mainnet**. Send it one image and it returns a seamless 3 or 6 tile Instagram profile
grid, sized for upload, in posting order. The result also includes a ZIP, a preview of the finished grid and a quick
Markdown posting guide. Agents and apps pay per call in USDC through x402, under
[Provider Standard v1](https://github.com/AlgoriaLabs/stellar-agent-services/blob/main/docs/provider-standard.md).

It runs free on Oracle Cloud's Always Free tier, and `./deploy.sh` takes it live with one command.

## What it does

One service, `make-grid`. It costs 0.01 USDC and is charged **only on success**: a bad URL or an unreadable image costs
nothing.

| Input | Default | Meaning |
| --- | --- | --- |
| `imageUrl` *or* `imageBase64` | | Public HTTPS URL (up to 25 MB), or base64 / a `data:` URL (about 7 MB). JPEG, PNG, WebP, AVIF, GIF, TIFF. |
| `tiles` | `3` | `3` (1 row) or `6` (2 rows) |
| `format` | `"4:5"` | `4:5` = 1080x1350, `3:4` = 1080x1440, `1:1` = 1080x1080 |
| `layout` | `"profile-grid"` | `profile-grid`: seamless on the profile's 3:4 grid. `edge-to-edge`: tiles meet at full edges (carousel). |
| `fit` | `"cover"` | `cover` crops to fill; `contain` keeps the whole image, with bars in `background` |
| `focus` | `"center"` | What `cover` keeps: `center`, `top`, `bottom`, `left`, `right`, `attention`, `entropy` |
| `background`, `quality`, `includeBase64` | `#ffffff`, `92`, `false` | Bar colour, JPEG quality, tiles inline as base64 too |

The output has `tiles` (in posting order, each with `url`, `row`, `col` and `postOrder`), `zipUrl`, `previewUrl`,
`guideUrl`, `guideMarkdown`, `settings` and `warnings`. Links stay valid for 24 hours, as long as the job does [S8].

**Why `profile-grid`.** Since 2025 Instagram's profile grid shows every post as a 3:4 crop of its middle. A plain
1080x1350 split would lose 34 px at each seam there. In this layout, each tile's visible middle lines up exactly with
its neighbours, and the hidden side strips repeat the neighbouring pixels.

**Posting order.** The newest post lands top left, so the guide numbers the tiles from the bottom right
(`post-1-of-6_row2-col3.jpg`) to the top left (`post-6-of-6_row1-col1.jpg`).

## Deploy: `./deploy.sh`

### Once, before the first deploy

1. **Oracle Cloud account** (free): sign up at <https://signup.cloud.oracle.com>. Your *home region* is where Always
   Free Ampere VMs live. Then create an API key: Console → Profile → *API keys* → *Add API key* → download the
   private key, and paste the config preview it shows into `~/.oci/config` (set `key_file=` to the downloaded `.pem`).
   Or install the OCI CLI and run `oci setup config`.
2. **Mainnet facilitator key** (free): get one at <https://channels.openzeppelin.com/gen>, then in `.env` set
   `FACILITATOR_AUTH="Bearer <key>"`. It settles payments and pays the network fees.
3. **A Stellar wallet** you already use (Freighter, xBull, Albedo, Hana, a Ledger…), with a few XLM (about 3)
   for the USDC trustline reserve and the registration fees. Its account receives the payments.
4. On this computer: Terraform 1.5+, Node.js 22.13+, `ssh`, `rsync`, `curl`.

### Then

```bash
./deploy.sh            # or: npm run deploy
```

The script:

1. **Provisions** the VM with Terraform. That covers an Ampere A1 VM (1 OCPU, 6 GB, Ubuntu 24.04), its network and a
   firewall that opens only 80, 443, and SSH from your IP. Its address is `https://<ip>.sslip.io`, so you don't need a
   domain. If one availability domain is out of A1 capacity, it tries the others.
2. **Registers** the service on Stellar mainnet with `provider-kit launch`. A page opens where **your wallet approves**,
   in one go, the USDC trustline, the Stellar 8004 registration and a verification request. It saves `PAY_TO` and
   `AGENT_ID` in `.env`. On later runs it signs nothing, unless the address changed.
3. **Ships**: it copies the code to the VM and runs `docker compose up --build` (the app plus Caddy, which gets a free
   Let's Encrypt certificate). It writes the production settings to the VM only.
4. **Checks**: it waits until the public manifest serves your agent id, then prints `provider-kit status`.

Run it again after any code change. Over SSH, or with no browser, use `./deploy.sh --no-open` and open the printed
approval link where your wallet is.

| Command | Does |
| --- | --- |
| `./deploy.sh` | Provision, register (once), build, start, check |
| `./deploy.sh status` | Where it stands: payTo, registered, live, verified, and what to do next |
| `./deploy.sh logs` | Follow the service's logs on the VM |
| `./deploy.sh ssh` | A shell on the VM |
| `./deploy.sh destroy` | Delete the VM and network. The on-chain registration stays; a new deploy re-registers the new address. |
| `./deploy.sh ci` | Once: let GitHub Actions deploy every push to `main` (below) |

### CI/CD: deploy on every push to `main`

`.github/workflows/ci-cd.yml` runs the tests on every push and pull request. When `main` passes them, it ships that
commit to the VM with `deploy/ship.sh` (the same step `./deploy.sh` uses) and waits until `https://<ip>.sslip.io/`
reports the new `revision`. You can also run it by hand from the Actions tab, on `main`.

Set it up once, after a first `./deploy.sh`, with the [GitHub CLI](https://cli.github.com) logged in (`gh auth login`)
and the repository pushed:

```bash
./deploy.sh ci
```

That does four things:

1. It makes SSH on the VM key-only.
2. It opens port 22 to GitHub's runners. Their addresses keep changing, so the port opens to everyone, and the
   `ssh_cidr` setting is saved in `terraform.tfvars`.
3. It gives GitHub Actions its own deploy key.
4. It stores the repository settings below.

| Name | Kind | What |
| --- | --- | --- |
| `DEPLOY_SSH_KEY` | secret | GitHub Actions' private key for the VM (`deploy/.secrets/github_actions_ed25519`) |
| `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS` | variables | The VM's IP and its SSH host key |
| `SERVICE_ORIGIN`, `AGENT_ID` | variables | What the live check expects |

GitHub never gets the facilitator key, the Terraform state or your wallet. The workflow only ships code. These stay
with `./deploy.sh`:

- the VM itself (Terraform);
- the Stellar registration;
- the production settings in the VM's `deploy/app.env`.

Change any of these with `./deploy.sh` on your computer. If the VM is replaced, `./deploy.sh` updates GitHub's
settings when `gh` is logged in. Otherwise, run `./deploy.sh ci` again.

To revoke GitHub Actions' access:

1. Delete the `github-actions` line from `~/.ssh/authorized_keys` on the VM (`./deploy.sh ssh`).
2. Run `gh secret delete DEPLOY_SSH_KEY`.
3. To close SSH back down to your own IP, remove `ssh_cidr` from `deploy/terraform/terraform.tfvars` and run
   `./deploy.sh`.

### Cost

| Item | Cost |
| --- | --- |
| Oracle VM, disk, network, public IP | 0: within Always Free (A1: 4 OCPU / 24 GB / 200 GB total) |
| HTTPS (sslip.io + Let's Encrypt) | 0 |
| OpenZeppelin facilitator | 0: it sponsors the fees of each payment |
| Stellar | About 3 XLM once: 0.5 XLM trustline reserve plus registration fees and reserve |

Oracle asks for a card at sign-up but doesn't charge for Always Free resources. Keep the account on the free tier, or
upgrade to Pay As You Go, which makes A1 capacity easier to get and still bills 0 inside the free limits.

### Options

Set these in `deploy/terraform/terraform.tfvars`, or as `TF_VAR_<name>` when you run the script:

| Variable | Default | Use |
| --- | --- | --- |
| `domain` | `""` | Your own hostname instead of sslip.io: point its A record at the VM's IP first |
| `instance_shape` | `VM.Standard.A1.Flex` | `VM.Standard.E2.1.Micro` (AMD, 1 GB, also free) when A1 has no capacity |
| `ocpus`, `memory_gb` | `1`, `6` | A1 size, up to 4 / 24 for free |
| `availability_domain_index` | `0` | Where to try first |
| `compartment_ocid` | the root | Compartment for all resources |

Other settings live in `.env`: `GRID_PRICE_USDC` (default `0.01`), and `SOROBAN_RPC_URL` (default
`https://mainnet.sorobanrpc.com`; an [RPC provider](https://developers.stellar.org/docs/data/apis/rpc/providers)'s
is safer for production traffic). Changing the price or the provider's name or description needs `./deploy.sh` again.

### Troubleshooting

- **`Out of host capacity`** on every availability domain: A1 is popular. Try later, or use
  `TF_VAR_instance_shape=VM.Standard.E2.1.Micro ./deploy.sh`.
- **HTTPS doesn't come up**: run `./deploy.sh logs` and look at Caddy's lines. Let's Encrypt needs ports 80 and 443
  reachable, which the security list and the VM's iptables both allow.
- **The VM was replaced** and has a new IP: `./deploy.sh` notices the new address, and your wallet approves the
  registration update once.

## Calling it

Any Provider Standard v1 client can call it, for example the payment client's CLI:

```bash
npx stellar-pay pay https://<ip>.sslip.io/.well-known/stellar-agent-services.json make-grid \
  '{"imageUrl":"https://example.com/photo.jpg","tiles":6}'
```

Agents find it in Stellar Agent Search by its name and description, after the registration.

## Develop

```bash
npm install
npm test               # offline: grid maths, seams, guide, file store, URL guard
```

Try a paid call with test money. Do it in a **copy** of the project with `STELLAR_NETWORK=stellar:testnet` and an
empty `PAY_TO` / `AGENT_ID` / `FACILITATOR_AUTH` in its `.env`, so your mainnet `.env` stays as it is:

```bash
npx provider-kit dev -- node dist/server.js          # paid to a throwaway testnet account
npx provider-kit try make-grid '{"imageUrl":"https://picsum.photos/id/1015/3200/2400","tiles":6}'
```

## Safety

- **No Stellar secret key anywhere**: the service knows only its public `PAY_TO`. Owner steps are signed in your wallet.
- **Image URLs are fetched safely**: HTTPS on port 443 only, public IP addresses only (checked on the address actually
  connected to, so the VM's metadata service and private network are unreachable), 3 redirects, 25 MB and 15 s at most.
- Inputs aren't kept. Output files sit under unguessable links, and are deleted about 25 hours after the job.
- `deploy/.secrets/` (the deploy SSH keys), Terraform state and `.env` are kept out of git. SSH on the VM takes keys
  only.

## Files

| File | What it is |
| --- | --- |
| `src/server.ts` | The provider: settings, the job database, the `/files` route in front of the kit's routes |
| `src/services/make-grid.ts` | The paid service: description, schemas, example, handler |
| `src/grid.ts` | Fitting, cutting and the preview (sharp) |
| `src/guide.ts` | The Markdown posting guide |
| `src/fetch-image.ts` | Safe download of `imageUrl`, base64 decoding |
| `src/outputs.ts` | Output files: save, serve, expire |
| `src/grid.test.ts` | Offline tests |
| `deploy.sh` | The one command |
| `deploy/ship.sh`, `deploy/rsync-exclude` | Copy, build, restart and check: used by `deploy.sh` and GitHub Actions |
| `.github/workflows/ci-cd.yml` | Tests every push; deploys `main` |
| `deploy/terraform/` | Oracle Cloud VM, network, firewall, first-boot setup |
| `deploy/docker-compose.yml`, `deploy/Caddyfile` | What runs on the VM: the app and HTTPS |
| `Dockerfile` | The app's image; jobs and files on the `/data` volume |
