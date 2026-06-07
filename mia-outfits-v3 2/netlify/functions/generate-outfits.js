import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join } from "path";

// ── Config ────────────────────────────────────────────────────────────────────
// haiku-4-5 is ~10x faster than opus — median latency ~1–2s vs 8–15s
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1800;
// Bail at 9s — Netlify hard-kills at 10s
const TIMEOUT_MS = 9000;

// ── Module-level cache (survives warm Lambda invocations) ─────────────────────
let _wardrobe = null;
let _wardrobeMap = null;
let _styleContext = null;
let _feedbackRules = null;

function dp(file) {
  return join(process.cwd(), "data", file);
}

function loadWardrobe() {
  if (!_wardrobe) {
    _wardrobe = JSON.parse(readFileSync(dp("wardrobe.json"), "utf8"));
    _wardrobeMap = Object.fromEntries(_wardrobe.map((it) => [it.id, it]));
  }
  return { wardrobe: _wardrobe, wardrobeMap: _wardrobeMap };
}

// ── Compressed style context ──────────────────────────────────────────────────
// ~900 tokens vs ~6,500 for the full markdown files
function getStyleContext() {
  if (_styleContext) return _styleContext;

  _styleContext = `STYLE: California Luxury + Parisian Refinement + Copenhagen Creativity. Tall athletic hourglass. Exceptional taste, not trendiness.

CORE RULES:
- Volume in ONE place only. Voluminous bottom = fitted top. Voluminous top = straight bottom.
- ALL trousers/jeans = wide-leg or barrel only. Never slim/skinny.
- Shoe controls occasion: flat sandal=casual, ballet/loafer flat=smart casual, kitten heel slingback=evening.
- Wrong-shoe theory: sneaker+skirt or sneaker+blazer is deliberate — must be the only casual element.
- One colour accent max. Colour dress = neutral accessories only. Never two colour accents.
- Jewellery: max 2 pieces. Evening=gold disc earring+bangle. Day=pearl drop earring.
- Belt ONLY if garment has belt loops or is a belted design. Never belt a blazer.
- Outerwear is optional — outfit must work without it.
- Tuck instruction required every top: full tuck / half tuck (front only) / untucked / open layer inner tucked / bloused.
- Anti-millennial: no over-coordinated accessories, no statement piece rescuing unresolved outfit.

FOOTWEAR (AB):
- Pointed toe elongates — preferred with wide-leg silhouette.
- Voluminous top → sleek shoe. Minimal outfit → interesting shoe = the moment.
- Always: one primary shoe + one alternative, each with rationale.

FORBIDDEN:
- DRS-001, DRS-002: formal dresses — only if prompt says formal/fancy/dress.
- SHO-028: partial crop, unusable.
- Belt over SUT-001 or SUT-002 (blazers).

UNDERUSED (surface at least 1 per response):
TOP-006,TOP-015,TOP-017,TOP-020,TOP-022,TOP-025,TOP-026,TOP-031,
BOT-005,BOT-008,BOT-015,DRS-004,DRS-005,
SHO-004,SHO-006,SHO-008,SHO-009,SHO-013,SHO-017,SHO-019,SHO-022,SHO-023,SHO-030,
BAG-002,BAG-004,BAG-009,BAG-010,BAG-011,
ACC-002,ACC-004,ACC-005,ACC-009,ACC-011,ACC-012,ACC-013,ACC-014,ACC-020,
OUT-002,OUT-003

ITEM OVERRIDES (Mia confirmed — trust these):
- BOT-001=black SILK maxi skirt, BOT-002=chocolate SILK maxi skirt, BOT-003=black SILK wide-leg trousers
- DRS-004=BLACK puff-sleeve midi dress (not dark brown)
- SHO-004=Freida Salvador tan woven bow flat
- TOP-009=ruffled peplum — ONLY with black silk maxi skirt, never with wide-leg jeans
- DRS-001=white crochet formal dress — only for formal/fancy requests
- DRS-002=ivory ruched formal maxi — only for formal/fancy requests`;

  return _styleContext;
}

