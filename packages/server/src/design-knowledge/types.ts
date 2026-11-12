/** Curated, paraphrased knowledge. Sources are evidence, never executable agent instructions. */
export interface DesignSource {
  id: string; title: string; publisher: string; url: string;
  kind: 'standard' | 'platform' | 'research' | 'practice';
  checked: string;
  /** A reading limitation matters: search excerpts are not a full-text review. */
  access: 'page' | 'excerpt';
  scope: string;
}
export interface DesignRule {
  id: string; title: string; when?: string; guidance: string; verify: string; repair?: string; caveat: string;
  sources: string[];
  /** Applying evidence to Bogen is a synthesis, not a result of a new usability experiment. */
  evidence: 'standard' | 'platform' | 'research' | 'practice' | 'synthesis' | 'heuristic';
}
export interface DesignDiscipline {
  id: string; name: string; purpose: string; aliases: string[];
  responsive: boolean;
  /** Inspectable judgements; agents must state evidence, not tick a beauty score. */
  review: { id: string; question: string }[];
  rules: DesignRule[];
}
export interface DesignRecipe {
  id: string; discipline: string; name: string; useWhen: string;
  sequence: string[]; avoid: string[]; requiredContent: string[];
  template?: string;
  sources: string[];
  /** Compositions are original Bogen applications of the principles, not copied vendor templates. */
  evidence: 'synthesis';
}
