<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { Canvas } from "@threlte/core";
  import * as THREE from "three";
  import { Loader, Box, Grid3x3, AlertTriangle } from "lucide-svelte";
  import ViewerScene from "./ViewerScene.svelte";
  import { parseModel } from "$lib/three/loadModel";

  let { modelId, extension }: { modelId: string; extension: string } = $props();

  let object = $state<THREE.Object3D | null>(null);
  let radius = $state(1);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let wireframe = $state(false);

  async function load(id: string, ext: string) {
    loading = true;
    error = null;
    object = null;
    try {
      // Raw bytes come back as an ArrayBuffer (the command returns tauri Response).
      const buffer = await invoke<ArrayBuffer>("read_model_file", { modelId: id });
      const result = parseModel(buffer, ext);
      radius = result.radius;
      object = result.object;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (modelId) load(modelId, extension);
  });
</script>

<div class="relative h-full w-full bg-surface">
  {#if error}
    <div class="flex h-full flex-col items-center justify-center gap-2 text-muted">
      <AlertTriangle size={28} class="text-warning" />
      <p class="max-w-xs text-center text-sm">{error}</p>
    </div>
  {:else}
    <Canvas>
      <ViewerScene {object} {radius} {wireframe} />
    </Canvas>

    {#if loading}
      <div class="absolute inset-0 flex items-center justify-center bg-surface/60">
        <Loader size={24} class="animate-spin text-primary" />
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
      <div class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted">
        <Box size={14} /> ⌀ {(radius * 2).toFixed(1)} units
      </div>
    </div>
  {/if}
</div>
