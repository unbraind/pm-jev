import { readFileSync } from "node:fs";

/** Public upstream template paired with a tiny byte-only BPE vocabulary for fast boundary tests. */
export function admissionMetadata(context = 65536, combinedLabels: readonly string[] = []): Record<string, unknown> {
  let extended = 256;
  const tokens = Array.from({ length: 256 }, (_, byte) => String.fromCharCode((byte >= 33 && byte <= 126) || (byte >= 161 && byte <= 172) || byte >= 174 ? byte : extended++));
  tokens.push("<|im_start|>", "<|im_end|>");
  const merges = combinedLabels.map(code => `${code[0]} ${code[1]}`);
  tokens.push(...combinedLabels);
  return { capabilities: ["decision"], parameters: `num_ctx ${context}`, model_info: {
    "general.architecture": "qwen35", "qwen35.context_length": 262144, "qwen35.decision.type": "pplx-decider",
    "tokenizer.chat_template.systemone": readFileSync(new URL("./fixtures/tev1-systemone.jinja", import.meta.url), "utf8"),
    "tokenizer.ggml.pre": "qwen35", "tokenizer.ggml.model": "gpt2", "tokenizer.ggml.add_bos_token": false, "tokenizer.ggml.add_eos_token": false,
    "tokenizer.ggml.tokens": tokens, "tokenizer.ggml.token_type": tokens.map((_, i) => i === 256 || i === 257 ? 3 : 1), "tokenizer.ggml.merges": merges,
  } };
}
