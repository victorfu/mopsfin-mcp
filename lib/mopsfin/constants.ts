export const MOPSFIN_BASE_URL = "https://mopsfin.twse.com.tw";
export const MOPSFIN_SOURCE_URL = `${MOPSFIN_BASE_URL}/`;
export const MOPSFIN_TERMS_URL = `${MOPSFIN_BASE_URL}/terms`;

export const CATALOG_TTL_MS = 5 * 60 * 1000;
export const UPSTREAM_TIMEOUT_MS = 20_000;
export const UPSTREAM_RETRY_DELAY_MS = 250;

export const ALLOWED_GET_PATHS = ["/", "/suggestCompany", "/terms"] as const;
export const ALLOWED_POST_PATHS = [
  "/compare/data",
  "/compare/report",
  "/compare/bcode",
  "/compare/xb",
  "/compare/fin",
  "/compare/adequacy",
] as const;

export type AllowedGetPath = (typeof ALLOWED_GET_PATHS)[number];
export type AllowedPostPath = (typeof ALLOWED_POST_PATHS)[number];
