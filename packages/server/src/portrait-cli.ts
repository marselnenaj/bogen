// `bogen omarchy portrait …`: the portrait background plugin from a terminal, where a person at this machine runs it.
// Every action plans and prints by default; only --apply changes anything. No Bogen server is needed.

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { auditFolders, undoUpgrade, upgradeThemeRuntime } from './omarchy-theme-audit.ts';
import { disablePlugin, enablePlugin, installPlugin, liveStatus, pluginStatus, staleRuntime, portraitEnv, readThemeRuntime, removePlugin, rollbackPlugin, screensFor, currentThemeDir, type PlanResult } from './omarchy-portrait-runtime.ts';
import { detectDisplays, type ThemeEnv } from './omarchy-themes.ts';
import { bogenHome } from './util.ts';

export const PORTRAIT_USAGE = `Usage: bogen omarchy portrait <action> [--apply] [--json]

  status [--live]        The plugin, the current theme's portrait map and what each monitor shows. --live also asks
                         the running shell (omarchy-shell background portraitStatus).
  install [--force]      Install or update the plugin, derived from this machine's own Omarchy background plugin.
  enable | disable       Switch between the plugin and Omarchy's own background (omarchy plugin enable|disable).
  rollback               Put back the previous version of the plugin's files.
  remove                 Move the plugin's files to a backup; only when it is disabled.
  audit                  Every installed theme: what a portrait screen shows and what would change it. Read-only.
  upgrade <theme>        Add displays/portrait-runtime.json to an installed Bogen theme from its verified portrait
                         artwork. That one file and a checkpoint; nothing else.
  undo-upgrade <checkpoint>
                         Delete the file an upgrade added, while it is unchanged.

Without --apply every action only says what it would do.`;

function themeEnvFor(env: NodeJS.ProcessEnv): ThemeEnv {
  const omarchyPath = env.OMARCHY_PATH || '/usr/share/omarchy';
  const p = portraitEnv(env);
  return { home: p.home, omarchyPath, bin: p.omarchyBin, stateFile: join(bogenHome(), 'omarchy-apply.json'), omamobilePath: env.OMAMOBILE_PATH || '/usr/share/omamobile' };
}

