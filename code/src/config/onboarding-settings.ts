export type GuideId = "workbench" | "trace-inspector";
export interface OnboardingSettings { enabled: boolean; revision: string }
export interface OnboardingSnapshot extends OnboardingSettings { seen: GuideId[] }

export const defaultOnboardingSettings: OnboardingSettings = { enabled: true, revision: "1" };

export function readOnboardingSettings(value: unknown): OnboardingSettings {
  if (value === undefined) return { ...defaultOnboardingSettings };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("web.onboarding 必须是 JSON 对象。");
  const input = value as Record<string, unknown>;
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("web.onboarding.enabled 必须是布尔值。");
  if (input.revision !== undefined && (typeof input.revision !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.revision))) {
    throw new Error("web.onboarding.revision 必须是 1-64 位字母、数字、下划线或短横线。");
  }
  return { enabled: (input.enabled as boolean | undefined) ?? defaultOnboardingSettings.enabled, revision: (input.revision as string | undefined) ?? defaultOnboardingSettings.revision };
}
