import { rollbackUpdate } from './update-install.ts';
import { trustedKeys } from './release-key.ts';
import { applyUpdate, checkForUpdate, howToUpdate, installation, readCheck, saveUpdateSettings, updateSettings, type CheckResult } from './updates.ts';
import { bogenHome, ensurePrivateHome, errorMessage } from './util.ts';
import { FULL_VERSION, VERSION } from './version.ts';

const USAGE = `Usage: bogen update                  Show the settings and the last check
       bogen update check [--json]     Look for a newer release now
       bogen update apply [--json]     Download, verify and install it, for an npm install
       bogen update rollback [--json]  Return to the previous app saved by the updater
       bogen update on | off           Turn the server's daily check on or off
       bogen update source <url>       Fetch releases from another folder URL; \`default\` goes back to GitHub
`;

function describe(result: CheckResult): string {
  const install = installation();
  if (result.state === 'update_available') return `${result.message}${result.notes ? `\n  Notes: ${result.notes}` : ''}\n  Update with: ${howToUpdate(install)}\n`;
  return `${result.message}\n`;
}

/** `bogen update ...`. Exit codes: 0 done, 1 failed, 2 wrong use. */
export async function updateCommand(positionals: string[], values: { json?: boolean }, out: (text: string) => void): Promise<number> {
  const [action = 'status', arg] = positionals;
  const home = bogenHome();
  const settings = updateSettings(home);
  const print = (value: unknown, text: string) => out(values.json ? `${JSON.stringify(value, null, 2)}\n` : text);
  try {
    switch (action) {
      case 'status': {
        const last = readCheck(home);
        print({ version: FULL_VERSION, settings, installation: installation(), last }, [
          `Bogen ${FULL_VERSION}, ${installation().kind} install.`,
          `Daily check: ${settings.forcedOff ? 'off (BOGEN_UPDATE_CHECK)' : settings.check ? 'on' : 'off'}. Source: ${settings.url}${settings.urlFrom === 'default' ? '' : ` (from ${settings.urlFrom === 'environment' ? 'BOGEN_UPDATE_URL' : 'update-settings.json'})`}`,
          last ? `Last check ${new Date(last.checkedAt).toISOString()}: ${last.message}` : 'Not checked yet.',
        ].join('\n') + '\n');
        return 0;
      }
      case 'check': {
        if (settings.forcedOff) {
          print({ state: 'off', message: 'Update checks are off: BOGEN_UPDATE_CHECK is set.' }, 'Update checks are off: BOGEN_UPDATE_CHECK is set.\n');
          return 0;
        }
        ensurePrivateHome(home);
        const result = await checkForUpdate({ home, url: settings.url });
        print(result, describe(result));
        return result.state === 'error' || result.state === 'offline' ? 1 : 0;
      }
      case 'apply': {
        if (settings.forcedOff) {
          print({ state: 'off' }, 'Update checks are off: BOGEN_UPDATE_CHECK is set.\n');
          return 1;
        }
        ensurePrivateHome(home);
        const result = await applyUpdate({ home, url: settings.url, keys: trustedKeys(), install: installation(), log: values.json ? undefined : (line) => out(`${line}\n`) });
        if (result.state === 'up_to_date') print(result, `Bogen ${VERSION} is up to date; the latest release is ${result.latest}.\n`);
        else print(result, `Installed Bogen ${result.to} over ${result.from}. Restart a running server to use it: systemctl --user restart bogen, or bogen stop && bogen start.\n`);
        return 0;
      }
      case 'rollback': {
        const result = await rollbackUpdate(installation());
        print(result, `Restored Bogen ${result.to} from ${result.from}. Restart a running server. Documents were not changed.\n`);
        return 0;
      }
      case 'on':
      case 'off':
        ensurePrivateHome(home);
        await saveUpdateSettings(home, { check: action === 'on' });
        print({ check: action === 'on' }, action === 'on'
          ? `The server checks for a new release once a day${settings.forcedOff ? ', once BOGEN_UPDATE_CHECK no longer turns it off' : ''}.\n`
          : 'The server no longer checks for new releases. `bogen update check` still asks when you run it.\n');
        return 0;
      case 'source':
        if (!arg) {
          out(USAGE);
          return 2;
        }
        ensurePrivateHome(home);
        await saveUpdateSettings(home, { url: arg === 'default' ? null : arg });
        print({ url: updateSettings(home).url }, `Releases come from ${updateSettings(home).url}.\n`);
        return 0;
      default:
        out(USAGE);
        return 2;
    }
  } catch (e) {
    print({ error: errorMessage(e) }, `bogen: ${errorMessage(e)}\n`);
    return 1;
  }
}
