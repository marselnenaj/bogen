/** Only Bogen-launched canvas runs opt in; outside MCP clients keep their selected tool mode. */
export const RUN_TOOL_MODE = 'grouped';
export function canvasRunHeaders(agent: string, fileId: string, runId?: string): Record<string, string> {
  return { 'X-Bogen-Tools': RUN_TOOL_MODE, 'X-Bogen-Agent': agent, 'X-Bogen-File': fileId, ...(runId ? { 'X-Bogen-Run': runId } : {}) };
}
