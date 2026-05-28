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
