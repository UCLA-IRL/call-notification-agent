# dns-api — Documentation

`dns-api` is a lightweight HTTP service written in Go that provides a secure, authenticated interface for making dynamic DNS updates to a BIND 9 server. It is designed to run on the same server as BIND 9 (`bruins.cs.ucla.edu`) and is managed with systemd.

External agents call this API over HTTPS (via a TLS reverse proxy in front of it) to insert and delete DNS TXT records as part of the NDNcert DNS challenge during authentication with the NDN testbed.

---

## Architecture

```
External Agent
    │
    │  HMAC-signed JSON over HTTPS
    ▼
TLS Reverse Proxy (nginx, :443)
    │
    │  plain HTTP (localhost only)
    ▼
dns-api (:8765)
    │  validates HMAC, nonce, timestamp, inputs
    │
    ▼
nsupdate (subprocess)
    │  TSIG-signed dynamic DNS update
    ▼
BIND 9 (:53)
```

The service binds to `127.0.0.1` by default, so it is never directly accessible from outside the server. All external access must go through the TLS reverse proxy.

---

## Environment Variables

| Variable        | Required | Default       | Description |
|-----------------|----------|---------------|-------------|
| `HMAC_SECRET`   | Yes      | —             | Shared secret used to validate incoming HMAC-SHA256 signatures. Must match the secret used by the agent's `Bind9DnsProvider`. |
| `DNS_ZONE`      | Yes      | —             | The DNS zone managed by BIND 9 (e.g., `ownly.named-data.net`). All record names must fall within this zone. |
| `TSIG_KEY_FILE` | Yes      | —             | Path to the TSIG key file used by `nsupdate` to authenticate with BIND 9. |
| `PORT`          | No       | `8765`        | Port to listen on. |
| `BIND_ADDR`     | No       | `127.0.0.1`   | Address to bind to. Change with caution — the service is designed to sit behind a reverse proxy. |

---

## API Endpoints

### `GET /health`

Health check. Returns HTTP 200 with a JSON body.

**Response:**
```json
{"status": "ok"}
```

---

### `POST /txt` — Insert TXT Record

Inserts a DNS TXT record under the configured zone.

**Request Headers:**

| Header          | Description |
|-----------------|-------------|
| `Content-Type`  | `application/json` |
| `Authorization` | HMAC-SHA256 signature of the full request body, base64-encoded. |

**Request Body:**
```json
{
  "recordName": "_ndncert-challenge.your-agent.ownly.named-data.net",
  "value":      "some-challenge-token",
  "ttl":        60,
  "nonce":      "a1b2c3d4-...",
  "timestamp":  1710000000
}
```

| Field        | Type   | Required | Description |
|--------------|--------|----------|-------------|
| `recordName` | string | Yes      | Fully qualified record name. Must be within `DNS_ZONE`. Allowed characters: `[a-zA-Z0-9._-]`. |
| `value`      | string | Yes      | TXT record value. Allowed characters: printable ASCII excluding `"` and `\`. |
| `ttl`        | int    | No       | TTL in seconds. Defaults to 60. |
| `nonce`      | string | Yes      | UUID v4 or other unique string. Used for replay protection (rejected if seen within the last 5 minutes). |
| `timestamp`  | int64  | Yes      | Unix timestamp (seconds). Request is rejected if older than 2 minutes or more than 30 seconds in the future. |

**Responses:**

| Status | Meaning |
|--------|---------|
| `200 OK` | TXT record successfully inserted. |
| `400 Bad Request` | Missing or invalid fields. |
| `401 Unauthorized` | HMAC validation failed, replayed nonce, or timestamp out of window. |
| `500 Internal Server Error` | `nsupdate` command failed. |

---

### `DELETE /txt` — Delete TXT Record

Deletes all TXT records for the given record name within the configured zone.

**Request Headers:** Same as POST.

**Request Body:**
```json
{
  "recordName": "_ndncert-challenge.your-agent.ownly.named-data.net",
  "nonce":      "e5f6g7h8-...",
  "timestamp":  1710000060
}
```

| Field        | Type   | Required | Description |
|--------------|--------|----------|-------------|
| `recordName` | string | Yes      | Fully qualified record name to delete. Must be within `DNS_ZONE`. |
| `nonce`      | string | Yes      | Unique string for replay protection. |
| `timestamp`  | int64  | Yes      | Unix timestamp (seconds). |

**Responses:** Same as POST.

---

## Security Model

### HMAC Authentication (External Callers)

Every request must include an `Authorization` header containing an HMAC-SHA256 signature of the full request body, encoded in base64:

```
HMAC-SHA256(HMAC_SECRET, request_body_bytes)  →  base64
```

The server recomputes this and uses a constant-time comparison (`hmac.Equal`) to prevent timing attacks. Any request with a missing or incorrect signature is rejected with `401 Unauthorized`.

> **Secret distribution:** Currently, a single `HMAC_SECRET` is shared among all authorized agents. New agents must obtain this secret by contacting whoever administers the Ownly infrastructure on `bruins.cs.ucla.edu`. This is a known limitation — a future improvement would be per-agent secrets (each agent gets its own credential, which can be revoked independently).

### Replay Protection

Each request must include:
- **`nonce`**: A unique string (e.g., UUID v4). The server remembers nonces for 5 minutes; any repeated nonce is rejected.
- **`timestamp`**: Unix epoch seconds. The server rejects requests older than 2 minutes or more than 30 seconds in the future, accounting for reasonable clock skew.

Together these prevent an attacker from capturing and replaying a valid signed request.

### Input Validation and Sanitization

- `recordName` must match `^[a-zA-Z0-9._-]+$` and must be within the configured `DNS_ZONE`. This prevents path traversal or injection into `nsupdate` commands.
- `value` must contain only safe printable ASCII characters (no quotes or backslashes), preventing injection into the `nsupdate` TXT value string.
- Request bodies are capped at 4096 bytes.

### TSIG Key (BIND 9 Trust)

`nsupdate` is invoked with a `-k <keyFile>` flag pointing to a TSIG key file. BIND 9 is configured to accept dynamic updates for the Ownly zone **only** from requests signed with this key. This limits the blast radius: even if `dns-api` were compromised, an attacker could only manipulate records in the designated zone, and only through the TSIG-signed update path.

### Network Exposure

The server binds to `127.0.0.1` by default and is never directly reachable from the internet. All external traffic arrives via the nginx TLS reverse proxy, which terminates HTTPS and forwards over localhost HTTP.

---

## Building and Running

### Build

```bash
cd dns-api
go build -o dns-api-server .
```

### Run (manual)

```bash
export HMAC_SECRET="your-shared-secret"
export DNS_ZONE="ownly.named-data.net"
export TSIG_KEY_FILE="/etc/bind/Kyour-tsig-key.+ALGO+KEYTAG.key"
./dns-api-server
```

### Run (systemd)

The service is managed with systemd on `bruins.cs.ucla.edu`. A sample unit file:

```ini
[Unit]
Description=dns-api — BIND 9 Dynamic Update Service
After=network.target named.service

[Service]
Type=simple
User=dns-api
WorkingDirectory=/opt/dns-api
ExecStart=/opt/dns-api/dns-api-server
EnvironmentFile=/etc/dns-api/env
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

---

## Dependencies

- Go 1.24+
- `nsupdate` (part of BIND 9 utils, installed on the server)
- No external Go modules — standard library only (see `go.mod`)
