import { KimiClient } from "./kimi-client.mjs";
import { VertexGeminiClient } from "./vertex-gemini-client.mjs";

export function createAiClient(config, fetchImpl = fetch) {
  let client = null;
  let provider = "";
  const current = () => {
    if (!client || provider !== config.provider) {
      provider = config.provider;
      client = provider === "vertex" ? new VertexGeminiClient(config, fetchImpl) : new KimiClient(config, fetchImpl);
    }
    return client;
  };
  return {
    get enabled() { return current().enabled; },
    completeJson(input) { return current().completeJson(input); },
    imageParts(assets) { return current().imageParts(assets); },
    videoParts(assets) { return current().videoParts(assets); },
  };
}
