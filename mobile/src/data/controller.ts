import { APIError, PocketAPI } from './api';
import type { FetchTransport } from './api';
import type { AuthResponse, FamilyDeletionContext, FamilyRegistrationInput, MemberInput, PendingSubscriptionUpdate, PocketActions, PocketSnapshot, SetupInput, Subscription, SubscriptionInput, SubscriptionPatch, TransactionInput } from './models';
import { DEFAULT_SERVER_URL, FAMILY_DELETE_UPDATE_MESSAGE, FAMILY_UPDATE_MESSAGE, MAX_TRANSACTION_CENTS, parseFamilyCode, validateServerURL } from './validation';
import { parseCreditCode } from './credits';
import { transactionPayload } from './payments';
import { REMINDERS_UPDATE_MESSAGE, subscriptionPatchPayload, subscriptionPayload, SUBSCRIPTIONS_UPDATE_MESSAGE, validateSubscriptionID, validateSubscriptionInput, validateSubscriptionPatch } from './subscriptions';

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
    error: null, setupRequired: false, signedIn: false, pendingTransaction: null, pendingSubscription: null, pendingSubscriptionUpdate: null,
    familyRegistrationAvailable: false, multipleFamilies: false, familyCodeHint: '',
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
  private pendingSubscriptions = new Map<string, SubscriptionInput>();
  private pendingSubscriptionUpdates = new Map<string, PendingSubscriptionUpdate>();
  private familyCodes = new Map<string, string>();

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
        this.update({ setupRequired: health.setupRequired, error: null,
          familyRegistrationAvailable: health.capabilities?.families?.registration === true && health.capabilities.families.multiple,
          multipleFamilies: health.capabilities?.families?.multiple === true });
      } catch (error) {
        if (!this.current(expected) || sequence !== this.healthSequence) return;
        throw error;
      }
    }, expected);
  };

  signIn = async (username: string, password: string, familyCode?: string): Promise<void> => {
    if (familyCode) parseFamilyCode(familyCode);
    const expected = this.beginSessionChange();
    const api = this.api();
    await this.operation(async () => {
      await this.queueStorage(() => this.storage.removeToken(api.serverURL));
      this.assertGeneration(expected);
      const response = await api.signIn(username.trim(), password, familyCode);
      await this.accept(response, api, expected);
    }, expected);
  };

  createFamily = async (input: FamilyRegistrationInput): Promise<void> => {
    // Never use /setup as a fallback: it belongs to the older single-family server.
    const beforeHealth = this.generation;
    await this.checkServer();
    this.assertGeneration(beforeHealth);
    if (!this.snapshot.familyRegistrationAvailable) throw new Error(FAMILY_UPDATE_MESSAGE);
    const expected = this.beginSessionChange();
    const api = this.api();
    await this.operation(async () => {
      await this.queueStorage(() => this.storage.removeToken(api.serverURL));
      this.assertGeneration(expected);
      const response = await api.createFamily(input);
      await this.accept(response, api, expected);
      if (this.current(expected)) this.update({ setupRequired: false });
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

  deleteFamily = async (context: FamilyDeletionContext): Promise<void> => {
    const session = this.session();
    await this.operation(async () => {
      const family = this.snapshot.state;
      if (family?.user.role !== 'parent') throw new Error('Only a parent can delete the family.');
      if (context.serverURL !== session.api.serverURL || context.userId !== family.user.id || context.familyCode !== family.familyCode) {
        throw new Error('Your family or account changed. Open the deletion confirmation again.');
      }
      const code = parseFamilyCode(context.familyCode);
      const health = await session.api.health();
      this.assertSession(session);
      if (health.capabilities?.families?.deletion !== true) throw new Error(FAMILY_DELETE_UPDATE_MESSAGE);
      await session.api.deleteFamily(session.token, code);

      // Clear only this family's cached retry state, even if another account has
      // signed in while the server was deleting it. Never sign that account out.
      for (const member of family.members) {
        const scope = `${session.api.serverURL}\n${member.id}`;
        this.pendingTransactions.delete(scope);
        this.pendingSubscriptions.delete(scope);
        this.pendingSubscriptionUpdates.delete(scope);
      }
      if (this.familyCodes.get(session.api.serverURL) === code) this.familyCodes.delete(session.api.serverURL);
      // A foreground refresh can discover the deleted session before DELETE's
      // reply arrives. Clear that signed-out hint without touching a new login.
      if (!this.token && this.snapshot.serverURL === session.api.serverURL && this.snapshot.familyCodeHint === code) this.update({ familyCodeHint: '' });
      this.assertSession(session);
      const clearedGeneration = this.beginSessionChange();
      this.update({ familyCodeHint: '' });
      try {
        await this.queueStorage(async () => {
          if (await this.storage.getToken(session.api.serverURL) === session.token) await this.storage.removeToken(session.api.serverURL);
        });
      } catch {
        if (this.current(clearedGeneration)) this.update({ error: 'Your family was deleted. Its expired saved sign-in could not be removed from this device.' });
      }
    }, session.generation);
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
      this.update({ serverURL, setupRequired: false, familyRegistrationAvailable: false, multipleFamilies: false, familyCodeHint: this.familyCodes.get(serverURL) ?? '' });
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

  listSubscriptions = async () => this.sessionResult(async session => {
    await this.requireSubscriptions(session);
    const scope = this.subscriptionScope(session);
    const pending = this.pendingSubscriptionUpdates.get(scope);
    const subscriptions = await session.api.listSubscriptions(session.token);
    this.assertSession(session);
    subscriptions.forEach(subscription => this.assertSubscriptionChild(subscription.childId));
    // The complete authorized list is authoritative for removed schedules. A
    // deleted schedule has no detail form in which to retry an uncertain edit.
    const current = this.pendingSubscriptionUpdates.get(scope);
    if (pending && !subscriptions.some(subscription => subscription.id === pending.id) && current?.id === pending.id && current.patch.idempotencyKey === pending.patch.idempotencyKey) {
      this.pendingSubscriptionUpdates.delete(scope);
      this.update({ pendingSubscriptionUpdate: null });
    }
    return subscriptions;
  });

  subscriptionSync = async () => this.sessionResult(async session => {
    const health = await session.api.health();
    this.assertSession(session);
    if (health.capabilities?.subscriptionReminders !== true) throw new Error(REMINDERS_UPDATE_MESSAGE);
    const feed = await session.api.subscriptionSync(session.token);
    this.assertSession(session);
    feed.subscriptions.forEach(subscription => this.assertSubscriptionChild(subscription.childId));
    feed.charges.forEach(charge => this.assertSubscriptionChild(charge.childId));
    return feed;
  });

  createSubscription = async (input: SubscriptionInput) => this.sessionResult(async session => {
    const validated = validateSubscriptionInput(input);
    this.assertSubscriptionChild(validated.childId);
    await this.requireSubscriptions(session);
    const scope = this.subscriptionScope(session);
    const pending = this.pendingSubscriptions.get(scope);
    if (pending && subscriptionPayload(pending) !== subscriptionPayload(validated)) throw new Error('A subscription is still unconfirmed. Retry that same subscription before creating another.');
    const request = { ...(pending ?? validated) };
    this.pendingSubscriptions.set(scope, request);
    this.update({ pendingSubscription: request });
    let result: Subscription;
    try { result = await session.api.createSubscription(session.token, request); }
    catch (error) {
      if ((!pending && this.definitiveRejection(error)) || (error instanceof APIError && (error.status === 410 || this.uncommittedPastDate(error)))) {
        if (this.pendingSubscriptions.get(scope)?.idempotencyKey === request.idempotencyKey) this.pendingSubscriptions.delete(scope);
        if (this.current(session.generation)) this.update({ pendingSubscription: this.pendingSubscriptions.get(scope) ?? null });
      }
      throw error;
    }
    if (this.pendingSubscriptions.get(scope)?.idempotencyKey === request.idempotencyKey) this.pendingSubscriptions.delete(scope);
    this.assertSession(session);
    this.assertSubscriptionChild(result.childId);
    this.update({ pendingSubscription: this.pendingSubscriptions.get(scope) ?? null });
    await this.refreshAfterSubscription(session);
    return result;
  });

  updateSubscription = async (id: string, input: SubscriptionPatch) => this.sessionResult(async session => {
    validateSubscriptionID(id);
    const validated = validateSubscriptionPatch(input);
    if (!validated.idempotencyKey) throw new Error('This subscription request is invalid. Reopen the form.');
    await this.requireSubscriptions(session);
    const scope = this.subscriptionScope(session);
    const pending = this.pendingSubscriptionUpdates.get(scope);
    if (pending && (pending.id !== id || subscriptionPatchPayload(pending.patch) !== subscriptionPatchPayload(validated))) throw new Error('A subscription update is still unconfirmed. Retry that same update before making another change.');
    const request = pending ?? { id, patch: validated };
    this.pendingSubscriptionUpdates.set(scope, request);
    this.update({ pendingSubscriptionUpdate: request });
    let result: Subscription;
    try { result = await session.api.updateSubscription(session.token, id, request.patch); }
    catch (error) {
      if ((!pending && this.definitiveRejection(error)) || (error instanceof APIError && (error.status === 404 || this.uncommittedPastDate(error)))) {
        const current = this.pendingSubscriptionUpdates.get(scope);
        if (current?.id === id && current.patch.idempotencyKey === request.patch.idempotencyKey) this.pendingSubscriptionUpdates.delete(scope);
        if (this.current(session.generation)) this.update({ pendingSubscriptionUpdate: this.pendingSubscriptionUpdates.get(scope) ?? null });
      }
      throw error;
    }
    const current = this.pendingSubscriptionUpdates.get(scope);
    if (current?.id === id && current.patch.idempotencyKey === request.patch.idempotencyKey) this.pendingSubscriptionUpdates.delete(scope);
    this.assertSession(session);
    this.assertSubscriptionChild(result.childId);
    this.update({ pendingSubscriptionUpdate: this.pendingSubscriptionUpdates.get(scope) ?? null });
    await this.refreshAfterSubscription(session);
    return result;
  });

  deleteSubscription = async (id: string) => this.sessionResult(async session => {
    await this.requireSubscriptions(session);
    const scope = this.subscriptionScope(session);
    await session.api.deleteSubscription(session.token, id);
    if (this.pendingSubscriptionUpdates.get(scope)?.id === id) this.pendingSubscriptionUpdates.delete(scope);
    this.assertSession(session);
    this.update({ pendingSubscriptionUpdate: this.pendingSubscriptionUpdates.get(scope) ?? null });
    await this.refreshAfterSubscription(session);
  });

  private async requireSubscriptions(session: Session): Promise<void> {
    const health = await session.api.health();
    this.assertSession(session);
    if (health.capabilities?.subscriptions !== true) throw new Error(SUBSCRIPTIONS_UPDATE_MESSAGE);
  }
  private subscriptionScope(session: Session): string {
    const user = this.snapshot.state?.user;
    if (!user) throw new Error('Sign in to continue.');
    return `${session.api.serverURL}\n${user.id}`;
  }
  private assertSubscriptionChild(childId: string): void {
    const family = this.snapshot.state;
    if (!family || (family.user.role === 'child' && childId !== family.user.id) || !family.members.some(member => member.id === childId && member.role === 'child')) throw new Error('This account cannot access that subscription.');
  }
  private definitiveRejection(error: unknown): boolean {
    return error instanceof APIError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
  }
  private uncommittedPastDate(error: APIError): boolean {
    // This precise response is returned only after the server checks the saved
    // idempotency key. A committed request replays before any date-age check.
    return error.status === 400 && error.message === 'Choose today or a future charge date.';
  }
  private async refreshAfterSubscription(session: Session): Promise<void> {
    // The mutation is confirmed even when the follow-up balance refresh fails.
    try { await this.loadState(session); }
    catch (error) { this.assertSession(session); await this.handleError(error, session.generation); }
  }

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
    if (response.familyCode) this.familyCodes.set(api.serverURL, response.familyCode);
    this.update({ signedIn: true, familyCodeHint: response.familyCode ?? '' });
    await this.loadState({ generation: expected, token: response.token, api });
  }

  private async loadState(session: Session): Promise<void> {
    this.assertSession(session);
    const sequence = ++this.stateSequence;
    try {
      const state = await session.api.state(session.token);
      this.assertSession(session);
      if (sequence !== this.stateSequence) return;
      if (state.familyCode) this.familyCodes.set(session.api.serverURL, state.familyCode);
      const scope = `${session.api.serverURL}\n${state.user.id}`;
      this.update({ state, error: null, familyCodeHint: state.familyCode ?? '', pendingTransaction: this.pendingTransactions.get(scope) ?? null,
        pendingSubscription: this.pendingSubscriptions.get(scope) ?? null, pendingSubscriptionUpdate: this.pendingSubscriptionUpdates.get(scope) ?? null });
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
    this.update({ state: null, signedIn: false, error: null, pendingTransaction: null, pendingSubscription: null, pendingSubscriptionUpdate: null });
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
