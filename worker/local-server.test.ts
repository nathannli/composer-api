import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";

const port = 20_000 + (process.pid % 10_000);
const baseUrl = `http://127.0.0.1:${port}`;
let child: ReturnType<typeof spawn>;

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for allowlist test server");
}

describe("local server model allowlist", () => {
  beforeAll(async () => {
    child = spawn("bun", ["run", "server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        CURSOR_API_KEY: "",
        LOCAL_API_KEY: "",
        CURSOR_SDK_BRIDGE_URL: "http://127.0.0.1:1/sdk",
        COMPOSER_API_MODELS: "composer-2.5,grok-4.5"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    await waitForServer();
  }, 15_000);

  afterAll(() => {
    child?.kill("SIGTERM");
  });

  it("emits only configured models", async () => {
    const response = await fetch(`${baseUrl}/v1/models`);
    const body = await response.json() as { data: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(body.data.map((model) => model.id)).toEqual(["composer-2.5", "grok-4.5"]);
  });

  it.each(["/v1/chat/completions", "/v1/responses"])("rejects unlisted models on %s", async (path) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.3-codex",
        ...(path.includes("chat")
          ? { messages: [{ role: "user", content: "must not reach bridge" }] }
          : { input: "must not reach bridge" })
      })
    });
    const body = await response.json() as { error: { code: string; param: string; message: string } };

    expect(response.status).toBe(404);
    expect(body.error).toMatchObject({
      code: "model_not_found",
      param: "model",
      message: "The model 'gpt-5.3-codex' does not exist"
    });
  });
});
