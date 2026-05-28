<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import FirstLaunch from "$lib/components/FirstLaunch.svelte";
  import LibraryShell from "$lib/components/LibraryShell.svelte";
  import type { Library } from "$lib/types";

  let libraries = $state<Library[]>([]);
  let loading = $state(true);

  async function refresh() {
    libraries = await invoke<Library[]>("list_libraries");
    loading = false;
  }

  onMount(refresh);
</script>

{#if loading}
  <div class="flex h-full w-full items-center justify-center text-muted">
    Loading…
  </div>
{:else if libraries.length === 0}
  <FirstLaunch onComplete={refresh} />
{:else}
  <LibraryShell {libraries} />
{/if}
