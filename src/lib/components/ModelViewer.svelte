<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { Canvas } from "@threlte/core";
  import * as THREE from "three";
  import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
  import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
  import { Loader, Box, Grid3x3, AlertTriangle } from "lucide-svelte";
  import ViewerScene from "./ViewerScene.svelte";

  let { modelId, extension }: { modelId: string; extension: string } = $props();

  let object = $state<THREE.Object3D | null>(null);
  let radius = $state(1);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let wireframe = $state(false);

  function makeMaterial(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color: 0xbd93f9,
      metalness: 0.1,
      roughness: 0.55,
      flatShading: false,
    });
  }

  async function load(id: string, ext: string) {
    loading = true;
    error = null;
    object = null;
    try {
      const bytes = await invoke<number[]>("read_model_file", { modelId: id });
      const buffer = new Uint8Array(bytes).buffer;

      let parsed: THREE.Object3D;
      if (ext === "stl") {
        const geo = new STLLoader().parse(buffer);
        geo.computeVertexNormals();
        parsed = new THREE.Mesh(geo, makeMaterial());
      } else if (ext === "obj") {
        const text = new TextDecoder().decode(buffer);
        parsed = new OBJLoader().parse(text);
        parsed.traverse((c) => {
          if (c instanceof THREE.Mesh) c.material = makeMaterial();
        });
      } else {
        throw new Error(`Preview not supported for .${ext}`);
      }

      // Wrap in a pivot so we can reorient + recenter cleanly.
      const pivot = new THREE.Group();
      pivot.add(parsed);
      // STLs from slicers are Z-up; convert to three.js Y-up so models stand up.
      if (ext === "stl") pivot.rotation.x = -Math.PI / 2;
      pivot.updateMatrixWorld(true);

      const box = new THREE.Box3().setFromObject(pivot);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      // Shift so the bounding sphere center sits at the origin.
      pivot.position.sub(sphere.center);
      pivot.updateMatrixWorld(true);

      radius = sphere.radius || 1;
      object = pivot;
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
