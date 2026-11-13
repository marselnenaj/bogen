// opentype.js (MIT) ships no types. Only what glyph-font-build.ts uses.
declare module 'opentype.js' {
  export type PathCommand =
    | { type: 'M' | 'L'; x: number; y: number }
    | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
    | { type: 'Q'; x1: number; y1: number; x: number; y: number }
    | { type: 'Z' };
  export class Path {
    commands: PathCommand[];
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void;
    quadTo(x1: number, y1: number, x: number, y: number): void;
    close(): void;
    toPathData(options?: number | { decimalPlaces?: number }): string;
  }
  export class Glyph {
    constructor(options: { name: string; unicode?: number; unicodes?: number[]; advanceWidth: number; path: Path });
    index: number;
    name: string | null;
    unicode?: number;
    unicodes: number[];
    advanceWidth: number;
    path: Path;
    getBoundingBox(): { x1: number; y1: number; x2: number; y2: number };
  }
  type NameRecord = Record<string, Record<string, string> | undefined>;
  export class Font {
    constructor(options: Record<string, unknown>);
    names: { unicode?: NameRecord; macintosh?: NameRecord; windows?: NameRecord } & NameRecord;
    unitsPerEm: number;
    ascender: number;
    descender: number;
    glyphs: { length: number; get(index: number): Glyph };
    tables: Record<string, Record<string, unknown> | undefined> & { os2?: Record<string, number>; cff?: unknown; gpos?: unknown };
    outlinesFormat: string;
    charToGlyph(char: string): Glyph;
    getKerningValue(left: Glyph | number, right: Glyph | number): number;
    getEnglishName(name: string): string | undefined;
    toArrayBuffer(): ArrayBuffer;
  }
  export function parse(buffer: ArrayBuffer, options?: Record<string, unknown>): Font;
}
