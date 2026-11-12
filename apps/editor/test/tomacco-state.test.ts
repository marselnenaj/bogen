import { describe, expect, it } from 'vitest';
import { commandOf, tomaccoView, type TomaccoStatus } from '../src/panels/tomacco-state.ts';

const base: TomaccoStatus = { state: 'no-device', version: '1.5.0', devices: [], notes: [], steps: [], fix: null };
const SDK = 'Run: tomaccoctl setup --yes. It downloads about 5 GB and accepts Google\'s Android SDK license, so tell the person that first.';

describe('what the editor says about Tomacco', () => {
  it('takes the command out of doctor\'s instructions, and leaves prose alone', () => {
    expect(commandOf(SDK)).toBe('tomaccoctl setup --yes');
    expect(commandOf('sudo modprobe kvm_intel')).toBe('sudo modprobe kvm_intel');
    expect(commandOf('curl -fsSL https://tomacco.dev/install.sh | bash')).toBe('curl -fsSL https://tomacco.dev/install.sh | bash');
    expect(commandOf('Run: tomaccoctl call doctor')).toBe('tomaccoctl call doctor');
    expect(commandOf('Unpack Gradle 9 from https://gradle.org/releases into your home directory.')).toBeNull();
    expect(commandOf('open the settings.')).toBeNull();
    expect(commandOf(null)).toBeNull();
  });

  it('is quiet while checking and when a device runs, and gives the one command otherwise', () => {
    expect(tomaccoView(null)).toEqual({ kind: 'checking' });
    expect(tomaccoView({ ...base, state: 'ready', devices: [{ id: 'emulator-5554', platform: 'android', name: 'Pixel' }] })).toEqual({ kind: 'ready', devices: 1 });
    expect(tomaccoView({ ...base, state: 'missing', version: null, fix: 'curl -fsSL https://tomacco.dev/install.sh | bash' })).toEqual({ kind: 'missing', command: 'curl -fsSL https://tomacco.dev/install.sh | bash' });
    const steps = [
      { goal: 'android', what: 'Install the Android SDK and create an emulator', how: SDK, askFirst: true },
      { goal: 'android', what: 'Make KVM usable', how: 'sudo modprobe kvm_intel', askFirst: true },
    ];
    // The warning that comes with the command stays visible next to it.
    expect(tomaccoView({ ...base, steps, fix: SDK })).toEqual({ kind: 'no-device', what: 'Install the Android SDK and create an emulator', command: 'tomaccoctl setup --yes', detail: SDK, askFirst: true });
    expect(tomaccoView({ ...base, steps: [steps[1]!] })).toMatchObject({ command: 'sudo modprobe kvm_intel', detail: null });
    expect(tomaccoView(base)).toEqual({ kind: 'no-device', what: null, command: null, detail: null, askFirst: false });
    expect(tomaccoView(null, 'Only from this computer.')).toEqual({ kind: 'unknown', message: 'Only from this computer.' });
  });
});
