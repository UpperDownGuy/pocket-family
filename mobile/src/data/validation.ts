import type { AuthResponse, FamilyState, Member, ServerHealth } from './models';

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8787';
export const MAX_TRANSACTION_CENTS = 1_000_000;
export const FAMILY_UPDATE_MESSAGE = 'Update the Pocket server to create separate families. Your existing family will stay unchanged.';

export function parseFamilyCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{8}$/.test(value)) throw new Error('Enter the eight-digit family code, including any leading zero.');
  return value;
}

export function validateServerURL(value: string): string {
  const invalid = () => new Error('Use an HTTPS server address, or an HTTP address on your local network.');
  const raw = value.trim();
  // Reject URL parser repairs, credentials, and escaped host characters.
  if (!/^https?:\/\//i.test(raw) || /[\\\s]/.test(raw)) throw invalid();
  let url: URL;
  try { url = new URL(raw); } catch { throw invalid(); }
  if (!url.hostname || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw invalid();
  const authority = raw.slice(raw.indexOf('://') + 3).split('/')[0];
  if (authority.includes('%') || authority.includes('@') || authority.includes('?') || authority.includes('#')) throw invalid();
  const rawHost = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0];
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const parts = rawHost.split('.');
  const octets = parts.map(Number);
  const privateIPv4 = parts.length === 4 && parts.every(part => /^(0|[1-9][0-9]{0,2})$/.test(part)) &&
    octets.every(part => part >= 0 && part <= 255) && (
      octets[0] === 10 || octets[0] === 127 ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 169 && octets[1] === 254)
    );
  const localIPv6 = rawHost.startsWith('[') && (host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host));
  const localName = host === 'localhost' || /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.local$/.test(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (localName || privateIPv4 || localIPv6))) throw invalid();
  return url.origin;
}

/** Accepts decimal dollars, not grouping separators; never uses floating-point money arithmetic. */
export function centsFromInput(input: string): number | null {
  const value = input.trim().replace(',', '.');
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const dollars = Number(whole);
  if (!Number.isSafeInteger(dollars) || dollars > 10_000) return null;
  const cents = dollars * 100 + Number(fraction.padEnd(2, '0'));
  return cents >= 1 && cents <= MAX_TRANSACTION_CENTS ? cents : null;
}

export function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(part => [...part][0] ?? '').join('').toUpperCase();
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function strings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every(key => typeof value[key] === 'string');
}
function member(value: unknown): value is Member {
  return record(value) && strings(value, ['id', 'name', 'username']) &&
    (value.role === 'parent' || value.role === 'child') &&
    (value.balanceCents === undefined || Number.isSafeInteger(value.balanceCents));
}
function invalidResponse(): never { throw new Error('The server returned an unexpected response.'); }

export function parseHealth(value: unknown): ServerHealth {
  if (!record(value) || typeof value.setupRequired !== 'boolean' || typeof value.pushConfigured !== 'boolean') invalidResponse();
  if (value.capabilities !== undefined) {
    if (!record(value.capabilities)) invalidResponse();
    if (value.capabilities.fts !== undefined) {
      const fts = value.capabilities.fts;
      if (!record(fts) || !Number.isSafeInteger(fts.setupCodeDigits) || (fts.setupCodeDigits as number) < 1 ||
          typeof fts.childCanConnect !== 'boolean' || typeof fts.parentComputerLog !== 'boolean') invalidResponse();
    }
    if (value.capabilities.families !== undefined) {
      const families = value.capabilities.families;
      if (!record(families) || typeof families.multiple !== 'boolean' || typeof families.registration !== 'boolean') invalidResponse();
    }
  }
  return value as unknown as ServerHealth;
}

export function parseAuth(value: unknown): AuthResponse {
  if (!record(value) || !strings(value, ['token', 'familyName']) || !member(value.user) ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.token as string)) invalidResponse();
  if (value.familyCode !== undefined) parseFamilyCode(value.familyCode);
  return value as unknown as AuthResponse;
}

export function parseFamilyState(value: unknown): FamilyState {
  if (!record(value) || !member(value.user) || typeof value.familyName !== 'string' || typeof value.pushConfigured !== 'boolean' ||
      !Array.isArray(value.members) || !value.members.every(member) || !Array.isArray(value.transactions) || !Array.isArray(value.notifications)) invalidResponse();
  if (value.familyCode !== undefined) parseFamilyCode(value.familyCode);
  for (const item of value.transactions) {
    if (!record(item) || !strings(item, ['id', 'childId', 'childName', 'merchant', 'note', 'createdAt']) ||
        (item.kind !== 'purchase' && item.kind !== 'addition') || !Number.isSafeInteger(item.amountCents) ||
        (item.amountCents as number) <= 0 || (item.amountCents as number) > MAX_TRANSACTION_CENTS) invalidResponse();
  }
  for (const item of value.notifications) {
    if (!record(item) || !strings(item, ['id', 'transactionId', 'title', 'body', 'createdAt']) ||
        (item.readAt !== null && typeof item.readAt !== 'string')) invalidResponse();
  }
  const computerNotifications = value.computerNotifications === undefined ? [] : value.computerNotifications;
  if (!Array.isArray(computerNotifications) || (value.user.role === 'child' && computerNotifications.length > 0)) invalidResponse();
  for (const item of computerNotifications) {
    if (!record(item) || !strings(item, ['id', 'issuerId', 'title', 'body', 'createdAt']) ||
        !['created', 'paired', 'removed'].includes(String(item.eventType)) ||
        (item.readAt !== null && typeof item.readAt !== 'string')) invalidResponse();
  }
  return { ...value, computerNotifications } as unknown as FamilyState;
}
