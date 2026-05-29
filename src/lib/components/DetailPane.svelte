<script lang="ts">
  import { X } from "lucide-svelte";
  import type { ModelRow } from "$lib/types";
  import { formatBytes, extColor } from "$lib/format";
  import ModelViewer from "./ModelViewer.svelte";

  let {
    model,
    onClose,
  }: {
    model: ModelRow;
    onClose: () => void;
  } = $props();

  const previewable = $derived(model.extension === "stl" || model.extension === "obj");
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
