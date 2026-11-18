// These virtual compatibility modules are supplied by the OMP extension loader.
// No second copy of OMP or its catalog is installed alongside the extension.
declare module "@earendil-works/pi-ai" {
  export const getBundledProviders: unknown;
  export const getProviders: unknown;
  export const getModels: unknown;
  export const getBundledModels: unknown;
}
declare module "@earendil-works/pi-coding-agent" {
  export const getAgentDir: unknown;
}
