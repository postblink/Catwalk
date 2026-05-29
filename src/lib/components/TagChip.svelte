<script lang="ts" module>
  // Dracula token name → hex. Mirrors the @theme palette in app.css. We resolve
  // to hex here because Tailwind v4 can't statically extract dynamic class names
  // like `text-${color}`, so tag colors are applied via inline style instead.
  const TOKEN_HEX: Record<string, string> = {
    cyan: "#8be9fd",
    green: "#50fa7b",
    orange: "#ffb86c",
    pink: "#ff79c6",
    purple: "#bd93f9",
    red: "#ff5555",
    yellow: "#f1fa8c",
  };

  export function tagHex(color: string | null | undefined): string {
    return (color && TOKEN_HEX[color]) || "#6272a4"; // fall back to muted
  }
</script>

<script lang="ts">
  import { Check, X } from "lucide-svelte";

  let {
    name,
    color = null,
    confirmed = true,
    onConfirm = null,
    onRemove = null,
  }: {
    name: string;
    color?: string | null;
    /** Confirmed tags render solid; suggestions render dashed/dimmed. */
    confirmed?: boolean;
    onConfirm?: (() => void) | null;
    onRemove?: (() => void) | null;
  } = $props();

  const hex = $derived(tagHex(color));
</script>

<span
  class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs leading-tight {confirmed
    ? ''
    : 'border-dashed opacity-70'}"
  style="color: {hex}; border-color: {hex}66; background-color: {hex}1a;"
>
  <span class="max-w-[10rem] truncate">{name}</span>
  {#if onConfirm}
    <button
      class="-mr-0.5 rounded-full p-0.5 hover:bg-white/10"
      onclick={onConfirm}
      title="Confirm tag"
    >
      <Check size={11} />
    </button>
  {/if}
  {#if onRemove}
    <button
      class="-mr-0.5 rounded-full p-0.5 hover:bg-white/10"
      onclick={onRemove}
      title="Remove tag"
    >
      <X size={11} />
    </button>
  {/if}
</span>
