/** Compact navigation metadata; never a second document or a design snapshot. */
export interface EditLocation {
  pageId: string;
  pageName: string;
  screenId?: string;
  screenName?: string;
}
export interface RecentEdit {
  id: string;
  at: number;
  actor: string;
  summary: string;
  locations: EditLocation[];
  locationCount: number;
}
