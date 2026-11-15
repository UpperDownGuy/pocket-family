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

export interface ReceiptItem {
  reportId: string;
  path: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  oldPath?: string;
}
export interface ReceiptItems { items: ReceiptItem[]; totalCount: number; omittedCount: number }

export interface InboxNotification {
  id: string;
  transactionId: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

export interface ComputerNotification {
  id: string;
  issuerId: string;
  eventType: 'created' | 'paired' | 'removed';
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

export interface FamilyState {
  user: Member;
  familyName: string;
  familyCode?: string;
  members: Member[];
  transactions: LedgerTransaction[];
  notifications: InboxNotification[];
  computerNotifications: ComputerNotification[];
  pushConfigured: boolean;
}

export interface AuthResponse {
  token: string;
  user: Member;
  familyName: string;
  familyCode?: string;
}

export interface ServerHealth {
  setupRequired: boolean;
  pushConfigured: boolean;
  capabilities?: {
    fts?: { setupCodeDigits: number; childCanConnect: boolean; parentComputerLog: boolean };
    families?: { multiple: boolean; registration: boolean };
  };
}

export interface FamilyRegistrationInput { familyName: string; name: string; username: string; password: string }

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
export interface FTSIssuer {
  id: string; name: string; priceCents: number; createdAt: string; revokedAt: string | null;
  ownerId?: string; ownerName?: string; pairedAt?: string | null;
}
export interface IssuedFTSKey { issuer: FTSIssuer; setupCode: string; expiresAt: string }

export interface PocketSnapshot {
  state: FamilyState | null;
  serverURL: string;
  ready: boolean;
  busy: boolean;
  error: string | null;
  setupRequired: boolean;
  signedIn: boolean;
  pendingTransaction: TransactionInput | null;
  familyRegistrationAvailable: boolean;
  multipleFamilies: boolean;
  familyCodeHint: string;
}

export interface PocketActions {
  checkServer(): Promise<void>;
  changeServer(url: string): Promise<void>;
  signIn(username: string, password: string, familyCode?: string): Promise<void>;
  createFamily(input: FamilyRegistrationInput): Promise<void>;
  setup(input: SetupInput): Promise<void>;
  signOut(): Promise<void>;
  addMember(input: MemberInput): Promise<void>;
  recordTransaction(input: TransactionInput): Promise<void>;
  transactionItems(id: string): Promise<ReceiptItems | null>;
  previewCredit(code: string): Promise<CreditVoucher>;
  redeemCredit(code: string, childId?: string): Promise<CreditRedemption>;
  listFTSIssuers(): Promise<FTSIssuer[]>;
  checkFTSSupport(): Promise<boolean>;
  createFTSIssuer(name: string, priceCents: number): Promise<IssuedFTSKey>;
  revokeFTSIssuer(id: string): Promise<FTSIssuer>;
  markRead(ids: string[]): Promise<void>;
  refresh(): Promise<void>;
  clearError(): void;
}

export type PocketContextValue = PocketSnapshot & PocketActions;
