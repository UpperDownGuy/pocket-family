import { isRunningInExpoGo, requireOptionalNativeModule } from 'expo';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { ExpoCalendarReminder } from 'expo-calendar';
import type { SubscriptionSyncFeed } from './models';
import { parseReminderMarker, type ReminderFields, type SyncedReminder } from './reminder-sync';
import { RemindersListUnavailableError, RemindersService, type RemindersConfiguration, type RemindersDependencies, type RemindersScope } from './reminders-service';

export type { RemindersSnapshot, RemindersScope } from './reminders-service';
export { REMINDERS_BUILD_MESSAGE } from './reminders-service';

const storageOptions: SecureStore.SecureStoreOptions = {
  keychainService: 'PocketFamily', keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const storageQueues = new Map<string, Promise<unknown>>();
function inStorageQueue<T>(key: string, action: () => Promise<T>): Promise<T> {
  const result = (storageQueues.get(key) ?? Promise.resolve()).then(action, action);
  storageQueues.set(key, result.catch(() => undefined));
  return result;
}

function decodeConfiguration(raw: string | null): RemindersConfiguration | null {
  if (!raw) return null;
  const value = JSON.parse(raw) as RemindersConfiguration;
  if (value.version !== 1 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.scopeId)
      || !(value.calendarId === null || (typeof value.calendarId === 'string' && value.calendarId.length > 0 && value.calendarId.length < 1024))
      || typeof value.enabled !== 'boolean' || !(value.lastSync === null || (typeof value.lastSync === 'string' && Number.isFinite(Date.parse(value.lastSync))))) {
    throw new Error('The saved Reminders connection could not be read. Reconnect Pocket before syncing.');
  }
  return value;
}

function splitNotes(notes: string | undefined) {
  const lines = (notes ?? '').split('\n');
  const markers = lines.filter(line => parseReminderMarker(line) !== null);
  // Ambiguous ownership never grants access to a reminder.
  return { marker: markers.length === 1 ? markers[0] : null, notes: lines.filter(line => !markers.includes(line)).join('\n').trimEnd() };
}
function normalize(reminder: ExpoCalendarReminder): SyncedReminder {
  const due = reminder.dueDate ? new Date(reminder.dueDate) : null;
  const dueDate = due && Number.isFinite(due.getTime())
    ? `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}` : null;
  return { id: reminder.id ?? '', calendarId: reminder.calendarId ?? '', ...splitNotes(reminder.notes),
    // EventKit exposes a localized abbreviation here (for example EST), not
    // the IANA billing zone. It cannot be compared to the server's zone.
    title: reminder.title ?? '', dueDate, completed: !!reminder.completed };
}
function nativeFields(fields: ReminderFields, marker: string) {
  const [year, month, day] = fields.dueDate.split('-').map(Number);
  // EventKit's all-day components use the device calendar. Local noon preserves
  // the selected calendar date across UTC offsets; the server owns billing time.
  return { title: fields.title, notes: `${fields.notes}\n${marker}`, dueDate: new Date(year, month - 1, day, 12),
    timeZone: fields.timeZone, allDay: true, completed: false };
}

export function createRemindersService({ scope, getFeed }: { scope: RemindersScope; getFeed: () => Promise<SubscriptionSyncFeed> }): RemindersService {
  const available = Platform.OS === 'ios' && !isRunningInExpoGo() && !!requireOptionalNativeModule('CalendarNext');
  const key = async () => `pocket.reminders.${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${scope.serverURL}\n${scope.userId}`)}`;
  // Loading this native module is deferred until a supported installed build
  // actually connects. Expo Go and web never import an unavailable native module.
  const calendarAPI = () => import('expo-calendar');
  const getList = async (id: string) => {
    const api = await calendarAPI();
    // ExpoCalendar.get currently requires Calendar-event permission even for a
    // Reminders list. Entity-filtered enumeration uses Reminders permission only.
    const list = (await api.getCalendars(api.EntityTypes.REMINDER)).find(value => value.id === id);
    if (!list || list.entityType !== api.EntityTypes.REMINDER || !list.allowsModifications) throw new RemindersListUnavailableError();
    return list;
  };
  const device: RemindersDependencies = {
    available,
    async read() {
      const name = await key();
      return inStorageQueue(name, async () => decodeConfiguration(await SecureStore.getItemAsync(name, storageOptions)));
    },
    async write(config) {
      const name = await key();
      await inStorageQueue(name, () => SecureStore.setItemAsync(name, JSON.stringify(config), storageOptions));
    },
    async requestPermission() { return (await (await calendarAPI()).requestRemindersPermissions()).granted; },
    async hasPermission() { return (await (await calendarAPI()).getRemindersPermissions()).granted; },
    async createList(title) {
      const api = await calendarAPI();
      const list = await api.createCalendar({ title, entityType: api.EntityTypes.REMINDER, color: '#176E59' });
      return list.id;
    },
    async list(calendarId) { return (await (await getList(calendarId)).listReminders()).map(normalize); },
    async apply(calendarId, scopeId, operation, isCurrent) {
      const assertCurrent = () => { if (!isCurrent()) throw new Error('Reminders sync stopped because the account or connection changed.'); };
      assertCurrent();
      const ownership = parseReminderMarker(operation.marker);
      if (!ownership || ownership.scopeId !== scopeId) throw new Error('This reminder does not belong to the current Pocket connection.');
      const list = await getList(calendarId);
      assertCurrent();
      if (operation.kind === 'create') {
        // Re-read after any earlier uncertain native write. The marker is stored
        // in the reminder itself, so recovery does not depend on a later ID save.
        if ((await list.listReminders()).some(item => splitNotes(item.notes).marker === operation.marker)) return;
        assertCurrent();
        await list.createReminder(nativeFields(operation.reminder, operation.marker));
        return;
      }
      const api = await calendarAPI();
      const reminder = await api.ExpoCalendarReminder.get(operation.reminderId);
      assertCurrent();
      const current = normalize(reminder);
      if (current.calendarId !== calendarId || current.marker !== operation.marker) throw new Error('A reminder was moved or changed outside Pocket. Sync again to refresh the list.');
      // A manual checkmark is never undone or interpreted as a Pocket payment.
      if (current.completed) return;
      if (operation.kind === 'complete') await reminder.update({ completed: true, completionDate: new Date(operation.completedAt) });
      else if (operation.kind === 'delete') await reminder.delete();
      else await reminder.update(nativeFields(operation.reminder, operation.marker));
    },
    uuid: () => Crypto.randomUUID(), now: () => new Date(),
  };
  return new RemindersService(scope, getFeed, device);
}
