export type Library = {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
  /** False when root_path is no longer a readable directory (moved, renamed,
   *  or on an unplugged drive). Every model read fails in that state, so the UI
   *  explains it once instead of erroring per click. */
  root_exists: boolean;
};

export type SlicerCandidate = {
  slicer: string;
  label: string;
  path: string;
  exists: boolean;
};

export type ModelRow = {
  id: string;
  library_id: string;
  relative_path: string;
  filename: string;
  extension: string;
  size_bytes: number;
  byte_hash: string | null;
  thumbnail_path: string | null;
  modified_at: string;
  indexed_at: string;
};

export type ModelMetadata = {
  model_id: string;
  format: string;
  plate_count: number | null;
  print_time_seconds: number | null;
  filament_grams: number | null;
  filament_types: string | null; // JSON array string
  nozzle_diameter: number | null;
  layer_height: number | null;
  bbox_min_x: number | null;
  bbox_min_y: number | null;
  bbox_min_z: number | null;
  bbox_max_x: number | null;
  bbox_max_y: number | null;
  bbox_max_z: number | null;
  triangle_count: number | null;
};

export type Tag = {
  id: string;
  name: string;
  color: string | null;
  category: string | null;
};

export type TagCount = Tag & {
  count: number;
};

export type ModelTag = {
  tag_id: string;
  name: string;
  color: string | null;
  category: string | null;
  source: string; // "manual" | "auto-tier1" | "auto-tier2"
  confidence: number | null;
  confirmed: number; // 0 | 1
};

export type SmartCollection = {
  id: string;
  name: string;
  query: string; // JSON-encoded SavedSearch
  icon: string | null;
  created_at: string;
};

// The shape encoded into SmartCollection.query.
export type SavedSearch = {
  q: string;
  tagId: string | null;
};

export type ScanProgress = {
  library_id: string;
  phase: "walking" | "indexing" | "pruning" | "done";
  processed: number;
  total: number;
  current: string | null;
};

export type ScanResult = {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  total_seen: number;
};
