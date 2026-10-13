export interface DesktopStartOptions {
  configRoot: string;
  workspaceRoot: string;
  staticRoot: string;
}

export type MainToService =
  | { type: "start"; options: DesktopStartOptions }
  | { type: "stop" }
  | { type: "status" }
  | { type: "pick-result"; id: string; path: string | null };

export type ServiceToMain =
  | { type: "ready"; url: string; accessCode: string; node: string; sqlite: string }
  | { type: "failed"; message: string }
  | { type: "stopped" }
  | { type: "status"; busy: boolean }
  | { type: "pick-request"; id: string };
