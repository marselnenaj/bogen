import type { CallLanguage } from '@bogen/core';

/**
 * The voices and the speech model a call can use. Nothing here is bundled: each file is downloaded once, when the
 * person asks for it in the call panel, checked against its SHA-256 and kept in `$BOGEN_HOME/speech/`. The licence of
 * the voice and of the recordings it learned from is part of the entry, because a voice is only as free as its data.
 * A new engine is a new `engine` value and new entries; the call panel lists whatever is
 * here.
 */

export interface SpeechFile { name: string; url: string; sha256: string; bytes: number }

export interface VoiceEntry {
  id: string;
  engine: 'piper' | 'tiny-voca';
  /** Which of the model's speakers this voice is, for a model with several (tiny-voca: 0 is F2, 1 is M2). */
  speaker?: number;
  /** Credit the voice's licence asks for, shown with the voice and in About. */
  attribution?: string;
  language: CallLanguage;
  /** In words, for the panel. */
  name: string;
  /** The model's licence and the licence of the recordings it was trained on. */
  licence: string;
  source: string;
  files: SpeechFile[];
  /** The default voice for its language. */
  preferred?: boolean;
}

const PIPER = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
/** tiny-voca at a fixed revision, so the files never change under their checksums. */
const TINY_VOCA = 'https://huggingface.co/n4ze3m/tiny-voca/resolve/666f595c1e818ba385853afb039ac7ce0456ed3c';

/**
 * tiny-voca (Apache-2.0, Muhammed Nazeem): a 4.5M-parameter English voice model, one ONNX file for both speakers,
 * read with Bogen's port of its phonemizer dizione (speech/dizione). The phonemizer data is CMUdict (BSD-style
 * licence, in tiny-voca-LICENSE.cmudict) and the Wikipedia Homograph Data (Apache-2.0). Both speakers share these
 * files, so downloading one downloads the other.
 */
