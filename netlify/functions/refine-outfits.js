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
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not set." }) };
  }

  let originalPrompt, currentOutfits, feedback, conversationHistory, preferenceRules, recentFeedback;
  try {
    ({
      originalPrompt = "",
      currentOutfits = [],
      feedback = "",
      conversationHistory = [],
      preferenceRules = [],
      recentFeedback = [],
    } = JSON.parse(event.body || "{}"));
  } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON body" }) }; }

  if (!feedback?.trim()) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "feedback is required" }) };

  const { wardrobe, wardrobeMap } = loadWardrobe();

  // Use broader wardrobe for refinements — user might want to swap to any category
  const filtered = filterWardrobe(originalPrompt, wardrobe);

  console.log("[refine-outfits]", JSON.stringify({
    model: MODEL,
    feedbackLen: feedback.length,
    currentOutfits: currentOutfits.length,
    historyTurns: conversationHistory.length,
    items: filtered.length,
    prefRules: preferenceRules.length,
  }));

  // Compact current outfits for context (strip image data, keep IDs/names)
  const compactOutfits = compactifyOutfits(currentOutfits);

  // Build preference context
  const prefContext = buildPrefContext(preferenceRules, recentFeedback);

  // Build conversation history for Claude (last 6 turns max to stay within limits)
  const messages = buildMessages(conversationHistory, compactOutfits, feedback);

  const system = buildSystem(filtered, prefContext);

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await withTimeout(
      client.messages.create({ model: MODEL, max_tokens: MAX_TOKENS, system, messages }),
      TIMEOUT_MS
    );

    const raw = response.content[0].text;
    console.log("[refine-outfits] response chars:", raw.length);

    let parsed;
    try { parsed = parseClaudeJSON(raw); }
    catch (e) {
      console.error("[refine-outfits] parse error:", e.message, raw.slice(0, 200));
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Claude returned malformed JSON. Please try again." }) };
    }

    parsed.outfits = enrichOutfits(parsed.outfits || [], wardrobeMap);

    // Extract any preference rules Claude mentions in its reasoning
    const extractedRules = extractPreferenceRules(feedback);

    console.log("[refine-outfits] success | outfits:", parsed.outfits.length, "| extracted rules:", extractedRules.length);

    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ ...parsed, extractedRules }),
    };

  } catch (err) {
    if (err.message === "TIMEOUT") {
      console.error("[refine-outfits] timeout");
      return { statusCode: 504, headers: CORS, body: JSON.stringify({ error: "Request timed out. Try a shorter refinement." }) };
    }
    console.error("[refine-outfits] error:", { message: err.message, status: err.status });
    return { statusCode: err.status || 500, headers: CORS, body: JSON.stringify({ error: `Refinement failed: ${err.message}` }) };
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function compactifyOutfits(outfits) {
  return outfits.map(o => ({
    id: o.id,
    rank: o.rank,
    outfit_name: o.outfit_name || o.title,
    item_ids: o.item_ids || (o.pieces || []).map(p => p.item_id),
    piece_roles: o.piece_roles || Object.fromEntries((o.pieces || []).map(p => [p.item_id, p.role])),
    shoe_primary_id: o.shoe_primary_id || o.shoe_primary?.item_id,
    shoe_alt_id: o.shoe_alt_id || o.shoe_alternative?.item_id,
    tuck_or_styling_note: o.tuck_or_styling_note,
    footwear_rationale: o.footwear_rationale,
    mood: o.mood,
    north_star: o.north_star,
  }));
}

function buildMessages(conversationHistory, compactOutfits, newFeedback) {
  // Keep last 6 turns for context without blowing the token budget
  const recent = conversationHistory.slice(-6);
  const msgs = [];

  if (recent.length === 0) {
    // First refinement — introduce the current outfits
    msgs.push({
      role: "user",
      content: `Here are the current outfits:\n${JSON.stringify(compactOutfits, null, 0)}\n\nFeedback: ${newFeedback}`,
    });
  } else {
    // Rebuild history
    recent.forEach(turn => msgs.push({ role: turn.role, content: turn.content }));
    msgs.push({ role: "user", content: newFeedback });
  }

  return msgs;
}

function buildPrefContext(preferenceRules, recentFeedback) {
  const parts = [];
  if (preferenceRules.length) {
    parts.push("LEARNED PREFERENCES (apply these always):\n" +
      preferenceRules.slice(-10).map(r => `- ${r.rule}`).join("\n"));
  }
  if (recentFeedback.length) {
    parts.push("RECENT SESSION FEEDBACK:\n" +
      recentFeedback.slice(-6).map(e =>
        `- ${e.type} on "${e.outfitName}"${e.itemIds?.length ? ` (${e.itemIds.slice(0,3).join(",")})` : ""}`
      ).join("\n"));
  }
  return parts.join("\n\n");
}

function buildSystem(filtered, prefContext) {
  return `You are Mia's personal AI stylist in a refinement conversation. Your job is to revise outfits based on feedback while preserving what the user liked.

${getStyleContext()}

${getFeedbackExcerpt() ? "FEEDBACK OVERRIDES:\n" + getFeedbackExcerpt() + "\n" : ""}
${prefContext ? prefContext + "\n" : ""}
REFINEMENT RULES:
- DO NOT start over unless the user explicitly asks to start fresh
- Preserve outfits the user said they liked or didn't mention
- Only change what the user asked to change
- If user says "wrong shoes" — only change the shoes, keep everything else
- If user says "more Parisian" — adjust the overall styling direction without replacing every piece
- If user says "swap the bag on outfit 2" — only change that bag on that outfit
- If feedback is vague like "make it more elevated" — make targeted swaps (better shoe, different bag) rather than rebuilding
- Return the same number of outfits as currently shown unless asked to add/remove

AVAILABLE WARDROBE (ID|Name|Brand|Category|Color):
${formatItems(filtered)}

RESPONSE FORMAT — valid JSON only, no markdown fences:
${OUTPUT_SCHEMA}

HARD RULES: only use IDs from wardrobe · no DRS-001/DRS-002 unless user asks for formal · no SHO-028 · no belt on blazers`;
}

// ── Preference rule extraction ────────────────────────────────────────────────
// Detect explicit preference statements in user feedback and save them
const PREF_PATTERNS = [
  { re: /i (love|like|prefer|always want) (.+)/i, type: "positive" },
  { re: /i (hate|don't like|dislike|never want|avoid) (.+)/i, type: "negative" },
  { re: /(never|don't) (put|use|wear|pair) (.+) with (.+)/i, type: "negative_combo" },
  { re: /(always|i always) (pair|wear|use|want) (.+) with (.+)/i, type: "positive_combo" },
];

export function extractPreferenceRules(text) {
  if (!text) return [];
  const rules = [];
  for (const { re, type } of PREF_PATTERNS) {
    const m = text.match(re);
    if (m) {
      rules.push({ rule: text.trim(), type, timestamp: Date.now() });
      break; // one rule per message is enough
    }
  }
  return rules;
}
