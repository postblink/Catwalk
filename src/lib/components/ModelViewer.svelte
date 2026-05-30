<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { Canvas } from "@threlte/core";
  import type * as THREE from "three";
  import { Loader, Box, Grid3x3, AlertTriangle, Maximize2, X } from "lucide-svelte";
  import ViewerScene from "./ViewerScene.svelte";
  import { loadPreview } from "$lib/three/previewLoader";

  let { modelId, extension }: { modelId: string; extension: string } = $props();

  let object = $state<THREE.Object3D | null>(null);
  let radius = $state(1);
  let loading = $state(false);
  let error = $state<string | null>(null);
  // The model's thumbnail (embedded PNG for 3MF, generated for STL/OBJ). Shown
  // as a placeholder during the parse and as the fallback image if parsing fails.
  let thumbUrl = $state<string | null>(null);
  let wireframe = $state(false);
  let expanded = $state(false);

  // Monotonic token guarding against a stale async load applying after the
  // model changed or the component unmounted (resolved-out-of-order races).
  let loadToken = 0;

  function revokeThumb() {
    if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    thumbUrl = null;
  }

  // Best-effort thumbnail fetch. Cheap relative to the parse, so we use it to
  // paint the model's general shape immediately while the heavy parse runs.
  async function fetchThumbnail(id: string): Promise<string | null> {
    try {
      const buf = await invoke<ArrayBuffer>("read_thumbnail", { modelId: id });
      return URL.createObjectURL(new Blob([buf], { type: "image/png" }));
    } catch {
      return null;
    }
  }

  async function load(id: string, ext: string) {
    const token = ++loadToken;
    loading = true;
    error = null;
    object = null;
    revokeThumb();

    // Race the thumbnail in alongside the parse so the user sees something the
    // moment they click, instead of an empty spinner while a big 3MF parses.
    fetchThumbnail(id).then((url) => {
      if (!url) return;
      // Drop it if a newer load superseded us, or the live view already arrived.
      if (token !== loadToken || object) {
        URL.revokeObjectURL(url);
        return;
      }
      thumbUrl = url;
    });

    try {
      // The preview loader yields to the event loop before the (main-thread)
      // parse so this spinner can paint, and serves cached/prefetched models
      // instantly. The returned object is owned by the cache — never dispose it.
      const result = await loadPreview(id, ext);
      if (token !== loadToken) return; // superseded by a newer load
      radius = result.radius;
      object = result.object;
      revokeThumb(); // interactive view is ready — drop the placeholder
    } catch (e) {
      if (token !== loadToken) return;
      error = String(e);
      // Keep the thumbnail (if it arrived) as the fallback image.
    } finally {
      if (token === loadToken) loading = false;
    }
  }

  $effect(() => {
    if (modelId) load(modelId, extension);
    return () => {
      // Invalidate any in-flight load so it can't write to freed state.
      loadToken++;
      revokeThumb();
    };
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && expanded) expanded = false;
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="relative h-full w-full bg-surface">
  {#if error && thumbUrl}
    <div class="flex h-full flex-col items-center justify-center gap-2 bg-surface">
      <img src={thumbUrl} alt="Embedded preview" class="h-full w-full object-contain p-4" />
      <p class="absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-surface-raised/90 px-2 py-1 text-xs text-muted">
        Embedded preview (interactive view unavailable)
      </p>
    </div>
  {:else if error}
    <div class="flex h-full flex-col items-center justify-center gap-2 text-muted">
      <AlertTriangle size={28} class="text-warning" />
      <p class="max-w-xs text-center text-sm">{error}</p>
    </div>
  {:else}
    <!-- Inline canvas. Hidden while expanded so the shared THREE.Object3D is
         never parented to two scenes at once (the modal mounts its own). -->
    {#if !expanded}
      <Canvas>
        <ViewerScene {object} {radius} {wireframe} />
      </Canvas>
    {/if}

    {#if loading}
      <div class="absolute inset-0 flex items-center justify-center bg-surface">
        {#if thumbUrl}
          <!-- Thumbnail placeholder so the user sees the model's shape while
               the interactive parse runs (dimmed under the spinner). -->
          <img src={thumbUrl} alt="Loading preview" class="h-full w-full object-contain p-4 opacity-50" />
        {/if}
        <div class="absolute inset-0 flex items-center justify-center bg-surface/30">
          <Loader size={24} class="animate-spin text-primary" />
        </div>
      </div>
    {/if}

    <!-- Viewer toolbar -->
    <div class="app-chrome absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-1 rounded-lg border border-border bg-surface-raised/90 p-1 backdrop-blur">
      <button
        class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs hover:bg-surface-overlay {wireframe ? 'text-primary' : 'text-muted'}"
        onclick={() => (wireframe = !wireframe)}
        title="Toggle wireframe"
      >
        <Grid3x3 size={14} /> Wireframe
      </button>
      <button
        class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted hover:bg-surface-overlay"
        onclick={() => (expanded = true)}
        title="Expand preview"
      >
        <Maximize2 size={14} /> Expand
      </button>
      <div class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted">
        <Box size={14} /> ⌀ {(radius * 2).toFixed(1)} units
      </div>
    </div>
  {/if}
</div>

<!-- Expanded preview modal: large centered viewer over a dimmed backdrop.
     Click-outside (the backdrop) or Esc closes it. Only mounts its Canvas
     while open, so the shared object moves cleanly between the two scenes. -->
{#if expanded}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    aria-label="Expanded model preview"
    tabindex="-1"
    onclick={(e) => {
      if (e.target === e.currentTarget) expanded = false;
    }}
    onkeydown={() => {}}
  >
    <div class="relative h-full w-full overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
      <Canvas>
        <ViewerScene {object} {radius} {wireframe} />
      </Canvas>

      <!-- Modal toolbar -->
      <div class="app-chrome absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-1 rounded-lg border border-border bg-surface-raised/90 p-1 backdrop-blur">
        <button
          class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs hover:bg-surface-overlay {wireframe ? 'text-primary' : 'text-muted'}"
          onclick={() => (wireframe = !wireframe)}
          title="Toggle wireframe"
        >
          <Grid3x3 size={14} /> Wireframe
        </button>
        <div class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted">
          <Box size={14} /> ⌀ {(radius * 2).toFixed(1)} units
        </div>
      </div>

      <!-- Close -->
      <button
        class="app-chrome absolute right-4 top-4 flex items-center gap-1.5 rounded-lg border border-border bg-surface-raised/90 px-2.5 py-1.5 text-xs text-muted backdrop-blur hover:bg-surface-overlay hover:text-foreground"
        onclick={() => (expanded = false)}
        title="Close (Esc)"
      >
        <X size={14} /> Close
      </button>
    </div>
  </div>
{/if}
