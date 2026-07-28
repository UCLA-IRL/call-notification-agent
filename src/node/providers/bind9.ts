import type { DnsProvider } from '../dns-provider.ts';
import crypto from 'crypto';
import { randomUUID } from 'crypto';

export class Bind9DnsProvider implements DnsProvider {
  constructor(
    private readonly apiUrl: string,
    private readonly secret: string,
  ) {}

  private sign(body: string): string {
    return crypto.createHmac('sha256', this.secret)
      .update(body)
      .digest('base64');
  }

private async post(method: string, body: object): Promise<void> {
    const payload = JSON.stringify({
        ...body,
        nonce: randomUUID(),
        timestamp: Math.floor(Date.now() / 1000),
    });
    const res = await fetch(`${this.apiUrl}/txt`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': this.sign(payload),
        },
        body: payload,
    });
    if (!res.ok) throw new Error(`DNS API ${method} failed: ${res.status} ${await res.text()}`);
}

async insertTxt(recordName: string, value: string, ttl = 60): Promise<void> {
    await this.post('POST', { recordName, value, ttl });
}

async deleteTxt(recordName: string): Promise<void> {
    await this.post('DELETE', { recordName });
}
}
