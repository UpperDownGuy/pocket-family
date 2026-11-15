import { APIError, PocketAPI } from './api';
import type { FetchTransport } from './api';
import type { AuthResponse, MemberInput, PocketActions, PocketSnapshot, SetupInput, TransactionInput } from './models';
import { DEFAULT_SERVER_URL, MAX_TRANSACTION_CENTS, validateServerURL } from './validation';
import { parseCreditCode } from './credits';
import { transactionPayload } from './payments';

export interface SessionStorage {
  getServerURL(): Promise<string | null>;
  setServerURL(url: string): Promise<void>;
  getToken(server: string): Promise<string | null>;
  setToken(server: string, token: string): Promise<void>;
  removeToken(server: string): Promise<void>;
}

interface Session { generation: number; token: string; api: PocketAPI }
class SupersededError extends Error {
  constructor() { super('This request was replaced by another sign-in or server change.'); }
}

/** Framework-independent session state; server authorization remains authoritative. */
export class PocketController implements PocketActions {
  private snapshot: PocketSnapshot = {
    state: null, serverURL: DEFAULT_SERVER_URL, ready: false, busy: false,
    error: null, setupRequired: false, signedIn: false, pendingTransaction: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly storage: SessionStorage;
  private readonly transport: FetchTransport;
  private token: string | null = null;
  private generation = 0;
  private stateSequence = 0;
  private healthSequence = 0;
  private operationCount = 0;
  private initialization: Promise<void> | null = null;
  private storageQueue: Promise<unknown> = Promise.resolve();
  private pendingTransactions = new Map<string, TransactionInput>();

  constructor(storage: SessionStorage, transport: FetchTransport) {
    this.storage = storage;
    this.transport = transport;
  }

  getSnapshot = (): PocketSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  clearError = (): void => { this.update({ error: null }); };

  initialize = (): Promise<void> => {
    this.initialization ??= this.restore();
    return this.initialization;
  };

  private async restore(): Promise<void> {
    const expected = this.generation;
    try {
      const saved = await this.storage.getServerURL();
      const serverURL = validateServerURL(saved ?? DEFAULT_SERVER_URL);
      const token = await this.storage.getToken(serverURL);
      this.assertGeneration(expected);
      this.token = token;
      this.update({ serverURL, ready: true, signedIn: !!token });
      try { await this.checkServer(); } catch { /* The connection error is available in the snapshot. */ }
      if (this.current(expected) && this.token) await this.refresh();
    } catch (error) {
      if (this.current(expected)) this.update({ ready: true, error: this.message(error) });
    }
  }

  checkServer = async (): Promise<void> => {
    const expected = this.generation;
    const sequence = ++this.healthSequence;
    const api = this.api();
    await this.operation(async () => {
      try {
        const health = await api.health();
        if (!this.current(expected) || sequence !== this.healthSequence) return;
        this.update({ setupRequired: health.setupRequired, error: null });
      } catch (error) {
        if (!this.current(expected) || sequence !== this.healthSequence) return;
        throw error;
      }
    }, expected);
  };

  signIn = async (username: string, password: string): Promise<void> => {
    const expected = this.beginSessionChange();
    const api = this.api();
    await this.operation(async () => {
      await this.queueStorage(() => this.storage.removeToken(api.serverURL));
      this.assertGeneration(expected);
      const response = await api.signIn(username.trim(), password);
      await this.accept(response, api, expected);
    }, expected);
  };

  setup = async (input: SetupInput): Promise<void> => {
    const expected = this.beginSessionChange();
    const api = this.api();
    await this.operation(async () => {
      await this.queueStorage(() => this.storage.removeToken(api.serverURL));
      this.assertGeneration(expected);
      try {
        const response = await api.setup(input);
        await this.accept(response, api, expected);
        if (this.current(expected)) this.update({ setupRequired: false });
      } catch (error) {
        // Setup may have committed even when its response was lost. Recover the
        // form mode without replacing the original failure or another session.
        if (this.current(expected)) {
          const sequence = ++this.healthSequence;
          try {
            const health = await api.health();
            if (this.current(expected) && sequence === this.healthSequence) {
              this.update({ setupRequired: health.setupRequired });
            }
          } catch { /* Keep the original setup error when the status check also fails. */ }
        }
        throw error;
      }
    }, expected);
  };

  signOut = async (): Promise<void> => {
    const oldToken = this.token;
    const api = this.api();
    const expected = this.beginSessionChange();
    await this.operation(async () => {
      const results = await Promise.allSettled([
        this.queueStorage(() => this.storage.removeToken(api.serverURL)),
        oldToken ? api.logout(oldToken) : Promise.resolve(),
      ]);
      if (results[0].status === 'rejected') throw new Error('Could not remove the saved sign-in. Try signing out again.');
      if (results[1].status === 'rejected') {
        const failure: unknown = results[1].reason;
        if (!(failure instanceof APIError && failure.status === 401)) {
          throw new Error('Signed out on this device. The server could not be reached to end the session.');
        }
      }
    }, expected);
  };

  changeServer = async (value: string): Promise<void> => {
    let serverURL: string;
    try { serverURL = validateServerURL(value); }
    catch (error) { this.update({ error: this.message(error) }); throw error; }
    if (serverURL === this.snapshot.serverURL) { await this.checkServer(); return; }
    const oldAPI = this.api();
    const oldToken = this.token;
    const expected = this.beginSessionChange();
    await this.operation(async () => {
      // Revoke the previous server session when possible; local sign-out does not depend on it.
      const remoteLogout = oldToken ? oldAPI.logout(oldToken).catch(() => undefined) : Promise.resolve();
      await this.queueStorage(async () => {
        await this.storage.removeToken(oldAPI.serverURL);
        if (this.current(expected)) await this.storage.setServerURL(serverURL);
      });
      this.assertGeneration(expected);
      this.update({ serverURL, setupRequired: false });
      const restored = await this.storage.getToken(serverURL);
      this.assertGeneration(expected);
      this.token = restored;
      this.update({ signedIn: !!restored });
      await this.checkServer();
      if (restored) await this.loadState(this.session());
      await remoteLogout;
    }, expected);
  };

  addMember = async (input: MemberInput): Promise<void> => {
    await this.operation(async () => {
      const session = this.session();
      await session.api.addMember(session.token, input);
      await this.loadState(session);
    });
  };

  recordTransaction = async (input: TransactionInput): Promise<void> => {
    await this.sessionResult(async session => {
      if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > MAX_TRANSACTION_CENTS) {
        throw new Error('Enter an amount between $0.01 and $10,000.00.');
      }
      const user = this.snapshot.state?.user;
      if (!user) throw new Error('Sign in to continue.');
      const scope = `${session.api.serverURL}\n${user.id}`;
      const pending = this.pendingTransactions.get(scope);
      if (pending && transactionPayload(pending) !== transactionPayload(input)) {
        throw new Error('A previous payment is still unconfirmed. Reopen this form to retry that same payment before starting another.');
      }
      const request = { ...(pending ?? input) };
      this.pendingTransactions.set(scope, request);
      this.update({ pendingTransaction: request });
      try { await session.api.recordTransaction(session.token, request); }
      catch (error) {
        // Transport failures may follow a committed write. Preserve its exact key
        // across screen changes; a definitive rejection permits a new request.
        if (!pending && error instanceof APIError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          this.pendingTransactions.delete(scope);
          if (this.current(session.generation)) this.update({ pendingTransaction: null });
        }
        throw error;
      }
      this.pendingTransactions.delete(scope);
      this.assertSession(session);
      this.update({ pendingTransaction: null });
      // A confirmed payment stays successful if only the subsequent refresh fails.
      try { await this.loadState(session); }
      catch (error) { this.assertSession(session); await this.handleError(error, session.generation); }
    });
  };

