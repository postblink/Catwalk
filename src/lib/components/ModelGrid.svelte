<script lang="ts">
  import type { ModelRow } from "$lib/types";
  import { formatBytes, extColor } from "$lib/format";
  import ModelThumb from "./ModelThumb.svelte";

  let {
    models,
    selectedIds = $bindable([]),
  }: {
    models: ModelRow[];
    selectedIds?: string[];
  } = $props();

  // Anchor for shift-range selection, stored by id so it survives reordering of
  // the models list (search/filter/library switch) — a numeric index would go
  // stale and select the wrong range.
  let anchorId: string | null = null;

  function selectOne(index: number) {
    const id = models[index].id;
    selectedIds = [id];
    anchorId = id;
  }

  function onCardClick(e: MouseEvent, index: number) {
    const id = models[index].id;
    const anchorIndex = anchorId === null ? -1 : models.findIndex((m) => m.id === anchorId);
    if (e.shiftKey && anchorIndex !== -1) {
      // Range from the anchor to here, merged into the current selection.
      const [a, b] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex];
      const set = new Set(selectedIds);
      for (const m of models.slice(a, b + 1)) set.add(m.id);
      selectedIds = [...set];
    } else if (e.ctrlKey || e.metaKey) {
      // Toggle this card's membership without disturbing the rest.
      const set = new Set(selectedIds);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      selectedIds = [...set];
      anchorId = id;
    } else {
      selectOne(index);
    }
  }
</script>

<div class="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
  {#each models as model, index (model.id)}
    <button
      class="group flex flex-col overflow-hidden rounded-lg border bg-surface-raised text-left transition-colors hover:border-primary {selectedIds.includes(model.id) ? 'border-primary' : 'border-border'}"
      onclick={(e) => onCardClick(e, index)}
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
