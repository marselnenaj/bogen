/** The part of sherpa-onnx-node (Apache-2.0) that the call's listening uses. The package ships no types. */
declare module 'sherpa-onnx-node' {
  export interface OfflineStream {
    acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void;
  }
  export class Vad {
    constructor(config: Record<string, unknown>, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array };
    pop(): void;
    reset(): void;
    flush(): void;
  }
  export class OfflineRecognizer {
    constructor(config: Record<string, unknown>);
    createStream(hotwords?: string): OfflineStream;
    decode(stream: OfflineStream): void;
    getResult(stream: OfflineStream): { text?: string; lang?: string };
  }
}
