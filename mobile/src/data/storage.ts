import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type { SessionStorage } from './controller';

const serverKey = 'pocket.server-url';
const options: SecureStore.SecureStoreOptions = {
  keychainService: 'PocketFamily',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

async function tokenKey(server: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, server);
  return `pocket.session.${digest}`;
}

export const sessionStorage: SessionStorage = {
  getServerURL: () => SecureStore.getItemAsync(serverKey, options),
  setServerURL: url => SecureStore.setItemAsync(serverKey, url, options),
  getToken: async server => SecureStore.getItemAsync(await tokenKey(server), options),
  setToken: async (server, token) => SecureStore.setItemAsync(await tokenKey(server), token, options),
  removeToken: async server => SecureStore.deleteItemAsync(await tokenKey(server), options),
};
