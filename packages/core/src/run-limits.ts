/** Shared by the server's scheduler, request validation and the editor's explicit run choices. */
export const MAX_PARALLEL_RUNS = 16;
export const MAX_DIRECTION_LANES = 16;
/** Lane colours are presentation only; each agent also has a unique name and lane id. */
export const LANE_COLORS = [
  '#0090ff', '#e5484d', '#46a758', '#f76b15', '#8e4ec6', '#12a594', '#d6409f', '#a18072',
  '#3e63dd', '#e93d82', '#30a46c', '#b68600', '#6e56cf', '#00a2c7', '#b85400', '#8b8d98',
] as const;
