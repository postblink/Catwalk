<script lang="ts">
  import { T } from "@threlte/core";
  import { OrbitControls } from "@threlte/extras";
  import * as THREE from "three";

  let {
    object,
    radius,
    wireframe = false,
  }: {
    object: THREE.Object3D | null;
    radius: number;
    wireframe?: boolean;
  } = $props();

  // Camera distance to comfortably frame a sphere of `radius` at fov 45°.
  const dist = $derived(Math.max(radius * 2.6, 1));

  // Toggle wireframe across all meshes in the loaded object.
  $effect(() => {
    object?.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const mat = child.material as THREE.MeshStandardMaterial;
        if (mat) mat.wireframe = wireframe;
      }
    });
  });
</script>

<T.PerspectiveCamera makeDefault position={[dist, dist * 0.8, dist]} fov={45} near={0.01} far={dist * 100}>
  <OrbitControls enableDamping dampingFactor={0.08} target={[0, 0, 0]} />
</T.PerspectiveCamera>

<T.AmbientLight intensity={0.55} />
<T.HemisphereLight args={[0xbd93f9, 0x282a36, 0.5]} />
<T.DirectionalLight position={[dist, dist * 1.5, dist * 0.5]} intensity={1.3} castShadow={false} />
<T.DirectionalLight position={[-dist, dist * 0.5, -dist]} intensity={0.4} />

{#if object}
  <T is={object} />
  <T.GridHelper args={[radius * 5, 24, 0x44475a, 0x343746]} position.y={-radius} />
{/if}
