<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { Box, Loader } from "lucide-svelte";
  import type { ModelRow } from "$lib/types";
  import { generateThumbnail } from "$lib/three/thumbnailer";

  let { model }: { model: ModelRow } = $props();

  let url = $state<string | null>(null);
  let rendering = $state(false);

  const renderable = (ext: string) => ext === "stl" || ext === "obj";

  // Resolve a thumbnail for this model:
  //  1. cached file  → fetch raw bytes via read_thumbnail
  //  2. STL/OBJ with no cache → render one offscreen (and persist it)
  //  3. otherwise → fall through to the Box placeholder
  $effect(() => {
    const current = model;
    let cancelled = false;
    let createdUrl: string | null = null;
    url = null;
    rendering = false;

    async function run() {
      if (current.thumbnail_path) {
        const buf = await invoke<ArrayBuffer>("read_thumbnail", {
          modelId: current.id,
        });
        if (cancelled) return;
        createdUrl = URL.createObjectURL(new Blob([buf], { type: "image/png" }));
        url = createdUrl;
        return;
      }

      if (renderable(current.extension)) {
        rendering = true;
        const u = await generateThumbnail(current);
        if (cancelled) {
          if (u) URL.revokeObjectURL(u);
          return;
        }
        rendering = false;
        if (u) {
          createdUrl = u; // generateThumbnail already created the object URL
          url = u;
        }
      }
    }

    run().catch(() => {
      if (!cancelled) {
        rendering = false;
        url = null;
      }
    });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
      url = null;
    };
  });
</script>

{#if url}
  <img src={url} alt={model.filename} class="h-full w-full object-contain" />
{:else if rendering}
  <Loader size={24} class="animate-spin text-muted opacity-50" />
{:else}
  <Box size={40} class="text-muted opacity-40 transition-opacity group-hover:opacity-70" />
{/if}
