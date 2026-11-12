// imagetracerjs (Unlicense) ships no types. Only what vectorize-worker.ts uses.
declare module 'imagetracerjs' {
  export interface TraceData { layers: unknown[][]; palette: { r: number; g: number; b: number; a: number }[]; width: number; height: number }
  const tracer: {
    imagedataToTracedata(img: { width: number; height: number; data: Uint8ClampedArray }, options: Record<string, unknown>): TraceData;
    getsvgstring(data: TraceData, options: Record<string, unknown>): string;
  };
  export default tracer;
}
