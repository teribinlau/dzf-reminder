/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_APP_VERSION?: string;
  /** 「仓库」页嵌的 SKU 网站；不填 = https://sku-kuwei.vercel.app（只在本地测试时换） */
  readonly VITE_SKU_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
