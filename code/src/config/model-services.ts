export const modelFamilies = ["minimax", "deepseek", "gpt-official", "gpt-relay"] as const;
export type ModelFamily = typeof modelFamilies[number];

export const officialUrls: Record<Exclude<ModelFamily, "gpt-relay">, string> = {
  minimax: "https://api.minimaxi.com/v1",
  deepseek: "https://api.deepseek.com",
  "gpt-official": "https://api.openai.com/v1"
};
