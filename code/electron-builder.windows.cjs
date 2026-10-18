module.exports = {
  appId: "cn.figo.agent",
  productName: "Figo Agent",
  directories: { output: "out/make/nsis/win32/x64", buildResources: "assets" },
  artifactName: "Figo-Agent-Setup-${version}-${arch}.${ext}",
  publish: null,
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "assets/figo-agent.ico",
    signExecutable: false
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    selectPerMachineByDefault: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    installerLanguages: ["zh_CN"],
    language: "2052",
    runAfterFinish: false
  }
};
