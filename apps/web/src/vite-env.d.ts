/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_ENABLE_DEV_LOGIN?: string;
  readonly VITE_DEV_PASSWORD?: string;
  readonly VITE_ENABLE_ON_DEVICE_ASR?: string;
  readonly VITE_ENABLE_WEB_SPEECH?: string;
  /** ADR-14: dedicated admin origin, e.g. https://admin.logbook.example. */
  readonly VITE_ADMIN_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*?raw' {
  const content: string;
  export default content;
}
