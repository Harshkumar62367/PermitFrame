import crypto from "node:crypto";
import fs from "node:fs/promises";

const KEY = process.env.LIVEPEER_MCP_BEARER;
const ENDPOINT = process.env.LIVEPEER_MCP_URL ?? "https://agent.livepeer.org/api/mcp/raw";

async function rpc(method, params, sessionId) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(KEY ? { authorization: `Bearer ${KEY}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params })
  });
  const sid = res.headers.get("mcp-session-id");
  const text = await res.text();
  if (text.includes("data:")) {
    const line = text.split("\n").filter((l) => l.startsWith("data:")).at(-1);
    return { payload: JSON.parse(line.slice(5).trim()), sessionId: sid ?? sessionId };
  }
  return { payload: JSON.parse(text), sessionId: sid ?? sessionId };
}

function extractUrl(payload) {
  const s = payload.result?.structuredContent ?? {};
  for (const k of ["url", "output_url", "image_url"]) {
    if (typeof s[k] === "string" && s[k].startsWith("http")) return s[k];
  }
  const text = (payload.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  const urls = extractUrls(text);
  return urls.find((u) => /\.(png|jpe?g|webp)(\?|$)/i.test(u)) ?? urls.at(-1);
}

function extractUrls(text) {
  return text.split(/[\s"'<>)]+/).filter((t) => t.startsWith("http"));
}

async function generate(name, prompt, aspect) {
  let sessionId;
  const init = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "permitframe-bg", version: "0.1.0" }
  });
  sessionId = init.sessionId;

  console.log(`[${name}] generating (${aspect})…`);
  const r = await rpc(
    "tools/call",
    {
      name: "run_capability",
      arguments: {
        capability: "flux-schnell",
        prompt,
        inputs: { aspect_ratio: aspect },
        timeout: 120,
        async: false,
        persist: false,
        session_id: "permitframe_bg"
      }
    },
    sessionId
  );
  const url = extractUrl(r.payload);
  if (!url) throw new Error(`[${name}] no url: ` + JSON.stringify(r.payload).slice(0, 300));
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const out = `public/bg/${name}.jpg`;
  await fs.writeFile(out, buf);
  console.log(`[${name}] saved ${out} (${(buf.length / 1024).toFixed(0)} KB)`);
}

const [,, which] = process.argv;
if (!which || which === "hero") {
  await generate(
    "hero",
    "Abstract premium dark background for a technology website hero, deep charcoal black with soft flowing emerald green aurora light ribbons, smooth silk gradient waves, very subtle film grain, cinematic elegant minimal, no text, no objects",
    "21:9"
  ).catch(async (e) => {
    console.error(e.message.slice(0, 200), "— retrying 16:9");
    await generate("hero", "Abstract premium dark background, deep charcoal black with soft flowing emerald green aurora light ribbons, smooth silk gradient waves, subtle film grain, cinematic elegant minimal, no text", "16:9");
  });
}
if (!which || which === "paper") {
  await generate(
    "paper",
    "Minimal abstract light cream paper texture background with an extremely subtle soft emerald green watercolor wash in one corner, airy, elegant, editorial, lots of empty space, no text",
    "21:9"
  );
}
console.log("done");
