import type { CreditRedemption, CreditVoucher, FTSIssuer, IssuedFTSKey } from './models';
import { MAX_TRANSACTION_CENTS } from './validation';

/** Only Pocket's own code format is accepted. A QR never chooses a server. */
export function parseCreditCode(value: unknown): string {
  if (typeof value !== 'string') throw new Error('This is not a Pocket earnings code.');
  const match = /^(?:pocket:\/\/redeem\?code=)?([A-Za-z0-9_-]{43})$/.exec(value.trim());
  if (!match) throw new Error('This is not a Pocket earnings code.');
  return match[1];
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function invalid(): never { throw new Error('The server returned an unexpected earnings response.'); }
function date(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function positive(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
}

export function parseVoucher(value: unknown): CreditVoucher {
  if (!object(value) || !['issued', 'redeemed', 'revoked'].includes(String(value.status)) ||
      !positive(value.amountCents, MAX_TRANSACTION_CENTS) || !positive(value.reportCount) || !positive(value.editCount) ||
      !date(value.createdAt) || !(value.redeemedAt === null || date(value.redeemedAt)) ||
      (value.status === 'redeemed' ? value.redeemedAt === null : value.redeemedAt !== null)) invalid();
  return { status: value.status as CreditVoucher['status'], amountCents: value.amountCents, reportCount: value.reportCount,
    editCount: value.editCount, createdAt: value.createdAt, redeemedAt: value.redeemedAt };
}

export function parseRedemption(value: unknown): CreditRedemption {
  const voucher = parseVoucher(value);
  if (!object(value) || voucher.status !== 'redeemed' || typeof value.replayed !== 'boolean') invalid();
  return { ...voucher, status: 'redeemed', replayed: value.replayed };
}

export function parseIssuer(value: unknown): FTSIssuer {
  if (!object(value) || typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value.id) ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 ||
      !positive(value.priceCents, MAX_TRANSACTION_CENTS) || !date(value.createdAt) || !(value.revokedAt === null || date(value.revokedAt))) invalid();
  return { id: value.id, name: value.name, priceCents: value.priceCents, createdAt: value.createdAt, revokedAt: value.revokedAt };
}

export function parseIssuers(value: unknown): FTSIssuer[] {
  if (!object(value) || !Array.isArray(value.issuers)) invalid();
  return value.issuers.map(parseIssuer);
}

export function parseIssuedKey(value: unknown): IssuedFTSKey {
  if (!object(value) || typeof value.token !== 'string' || !/^fts_[A-Za-z0-9_-]{43}$/.test(value.token)) invalid();
  return { issuer: parseIssuer(value.issuer), token: value.token };
}

export function parseRevokedIssuer(value: unknown): FTSIssuer {
  if (!object(value)) invalid();
  const issuer = parseIssuer(value.issuer);
  if (!issuer.revokedAt) invalid();
  return issuer;
}
