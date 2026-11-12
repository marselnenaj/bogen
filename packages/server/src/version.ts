import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;

declare const __BOGEN_BUILD__: string | undefined;

/** Which build this is: set by the bundler. From source it is `dev`. */
export const BUILD: string = typeof __BOGEN_BUILD__ === 'string' ? __BOGEN_BUILD__ : 'dev';

/** What devices compare: 0.1.0 alone says little, since every build until a release has that number. */
export const FULL_VERSION: string = BUILD === 'dev' ? VERSION : `${VERSION}+${BUILD}`;
