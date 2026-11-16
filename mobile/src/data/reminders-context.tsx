import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import { usePocket } from './PocketProvider';
import { createRemindersService } from './reminders-device';
import type { FamilyState } from './models';

type Service = ReturnType<typeof createRemindersService>;
type RemindersValue = ReturnType<Service['getSnapshot']> & Pick<Service, 'connect' | 'sync' | 'disconnect'>;
const RemindersContext = createContext<RemindersValue | null>(null);
const unavailable: RemindersValue = { available: false, enabled: false, syncing: false, lastSync: null, error: null,
  connect: async () => undefined, sync: async () => undefined, disconnect: async () => undefined };

export function RemindersProvider({ children }: PropsWithChildren) {
  const { state, serverURL, subscriptionSync } = usePocket();
  const [published, setPublished] = useState<{ scopeKey: string; value: RemindersValue } | null>(null);
  const publish = useCallback((scopeKey: string, value: RemindersValue) => setPublished({ scopeKey, value }), []);
  const childIds = state?.members.filter(member => member.role === 'child').map(member => member.id).sort() ?? [];
  const scope = state ? {
    serverURL, userId: state.user.id, familyName: state.familyName, userName: state.user.name, role: state.user.role,
    allowedChildIds: childIds,
    childNames: state.user.role === 'parent' ? Object.fromEntries(state.members.filter(member => member.role === 'child').map(member => [member.id, member.name])) : undefined,
  } : null;
  const scopeKey = `${serverURL}:${state?.user.id ?? ''}:${childIds.join(',')}`;
  // Membership changes rebuild the service with the new authorization set;
  // account/server changes also dispose it before another account can sync.
  // Navigation stays mounted so incoming redemption links survive sign-in.
  return <RemindersContext.Provider value={state && published?.scopeKey === scopeKey ? published.value : unavailable}>
    {scope && state ? <RemindersCoordinator key={scopeKey} scopeKey={scopeKey} scope={scope} getFeed={subscriptionSync} state={state} publish={publish} /> : null}
    {children}
  </RemindersContext.Provider>;
}

function RemindersCoordinator({ scope, getFeed, state, scopeKey, publish }: Parameters<typeof createRemindersService>[0] & { state: FamilyState; scopeKey: string; publish(scopeKey: string, value: RemindersValue): void }) {
  const [initialScope] = useState(scope);
  const currentService = useRef<Service | null>(null);
  useEffect(() => {
    let active = true;
    let initialized = false;
    // Construct disposable resources in the effect so Strict Mode's cleanup /
    // setup replay gets a fresh service instead of reusing a disposed instance.
    const service = createRemindersService({ scope: initialScope, getFeed });
    currentService.current = service;
    const update = () => { if (active) publish(scopeKey, { ...service.getSnapshot(), connect: service.connect, sync: service.sync, disconnect: service.disconnect }); };
    const sync = () => { if (active && initialized && service.getSnapshot().enabled && AppState.currentState === 'active') void service.sync().catch(() => undefined); };
    const unsubscribe = service.subscribe(update);
    const listener = AppState.addEventListener('change', next => { if (next === 'active') sync(); });
    update();
    void service.initialize().then(() => { initialized = true; sync(); }).catch(() => undefined);
    return () => { active = false; unsubscribe(); listener.remove(); service.dispose(); if (currentService.current === service) currentService.current = null; };
  }, [getFeed, initialScope, publish, scopeKey]);
  useEffect(() => {
    const service = currentService.current;
    if (service?.getSnapshot().enabled && AppState.currentState === 'active') void service.sync().catch(() => undefined);
  }, [state]);
  return null;
}

export function useReminders(): RemindersValue {
  const context = useContext(RemindersContext);
  if (!context) throw new Error('Sign in before opening subscription reminders.');
  return context;
}