  transactionItems = async (id: string) => this.sessionResult(session => session.api.transactionItems(session.token, id));

  markRead = async (ids: string[]): Promise<void> => {
    if (!ids.length) return;
    await this.operation(async () => {
      const session = this.session();
      const unique = [...new Set(ids)];
      // Keep JSON below the server's 16 KiB limit even with maximum-length IDs.
      for (let offset = 0; offset < unique.length; offset += 100) {
        this.assertSession(session);
        await session.api.markRead(session.token, unique.slice(offset, offset + 100));
      }
      await this.loadState(session);
    });
  };

  previewCredit = async (code: string) => this.sessionResult(async session => session.api.previewCredit(session.token, parseCreditCode(code)));

  redeemCredit = async (code: string, childId?: string) => this.sessionResult(async session => {
    const user = this.snapshot.state?.user;
    if (!user) throw new Error('Sign in to redeem earnings.');
    if (user.role === 'child' && childId && childId !== user.id) throw new Error('You can only redeem earnings for yourself.');
    if (user.role === 'parent' && !this.snapshot.state?.members.some(member => member.id === childId && member.role === 'child')) {
      throw new Error('Choose a child for these earnings.');
    }
    const result = await session.api.redeemCredit(session.token, parseCreditCode(code), user.role === 'parent' ? childId : undefined);
    this.assertSession(session);
    // Redemption has committed. A later refresh failure must not imply it failed.
    try { await this.loadState(session); }
    catch (error) { this.assertSession(session); await this.handleError(error, session.generation); }
    return result;
  });

