<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { Box } from "lucide-svelte";
  import type { ModelRow } from "$lib/types";

  let { model }: { model: ModelRow } = $props();

  let url = $state<string | null>(null);

  // Load the cached thumbnail bytes and expose them as a blob URL. Revoke the
  // previous URL whenever the model changes or the component is torn down.
  $effect(() => {
    if (!model.thumbnail_path) {
      url = null;
      return;
    }
    let revoked = false;
    let createdUrl: string | null = null;

    invoke<number[]>("read_thumbnail", { modelId: model.id })
      .then((bytes) => {
        if (revoked) return;
        const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
        createdUrl = URL.createObjectURL(blob);
        url = createdUrl;
      })
      .catch(() => {
        if (!revoked) url = null;
      });

    return () => {
      revoked = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
      url = null;
    };
  });
</script>

{#if url}
  <img src={url} alt={model.filename} class="h-full w-full object-contain" />
{:else}
  <Box size={40} class="text-muted opacity-40 transition-opacity group-hover:opacity-70" />
{/if}
