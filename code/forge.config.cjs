const { join } = require("node:path");
const { ignoreDevelopmentContent, trimElectronLocales } = require("./scripts/desktop-package-content.cjs");

module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: "cn.figo.agent",
    icon: join(__dirname, "assets/figo-agent.icns"),
    ...(process.env.FIGO_ELECTRON_ZIP_DIR ? { electronZipDir: process.env.FIGO_ELECTRON_ZIP_DIR } : {}),
    ignore: ignoreDevelopmentContent,
    afterExtract: [trimElectronLocales]
  },
  makers: [{ name: "@electron-forge/maker-zip", platforms: ["darwin"] }]
};