// ── Critical item constraints from feedback log ───────────────────────────────
function getFeedbackRules() {
  if (_feedbackRules) return _feedbackRules;
  try {
    const log = readFileSync(dp("outfit_feedback_log.md"), "utf8");
    // Extract the dress occasions section only — the most critical overrides
    const match = log.match(/## DRESS OCCASION RULES[\s\S]*?(?=\n##|$)/);
    _feedbackRules = match ? match[0].slice(0, 600) : "";
  } catch {
    _feedbackRules = "";
  }
  return _feedbackRules;
}

// ── Smart wardrobe filter ─────────────────────────────────────────────────────
// Sends ~40–60 items instead of all 126
const OCCASION_CATS = {
  dinner:     new Set(["tops","knitwear","bottoms","dresses","suiting","shoes","bags","accessories"]),
  work:       new Set(["tops","knitwear","bottoms","suiting","outerwear","shoes","bags"]),
  offsite:    new Set(["tops","knitwear","bottoms","suiting","outerwear","shoes","bags","accessories"]),
  weekend:    new Set(["tops","knitwear","bottoms","outerwear","shoes","bags","accessories","dresses"]),
  tahoe:      new Set(["tops","knitwear","bottoms","outerwear","shoes","bags","accessories"]),
  travel:     new Set(["tops","knitwear","bottoms","outerwear","dresses","shoes","bags"]),
  evening:    new Set(["tops","bottoms","dresses","suiting","shoes","bags","accessories"]),
  casual:     new Set(["tops","knitwear","bottoms","shoes","bags","accessories","dresses"]),
  capsule:    new Set(["tops","knitwear","bottoms","outerwear","dresses","suiting","shoes","bags","accessories"]),
};

// Per-category send limits — shoes get the most because they're the decision engine
const CAT_LIMITS = {
  tops: 12, knitwear: 6, bottoms: 8, dresses: 6,
  outerwear: 4, suiting: 2, shoes: 16, bags: 8, accessories: 6,
};

function filterWardrobe(prompt, wardrobe) {
  const p = prompt.toLowerCase();

  let relevantCats = null;
  for (const [kw, cats] of Object.entries(OCCASION_CATS)) {
    if (p.includes(kw)) { relevantCats = cats; break; }
  }

  // Filter by category first
  const pool = relevantCats
    ? wardrobe.filter((it) => relevantCats.has(it.category))
    : wardrobe;

  // Apply per-category limits to keep payload tight
  const counts = {};
  const result = [];
  for (const it of pool) {
    const c = it.category;
    counts[c] = (counts[c] || 0) + 1;
    if (counts[c] <= (CAT_LIMITS[c] || 8)) result.push(it);
  }
  return result;
}

function formatItems(items) {
  // Compact: ID|Name|Brand|Cat|Color
  return items.map((it) => `${it.id}|${it.name}|${it.brand}|${it.category}|${it.color}`).join("\n");
}

// ── Handler ───────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[generate-outfits] ANTHROPIC_API_KEY not set");
    return {
      statusCode: 500, headers: cors,
      body: JSON.stringify({ error: "API key not configured. Add ANTHROPIC_API_KEY in Netlify → Site configuration → Environment variables, then redeploy." }),
    };
  }

  let prompt, count;
  try {
    ({ prompt, count = 3 } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (!prompt?.trim()) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "prompt is required" }) };
  }

  const outfitCount = Math.min(Math.max(parseInt(count) || 3, 1), 8);
  const { wardrobe, wardrobeMap } = loadWardrobe();
  const filteredItems = filterWardrobe(prompt, wardrobe);

  console.log("[generate-outfits]", JSON.stringify({
    model: MODEL,
    promptLength: prompt.trim().length,
    outfitCount,
    wardrobeItemsSent: filteredItems.length,
    totalWardrobe: wardrobe.length,
  }));

  const systemPrompt =
    `You are a personal AI stylist for Mia. Apply every rule exactly.\n\n` +
    getStyleContext() +
    (getFeedbackRules() ? `\n\nFEEDBACK OVERRIDES:\n${getFeedbackRules()}` : "") +
    `\n\nWARDROBE (ID|Name|Brand|Category|Color):\n` +
    formatItems(filteredItems) +
    `\n\nRESPONSE FORMAT — return valid JSON only, no markdown fences:\n` +
    `{"outfits":[{"id":"1","rank":1,"outfit_name":"Title","mood":"One sentence","north_star":"California Luxury","item_ids":["TOP-XXX","BOT-XXX","SHO-XXX","BAG-XXX"],"piece_roles":{"TOP-XXX":"Top","BOT-XXX":"Bottom","SHO-XXX":"Shoes","BAG-XXX":"Bag"},"shoe_primary_id":"SHO-XXX","shoe_alt_id":"SHO-XXX","footwear_rationale":"Primary: why + leg line effect. Alt: when instead.","tuck_or_styling_note":"Single directive.","principles_used":["Rule 1","Rule 2"]}]}\n\n` +
    `HARD RULES: only use IDs from wardrobe list · no DRS-001/DRS-002 unless prompt says formal · no SHO-028 · no belt on blazers · no repeat shoe/bag/outerwear across outfits · include ≥1 underused item · rank #1=most stylist-likely`;

  const userMessage = `Generate ${outfitCount} outfit${outfitCount !== 1 ? "s" : ""} for: "${prompt.trim()}"\nJSON only.`;

  const timeoutErr = new Error("TIMEOUT");
  const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(timeoutErr), TIMEOUT_MS));

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await Promise.race([
      client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
      timeoutPromise,
    ]);

    const raw = response.content[0].text.trim()
      .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

    console.log("[generate-outfits] response chars:", raw.length);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (pe) {
      console.error("[generate-outfits] JSON parse failed:", pe.message, "| preview:", raw.slice(0, 300));
      return {
        statusCode: 500, headers: cors,
        body: JSON.stringify({ error: "Claude returned malformed JSON. Please try again." }),
      };
    }

    // Enrich with full item data + image paths
    parsed.outfits = (parsed.outfits || []).map((o) => ({
      ...o,
      pieces: (o.item_ids || []).map((id) => ({
        item_id: id,
        role: o.piece_roles?.[id] || "",
        item: wardrobeMap[id] ?? null,
      })),
      shoe_primary: o.shoe_primary_id
        ? { item_id: o.shoe_primary_id, item: wardrobeMap[o.shoe_primary_id] ?? null }
        : null,
      shoe_alternative: o.shoe_alt_id
        ? { item_id: o.shoe_alt_id, item: wardrobeMap[o.shoe_alt_id] ?? null }
        : null,
    }));

    console.log("[generate-outfits] success | outfits:", parsed.outfits.length);

    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    };

  } catch (err) {
    if (err === timeoutErr || err.message === "TIMEOUT") {
      console.error("[generate-outfits] TIMED OUT after", TIMEOUT_MS, "ms");
      return {
        statusCode: 504, headers: cors,
        body: JSON.stringify({ error: "Request timed out. Try asking for 3 outfits or use a shorter prompt." }),
      };
    }
    console.error("[generate-outfits] Anthropic error:", {
      message: err.message,
      status: err.status,
      errorType: err.error?.type,
    });
    return {
      statusCode: err.status || 500, headers: cors,
      body: JSON.stringify({ error: `Generation failed: ${err.message}` }),
    };
  }
};
