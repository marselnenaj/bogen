/** The routes a paired browser extension may call, with its own Origin. Everything else refuses that Origin. */
export const EXTENSION_ROUTE = /^\/api\/extension\/(pair|pair\/[a-f0-9]{16}|status|capture)$/;

/** chrome-extension://, moz-extension:// (a random id per install) and Safari's scheme. */
export function isExtensionOrigin(origin: string | undefined): origin is string {
  return typeof origin === 'string' && /^(chrome-extension|moz-extension|safari-web-extension):\/\/[a-z0-9-]{8,64}$/i.test(origin);
}
