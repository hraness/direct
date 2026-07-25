export const DIRECT_PACKAGE_VERSION = "0.5.1" as const;
export const DIRECT_PACKAGE_TAG = `v${DIRECT_PACKAGE_VERSION}` as const;
export const DIRECT_INSTALL_COMMAND =
  `bun add --dev github:hraness/direct#${DIRECT_PACKAGE_TAG}` as const;