const TINY_VOCA_FILES: SpeechFile[] = [
  { name: 'tiny-voca-model.onnx', url: `${TINY_VOCA}/onnx/model.onnx`, sha256: 'fe6d918791a15b82e37465981d7f27a070e46b46635e5a3482fc8dff87a1ae46', bytes: 21_386_372 },
  { name: 'tiny-voca-config.json', url: `${TINY_VOCA}/config.json`, sha256: '27bcbf322fc428581f0e959be1c141dd7751c61f4fed5eded326e779b215f69c', bytes: 2_129 },
  { name: 'tiny-voca-lexicon.tsv', url: `${TINY_VOCA}/phonemizer/lexicon.tsv`, sha256: '3fc930345c6b3cabc533981c4b212fa309eec83913fcdbd42919338270d64b06', bytes: 3_454_357 },
  { name: 'tiny-voca-align.json', url: `${TINY_VOCA}/phonemizer/align.json`, sha256: '864763dbd558a864950266b2c30627f1cad203e75062ee842ee63c653e823b75', bytes: 29_729 },
  { name: 'tiny-voca-g2p.json', url: `${TINY_VOCA}/phonemizer/g2p.json`, sha256: 'c518fd839ea0109c0b2b4f778c17506bf0d7653557b8b8c97a4c8dd9883d4432', bytes: 834 },
  { name: 'tiny-voca-g2p.npz', url: `${TINY_VOCA}/phonemizer/g2p.npz`, sha256: 'eb3fd519ff00e72d850928d2fccb968adc36134bca2f3bda09de7e794c2ed01b', bytes: 1_840_104 },
  { name: 'tiny-voca-homographs.json', url: `${TINY_VOCA}/phonemizer/homographs.json`, sha256: '9c3a96fcdf79fa27d1b3686dc6a507c37e4f754966928608ee9ddb617ba39192', bytes: 51_956 },
  { name: 'tiny-voca-LICENSE.cmudict', url: `${TINY_VOCA}/phonemizer/LICENSE.cmudict`, sha256: 'bd4ce8e44170a5f9f481310ca85c51de3c4f851a65e679b40e603b143bd3542a', bytes: 1_754 },
  { name: 'tiny-voca-LICENSE.homograph-data', url: `${TINY_VOCA}/phonemizer/LICENSE.homograph-data`, sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30', bytes: 11_358 },
];
const TINY_VOCA_LICENCE = 'Model and code Apache-2.0 (tiny-voca, Muhammed Nazeem); trained on the tiny-voca dataset, CC BY 4.0, speech made with Qwen3-TTS; phonemes from CMUdict (BSD-style) and the Wikipedia Homograph Data (Apache-2.0)';
const TINY_VOCA_ATTRIBUTION = 'Voice: tiny-voca by Muhammed Nazeem (Apache-2.0), trained on the tiny-voca dataset (CC BY 4.0, https://huggingface.co/datasets/n4ze3m/tiny-voca).';

export const VOICES: VoiceEntry[] = [
  {
    id: 'de_DE-thorsten-medium', engine: 'piper', language: 'de', name: 'Thorsten (Deutsch)', preferred: true,
    licence: 'Model and Thorsten-Voice recordings CC0-1.0; fine-tuned from a CC0 Dutch voice (rdh)',
    source: 'https://huggingface.co/rhasspy/piper-voices/tree/main/de/de_DE/thorsten/medium',
    files: [
      { name: 'de_DE-thorsten-medium.onnx', url: `${PIPER}/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx`, sha256: 'fd270eb3d1ebf91d763f8a0f949b1b1bebdfefaea18c3aaf8577dd34536e064f', bytes: 63_221_984 },
      { name: 'de_DE-thorsten-medium.onnx.json', url: `${PIPER}/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx.json`, sha256: 'cf245c91668e74cb6716f38647ae3d6d9bac42965872596f65f9ab2b7d7221ed', bytes: 5_460 },
    ],
  },
  {
    id: 'en_US-tiny-voca-F2', engine: 'tiny-voca', speaker: 0, language: 'en', name: 'tiny-voca F2 (English)', preferred: true,
    licence: TINY_VOCA_LICENCE, attribution: TINY_VOCA_ATTRIBUTION, source: 'https://huggingface.co/n4ze3m/tiny-voca', files: TINY_VOCA_FILES,
  },
  {
    id: 'en_US-tiny-voca-M2', engine: 'tiny-voca', speaker: 1, language: 'en', name: 'tiny-voca M2 (English)',
    licence: TINY_VOCA_LICENCE, attribution: TINY_VOCA_ATTRIBUTION, source: 'https://huggingface.co/n4ze3m/tiny-voca', files: TINY_VOCA_FILES,
  },
  {
    id: 'en_US-ljspeech-medium', engine: 'piper', language: 'en', name: 'LJ (English, Piper)',
    licence: 'LJ Speech recordings public domain; trained from scratch on them',
    source: 'https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ljspeech/medium',
    files: [
      { name: 'en_US-ljspeech-medium.onnx', url: `${PIPER}/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx`, sha256: '6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22', bytes: 63_531_379 },
      { name: 'en_US-ljspeech-medium.onnx.json', url: `${PIPER}/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx.json`, sha256: '141d612cc0a95ed7efc1ca936b845c2364967f2e9217c5dbfcf69fc4d6c65860', bytes: 4_972 },
    ],
  },
];

/** Whisper base, multilingual: hears German and English. MIT, from whisper.cpp. Run through Voxtype. */
export const LISTEN_MODEL: SpeechFile & { licence: string; source: string } = {
  name: 'ggml-base.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', bytes: 147_951_465,
  licence: 'Whisper weights MIT (OpenAI), ggml conversion MIT (whisper.cpp)', source: 'https://huggingface.co/ggerganov/whisper.cpp',
};

/**
 * Whisper large-v3-turbo, 5-bit: hears German, English and design words well, and runs in about 0.2 s per sentence on
 * a GPU through whisper.cpp in this process. Used when there is a GPU; Whisper base through Voxtype otherwise.
 */
export const HEAR_MODEL: SpeechFile & { licence: string; source: string } = {
  name: 'ggml-large-v3-turbo-q5_0.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
  sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2', bytes: 574_041_195,
  licence: 'Whisper weights MIT (OpenAI), ggml conversion MIT (whisper.cpp)', source: 'https://huggingface.co/ggerganov/whisper.cpp',
};

const PARAKEET = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/ed5d745623472f97cfc2e6c2916ee248798fc5a8';

/**
 * NVIDIA Parakeet TDT 0.6B v3, 8-bit, for sherpa-onnx: 25 European languages with German and English, on the CPU in
 * about 0.2 s per sentence. In a comparison with real voices it made half Whisper turbo's errors in German and lost no
 * sentence to a made-up one ("Vielen Dank."), so it is how a call hears by default, on every computer. CC BY 4.0:
 * credited in the voice list and in About.
 */
export const PARAKEET_MODEL: { files: SpeechFile[]; bytes: number; licence: string; source: string; attribution: string } = {
  files: [
    { name: 'parakeet-encoder.int8.onnx', url: `${PARAKEET}/encoder.int8.onnx`, sha256: '1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479', bytes: 652_282_294 },
    { name: 'parakeet-decoder.int8.onnx', url: `${PARAKEET}/decoder.int8.onnx`, sha256: '0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5', bytes: 11_845_274 },
    { name: 'parakeet-joiner.int8.onnx', url: `${PARAKEET}/joiner.int8.onnx`, sha256: 'cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98', bytes: 6_355_277 },
    { name: 'parakeet-tokens.txt', url: `${PARAKEET}/tokens.txt`, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d', bytes: 93_939 },
  ],
  bytes: 670_576_784,
  licence: 'CC BY 4.0 (NVIDIA); sherpa-onnx conversion by k2-fsa',
  source: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3',
  attribution: 'Speech recognition: NVIDIA Parakeet TDT 0.6B v3, CC BY 4.0, converted for sherpa-onnx by the k2-fsa project.',
};

/**
 * Silero VAD as ONNX for sherpa-onnx: tells speech from noise, typing and silence before anything is written down, so
 * no engine is asked to transcribe a stretch without speech (where Whisper makes up "Thank you."). It runs in a few
 * milliseconds a turn. Version 6.2 from the Silero repository's tag (2.3 MB, checked by SHA-256): the older v4 file
 * took typing for speech.
 */
export const VAD_MODEL: SpeechFile & { licence: string; source: string } = {
  name: 'silero_vad_v6.2.onnx',
  url: 'https://raw.githubusercontent.com/snakers4/silero-vad/v6.2/src/silero_vad/data/silero_vad.onnx',
  sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3', bytes: 2_327_524,
  licence: 'Silero VAD MIT (Silero Team)', source: 'https://github.com/snakers4/silero-vad',
};

/**
 * The languages a call speaks: English for now. German is coming with a voice of its own; setting
 * BOGEN_CALL_LANGUAGES=en,de turns German back on (with the Piper voice below) for testing.
 */
export function callLanguages(env: NodeJS.ProcessEnv = process.env): CallLanguage[] {
  const asked = (env.BOGEN_CALL_LANGUAGES ?? '').split(',').map((x) => x.trim()).filter((x): x is CallLanguage => x === 'en' || x === 'de');
  return asked.length ? [...new Set(asked)] : ['en'];
}

/** The voices of the languages a call speaks. */
export function offeredVoices(env: NodeJS.ProcessEnv = process.env): VoiceEntry[] {
  const langs = callLanguages(env);
  return VOICES.filter((v) => langs.includes(v.language));
}

export function voiceFor(language: CallLanguage, id?: string): VoiceEntry | undefined {
  if (id) return VOICES.find((v) => v.id === id && v.language === language);
  return VOICES.find((v) => v.language === language && v.preferred) ?? VOICES.find((v) => v.language === language);
}

/**
 * The small open models the call's talking layer can run on this computer. Only what the voice says comes from
 * them; the agent that edits is the person's own. Chosen with scripts/voice-harness: Qwen3 4B answers in about 0.3 s
 * on a GPU (Vulkan) with good German; without a GPU it takes about 4 s, so Qwen3 1.7B (about 1.8 s on 32 CPU cores)
 * is the default there.
 */
export interface TalkModel extends SpeechFile { id: string; label: string; licence: string; source: string; family: 'qwen3'; forGpu: boolean }

export const TALK_MODELS: TalkModel[] = [
  {
    id: 'qwen3-4b', label: 'Qwen3 4B', family: 'qwen3', forGpu: true,
    licence: 'Apache-2.0 (Qwen team, Alibaba Cloud)', source: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF',
    name: 'Qwen3-4B-Q4_K_M.gguf', url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf',
    sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5', bytes: 2_497_280_256,
  },
  {
    id: 'qwen3-1.7b', label: 'Qwen3 1.7B', family: 'qwen3', forGpu: false,
    licence: 'Apache-2.0 (Qwen team, Alibaba Cloud)', source: 'https://huggingface.co/Qwen/Qwen3-1.7B-GGUF',
    name: 'Qwen3-1.7B-Q8_0.gguf', url: 'https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf',
    sha256: '061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a', bytes: 1_834_426_016,
  },
];
