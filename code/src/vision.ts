// Screenshot facts via a vision LLM, validated with zod and cached by image content.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "./load.ts";
import { cachedStructured, makeClient, VISION_MODEL } from "./llm.ts";

export const VisionSchema = z.object({
  records: z.array(z.object({
    reference: z.string(), // resource id as printed, or another printed handle (file name, user_<n>) resolved via the data catalog
    email: z.string().nullable(),
    phone: z.string().nullable(),
    name: z.string().nullable(),
    user_id: z.string().nullable(),
    status: z.string().nullable(),
    detail: z.string().nullable(),
  })),
});
export type Vision = z.infer<typeof VisionSchema>;
export const VISION_PROMPT = readFileSync(join(REPO_ROOT, "code", "prompts", "vision.md"), "utf8");
export const visionMisses: string[] = [];

export async function extractImage(buf: Buffer, _sha: string, path: string): Promise<Vision> {
  const out = await cachedStructured(makeClient(), {
    purpose: "vision", model: VISION_MODEL, system: VISION_PROMPT, schema: VisionSchema, anyModelCache: true,
    content: [{ type: "image", mediaType: "image/png", base64: buf.toString("base64") }, { type: "text", text: `File: ${path.split("/").pop()}` }],
  });
  if (!out) visionMisses.push(path);
  return out ?? { records: [] };
}
