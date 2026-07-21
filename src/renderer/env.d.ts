/// <reference types="vite/client" />
import type { OrbitAPI } from "../shared/contracts";
declare global { interface Window { orbit: OrbitAPI } }
export {};
