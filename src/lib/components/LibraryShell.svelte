<script lang="ts">
  import { Library, Tag, Settings } from "lucide-svelte";
  import type { Library as Lib } from "$lib/types";

  let { libraries }: { libraries: Lib[] } = $props();
  let activeId = $state<string | null>(null);
  let active = $derived(libraries.find((l) => l.id === activeId) ?? libraries[0]);
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
      <div class="mt-4 px-2 py-1 text-xs uppercase tracking-wider text-muted">Tags</div>
      <div class="px-2 py-1 text-sm text-muted">No tags yet</div>
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
      <div class="text-xs text-muted">{active?.root_path}</div>
    </header>
    <section class="flex-1 overflow-y-auto p-6">
      <div class="flex h-full flex-col items-center justify-center text-muted">
        <Tag size={32} class="mb-3 opacity-50" />
        <p>Library scanning coming next.</p>
      </div>
    </section>
  </main>
</div>
