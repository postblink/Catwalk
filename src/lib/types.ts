export type Library = {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
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
