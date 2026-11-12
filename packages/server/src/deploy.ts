import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Next to the bundle on a deployed device, or further up in a checkout. */
export function deployScript(from = process.argv[1] ?? ''): string | null {
  const here = dirname(resolve(from));
  for (const up of ['..', join('..', '..', '..'), join('..', '..', '..', '..')]) {
    const path = join(here, up, 'integrations', 'omarchy', 'deploy.sh');
    if (existsSync(path)) return resolve(path);
  }
  return null;
}

/** `bogen peer deploy <host>`. The work is in the shell script, which also runs by itself. */
export function deployCommand(host: string | undefined, options: { dryRun?: boolean; port?: string }): Promise<number> {
  if (!host) {
    process.stderr.write('Usage: bogen peer deploy <ssh-host> [--dry-run]\n');
    return Promise.resolve(2);
  }
  const script = deployScript();
  if (!script) {
    process.stderr.write('bogen: this install has no integrations/omarchy/deploy.sh to deploy with. Run it from a checkout.\n');
    return Promise.resolve(1);
  }
  return new Promise((done) => {
    const child = spawn('bash', [script, host, ...(options.dryRun ? ['--dry-run'] : []), ...(options.port ? ['--port', options.port] : [])], { stdio: 'inherit' });
    child.on('error', () => done(1));
    child.on('close', (code) => done(code ?? 1));
  });
}
