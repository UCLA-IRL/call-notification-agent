/* DnsProvider type contract
  -> interface decouples the agent (client) from the DNS implementation
  -> to change out DNS backend, define type in /providers
*/
export interface DnsProvider {
  insertTxt(recordName: string, value: string, ttl?: number): Promise<void>;
  deleteTxt(recordName: string): Promise<void>;
}
