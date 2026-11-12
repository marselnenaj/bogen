import type { CodeHandoff, CodeRef, TokenKind } from '@bogen/core';

/** Variant axis values of one member, such as `{ variant: 'outline', size: 'sm' }`. */
export type Variant = Record<string, string>;

/**
 * What a token means, whatever the kit calls it, so that a brand or a theme maps onto any kit: the brand's
 * primary colour becomes shadcn's `primary`, Material's `md-sys-color-primary` and Bootstrap's `bs-primary`.
 */
export type KitRole = 'background' | 'foreground' | 'surface' | 'primary' | 'on-primary' | 'secondary' | 'muted' | 'border' | 'accent' | 'danger' | 'font' | 'radius';

export interface KitToken {
  /** The CSS variable without `--`, in the kit's own naming. */
  name: string;
  kind: TokenKind;
  light: string;
  /** The value in the dark mode, where it differs or the kit has one. */
  dark?: string;
  role?: KitRole;
}

export interface KitProp {
  name: string;
  type: 'text' | 'boolean' | 'image';
  /** The layer it drives, by its name in the member; empty for the root. */
  target: string;
  /** The field, when not the usual one for the type (text, visible, src). */
  field?: string;
}

export interface KitComponent {
  name: string;
  /** The showcase section it sits in, such as Forms. */
  group: string;
  description: string;
  /** Variant axes and their values; the first value of each is the default. */
  axes?: Record<string, string[]>;
  /** The members to make, when not every combination of the axes. */
  members?: Variant[];
  props?: KitProp[];
  /** One root element of HTML with inline styles that use the kit's tokens. */
  html?: (variant: Variant) => string;
  /**
   * A component of a linked code project, placed as a code component: how a kit made from a repository's
   * design system works. A library cannot hold these, so such a kit is built into the file that uses it.
   */
  code?: Omit<CodeRef, 'props'> & { props?: (variant: Variant) => CodeRef['props'] };
  handoff: CodeHandoff;
}

export interface Kit {
  /** Lower case letters, digits and dashes. */
  id: string;
  name: string;
  description: string;
  platform: 'web' | 'android' | 'ios-like';
  /** The code library the handoff writes for, and its licence. */
  library: { name: string; package: string; license: string; url: string };
  /** Where the look comes from, when it differs from the code library, such as Material Design 3 for MUI. */
  design?: { name: string; license: string; url: string };
  font: string;
  /** Raise it when the components change: a device makes the kit's library file again for a new version. */
  version: number;
  tokens: KitToken[];
  components: KitComponent[];
  /** Built into Bogen, or registered at run time from a code project or a Storybook. */
  source?: 'builtin' | 'code' | 'storybook';
}

export interface KitSummary {
  id: string;
  name: string;
  description: string;
  platform: Kit['platform'];
  library: Kit['library'];
  design?: Kit['design'];
  source: NonNullable<Kit['source']>;
  tokens: string[];
  components: { name: string; group: string; variants: Record<string, string[]>; import: string }[];
}
