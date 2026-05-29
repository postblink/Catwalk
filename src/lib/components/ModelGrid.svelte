<script lang="ts">
  import type { ModelRow } from "$lib/types";
  import { formatBytes, extColor } from "$lib/format";
  import ModelThumb from "./ModelThumb.svelte";

  let {
    models,
    selectedId = $bindable(null),
  }: {
    models: ModelRow[];
    selectedId?: string | null;
  } = $props();
</script>

<div class="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
  {#each models as model (model.id)}
    <button
      class="group flex flex-col overflow-hidden rounded-lg border bg-surface-raised text-left transition-colors hover:border-primary {selectedId === model.id ? 'border-primary' : 'border-border'}"
      onclick={() => (selectedId = model.id)}
    >
      <div class="flex aspect-square items-center justify-center bg-surface">
        <ModelThumb {model} />
      </div>
      <div class="flex flex-col gap-1 p-2.5">
        <div class="truncate text-sm font-medium" title={model.filename}>{model.filename}</div>
        <div class="flex items-center justify-between text-xs">
          <span class="font-mono uppercase {extColor(model.extension)}">{model.extension}</span>
          <span class="text-muted">{formatBytes(model.size_bytes)}</span>
        </div>
      </div>
    </button>
  {/each}
</div>
