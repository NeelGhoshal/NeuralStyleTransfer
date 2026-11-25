/** strength 1 = the painting's look, 0 = the photo's own look. */
export function mix(photoLook: ArrayLike<number>, styleLook: ArrayLike<number>, strength: number) {
  return Float32Array.from({ length: 100 }, (_, i) => photoLook[i] * (1 - strength) + styleLook[i] * strength);
}
