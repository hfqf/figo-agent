const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("figoSetup", {
  read: () => ipcRenderer.invoke("figo-setup:read"),
  saveModel: (input) => ipcRenderer.invoke("figo-setup:save-model", input),
  discoverModels: (input) => ipcRenderer.invoke("figo-setup:discover-models", input),
  pickWorkspace: () => ipcRenderer.invoke("figo-setup:pick-workspace"),
  openWorkspace: (path) => ipcRenderer.invoke("figo-setup:open-workspace", path)
});
