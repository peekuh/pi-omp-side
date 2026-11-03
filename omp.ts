import { registerSide } from "./src/extension.ts";
import type { SideAPI } from "./src/types.ts";

export default function side(api: SideAPI): void {
  registerSide(api, "omp");
}
