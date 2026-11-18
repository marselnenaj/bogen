/** Pure parts of the Teams settings, so they can be tested without the page. */

export interface Transports { lan: { on: boolean; address: string }; tailscale: { on: boolean }; vpn: { on: boolean; address: string }; port: number; listenEverywhere?: boolean }
export type KeyStorage = 'keyring' | 'file' | 'locked';
export const EVERY_INTERFACE = '0.0.0.0';

/**
 * The connections after the "Listen on every network" switch: on listens on 0.0.0.0 with the confirmation the
 * server asks for; off goes back to one address of the local network (the first one this device has), and never
 * leaves 0.0.0.0 behind without the confirmation.
 */
export function withEverywhere(tr: Transports, on: boolean, lanAddresses: readonly string[]): Transports {
  if (on) return { ...tr, listenEverywhere: true, lan: { on: true, address: EVERY_INTERFACE } };
  const fallback = lanAddresses.find((a) => a !== EVERY_INTERFACE && a !== '::') ?? '';
  const lan = tr.lan.address === EVERY_INTERFACE || tr.lan.address === '::' ? { on: tr.lan.on && fallback !== '', address: fallback } : tr.lan;
  const vpn = tr.vpn.address === EVERY_INTERFACE || tr.vpn.address === '::' ? { on: false, address: '' } : tr.vpn;
  return { ...tr, listenEverywhere: false, lan, vpn };
}

/** How the key's place is told: quietly for the keyring, as a warning for a file or a locked keyring. */
export function keyStorageTone(storage: KeyStorage | undefined): 'ok' | 'warning' {
  return storage === 'keyring' ? 'ok' : 'warning';
}
