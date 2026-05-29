<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { X } from "lucide-svelte";
  import type { ModelRow, ModelMetadata } from "$lib/types";
  import { formatBytes, extColor, formatDuration, formatDimensions } from "$lib/format";
  import ModelViewer from "./ModelViewer.svelte";

  let {
    model,
    onClose,
  }: {
    model: ModelRow;
    onClose: () => void;
  } = $props();

  const previewable = $derived(model.extension === "stl" || model.extension === "obj");

  let meta = $state<ModelMetadata | null>(null);

  // Load parsed slicer/format metadata whenever the selected model changes.
  $effect(() => {
    const id = model.id;
    meta = null;
    invoke<ModelMetadata | null>("get_model_metadata", { modelId: id })
      .then((m) => {
        // Guard against a stale response if the selection changed mid-flight.
        if (m && m.model_id === model.id) meta = m;
        else if (!m) meta = null;
      })
      .catch(() => (meta = null));
  });

  const filamentTypes = $derived.by(() => {
    if (!meta?.filament_types) return [];
    try {
      const parsed = JSON.parse(meta.filament_types);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  });

  const dimensions = $derived.by(() => {
    if (!meta) return null;
    const { bbox_min_x, bbox_min_y, bbox_min_z, bbox_max_x, bbox_max_y, bbox_max_z } = meta;
    if (
      bbox_min_x == null || bbox_min_y == null || bbox_min_z == null ||
      bbox_max_x == null || bbox_max_y == null || bbox_max_z == null
    )
      return null;
    return formatDimensions(
      [bbox_min_x, bbox_min_y, bbox_min_z],
      [bbox_max_x, bbox_max_y, bbox_max_z],
    );
  });
</script>

<div class="flex h-full w-full flex-col border-l border-border bg-surface-raised">
  <header class="app-chrome flex items-center justify-between border-b border-border px-4 py-3">
    <div class="min-w-0">
      <div class="truncate font-medium" title={model.filename}>{model.filename}</div>
      <div class="text-xs text-muted">{model.relative_path}</div>
    </div>
    <button class="rounded-md p-1 text-muted hover:bg-surface-overlay hover:text-fg" onclick={onClose} title="Close">
      <X size={16} />
    </button>
  </header>

  <div class="h-72 shrink-0 border-b border-border">
    {#if previewable}
      {#key model.id}
        <ModelViewer modelId={model.id} extension={model.extension} />
      {/key}
    {:else}
      <div class="flex h-full items-center justify-center text-sm text-muted">
        No 3D preview for .{model.extension} files yet.
      </div>
    {/if}
  </div>

  <div class="flex-1 overflow-y-auto p-4">
    <dl class="space-y-2.5 text-sm">
      <div class="flex justify-between">
        <dt class="text-muted">Format</dt>
        <dd class="font-mono uppercase {extColor(model.extension)}">{model.extension}</dd>
      </div>
      <div class="flex justify-between">
        <dt class="text-muted">Size</dt>
        <dd>{formatBytes(model.size_bytes)}</dd>
      </div>
      {#if dimensions}
        <div class="flex justify-between gap-4">
          <dt class="shrink-0 text-muted">Dimensions</dt>
          <dd class="truncate font-mono">{dimensions}</dd>
        </div>
      {/if}
      {#if meta?.triangle_count}
        <div class="flex justify-between">
          <dt class="text-muted">Triangles</dt>
          <dd>{meta.triangle_count.toLocaleString()}</dd>
        </div>
      {/if}
      {#if meta?.print_time_seconds}
        <div class="flex justify-between">
          <dt class="text-muted">Print time</dt>
          <dd>{formatDuration(meta.print_time_seconds)}</dd>
        </div>
      {/if}
      {#if meta?.filament_grams}
        <div class="flex justify-between">
          <dt class="text-muted">Filament</dt>
          <dd>{meta.filament_grams.toFixed(1)} g{filamentTypes.length ? ` · ${filamentTypes.join(", ")}` : ""}</dd>
        </div>
      {:else if filamentTypes.length}
        <div class="flex justify-between">
          <dt class="text-muted">Filament</dt>
          <dd>{filamentTypes.join(", ")}</dd>
        </div>
      {/if}
      {#if meta?.layer_height}
        <div class="flex justify-between">
          <dt class="text-muted">Layer height</dt>
          <dd>{meta.layer_height} mm</dd>
        </div>
      {/if}
      {#if meta?.nozzle_diameter}
        <div class="flex justify-between">
          <dt class="text-muted">Nozzle</dt>
          <dd>{meta.nozzle_diameter} mm</dd>
        </div>
      {/if}
      {#if meta?.plate_count && meta.plate_count > 1}
        <div class="flex justify-between">
          <dt class="text-muted">Plates</dt>
          <dd>{meta.plate_count}</dd>
        </div>
      {/if}
      <div class="flex justify-between gap-4">
        <dt class="shrink-0 text-muted">Modified</dt>
        <dd class="truncate">{new Date(model.modified_at).toLocaleString()}</dd>
      </div>
      <div class="flex justify-between gap-4">
        <dt class="shrink-0 text-muted">Indexed</dt>
        <dd class="truncate">{new Date(model.indexed_at).toLocaleString()}</dd>
      </div>
      {#if model.byte_hash}
        <div>
          <dt class="mb-1 text-muted">SHA-256</dt>
          <dd class="break-all rounded bg-surface p-2 font-mono text-xs text-muted">{model.byte_hash}</dd>
        </div>
      {/if}
    </dl>

    <div class="mt-5">
      <div class="mb-2 text-xs uppercase tracking-wider text-muted">Tags</div>
      <div class="text-sm text-muted">Tagging lands next.</div>
    </div>
  </div>
</div>
