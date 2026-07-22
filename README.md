<img height=90 src="./src/assets/logo.svg" alt="Ownly" />

Secure decentralized workspace built over the [Named Data Networking](https://named-data.net) stack.

[![ci](https://github.com/pulsejet/ownly/actions/workflows/ci.yml/badge.svg)](https://github.com/pulsejet/ownly/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Website](https://img.shields.io/website?url=https%3A%2F%2Fownly.work)](https://ownly.work)

---

## dns-call-notification-agent

Features **automatic DNS-based agent authentication** for Ownly agents. The original `call-notification-agent` authenticated via a user's email identity. This version enables agents to autonomously prove ownership of a domain name by completing the NDNcert DNS challenge — with no human involvement.

All DNS-authentication work lives on the [`dns-challenge`](https://github.com/j3llery/dns-call-notification-agent/tree/dns-challenge) branch of [@j3llery/dns-call-notification-agent](https://github.com/j3llery/dns-call-notification-agent/tree/dns-challenge).

---

## How to Use dns-call-notification-agent

### Prerequisites

Your agent needs:
- A **domain name** whose DNS records you can manage programmatically.
- Access to your DNS provider's API.

**UCLA CS users:** You can use the BIND 9 server and `dns-api` service already configured for Ownly agent domains. This works whether your agent is hosted on a campus server or externally (e.g., your home machine).

**Non-UCLA users:** You will need a third-party DNS provider with API access (e.g., Cloudflare, AWS Route 53, Namecheap). See [Case 3](#case-3-external-agent-with-third-party-dns) below.

---

### Step 0: Clone the Repo and Create `.env`

```bash
git clone https://github.com/j3llery/dns-call-notification-agent
cd dns-call-notification-agent
git checkout dns-challenge
cp .env.example .env
```

---

### Step 1: Modify the Agent as You Desire

```bash
# Agent logic
./src/node/headless_dns.ts    # main agent script — modify for your use case
./.env                        # fill in with your agent's credentials and config

# DNS provider
./src/node/providers/         # define DNSProvider for your DNS API here
./src/node/providers/bind9.ts # use this if you are using the UCLA BIND 9 server
```

#### Core Logic Components (Keep These)

`headless_dns.ts` contains the weekly call notification agent as an example. When adapting it:

- **`initEnvironment()`** — connects the agent to the NDN testbed and completes the NDNcert DNS challenge. This is where the `DnsProvider` is used. **Keep this.**
- **`startHttpServer()`** — listens for HTTP POST requests (workspace invites). This is the only way to add agents to workspaces, by design, to keep the process synchronized with a human user. **Keep this.**
- All other functions are either helpers or specific to the weekly-call use case — modify freely.

#### Environment Variables (`.env`)

| Variable              | Description |
|-----------------------|-------------|
| `AGENT_EMAIL`         | Gmail address used to send notification emails. |
| `AGENT_EMAIL_PASSWORD`| Gmail app password. |
| `MAIL_TO`             | Primary recipient address. |
| `MAIL_BCC`            | BCC recipient (listserv address). |
| `DNS_API_URL`         | Base URL for `dns-api` (e.g., `https://bruins.cs.ucla.edu`). UCLA users only. |
| `DNS_API_SECRET`      | Shared HMAC secret for `dns-api`. UCLA users only. See note below on obtaining this. |
| `AGENT_DNS_NAME`      | Your agent's **unique** DNS name under `ownly.named-data.net` (e.g., `your-agent.ownly.named-data.net`). The deployed email agent uses `email-agent.ownly.named-data.net`. **Every agent must have a distinct name.** |
| `AGENT_PORT`          | Port for the agent's HTTP invite server. **Must be unique per machine** — no two agents on the same host can share a port (e.g., `3000`, `3001`, …). |

> **UCLA users — obtaining `DNS_API_SECRET`:**
> `dns-api` uses a single shared HMAC secret to authenticate all agents.
> To get the secret value, contact whoever administers the Ownly infrastructure on `bruins.cs.ucla.edu`.
> Note: because all agents currently share one secret, anyone with `DNS_API_SECRET` can make
> authenticated requests to `dns-api`. Per-agent secrets are a known improvement for future work.

---

### Step 2: Build and Deploy the Agent

#### Case 1 & 3 — Without Docker (External Agent)

```bash
npm install
npx tsx --tsconfig tsconfig.headless.json src/node/headless_dns.ts
```

#### Case 2 — With Docker (Internal/Containerized Agent)

1. Create a `Dockerfile` and `docker-compose.yml` in the repo root (see example below).
2. Build and run:

```bash
docker build -t dns-call-agent .
docker compose up -d
```

3. **Ask the `bruins` admin to add an nginx location block** for your agent (see below) — this is required so workspace invites from outside can reach your container.

**Example `Dockerfile`:**
```dockerfile
FROM node:23-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npx", "tsx", "--tsconfig", "tsconfig.headless.json", "src/node/headless_dns.ts"]
```

**Example `docker-compose.yml`:**
```yaml
services:
  agent:
    build: .
    env_file: .env
    restart: unless-stopped
    ports:
      - "${AGENT_PORT}:${AGENT_PORT}"
```

**nginx location block (must be added by the `bruins` admin):**

Workspace invites arrive from outside as HTTP POST requests to `https://bruins.cs.ucla.edu/agents/<your-agent-name>/agent`. nginx must be configured to proxy these to your container's port. The pattern used in `/etc/nginx/sites-enabled/dns-api` is:

```nginx
location /agents/your-agent-name/ {
    proxy_pass http://127.0.0.1:YOUR_AGENT_PORT/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

For example, the deployed email agent uses:
```nginx
location /agents/email-agent/ {
    proxy_pass http://127.0.0.1:3000/;
    ...
}
```
so its invite endpoint is `https://bruins.cs.ucla.edu/agents/email-agent/agent`.

Each new containerized agent needs its own block like this added and nginx reloaded (`sudo nginx -s reload`). The agent name in the location path should match the subdomain portion of its `AGENT_DNS_NAME` (e.g., `email-agent` for `email-agent.ownly.named-data.net`).

---

## Agent Cases

### Case 1: External Agent with UCLA DNS

Agent hosted off-campus; DNS managed via UCLA BIND 9 server and `dns-api`.

- Uses `Bind9DnsProvider` (`src/node/providers/bind9.ts`).
- Requires `DNS_API_URL` and `DNS_API_SECRET` in `.env`.
- Communicates with `dns-api` over HTTPS (TLS reverse proxy on `bruins.cs.ucla.edu:443`).

### Case 2: Internal/Containerized Agent with UCLA DNS

Agent containerized on `bruins.cs.ucla.edu` (same server as BIND 9).

- Uses `Bind9DnsProvider` with `DNS_API_URL` pointing to `localhost`.
- TLS is not needed for DNS updates — that traffic stays on localhost to `dns-api`.
- Each container must map a **different host port** for `AGENT_PORT`. If two containers both tried to bind port `3000` on the host, the second would fail to start. Use distinct ports (e.g., `3000`, `3001`) and expose them accordingly in `docker-compose.yml`.
- **Workspace invites require nginx routing.** Invites arrive on port 443 and nginx must proxy them to your container's port. A new `location /agents/<name>/` block must be added to the nginx config on `bruins` for each new agent — see the Docker deployment section above for the exact pattern.

### Case 3: External Agent with Third-Party DNS

Agent hosted anywhere, using any DNS provider.

- Define a new class in `src/node/providers/` that implements `DnsProvider`.
- See [`src/node/DNS_PROVIDER_DOCS.md`](src/node/DNS_PROVIDER_DOCS.md) for the interface spec and an example implementation.

---

## Key Files

| File | Description |
|------|-------------|
| `src/node/headless_dns.ts` | Main agent script with DNS authentication. |
| `src/node/dns-provider.ts` | `DnsProvider` TypeScript interface. |
| `src/node/providers/bind9.ts` | `Bind9DnsProvider` implementation for UCLA `dns-api`. |
| `src/node/DNS_PROVIDER_DOCS.md` | Documentation for the `DnsProvider` interface and how to implement custom providers. |
| `dns-api/main.go` | Go HTTP service for authenticated BIND 9 updates. |
| `dns-api/DOCS.md` | Full API documentation for `dns-api`. |

---

## dns-api

`dns-api` is a Go HTTP service running on `bruins.cs.ucla.edu` that provides a secure interface for BIND 9 dynamic DNS updates. See [`dns-api/DOCS.md`](dns-api/DOCS.md) for full documentation.

**Quick overview:**

- Agents send HMAC-signed POST/DELETE requests to `/txt` to insert or delete DNS TXT records.
- The service validates HMAC signatures, checks nonce/timestamp for replay protection, sanitizes inputs, and calls `nsupdate` with a TSIG key to update BIND 9.
- Runs on `127.0.0.1:8765` behind an nginx TLS reverse proxy.

---

## Development Setup (Original)

It is recommended to use [VSCode](https://code.visualstudio.com/) with the following extensions:

- [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar) for Vue 3 support.
- [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) for TypeScript linting.
- [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) for code formatting.
- [Go](https://marketplace.visualstudio.com/items?itemName=golang.Go) for Go language support.

For debugging, install the [NDN-Play Devtools](https://chromewebstore.google.com/detail/ndn-play-devtools/iknhkednlmhmcooifnplndiahiopfmnh?hl=en) and [OPFS Viewer](https://chromewebstore.google.com/detail/opfs-viewer/bebjgdnmkhibekhoijhhbdpfdddpefci) extensions.

To build the WebAssembly module, install [Go 1.23](https://go.dev/doc/install)

```sh
npm install      # install dependencies

npx tsx --tsconfig tsconfig.headless.json src/node/headless_dns.ts
npm run lint     # eslint

npm run go:wasm  # build Go WebAssembly module
```
