import { useSyncExternalStore } from 'react';
import type { Translate } from './core.ts';
import { currentTranslate, subscribeLanguage } from './store.ts';

/**
 * The words of the language in use. A component re-renders when the language changes, and at no other time: the
 * translator is one object per language, so it is also a stable dependency for `useMemo` and `useCallback`.
 */
export function useT(): Translate {
  return useSyncExternalStore(subscribeLanguage, currentTranslate, currentTranslate);
}
