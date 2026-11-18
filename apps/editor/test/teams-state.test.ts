import { describe, expect, it } from 'vitest';
import { keyStorageTone, withEverywhere, type Transports } from '../src/panels/teams-state.ts';

const base: Transports = { lan: { on: true, address: '192.168.1.5' }, tailscale: { on: false }, vpn: { on: false, address: '' }, port: 29998 };

describe('Teams settings', () => {
  it('listening everywhere sends the confirmation with 0.0.0.0, and turning it off goes back to one network', () => {
    const on = withEverywhere(base, true, ['192.168.1.5']);
    expect(on).toMatchObject({ listenEverywhere: true, lan: { on: true, address: '0.0.0.0' } });
    expect(withEverywhere(on, false, ['192.168.1.5'])).toMatchObject({ listenEverywhere: false, lan: { on: true, address: '192.168.1.5' } });
  });

  it('never leaves an every-interface address behind without the confirmation', () => {
    const vpnAll: Transports = { ...base, listenEverywhere: true, lan: { on: true, address: '0.0.0.0' }, vpn: { on: true, address: '::' } };
    const off = withEverywhere(vpnAll, false, []);
    expect(off.lan).toEqual({ on: false, address: '' });
    expect(off.vpn).toEqual({ on: false, address: '' });
    expect(off.listenEverywhere).toBe(false);
  });

  it('warns unless the key is in the keyring', () => {
    expect(keyStorageTone('keyring')).toBe('ok');
    expect(keyStorageTone('file')).toBe('warning');
    expect(keyStorageTone('locked')).toBe('warning');
    expect(keyStorageTone(undefined)).toBe('warning');
  });
});
