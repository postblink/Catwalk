<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { Library, Settings, RefreshCw, Box, Loader, X } from "lucide-svelte";
  import type { Library as Lib, ModelRow, ScanProgress, ScanResult, TagCount } from "$lib/types";
  import ModelGrid from "./ModelGrid.svelte";
  import DetailPane from "./DetailPane.svelte";
  import { tagHex } from "./TagChip.svelte";

  let { libraries }: { libraries: Lib[] } = $props();
  let activeId = $state<string | null>(null);
  let active = $derived(libraries.find((l) => l.id === activeId) ?? libraries[0]);

  let models = $state<ModelRow[]>([]);
  let loadingModels = $state(false);
  let selectedId = $state<string | null>(null);

  let tags = $state<TagCount[]>([]);
  let selectedTagId = $state<string | null>(null);

  let scanning = $state(false);
  let progress = $state<ScanProgress | null>(null);
  let lastResult = $state<ScanResult | null>(null);

  let unlistenProgress: UnlistenFn | null = null;
  let unlistenComplete: UnlistenFn | null = null;

  async function loadModels(libraryId: string) {
    loadingModels = true;
    try {
      models = await invoke<ModelRow[]>("list_models", {
        libraryId,
        tagId: selectedTagId,
      });
    } finally {
      loadingModels = false;
    }
  }

  async function loadTags(libraryId: string) {
    try {
      tags = await invoke<TagCount[]>("list_tags", { libraryId });
    } catch {
      tags = [];
    }
  }

  function toggleTag(id: string) {
    selectedTagId = selectedTagId === id ? null : id;
    selectedId = null;
    if (active) loadModels(active.id);
  }

  // Refresh both the grid and the sidebar counts after a tag edit in the pane.
  async function onTagsChanged() {
    if (!active) return;
    await Promise.all([loadTags(active.id), loadModels(active.id)]);
  }

  async function scan() {
    if (!active || scanning) return;
    scanning = true;
    lastResult = null;
    try {
      await invoke<ScanResult>("scan_library", { libraryId: active.id });
    } catch (e) {
      console.error("scan failed", e);
    } finally {
      scanning = false;
      progress = null;
      await Promise.all([loadModels(active.id), loadTags(active.id)]);
    }
  }

  // Reload models + tags whenever the active library changes.
  $effect(() => {
    if (active) {
      selectedId = null;
      selectedTagId = null;
      loadModels(active.id);
      loadTags(active.id);
    }
  });

  onMount(() => {
    listen<ScanProgress>("scan:progress", (e) => {
      progress = e.payload;
    }).then((fn) => (unlistenProgress = fn));
    listen<ScanResult>("scan:complete", (e) => {
      lastResult = e.payload;
    }).then((fn) => (unlistenComplete = fn));

    return () => {
      unlistenProgress?.();
      unlistenComplete?.();
    };
  });

  const selectedModel = $derived(models.find((m) => m.id === selectedId) ?? null);

  const pct = $derived(
    progress && progress.total > 0
      ? Math.round((progress.processed / progress.total) * 100)
      : 0,
  );
</script>

<div class="flex h-full w-full">
  <aside class="app-chrome flex w-60 flex-col border-r border-border bg-surface-raised">
    <div class="border-b border-border px-4 py-3">
      <div class="text-sm font-semibold tracking-wide text-primary">CATWALK</div>
    </div>
    <nav class="flex-1 overflow-y-auto p-2">
      <div class="px-2 py-1 text-xs uppercase tracking-wider text-muted">Libraries</div>
      {#each libraries as lib (lib.id)}
        <button
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-overlay {active?.id === lib.id ? 'bg-surface-overlay text-fg' : 'text-muted'}"
          onclick={() => (activeId = lib.id)}
        >
          <Library size={14} />
          <span class="truncate">{lib.name}</span>
        </button>
      {/each}
      <div class="mt-4 flex items-center justify-between px-2 py-1">
        <span class="text-xs uppercase tracking-wider text-muted">Tags</span>
        {#if selectedTagId}
          <button
            class="flex items-center gap-0.5 text-xs text-muted hover:text-fg"
            onclick={() => toggleTag(selectedTagId!)}
            title="Clear filter"
          >
            <X size={11} /> Clear
          </button>
        {/if}
      </div>
      {#if tags.length === 0}
        <div class="px-2 py-1 text-sm text-muted">No tags yet</div>
      {:else}
        {#each tags as tag (tag.id)}
          <button
            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-overlay {selectedTagId === tag.id ? 'bg-surface-overlay text-fg' : 'text-muted'}"
            onclick={() => toggleTag(tag.id)}
          >
            <span class="size-2 shrink-0 rounded-full" style="background-color: {tagHex(tag.color)}"></span>
            <span class="truncate">{tag.name}</span>
            <span class="ml-auto shrink-0 text-xs text-muted">{tag.count}</span>
          </button>
        {/each}
      {/if}
    </nav>
    <div class="border-t border-border p-2">
      <button class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted hover:bg-surface-overlay hover:text-fg">
        <Settings size={14} /> Settings
      </button>
    </div>
  </aside>

  <main class="flex flex-1 flex-col">
    <header class="app-chrome flex items-center justify-between border-b border-border px-6 py-3">
      <div>
        <div class="text-sm text-muted">Library</div>
        <h1 class="text-lg font-semibold">{active?.name ?? "—"}</h1>
      </div>
      <div class="flex items-center gap-4">
        <div class="text-right">
          <div class="text-xs text-muted">{active?.root_path}</div>
          <div class="text-xs text-muted">
            {models.length} model{models.length === 1 ? "" : "s"}
            {#if lastResult}
              · +{lastResult.added} ~{lastResult.updated} −{lastResult.removed}
            {/if}
          </div>
        </div>
        <button
          class="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-fg disabled:opacity-50"
          onclick={scan}
          disabled={scanning}
        >
          {#if scanning}
            <Loader size={14} class="animate-spin" /> Scanning…
          {:else}
            <RefreshCw size={14} /> Scan now
          {/if}
        </button>
      </div>
    </header>

    {#if scanning && progress}
      <div class="border-b border-border bg-surface-raised px-6 py-2">
        <div class="mb-1 flex justify-between text-xs text-muted">
          <span class="capitalize">{progress.phase}{progress.current ? `: ${progress.current}` : ""}</span>
          <span>{progress.processed}/{progress.total || "?"}</span>
        </div>
        <div class="h-1 w-full overflow-hidden rounded-full bg-surface-overlay">
          <div class="h-full bg-primary transition-all" style="width: {pct}%"></div>
        </div>
      </div>
    {/if}

    <div class="flex flex-1 overflow-hidden">
      <section class="flex-1 overflow-y-auto p-6">
        {#if loadingModels}
          <div class="flex h-full items-center justify-center text-muted">Loading models…</div>
        {:else if models.length === 0}
          <div class="flex h-full flex-col items-center justify-center text-muted">
            <Box size={32} class="mb-3 opacity-50" />
            <p>No models indexed yet.</p>
            <p class="text-sm">Hit <span class="text-fg">Scan now</span> to index this library.</p>
          </div>
        {:else}
          <ModelGrid {models} bind:selectedId />
        {/if}
      </section>

      {#if selectedModel}
        <div class="w-96 shrink-0">
          <DetailPane model={selectedModel} onClose={() => (selectedId = null)} {onTagsChanged} />
        </div>
      {/if}
    </div>
  </main>
</div>
