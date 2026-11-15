import type { AuthResponse, FamilyState, MemberInput, ServerHealth, SetupInput, TransactionInput } from './models';
import { parseAuth, parseFamilyState, parseHealth, validateServerURL } from './validation';
import { FTS_SERVER_UPDATE_MESSAGE, parseCreditCode, parseIssuedKey, parseIssuers, parseRedemption, parseRevokedIssuer, parseVoucher } from './credits';
import { parseReceiptItems } from './payments';

export class APIError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'APIError';
    this.status = status;
  }
}

// This small interface works with Expo's fetch and Node's fetch in integration tests.
export interface FetchResponse {
  status: number;
  redirected?: boolean;
  type?: string;
  json(): Promise<unknown>;
}
export interface FetchOptions {
  method: string;
  headers: Record<string, string>;
  body?: string;
  credentials: 'omit';
  redirect: 'manual';
  cache: 'no-store';
  signal: AbortSignal;
}
export type FetchTransport = (url: string, options: FetchOptions) => Promise<FetchResponse>;

export class PocketAPI {
  readonly serverURL: string;
  private readonly transport: FetchTransport;

  constructor(serverURL: string, transport: FetchTransport) {
    this.serverURL = validateServerURL(serverURL);
    this.transport = transport;
  }

  async health(): Promise<ServerHealth> { return parseHealth(await this.request('/health')); }
  async state(token: string): Promise<FamilyState> { return parseFamilyState(await this.request('/state', { token })); }
  async signIn(username: string, password: string): Promise<AuthResponse> {
    return parseAuth(await this.request('/login', { body: { username, password } }));
  }
  async setup(input: SetupInput): Promise<AuthResponse> { return parseAuth(await this.request('/setup', { body: input })); }
  async logout(token: string): Promise<void> { await this.request('/logout', { token, body: {} }); }
  async addMember(token: string, input: MemberInput): Promise<void> { await this.request('/members', { token, body: input }); }
  async recordTransaction(token: string, input: TransactionInput): Promise<void> { await this.request('/transactions', { token, body: input }); }
  async transactionItems(token: string, id: string) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('Choose a valid receipt.');
    try { return parseReceiptItems(await this.request(`/transactions/${id}/items`, { token })); }
    catch (error) {
      // Older servers have no item route. Inaccessible receipts also reveal no list.
      if (error instanceof APIError && error.status === 404) return null;
      throw error;
    }
  }
  async markRead(token: string, ids: string[]): Promise<void> { await this.request('/notifications/read', { token, body: { ids } }); }
  async previewCredit(token: string, code: string) { return parseVoucher(await this.request('/credits/preview', { token, body: { code: parseCreditCode(code) } })); }
  async redeemCredit(token: string, code: string, childId?: string) {
    return parseRedemption(await this.request('/credits/redeem', { token, body: { code: parseCreditCode(code), ...(childId ? { childId } : {}) } }));
  }
  async checkFTSSupport() {
    const fts = (await this.health()).capabilities?.fts;
    return fts?.setupCodeDigits === 8 && fts.childCanConnect && fts.parentComputerLog;
  }
  async listFTSIssuers(token: string) { return parseIssuers(await this.ftsRequest('/fts/issuers', { token })); }
  async createFTSIssuer(token: string, name: string, priceCents: number) {
    const result = await this.ftsRequest('/fts/issuers', { token, body: { name, priceCents } });
    if (result && typeof result === 'object' && 'token' in result && !('setupCode' in result)) throw new APIError(409, FTS_SERVER_UPDATE_MESSAGE);
    return parseIssuedKey(result);
  }
  async revokeFTSIssuer(token: string, id: string) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('Choose a valid File Tracker connection.');
    return parseRevokedIssuer(await this.ftsRequest(`/fts/issuers/${id}/revoke`, { token, body: {} }));
  }

  private async ftsRequest(path: string, input: { token: string; body?: unknown }): Promise<unknown> {
    try { return await this.request(path, input); }
    catch (error) {
      if (error instanceof APIError && ((error.status === 403 && /only (?:a )?parents?|parents? only|parent (?:is )?required/i.test(error.message)) ||
          (error.status === 404 && path === '/fts/issuers'))) {
        throw new APIError(409, FTS_SERVER_UPDATE_MESSAGE);
      }
      throw error;
    }
  }

  private async request(path: string, { token, body }: { token?: string; body?: unknown } = {}): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      let response: FetchResponse;
      try {
        response = await this.transport(`${this.serverURL}${path}`, {
          method: body === undefined ? 'GET' : 'POST', headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: 'omit', redirect: 'manual', cache: 'no-store', signal: controller.signal,
        });
      } catch {
        throw new Error(controller.signal.aborted ? 'The family server took too long to respond.' : 'Could not reach the family server. Check its address and your connection.');
      }
      if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        throw new Error('The server redirected this request. Enter its direct address in Server settings.');
      }
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new Error('The server returned an unexpected response.'); }
      if (response.status < 200 || response.status >= 300) {
        const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
          ? payload.error : 'The request could not be completed.';
        throw new APIError(response.status, message);
      }
      return payload;
    } finally { clearTimeout(timeout); }
  }
}
