module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: "cn.figo.agent",
    ...(process.env.FIGO_ELECTRON_ZIP_DIR ? { electronZipDir: process.env.FIGO_ELECTRON_ZIP_DIR } : {}),
    ignore: (path) => {
      const normalized = path.replaceAll("\\", "/");
      return /(^|\/)figo-agent\.config\.json$/.test(normalized) ||
        /(^|\/)\.figo-agent(\/|$)/.test(normalized) ||
        /(^|\/)node_modules(\/|$)/.test(normalized) ||
        /(^|\/)(src|tests|e2e|docs)(\/|$)/.test(normalized) ||
        /(^|\/)web\/(src|node_modules)(\/|$)/.test(normalized) ||
        /(^|\/)(\.env[^/]*|\.DS_Store)$/.test(normalized);
    }
  },
  makers: [{ name: "@electron-forge/maker-zip", platforms: ["darwin"] }]
};
