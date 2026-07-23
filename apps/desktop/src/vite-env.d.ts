/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SILVERFISH_RELAY_URL?: string;
  readonly VITE_CO_DEX_RELAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
