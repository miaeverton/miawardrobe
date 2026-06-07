import Anthropic from "@anthropic-ai/sdk";
import {
  MODEL, MAX_TOKENS, TIMEOUT_MS, CORS,
  loadWardrobe, getStyleContext, getFeedbackExcerpt,
  filterWardrobe, formatItems, enrichOutfits,
  OUTPUT_SCHEMA, withTimeout, parseClaudeJSON,
} from "./_shared.js";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };

  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not set. Add it in Netlify → Site configuration → Environment variables, then redeploy." }) };
  }

  let prompt, count, recentFeedback, preferenceRules;
  try {
    ({ prompt, count = 3, recentFeedback = [], preferenceRules = [] } = JSON.parse(event.body || "{}"));
  } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON body" }) }; }

  if (!prompt?.trim()) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "prompt is required" }) };

  const outfitCount = Math.min(Math.max(parseInt(count) || 3, 1), 8);
  const { wardrobe, wardrobeMap } = loadWardrobe();
  const filtered = filterWardrobe(prompt, wardrobe);

  console.log("[generate-outfits]", JSON.stringify({ model: MODEL, promptLen: prompt.length, items: filtered.length, outfitCount, feedbackEvents: recentFeedback.length, prefRules: preferenceRules.length }));

  // Build preference context from stored feedback
  const prefContext = buildPrefContext(recentFeedback, preferenceRules);

  const system = buildSystem(filtered, prefContext);
  const user = `Generate ${outfitCount} outfit${outfitCount !== 1 ? "s" : ""} for: "${prompt.trim()}"\nJSON only.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await withTimeout(
      client.messages.create({ model: MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: "user", content: user }] }),
      TIMEOUT_MS
    );

    const raw = response.content[0].text;
    console.log("[generate-outfits] response chars:", raw.length);

    let parsed;
    try { parsed = parseClaudeJSON(raw); }
    catch (e) {
      console.error("[generate-outfits] parse error:", e.message, raw.slice(0, 200));
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Claude returned malformed JSON. Please try again." }) };
    }

    parsed.outfits = enrichOutfits(parsed.outfits || [], wardrobeMap);
    console.log("[generate-outfits] success | outfits:", parsed.outfits.length);

    return { statusCode: 200, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(parsed) };

  } catch (err) {
    if (err.message === "TIMEOUT") {
      console.error("[generate-outfits] timeout");
      return { statusCode: 504, headers: CORS, body: JSON.stringify({ error: "Request timed out. Try asking for 3 outfits or a shorter prompt." }) };
    }
    console.error("[generate-outfits] error:", { message: err.message, status: err.status });
    return { statusCode: err.status || 500, headers: CORS, body: JSON.stringify({ error: `Generation failed: ${err.message}` }) };
  }
};

function buildPrefContext(recentFeedback, preferenceRules) {
  const parts = [];
  if (preferenceRules.length) {
    parts.push("LEARNED PREFERENCES:\n" + preferenceRules.slice(-10).map(r => `- ${r.rule}`).join("\n"));
  }
  if (recentFeedback.length) {
    const summary = recentFeedback.slice(-8).map(e => `- ${e.type} on "${e.outfitName}"${e.itemIds?.length ? ` (items: ${e.itemIds.slice(0,3).join(",")})` : ""}`).join("\n");
    parts.push("RECENT FEEDBACK:\n" + summary);
  }
  return parts.join("\n\n");
}

function buildSystem(filtered, prefContext) {
  return `You are a personal AI stylist for Mia. Apply every rule exactly.

${getStyleContext()}

${getFeedbackExcerpt() ? "FEEDBACK OVERRIDES:\n" + getFeedbackExcerpt() + "\n" : ""}
${prefContext ? prefContext + "\n" : ""}
WARDROBE (ID|Name|Brand|Category|Color):
${formatItems(filtered)}

RESPONSE FORMAT — valid JSON only, no markdown fences:
${OUTPUT_SCHEMA}

HARD RULES: only use IDs from wardrobe · no DRS-001/DRS-002 unless prompt says formal · no SHO-028 · no belt on blazers · no repeat shoe/bag/outerwear across outfits · ≥1 underused item · rank #1=most stylist-likely`;
}
