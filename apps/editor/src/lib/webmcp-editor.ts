import { useSettings } from '../state/settings.ts';
import { phoneOrigin } from './phone.ts';
import { findModelContext, startWebMcp, type WebMcpHandle } from './webmcp.ts';

/**
 * Offers Bogen's tools to an agent in this browser while a file is open, when the browser has WebMCP and the
 * person has not turned it off in Settings. The phone's listener has no MCP endpoint, so the phone never offers them.
 */
export function installWebMcp(fileId: string): () => void {
  const modelContext = findModelContext();
  if (!modelContext || phoneOrigin) return () => {};
  let handle: WebMcpHandle | null = null;
  const apply = (on: boolean) => {
    if (on && !handle) {
      handle = startWebMcp({ fileId, modelContext });
      handle.ready.catch((e: unknown) => console.warn(`bogen: WebMCP tools are not offered: ${(e as Error).message}`));
    } else if (!on && handle) {
      void handle.stop();
      handle = null;
    }
  };
  apply(useSettings.getState().webmcp !== 'off');
  const off = useSettings.subscribe((st, prev) => {
    if (st.webmcp !== prev.webmcp) apply(st.webmcp !== 'off');
  });
  return () => {
    off();
    apply(false);
  };
}

/** For Settings: whether this browser offers WebMCP at all. */
export function browserHasWebMcp(): boolean {
  return findModelContext() !== null;
}
