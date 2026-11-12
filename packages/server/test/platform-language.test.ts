import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { languageFilePath, parseLanguageFile, platformLanguage, systemLocales } from '../src/platform-language.ts';
import { startServer, type Harness } from './helpers.ts';

describe('the desktop language', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'bogen-lang-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('is found where omarchy-language keeps it', () => {
    expect(languageFilePath({}, '/home/a')).toBe('/home/a/.config/omarchy/language');
    expect(languageFilePath({ XDG_CONFIG_HOME: '/cfg' }, '/home/a')).toBe('/cfg/omarchy/language');
    expect(languageFilePath({ XDG_CONFIG_HOME: '/cfg', OMARCHY_LANGUAGE_FILE: '/pinned/lang' }, '/home/a')).toBe('/pinned/lang');
    // Relative paths would depend on the server's working folder: ignored, as the XDG specification says.
    expect(languageFilePath({ XDG_CONFIG_HOME: 'cfg', OMARCHY_LANGUAGE_FILE: 'lang' }, '/home/a')).toBe('/home/a/.config/omarchy/language');
  });

  it('is read like Omarchy reads it, and only a known code counts', () => {
    expect(parseLanguageFile('de\n')).toBe('de');
    expect(parseLanguageFile(' zh-TW \n')).toBe('zh-TW');
    expect(parseLanguageFile('es-MX\r\nmore')).toBe('es-MX');
    expect(parseLanguageFile('de-AT')).toBeNull();
    expect(parseLanguageFile('xx')).toBeNull();
    expect(parseLanguageFile('<script>')).toBeNull();
    expect(parseLanguageFile('')).toBeNull();
  });

  it('comes from the XDG config folder, and from OMARCHY_LANGUAGE_FILE before it', async () => {
    mkdirSync(join(dir, 'cfg/omarchy'), { recursive: true });
    writeFileSync(join(dir, 'cfg/omarchy/language'), 'fa\n');
    writeFileSync(join(dir, 'pinned'), 'ga');
    expect(await platformLanguage({ XDG_CONFIG_HOME: join(dir, 'cfg') }, '/nowhere')).toEqual({ omarchy: 'fa', system: [] });
    expect(await platformLanguage({ XDG_CONFIG_HOME: join(dir, 'cfg'), OMARCHY_LANGUAGE_FILE: join(dir, 'pinned') }, '/nowhere')).toEqual({ omarchy: 'ga', system: [] });
    expect(await platformLanguage({}, join(dir, 'empty-home'))).toEqual({ omarchy: null, system: [] });
  });

  it('is never more than the first bytes of a regular file', async () => {
    writeFileSync(join(dir, 'huge'), 'de\n' + 'x'.repeat(5_000_000));
    expect((await platformLanguage({ OMARCHY_LANGUAGE_FILE: join(dir, 'huge') })).omarchy).toBe('de');
    mkdirSync(join(dir, 'a-folder'), { recursive: true });
    expect((await platformLanguage({ OMARCHY_LANGUAGE_FILE: join(dir, 'a-folder') })).omarchy).toBeNull();
  });

  it.skipIf(spawnSync('mkfifo', ['--version']).status !== 0)('does not wait on a FIFO put in the file\'s place', async () => {
    const fifo = join(dir, 'fifo');
    spawnSync('mkfifo', [fifo]);
    expect(statSync(fifo).isFIFO()).toBe(true);
    const started = Date.now();
    expect((await platformLanguage({ OMARCHY_LANGUAGE_FILE: fifo })).omarchy).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('lists the session locales glibc would use, and nothing that does not look like one', () => {
    expect(systemLocales({ LANGUAGE: 'pt_BR:pt', LC_ALL: '', LC_MESSAGES: 'de_DE.UTF-8', LANG: 'en_US.UTF-8' })).toEqual(['pt_BR', 'pt', 'de_DE.UTF-8', 'en_US.UTF-8']);
    expect(systemLocales({ LANG: 'C.UTF-8' })).toEqual([]);
    expect(systemLocales({ LANG: 'POSIX', LC_ALL: '$(rm -rf /)' })).toEqual([]);
    expect(systemLocales({ LANG: 'sr_RS.UTF-8@latin' })).toEqual(['sr_RS.UTF-8@latin']);
  });
});

describe('/api/language', () => {
  let h: Harness;
  let dir: string;
  const saved = { file: process.env.OMARCHY_LANGUAGE_FILE, lang: process.env.LANG };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bogen-lang-http-'));
    h = await startServer();
  });
  afterEach(() => {
    if (saved.file === undefined) delete process.env.OMARCHY_LANGUAGE_FILE;
    else process.env.OMARCHY_LANGUAGE_FILE = saved.file;
    if (saved.lang === undefined) delete process.env.LANG;
    else process.env.LANG = saved.lang;
  });
  afterAll(async () => {
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it('tells the person at this machine, read fresh each time, and writes nothing', async () => {
    const file = join(dir, 'language');
    writeFileSync(file, 'uk\n');
    process.env.OMARCHY_LANGUAGE_FILE = file;
    process.env.LANG = 'uk_UA.UTF-8';
    const first = await (await fetch(`${h.base}/api/language`)).json();
    expect(first).toEqual({ omarchy: 'uk', system: expect.arrayContaining(['uk_UA.UTF-8']) });
    writeFileSync(file, 'si\n');
    expect((await (await fetch(`${h.base}/api/language`)).json()).omarchy).toBe('si');
    const before = statSync(file).mtimeMs;
    await fetch(`${h.base}/api/language`);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it('tells a request that is not from this machine nothing about it', async () => {
    const file = join(dir, 'language');
    writeFileSync(file, 'de\n');
    process.env.OMARCHY_LANGUAGE_FILE = file;
    const res = await fetch(`${h.base}/api/language`, { headers: { 'X-Forwarded-For': '100.64.0.9' } });
    expect(await res.json()).toEqual({ omarchy: null, system: [] });
  });

  it('only answers GET', async () => {
    expect((await fetch(`${h.base}/api/language`, { method: 'POST', body: '{}' })).status).not.toBe(200);
  });
});
