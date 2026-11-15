import * as Crypto from 'expo-crypto';

export function createRequestID(): string { return Crypto.randomUUID(); }
