import { describe, expect, it } from "vitest";
import { zhCN } from "../../src/i18n/catalog.js";

describe("desktop locale", () => {
  it("keeps native menu and dialog copy in the Chinese catalog", () => {
    const copy = zhCN.desktop;
    expect(copy).toBeDefined();
    for (const key of [
      "startupFailed", "chooseWorkspace", "serviceExited", "fileMenu", "openModelConfig",
      "importOldConfig", "modelSetupTitle", "modelKeyMissing", "importOldConfigButton",
      "openConfigButton", "laterButton", "chooseLegacyConfig", "importCompleteTitle",
      "importCompleteMessage", "importFailedTitle", "importFailedMessage", "busyExitTitle",
      "busyExitMessage", "waitButton", "forceQuitButton"
    ] as const) {
      expect(typeof copy[key]).toBe("string");
      expect(copy[key].trim()).not.toBe("");
    }
  });
});
