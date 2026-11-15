import type { SessionStorage } from './controller';

// The iPhone app persists tokens in SecureStore. Web previews keep tokens in memory only.
const tokens = new Map<string, string>();
let fallbackServer: string | null = null;
export const sessionStorage: SessionStorage = {
  async getServerURL() {
    return typeof window === 'undefined' ? fallbackServer : window.localStorage.getItem('pocket.server-url');
  },
  async setServerURL(url) {
    fallbackServer = url;
    if (typeof window !== 'undefined') window.localStorage.setItem('pocket.server-url', url);
  },
  async getToken(server) { return tokens.get(server) ?? null; },
  async setToken(server, token) { tokens.set(server, token); },
  async removeToken(server) { tokens.delete(server); },
};
