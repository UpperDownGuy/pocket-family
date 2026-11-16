import type { SubscriptionSyncFeed } from './models';
import { planReminderSync, type ReminderSyncOperation, type SyncedReminder } from './reminder-sync';

export interface RemindersScope {
  serverURL: string; userId: string; familyName: string; userName: string; role: 'parent' | 'child';
  allowedChildIds: string[]; childNames?: Record<string, string>;
}
export interface RemindersSnapshot {
  available: boolean; enabled: boolean; syncing: boolean; lastSync: string | null; error: string | null;
}
export interface RemindersConfiguration {
  version: 1; scopeId: string; calendarId: string | null; enabled: boolean; lastSync: string | null;
}
export interface RemindersDependencies {
  available: boolean;
  read(): Promise<RemindersConfiguration | null>;
  write(config: RemindersConfiguration): Promise<void>;
  requestPermission(): Promise<boolean>;
  hasPermission(): Promise<boolean>;
  createList(title: string): Promise<string>;
  list(calendarId: string): Promise<SyncedReminder[]>;
  apply(calendarId: string, scopeId: string, operation: ReminderSyncOperation, isCurrent: () => boolean): Promise<void>;
  uuid(): string;
  now(): Date;
}

export const REMINDERS_BUILD_MESSAGE = 'Apple Reminders needs the updated installed Pocket app. It is not available in Expo Go.';
export class RemindersListUnavailableError extends Error {
  constructor() { super('The Pocket Reminders list was removed or became read-only. Connect again to create a new list.'); }
}

/** A service belongs to one signed-in account. Disposing it cancels future writes. */
export class RemindersService {
  private snapshot: RemindersSnapshot;
  private configuration: RemindersConfiguration | null = null;
  private listeners = new Set<() => void>();
  private initialized: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private syncing: Promise<void> | null = null;
  private generation = 0;
  private disposed = false;

  constructor(private scope: RemindersScope, private getFeed: () => Promise<SubscriptionSyncFeed>, private device: RemindersDependencies) {
    this.snapshot = { available: device.available, enabled: false, syncing: false, lastSync: null, error: null };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  initialize = (): Promise<void> => {
    if (!this.initialized) {
      const loading = this.load();
      this.initialized = loading;
      void loading.catch(() => { if (this.initialized === loading) this.initialized = null; });
    }
    return this.initialized;
  };
  private async load() {
    if (!this.device.available || this.disposed) return;
    try {
      const config = await this.device.read();
      if (this.disposed) return;
      this.configuration = config;
      this.update({ enabled: config?.enabled ?? false, lastSync: config?.lastSync ?? null });
    } catch (error) { this.report(error); throw error; }
  }
  connect = (): Promise<void> => this.enqueue(async expected => {
    if (!this.device.available) throw new Error(REMINDERS_BUILD_MESSAGE);
    await this.initialize(); this.assertCurrent(expected);
    // Prove this server supports an authenticated sync before asking for device access.
    await this.getFeed(); this.assertCurrent(expected);
    const granted = await this.device.requestPermission(); this.assertCurrent(expected);
    if (!granted) throw new Error('Allow Reminders access in iPhone Settings to connect your subscription list.');
    let config = this.configuration;
    if (!config) {
      config = { version: 1, scopeId: this.device.uuid(), calendarId: null, enabled: false, lastSync: null };
      // Save ownership before any native creations. A storage failure cannot leave duplicate reminders.
      await this.device.write(config); this.assertCurrent(expected);
      this.configuration = config;
    }
    if (!config.calendarId) {
      const title = `Pocket · ${this.scope.familyName} · ${this.scope.userName}`.slice(0, 180);
      const calendarId = await this.device.createList(title);
      config = { ...config, calendarId };
      // No reminders are added until the newly created list ID is durable.
      this.configuration = config;
      await this.device.write(config); this.assertCurrent(expected);
    }
    config = { ...config, enabled: true };
    await this.device.write(config); this.assertCurrent(expected);
    this.configuration = config; this.update({ enabled: true });
    await this.performSync(expected);
  });
  sync = (): Promise<void> => {
    if (this.syncing) return this.syncing;
    const run = this.enqueue(async expected => {
      await this.initialize(); this.assertCurrent(expected);
      if (this.configuration?.enabled) await this.performSync(expected);
    });
    this.syncing = run;
    void run.finally(() => { if (this.syncing === run) this.syncing = null; }).catch(() => undefined);
    return run;
  };
  disconnect = (): Promise<void> => {
    // Invalidate a waiting server/native read immediately, before the queued persistence.
    this.generation++;
    this.update({ enabled: false });
    return this.enqueue(async expected => {
      await this.initialize(); this.assertCurrent(expected);
      if (this.configuration) {
        const config = { ...this.configuration, enabled: false };
        this.configuration = config;
        await this.device.write(config); this.assertCurrent(expected);
      }
      this.update({ enabled: false });
    });
  };
  dispose = () => { this.disposed = true; this.generation++; this.listeners.clear(); };

  private async performSync(expected: number) {
    const config = this.configuration;
    if (!config?.enabled || !config.calendarId) return;
    if (!(await this.device.hasPermission())) throw new Error('Reminders access is off. Allow it in iPhone Settings, then sync again.');
    this.assertCurrent(expected);
    // The server is authoritative. A failed fetch must never complete or remove reminders.
    const feed = await this.getFeed(); this.assertCurrent(expected);
    let reminders: SyncedReminder[];
    try { reminders = await this.device.list(config.calendarId); }
    catch (error) {
      this.assertCurrent(expected);
      if (error instanceof RemindersListUnavailableError) {
        const disconnected = { ...config, calendarId: null, enabled: false };
        await this.device.write(disconnected); this.assertCurrent(expected);
        this.configuration = disconnected; this.update({ enabled: false });
      }
      throw error;
    }
    this.assertCurrent(expected);
    const operations = planReminderSync({ scopeId: config.scopeId, calendarId: config.calendarId,
      allowedChildIds: this.scope.allowedChildIds, childNames: this.scope.childNames,
      subscriptions: feed.subscriptions, charges: feed.charges, reminders, now: this.device.now() });
    for (const operation of operations) {
      this.assertCurrent(expected);
      await this.device.apply(config.calendarId, config.scopeId, operation, () => this.current(expected));
    }
    this.assertCurrent(expected);
    const updated = { ...config, lastSync: this.device.now().toISOString() };
    await this.device.write(updated); this.assertCurrent(expected);
    this.configuration = updated;
    this.update({ lastSync: updated.lastSync });
  }
  private enqueue(action: (generation: number) => Promise<void>) {
    const expected = this.generation;
    const run = this.queue.then(async () => {
      this.assertCurrent(expected);
      this.update({ syncing: true, error: null });
      try { await action(expected); }
      catch (error) { if (this.current(expected)) this.report(error); throw error; }
      finally { if (this.current(expected)) this.update({ syncing: false }); }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  private current(expected: number) { return !this.disposed && this.generation === expected; }
  private assertCurrent(expected: number) { if (!this.current(expected)) throw new Error('Reminders sync stopped because the account or connection changed.'); }
  private report(error: unknown) { this.update({ error: error instanceof Error ? error.message : 'Could not sync Apple Reminders.' }); }
  private update(patch: Partial<RemindersSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach(listener => listener());
  }
}
