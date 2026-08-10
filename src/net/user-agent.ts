import packageJson from "../../package.json" with { type: "json" };

/** App identity for BIP14 version user agent (from package.json). */
export const APP_NAME = packageJson.name;
export const APP_VERSION = packageJson.version;
