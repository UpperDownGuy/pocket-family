import { fetch as expoFetch } from 'expo/fetch';
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import { PocketController } from './controller';
import type { PocketContextValue } from './models';
import { sessionStorage } from './storage';

const PocketContext = createContext<PocketContextValue | null>(null);

export function PocketProvider({ children }: PropsWithChildren) {
  const [controller] = useState(() => new PocketController(sessionStorage, (url, options) => expoFetch(url, options)));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useEffect(() => { void controller.initialize(); }, [controller]);

  useEffect(() => {
    if (!snapshot.ready || !snapshot.signedIn) return;
    let active = AppState.currentState === 'active';
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loop = 0;
    const stop = () => { loop++; if (timer !== undefined) clearTimeout(timer); };
    const refresh = async (currentLoop: number) => {
      if (cancelled || !active || currentLoop !== loop) return;
      await controller.refresh();
      if (!cancelled && active && currentLoop === loop) {
        timer = setTimeout(() => { void refresh(currentLoop); }, 8_000);
      }
    };
    const subscription = AppState.addEventListener('change', state => {
      active = state === 'active';
      stop();
      if (active) void refresh(loop);
    });
    if (active) void refresh(loop);
    return () => {
      cancelled = true;
      stop();
      subscription.remove();
    };
  }, [controller, snapshot.ready, snapshot.signedIn]);

  const value = useMemo<PocketContextValue>(() => ({
    ...snapshot,
    checkServer: controller.checkServer,
    changeServer: controller.changeServer,
    signIn: controller.signIn,
    setup: controller.setup,
    signOut: controller.signOut,
    addMember: controller.addMember,
    recordTransaction: controller.recordTransaction,
    markRead: controller.markRead,
    refresh: controller.refresh,
    clearError: controller.clearError,
  }), [controller, snapshot]);

  return <PocketContext.Provider value={value}>{children}</PocketContext.Provider>;
}

export function usePocket(): PocketContextValue {
  const context = useContext(PocketContext);
  if (!context) throw new Error('usePocket must be used inside PocketProvider.');
  return context;
}
