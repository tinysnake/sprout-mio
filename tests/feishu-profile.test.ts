import { expect, it } from "vite-plus/test";
import type { FeishuHttpTransport } from "../src/server/feishu/emission";
import { fetchFeishuNickname, MAX_NICKNAME_CHARS } from "../src/server/feishu/profile";

const config = { origin: "https://open.feishu.cn" };
const tokens = { get: async () => "t-1" };

function transport(reply: { status: number; body: string }) {
  const calls: Parameters<FeishuHttpTransport>[0][] = [];
  const fake: FeishuHttpTransport = (input) => {
    calls.push(input);
    return { initiated: true, response: Promise.resolve(reply), abort: () => {} };
  };
  return { fake, calls };
}

it("reads the account name with a tenant token", async () => {
  const { fake, calls } = transport({
    status: 200,
    body: JSON.stringify({ code: 0, data: { user: { name: "  张三  " } } }),
  });
  const nickname = await fetchFeishuNickname({ config, transport: fake, tokens, openId: "ou_abc" });
  expect(nickname).toBe("张三");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    method: "GET",
    url: "https://open.feishu.cn/open-apis/contact/v3/users/ou_abc?user_id_type=open_id",
    headers: { authorization: "Bearer t-1" },
  });
});

it("falls back to null for every unresolved lookup", async () => {
  const responses = [
    { status: 403, body: JSON.stringify({ code: 99_914 }) },
    { status: 200, body: "not json" },
    { status: 200, body: JSON.stringify({ code: 0, data: { user: {} } }) },
    { status: 200, body: JSON.stringify({ code: 0, data: { user: { name: "   " } } }) },
  ];
  for (const reply of responses) {
    const { fake } = transport(reply);
    expect(await fetchFeishuNickname({ config, transport: fake, tokens, openId: "ou_abc" })).toBe(
      null,
    );
  }
  const failingTokens = {
    get: async () => {
      throw new Error("token_unavailable");
    },
  };
  const { fake } = transport({ status: 200, body: "{}" });
  expect(
    await fetchFeishuNickname({ config, transport: fake, tokens: failingTokens, openId: "ou_abc" }),
  ).toBe(null);
});

it("skips the platform call for a blank open id and caps long names", async () => {
  const { fake, calls } = transport({ status: 200, body: "{}" });
  expect(await fetchFeishuNickname({ config, transport: fake, tokens, openId: "  " })).toBe(null);
  expect(calls).toHaveLength(0);

  const long = "名".repeat(MAX_NICKNAME_CHARS + 10);
  const longCall = transport({
    status: 200,
    body: JSON.stringify({ code: 0, data: { user: { name: long } } }),
  });
  expect(
    await fetchFeishuNickname({ config, transport: longCall.fake, tokens, openId: "ou_abc" }),
  ).toBe("名".repeat(MAX_NICKNAME_CHARS));
});
