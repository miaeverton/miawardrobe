import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join } from "path";

// Netlify bundles this file; data/ is included via netlify.toml included_files
// process.cwd() at runtime is the site root
function dataPath(filename) {
  return join(process.cwd(), "data", filename);
}

function loadData() {
  return {
    wardrobe: JSON.parse(readFileSync(dataPath("wardrobe.json"), "utf8")),
    styleOS: readFileSync(dataPath("style_operating_system.md"), "utf8"),
    stylistRules: readFileSync(dataPath("stylist_operating_rules.md"), "utf8"),
    lookbookPrinciples: readFileSync(dataPath("lookbook_principles.md"), "utf8"),
    footwearPlaybook: readFileSync(dataPath("footwear_playbook.md"), "utf8"),
    utilizationRules: readFileSync(dataPath("wardrobe_utilization_rules.md"), "utf8"),
    feedbackLog: readFileSync(dataPath("outfit_feedback_log.md"), "utf8"),
  };
}

function buildSystemPrompt(data) {
  const itemList = data.wardrobe
    .map(
      (it) =>
        `${it.id} | ${it.name} | ${it.brand} | ${it.category} | ${it.color} | tags: ${(it.tags || []).slice(0, 5).join(", ")}`
    )
    .join("\n");

  return `You are Mia's personal AI stylist. You know her wardrobe intimately and apply her styling system to every recommendation.

━━━ STYLE OPERATING SYSTEM ━━━
${data.styleOS}

━━━ STYLIST OPERATING RULES ━━━
${data.stylistRules}

━━━ LOOKBOOK PRINCIPLES (extracted from 61 real lookbook boards) ━━━
${data.lookbookPrinciples}

━━━ FOOTWEAR PLAYBOOK ━━━
${data.footwearPlaybook}

━━━ WARDROBE UTILIZATION RULES ━━━
${data.utilizationRules}

━━━ OUTFIT FEEDBACK LOG (corrections — these override everything) ━━━
${data.feedbackLog}

━━━ VERIFIED WARDROBE — 126 ITEMS ━━━
ID | Name | Brand | Category | Color | Tags
${itemList}

━━━ RESPONSE FORMAT ━━━
Return ONLY valid JSON — no markdown fences, no explanation outside the JSON object.

{
  "outfits": [
    {
      "id": "outfit-1",
      "rank": 1,
      "title": "Short evocative title",
      "mood": "One sentence — the feeling of the look",
      "north_star": "California Luxury",
      "occasion": "What context this is right for",
      "pieces": [
        { "item_id": "TOP-XXX", "role": "Top" },
        { "item_id": "BOT-XXX", "role": "Bottom" },
        { "item_id": "SHO-XXX", "role": "Shoes" },
        { "item_id": "BAG-XXX", "role": "Bag" }
      ],
      "tuck_instruction": "One directive only — e.g. Full tuck. Or: Half tuck — front only, centered.",
      "shoe_primary": {
        "item_id": "SHO-XXX",
        "rationale": "Why this shoe. What it does to the leg line. Which AB principle."
      },
      "shoe_alternative": {
        "item_id": "SHO-XXX",
        "rationale": "When to choose this instead."
      },
      "piece_labels": {
        "hero": "ITEM-ID",
        "supporting": ["ITEM-ID", "ITEM-ID"],
        "underused": ["ITEM-ID"]
      },
      "principles_applied": [
        "Specific rule with citation",
        "Second principle"
      ],
      "why_it_works": "2–3 sentences explaining the styling logic."
    }
  ]
}

HARD RULES — never violate:
- Only use item IDs from the wardrobe list above
- Never suggest DRS-001 or DRS-002 unless prompt explicitly requests formal/fancy/dress
- Never suggest SHO-028 as a primary shoe (partial crop, unusable)
- Never recommend a belt unless the garment has belt loops or is a belted design
- Do not repeat the same shoe, bag, or outerwear across outfits in one response
- At least 25% of outfits must surface an underused piece (see utilization rules)
- Run the anti-millennial checklist on every outfit
- Rank outfits #1 = most likely stylist choice → last = most unexpected`;
}

export const handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        error: "ANTHROPIC_API_KEY environment variable is not set",
      }),
    };
  }

  let prompt, count;
  try {
    ({ prompt, count = 5 } = JSON.parse(event.body || "{}"));
  } catch {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "prompt is required" }),
    };
  }

  const outfitCount = Math.min(Math.max(parseInt(count) || 5, 1), 10);

  try {
    const data = loadData();
    const systemPrompt = buildSystemPrompt(data);
    const wardrobeMap = Object.fromEntries(data.wardrobe.map((it) => [it.id, it]));

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Generate ${outfitCount} outfit${outfitCount !== 1 ? "s" : ""} for: "${prompt.trim()}"\n\nReturn exactly ${outfitCount} outfits, ranked best to most unexpected. Valid JSON only.`,
        },
      ],
    });

    const rawText = message.content[0].text.trim();

    // Strip accidental markdown code fences
    const jsonText = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const parsed = JSON.parse(jsonText);

    // Enrich pieces with full item data including image path
    parsed.outfits = (parsed.outfits || []).map((outfit) => ({
      ...outfit,
      pieces: (outfit.pieces || []).map((p) => ({
        ...p,
        item: wardrobeMap[p.item_id] ?? null,
      })),
      shoe_primary: outfit.shoe_primary
        ? {
            ...outfit.shoe_primary,
            item: wardrobeMap[outfit.shoe_primary.item_id] ?? null,
          }
        : null,
      shoe_alternative: outfit.shoe_alternative
        ? {
            ...outfit.shoe_alternative,
            item: wardrobeMap[outfit.shoe_alternative.item_id] ?? null,
          }
        : null,
    }));

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    console.error("[generate-outfits]", err);
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        error: "Failed to generate outfits",
        detail: err.message,
      }),
    };
  }
};
