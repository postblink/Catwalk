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
