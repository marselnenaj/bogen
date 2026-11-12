import { msg } from '../i18n/core.ts';
export type SettingsSectionId = 'appearance' | 'canvas' | 'agents' | 'knowledge' | 'devices' | 'privacy' | 'about';
/** Search uses translated visible words as well as common command names. */
export const SETTINGS_SECTIONS: { id: SettingsSectionId; label: string; hint: string; keywords: string[] }[] = [
  { id: 'appearance', label: msg('Appearance'), hint: msg('Panels, toolbar and dialogs. The canvas is not affected'), keywords: [msg('Interface size'), msg('Language'), msg('Theme'), msg('Reduce motion')] },
  { id: 'canvas', label: msg('Canvas'), hint: msg('How far arrow keys move a layer, and with Shift'), keywords: [msg('Nudge'), msg('Zoom direction'), msg('Plain wheel'), msg('Layout grids'), msg('Fit screen')] },
  { id: 'agents', label: msg('Agents'), hint: msg('The model is chosen where you ask an agent.'), keywords: [msg('Models'), 'Claude', 'Codex', 'OpenCode', 'Grok', 'Hermes', msg('Prompt'), msg('Comments')] },
  { id: 'knowledge', label: msg('Design knowledge'), hint: msg('Design playbooks, decisions and repair paths.'), keywords: ['SKILL.md', msg('Templates'), msg('Anti-slop rules')] },
  { id: 'devices', label: msg('Devices'), hint: msg('Sync and paired phones on this computer.'), keywords: [msg('Sync'), msg('Phone'), 'Tailscale', msg('Conflicts')] },
  { id: 'privacy', label: msg('Privacy'), hint: msg('Control access to this Bogen.'), keywords: ['WebMCP', msg('Agents in this browser'), msg('Phone')] },
  { id: 'about', label: msg('About'), hint: msg('Installed version and available updates.'), keywords: [msg('This Bogen'), msg('What is new'), msg('Version')] },
];