function printPlan(title: string, r: PlanResult): void {
  const lines = [`${title}: ${r.applied ? 'done' : r.possible ? 'possible (plan only; add --apply)' : 'not possible'}`];
  for (const b of r.blockers) lines.push(`  ✗ ${b}`);
  for (const s of r.steps) lines.push(`  · ${s.do}${s.detail ? ` (${s.detail})` : ''}`);
  for (const c of r.commands) lines.push(`  $ ${c.join(' ')}`);
  if (r.backup) lines.push(`  backup: ${r.backup}`);
  lines.push(`  ${r.status.summary}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  if (!r.possible) process.exitCode = 1;
}

export async function portraitCli(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { apply: { type: 'boolean' }, force: { type: 'boolean' }, live: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  const [action, arg] = positionals;
  if (values.help || !action) {
    process.stdout.write(`${PORTRAIT_USAGE}\n`);
    return;
  }
  const env = portraitEnv();
  const apply = Boolean(values.apply);
  const out = (data: unknown, text: () => void): void => {
    if (values.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    else text();
  };
  switch (action) {
    case 'status': {
      const status = pluginStatus(env);
      const current = readThemeRuntime(currentThemeDir(env.home));
      const screens = screensFor(current, await detectDisplays());
      const live = values.live ? await liveStatus(env) : {};
      out({ plugin: status, current, screens, ...live, ...('live' in live ? { stale: staleRuntime(status.installed?.version, live.live) } : {}) }, () => {
        const lines = [`Plugin: ${status.state}${status.installed?.version ? ` ${status.installed.version}` : ''}. ${status.summary}`];
        lines.push(`Stock background: ${status.stock.present ? (status.stock.compatible ? 'can be patched' : `cannot be patched (${status.stock.reason})`) : 'not on this machine'}`);
        for (const c of status.conflicts) lines.push(`Other background clone: ${c.id}${c.enabled ? ' (enabled)' : ''} in ${c.dir}`);
        lines.push(`Current theme's portrait map: ${current.state}`);
        for (const e of current.entries) lines.push(`  ${e.aspect} ${e.file}: ${e.verified ? 'verified' : `refused, ${e.reason}`}`);
        for (const i of current.incomplete) lines.push(`  ${i.aspect}: ${i.status}, not shown. ${i.reason}`);
        for (const p of current.problems) lines.push(`  ! ${p}`);
        for (const s of screens) lines.push(`Monitor ${s.name} ${s.width} × ${s.height}: ${status.enabled || s.orientation === 'landscape' ? s.shows : 'the theme background, cropped (plugin not enabled)'}${s.reason ? `. ${s.reason}` : ''}`);
        if ('live' in live) lines.push(`Running shell: ${JSON.stringify(live.live)}`);
        const stale = 'live' in live ? staleRuntime(status.installed?.version, live.live) : null;
        if (stale) lines.push(`Next: ${stale}`);
        if ('liveError' in live) lines.push(`Running shell: ${live.liveError}`);
        for (const n of status.next) lines.push(`Next: ${n}`);
        process.stdout.write(`${lines.join('\n')}\n`);
      });
      return;
    }
    case 'install': {
      const r = await installPlugin(env, { apply, force: Boolean(values.force) });
      return out(r, () => printPlan('Install', r));
    }
    case 'enable': {
      const r = await enablePlugin(env, { apply });
      return out(r, () => printPlan('Enable', r));
    }
    case 'disable': {
      const r = await disablePlugin(env, { apply });
      return out(r, () => printPlan('Disable', r));
    }
    case 'rollback': {
      const r = await rollbackPlugin(env, { apply });
      return out(r, () => printPlan('Rollback', r));
    }
    case 'remove': {
      const r = await removePlugin(env, { apply });
      return out(r, () => printPlan('Remove', r));
    }
    case 'audit': {
      const folders = auditFolders(themeEnvFor(process.env));
      out({ folders }, () => {
        for (const f of folders) {
          process.stdout.write(`${f.current ? '* ' : '  '}${f.slug} [${f.source}${f.bogen ? ', Bogen' : ''}]: ${f.verdict}. A portrait screen shows ${f.portraitShows}.\n`);
          for (const a of f.actions) process.stdout.write(`      ${a}\n`);
        }
      });
      return;
    }
    case 'upgrade': {
      if (!arg) throw new Error('upgrade needs a theme name.');
      const r = await upgradeThemeRuntime(themeEnvFor(process.env), arg, { apply });
      out(r, () => {
        process.stdout.write(`Upgrade ${r.slug}: ${r.applied ? 'done' : r.possible ? 'possible (plan only; add --apply)' : 'not possible'}\n`);
        for (const b of r.blockers) process.stdout.write(`  ✗ ${b}\n`);
        for (const l of r.lists) process.stdout.write(`  lists ${l} in ${r.file}\n`);
        for (const i of r.incomplete) process.stdout.write(`  not listed: ${i}\n`);
        if (r.checkpoint) process.stdout.write(`  checkpoint: ${r.checkpoint}\n`);
        for (const n of r.next) process.stdout.write(`  next: ${n}\n`);
      });
      if (!r.possible) process.exitCode = 1;
      return;
    }
    case 'undo-upgrade': {
      if (!arg) throw new Error('undo-upgrade needs the checkpoint path an upgrade printed.');
      const r = await undoUpgrade(themeEnvFor(process.env), arg, { apply });
      out(r, () => process.stdout.write(`${apply ? 'Removed' : 'Would remove'}: ${r.removed.join(', ') || 'nothing'}${r.kept.length ? `\nKept (changed since): ${r.kept.join(', ')}` : ''}\n`));
      return;
    }
    default:
      throw new Error(`There is no portrait action "${action}".\n${PORTRAIT_USAGE}`);
  }
}
