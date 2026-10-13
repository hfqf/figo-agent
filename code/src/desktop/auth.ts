export interface DesktopCookie {
  name: "figo_sid";
  value: string;
}

export async function authenticateDesktop(url: string, accessCode: string): Promise<DesktopCookie> {
  const origin = new URL(url);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/") {
    throw new Error("桌面服务地址不是本机回环地址。");
  }
  const response = await fetch(new URL("/api/v1/auth", origin), {
    method: "POST", headers: { "content-type": "application/json", origin: origin.origin },
    body: JSON.stringify({ accessCode })
  });
  if (!response.ok) throw new Error("桌面本地认证失败。");
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const match = /^figo_sid=([A-Za-z0-9_-]+)$/.exec(cookie);
  if (!match) throw new Error("桌面服务未返回有效会话。");
  return { name: "figo_sid", value: match[1] };
}
