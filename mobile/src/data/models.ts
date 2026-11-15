export type MemberRole = 'parent' | 'child';
export type TransactionKind = 'addition' | 'purchase';

export interface Member {
  id: string;
  name: string;
  username: string;
  role: MemberRole;
  balanceCents?: number;
}

export interface LedgerTransaction {
  id: string;
  childId: string;
  childName: string;
  kind: TransactionKind;
  amountCents: number;
  merchant: string;
  note: string;
  createdAt: string;
}

export interface InboxNotification {
  id: string;
  transactionId: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

export interface FamilyState {
  user: Member;
  familyName: string;
  members: Member[];
  transactions: LedgerTransaction[];
  notifications: InboxNotification[];
  pushConfigured: boolean;
}

export interface AuthResponse {
  token: string;
  user: Member;
  familyName: string;
}

export interface ServerHealth {
  setupRequired: boolean;
  pushConfigured: boolean;
}

export interface SetupInput {
  familyName: string;
  name: string;
  username: string;
  password: string;
  setupCode: string;
}

export interface MemberInput {
  name: string;
  username: string;
  password: string;
  role: MemberRole;
}

export interface TransactionInput {
  childId: string;
  kind: TransactionKind;
  amountCents: number;
  merchant: string;
  note: string;
  /** Keep this unchanged when retrying the same purchase after a connection error. */
  idempotencyKey: string;
}

export interface CreditVoucher {
  status: 'issued' | 'redeemed' | 'revoked';
  amountCents: number;
  reportCount: number;
  editCount: number;
  createdAt: string;
  redeemedAt: string | null;
}
export interface CreditRedemption extends CreditVoucher { status: 'redeemed'; replayed: boolean }
export interface FTSIssuer { id: string; name: string; priceCents: number; createdAt: string; revokedAt: string | null }
export interface IssuedFTSKey { issuer: FTSIssuer; token: string }

export interface PocketSnapshot {
  state: FamilyState | null;
  serverURL: string;
  ready: boolean;
  busy: boolean;
  error: string | null;
  setupRequired: boolean;
  signedIn: boolean;
}

export interface PocketActions {
  checkServer(): Promise<void>;
  changeServer(url: string): Promise<void>;
  signIn(username: string, password: string): Promise<void>;
  setup(input: SetupInput): Promise<void>;
  signOut(): Promise<void>;
  addMember(input: MemberInput): Promise<void>;
  recordTransaction(input: TransactionInput): Promise<void>;
  previewCredit(code: string): Promise<CreditVoucher>;
  redeemCredit(code: string, childId?: string): Promise<CreditRedemption>;
  listFTSIssuers(): Promise<FTSIssuer[]>;
  createFTSIssuer(name: string, priceCents: number): Promise<IssuedFTSKey>;
  revokeFTSIssuer(id: string): Promise<FTSIssuer>;
  markRead(ids: string[]): Promise<void>;
  refresh(): Promise<void>;
  clearError(): void;
}

export type PocketContextValue = PocketSnapshot & PocketActions;
