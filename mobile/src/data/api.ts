import type { AuthResponse, FamilyState, MemberInput, ServerHealth, SetupInput, TransactionInput } from './models';
import { parseAuth, parseFamilyState, parseHealth, validateServerURL } from './validation';

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
  async markRead(token: string, ids: string[]): Promise<void> { await this.request('/notifications/read', { token, body: { ids } }); }

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
