# DNSProvider Interface — Documentation

This document describes the `DnsProvider` interface (`dns-provider.ts`) and the `Bind9DnsProvider` implementation (`providers/bind9.ts`) used by the DNS-authenticated agent.

---

## Overview

The `DnsProvider` interface decouples the agent's authentication logic from the underlying DNS infrastructure. Any agent that needs to complete the NDNcert DNS challenge only needs to interact with this interface — it does not need to know anything about the specific DNS provider being used.

This design supports three scenarios:
- **UCLA BIND 9 (external agent):** Use the provided `Bind9DnsProvider`, which communicates with `dns-api` over HMAC-authenticated HTTPS.
- **UCLA BIND 9 (internal/containerized agent):** Same `Bind9DnsProvider`, but communicating over localhost HTTP.
- **Third-party DNS provider:** Implement the interface yourself for your provider's API.

---

## Interface: `DnsProvider`

**File:** `src/node/dns-provider.ts`

```typescript
export interface DnsProvider {
  insertTxt(recordName: string, value: string, ttl?: number): Promise<void>;
  deleteTxt(recordName: string): Promise<void>;
}
```

### Methods

#### `insertTxt(recordName, value, ttl?)`

Inserts a DNS TXT record.

| Parameter    | Type     | Required | Description |
|--------------|----------|----------|-------------|
| `recordName` | `string` | Yes      | Fully qualified domain name for the TXT record (e.g., `_ndncert-challenge.your-agent.ownly.named-data.net`). **Each agent must have a unique name** in the zone — `email-agent.ownly.named-data.net` is the deployed email notification agent. |
| `value`      | `string` | Yes      | The TXT record value — typically a challenge token provided by the NDN CA. |
| `ttl`        | `number` | No       | Time-to-live in seconds. Defaults to 60. A low TTL is appropriate for short-lived challenge records. |

Returns a `Promise<void>` that resolves on success and rejects on failure.

---

#### `deleteTxt(recordName)`

Removes a DNS TXT record. Intended to clean up challenge records after they are no longer needed.

| Parameter    | Type     | Required | Description |
|--------------|----------|----------|-------------|
| `recordName` | `string` | Yes      | Fully qualified domain name of the record to delete. |

Returns a `Promise<void>` that resolves on success and rejects on failure.

---

## Implementation: `Bind9DnsProvider`

**File:** `src/node/providers/bind9.ts`

The `Bind9DnsProvider` class implements `DnsProvider` for use with the UCLA `dns-api` HTTP service. It communicates with `dns-api` using HMAC-SHA256 request signing, a nonce, and a Unix timestamp.

### Constructor

```typescript
new Bind9DnsProvider(apiUrl: string, secret: string)
```

| Parameter | Type     | Description |
|-----------|----------|-------------|
| `apiUrl`  | `string` | Base URL of the `dns-api` service (e.g., `https://bruins.cs.ucla.edu`). Set via `DNS_API_URL` in `.env`. |
| `secret`  | `string` | Shared HMAC secret. Must match `HMAC_SECRET` on the server. Set via `DNS_API_SECRET` in `.env`. |

### Request Signing

Every request is signed by including in the JSON body:
- `nonce`: A UUID v4 generated with `crypto.randomUUID()`, used for replay protection.
- `timestamp`: The current Unix time in seconds.

The full JSON body (including nonce and timestamp) is then HMAC-SHA256 signed with the secret, and the base64-encoded signature is sent in the `Authorization` header:

```
Authorization: base64(HMAC-SHA256(secret, request_body))
```

### Usage Example

```typescript
import { Bind9DnsProvider } from './providers/bind9.ts';

const dnsProvider = new Bind9DnsProvider(
  process.env.DNS_API_URL!,
  process.env.DNS_API_SECRET!
);

// Insert a TXT record (e.g., during NDNcert challenge)
// The record name is derived from AGENT_DNS_NAME in .env — for the deployed email agent this is
// email-agent.ownly.named-data.net; each new agent must use its own unique name in the zone.
await dnsProvider.insertTxt('_ndncert-challenge.email-agent.ownly.named-data.net', 'challenge-token-xyz');

// Delete the TXT record after the challenge completes
await dnsProvider.deleteTxt('_ndncert-challenge.email-agent.ownly.named-data.net');
```

---

## Implementing a Custom DNSProvider

To support a third-party DNS provider (Case 3), create a new file under `src/node/providers/` and implement the interface:

```typescript
// src/node/providers/cloudflare.ts
import type { DnsProvider } from '../dns-provider.ts';

export class CloudflareDnsProvider implements DnsProvider {
  constructor(
    private readonly apiToken: string,
    private readonly zoneId: string,
  ) {}

  async insertTxt(recordName: string, value: string, ttl = 60): Promise<void> {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${this.zoneId}/dns_records`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'TXT', name: recordName, content: value, ttl }),
      }
    );
    if (!res.ok) throw new Error(`Cloudflare insert failed: ${res.status}`);
  }

  async deleteTxt(recordName: string): Promise<void> {
    // First look up the record ID, then delete it
    // (implementation depends on your provider's API)
  }
}
```

Then update your agent to use the new provider:

```typescript
import { CloudflareDnsProvider } from './providers/cloudflare.ts';

const dnsProvider = new CloudflareDnsProvider(
  process.env.CF_API_TOKEN!,
  process.env.CF_ZONE_ID!,
);
```

The rest of the agent code (`initEnvironment`, the NDNcert challenge loop) requires no changes.

---

## How the DNSProvider Is Used in the Agent

In `headless_dns.ts`, the provider is used inside `initEnvironment()` during the NDNcert DNS challenge:

```typescript
const dnsProvider = new Bind9DnsProvider(DNS_API_URL, DNS_API_SECRET);
const recordName = `_ndncert-challenge.${AGENT_DNS_NAME}`;

await ndn.api.ndncert_dns(agentDns, async (recordName, expectedValue, status) => {
  if (status === 'need-record' || status === 'wrong-record') {
    await dnsProvider.deleteTxt(recordName).catch(() => {});
    await dnsProvider.insertTxt(recordName, expectedValue);
    return 'ready';
  }
  return '';
});

// Clean up after challenge
await dnsProvider.deleteTxt(recordName).catch(() => {});
```

The NDN library calls the callback with the `recordName` and `expectedValue` (the challenge token). The agent uses the `DnsProvider` to insert the token, then returns `'ready'` to signal the CA to verify. Once the challenge succeeds or fails, the TXT record is deleted.