  listFTSIssuers = async () => this.sessionResult(async session => {
    return session.api.listFTSIssuers(session.token);
  });

  checkFTSSupport = async () => this.sessionResult(async session => session.api.checkFTSSupport());

  createFTSIssuer = async (name: string, priceCents: number) => this.sessionResult(async session => {
    if (!name.trim() || name.trim().length > 60 || !Number.isSafeInteger(priceCents) || priceCents <= 0 || priceCents > MAX_TRANSACTION_CENTS) {
      throw new Error('Enter a name and a price from $0.01 to $10,000.00.');
    }
    return session.api.createFTSIssuer(session.token, name.trim(), priceCents);
  });

  revokeFTSIssuer = async (id: string) => this.sessionResult(async session => {
    return session.api.revokeFTSIssuer(session.token, id);
  });

  private async sessionResult<T>(action: (session: Session) => Promise<T>): Promise<T> {
    const session = this.session();
    return this.operation(async () => {
      this.assertSession(session);
      const result = await action(session);
      this.assertSession(session);
      return result;
    }, session.generation);
  }

  refresh = async (): Promise<void> => {
    if (!this.token) return;
    const expected = this.generation;
    try { await this.loadState(this.session()); }
    catch (error) { await this.handleError(error, expected); }
  };

  private async accept(response: AuthResponse, api: PocketAPI, expected: number): Promise<void> {
    if (!this.current(expected)) {
      await api.logout(response.token).catch(() => undefined);
      throw new SupersededError();
    }
    try {
      await this.queueStorage(async () => {
        this.assertGeneration(expected);
        await this.storage.setToken(api.serverURL, response.token);
      });
    } catch (error) {
      await api.logout(response.token).catch(() => undefined);
      throw error;
    }
    if (!this.current(expected)) {
      await api.logout(response.token).catch(() => undefined);
      throw new SupersededError();
    }
    this.token = response.token;
    this.update({ signedIn: true });
    await this.loadState({ generation: expected, token: response.token, api });
  }

  private async loadState(session: Session): Promise<void> {
    this.assertSession(session);
    const sequence = ++this.stateSequence;
    try {
      const state = await session.api.state(session.token);
      this.assertSession(session);
      if (sequence !== this.stateSequence) return;
      this.update({ state, error: null, pendingTransaction: this.pendingTransactions.get(`${session.api.serverURL}\n${state.user.id}`) ?? null });
    } catch (error) {
      this.assertSession(session);
      if (sequence !== this.stateSequence) return;
      throw error;
    }
  }

  private async operation<T>(action: () => Promise<T>, expected = this.generation): Promise<T> {
    this.operationCount++;
    this.update({ busy: true, error: null });
    try { return await action(); }
    catch (error) {
      await this.handleError(error, expected);
      throw error;
    } finally {
      this.operationCount--;
      this.update({ busy: this.operationCount > 0 });
    }
  }

  private async handleError(error: unknown, expected: number): Promise<void> {
    if (!this.current(expected) || error instanceof SupersededError) return;
    if (error instanceof APIError && error.status === 401 && this.token) {
      const serverURL = this.snapshot.serverURL;
      const clearedGeneration = this.beginSessionChange();
      this.update({ error: error.message });
      try { await this.queueStorage(() => this.storage.removeToken(serverURL)); }
      catch {
        if (this.current(clearedGeneration)) this.update({ error: 'Your session expired, and its saved sign-in could not be removed. Try signing out again.' });
      }
      return;
    }
    this.update({ error: this.message(error) });
  }

  private beginSessionChange(): number {
    this.generation++;
    this.token = null;
    this.update({ state: null, signedIn: false, error: null, pendingTransaction: null });
    return this.generation;
  }
  private current(expected: number): boolean { return expected === this.generation; }
  private assertGeneration(expected: number): void { if (!this.current(expected)) throw new SupersededError(); }
  private assertSession(session: Session): void {
    if (!this.current(session.generation) || session.token !== this.token) throw new SupersededError();
  }
  private session(): Session {
    if (!this.token) throw new Error('Sign in to continue.');
    return { token: this.token, api: this.api(), generation: this.generation };
  }
  private api(): PocketAPI { return new PocketAPI(this.snapshot.serverURL, this.transport); }
  private message(error: unknown): string { return error instanceof Error ? error.message : 'The request could not be completed.'; }
  private queueStorage<T>(action: () => Promise<T>): Promise<T> {
    const result = this.storageQueue.then(action, action);
    this.storageQueue = result.catch(() => undefined);
    return result;
  }
  private update(patch: Partial<PocketSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach(listener => listener());
  }
}
