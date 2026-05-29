export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const EXT_COLORS: Record<string, string> = {
  stl: "text-cyan",
  obj: "text-green",
  "3mf": "text-purple",
  gcode: "text-orange",
  gco: "text-orange",
  g: "text-orange",
};

export function extColor(ext: string): string {
  return EXT_COLORS[ext.toLowerCase()] ?? "text-muted";
}

/** Human-readable print duration, e.g. 3725s → "1h 2m". */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

/** Dimensions string from a bounding box, in mm: "120 × 80 × 45 mm". */
export function formatDimensions(
  min: [number, number, number],
  max: [number, number, number],
): string {
  const dims = [max[0] - min[0], max[1] - min[1], max[2] - min[2]].map((d) =>
    d >= 100 ? d.toFixed(0) : d.toFixed(1),
  );
  return `${dims[0]} × ${dims[1]} × ${dims[2]} mm`;
}
