<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
  import { FolderOpen, FolderPlus, Sparkles, ChevronRight } from "lucide-svelte";
  import type { SlicerCandidate } from "$lib/types";

  let { onComplete }: { onComplete: () => void } = $props();

  let mode = $state<"choose" | "create" | "import" | "detect" | "working">("choose");
  let error = $state<string | null>(null);
  let candidates = $state<SlicerCandidate[]>([]);
  let newDirParent = $state<string | null>(null);
  let newDirName = $state("3D Models");
  let libraryName = $state("My Library");

  async function pickExistingDirectory() {
    error = null;
    const selected = await open({ directory: true, multiple: false, title: "Choose library folder" });
    if (typeof selected !== "string") return;
    await createLibrary(libraryName, selected);
  }

  async function pickNewDirParent() {
    error = null;
    const selected = await open({ directory: true, multiple: false, title: "Choose where to create the library folder" });
    if (typeof selected !== "string") return;
    newDirParent = selected;
  }

  async function createNewDir() {
    if (!newDirParent || !newDirName.trim()) return;
    error = null;
    mode = "working";
    try {
      const fullPath = await invoke<string>("create_library_dir", {
        parent: newDirParent,
        name: newDirName.trim(),
      });
      await createLibrary(libraryName, fullPath);
    } catch (e) {
      error = String(e);
      mode = "create";
    }
  }

  async function detectSlicers() {
    error = null;
    mode = "detect";
    candidates = await invoke<SlicerCandidate[]>("detect_slicer_libraries");
  }

  async function useCandidate(c: SlicerCandidate) {
    await createLibrary(c.label, c.path);
  }

  async function createLibrary(name: string, root: string) {
    mode = "working";
    try {
      await invoke("create_library", { name, rootPath: root });
      onComplete();
    } catch (e) {
      error = String(e);
      mode = "choose";
    }
  }
</script>

<div class="app-chrome flex h-full w-full items-center justify-center p-8">
  <div class="w-full max-w-2xl rounded-xl border border-border bg-surface-raised p-8 shadow-2xl">
    <div class="mb-6 flex items-center gap-3">
      <div class="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-primary-fg">
        <Sparkles size={20} />
      </div>
      <div>
        <h1 class="text-xl font-semibold">Welcome to Catwalk</h1>
        <p class="text-sm text-muted">Let's set up your first model library.</p>
      </div>
    </div>

    {#if error}
      <div class="mb-4 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
        {error}
      </div>
    {/if}

    {#if mode === "choose"}
      <div class="space-y-2">
        <button
          class="group flex w-full items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 text-left hover:border-primary"
          onclick={() => (mode = "create")}
        >
          <div class="flex items-center gap-3">
            <FolderPlus size={20} class="text-primary" />
            <div>
              <div class="font-medium">Create a new library folder</div>
              <div class="text-sm text-muted">Make a fresh directory anywhere on disk.</div>
            </div>
          </div>
          <ChevronRight size={16} class="text-muted group-hover:text-fg" />
        </button>

        <button
          class="group flex w-full items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 text-left hover:border-primary"
          onclick={pickExistingDirectory}
        >
          <div class="flex items-center gap-3">
            <FolderOpen size={20} class="text-cyan" />
            <div>
              <div class="font-medium">Use an existing folder</div>
              <div class="text-sm text-muted">Point Catwalk at a folder you already have.</div>
            </div>
          </div>
          <ChevronRight size={16} class="text-muted group-hover:text-fg" />
        </button>

        <button
          class="group flex w-full items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 text-left hover:border-primary"
          onclick={detectSlicers}
        >
          <div class="flex items-center gap-3">
            <Sparkles size={20} class="text-pink" />
            <div>
              <div class="font-medium">Detect common slicer folders</div>
              <div class="text-sm text-muted">Find Bambu Studio, OrcaSlicer, PrusaSlicer, Cura.</div>
            </div>
          </div>
          <ChevronRight size={16} class="text-muted group-hover:text-fg" />
        </button>
      </div>
    {:else if mode === "create"}
      <div class="space-y-4">
        <label class="block">
          <span class="text-sm text-muted">Library name</span>
          <input
            type="text"
            bind:value={libraryName}
            class="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 focus:border-primary focus:outline-none"
          />
        </label>
        <label class="block">
          <span class="text-sm text-muted">Folder name</span>
          <input
            type="text"
            bind:value={newDirName}
            class="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 focus:border-primary focus:outline-none"
          />
        </label>
        <div>
          <span class="text-sm text-muted">Parent location</span>
          <button
            class="mt-1 flex w-full items-center justify-between rounded-md border border-border bg-surface px-3 py-2 text-left hover:border-primary"
            onclick={pickNewDirParent}
          >
            <span class="truncate">{newDirParent ?? "Choose…"}</span>
            <FolderOpen size={16} class="text-muted" />
          </button>
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <button class="rounded-md px-4 py-2 text-muted hover:text-fg" onclick={() => (mode = "choose")}>Back</button>
          <button
            class="rounded-md bg-primary px-4 py-2 font-medium text-primary-fg disabled:opacity-40"
            disabled={!newDirParent || !newDirName.trim()}
            onclick={createNewDir}
          >
            Create library
          </button>
        </div>
      </div>
    {:else if mode === "detect"}
      <div class="space-y-2">
        {#if candidates.length === 0}
          <div class="rounded-md border border-border bg-surface p-4 text-sm text-muted">
            Scanning… if nothing appears, no known slicer folders were found.
          </div>
        {:else}
          {#each candidates as c (c.path)}
            <button
              class="flex w-full items-center justify-between rounded-md border border-border bg-surface px-4 py-3 text-left hover:border-primary disabled:opacity-40"
              disabled={!c.exists}
              onclick={() => useCandidate(c)}
            >
              <div>
                <div class="font-medium">{c.label}</div>
                <div class="text-xs text-muted">{c.path}</div>
              </div>
              <span class="text-xs uppercase tracking-wide {c.exists ? 'text-success' : 'text-muted'}">
                {c.exists ? "found" : "not found"}
              </span>
            </button>
          {/each}
        {/if}
        <div class="flex justify-end pt-2">
          <button class="rounded-md px-4 py-2 text-muted hover:text-fg" onclick={() => (mode = "choose")}>Back</button>
        </div>
      </div>
    {:else if mode === "working"}
      <div class="py-8 text-center text-muted">Setting up your library…</div>
    {/if}
  </div>
</div>
