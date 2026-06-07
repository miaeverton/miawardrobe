// Shared utilities loaded by both generate-outfits and refine-outfits
import { readFileSync } from "fs";
import { join } from "path";

// ── Module-level cache ────────────────────────────────────────────────────────
let _wardrobe = null;
let _wardrobeMap = null;
let _styleCtx = null;
let _feedbackRules = null;

export const MODEL = "claude-haiku-4-5-20251001";
export const MAX_TOKENS = 2048;
export const TIMEOUT_MS = 9000;

export function dp(file) {
  return join(process.cwd(), "data", file);
}

export function loadWardrobe() {
  if (!_wardrobe) {
    _wardrobe = JSON.parse(readFileSync(dp("wardrobe.json"), "utf8"));
    _wardrobeMap = Object.fromEntries(_wardrobe.map((it) => [it.id, it]));
  }
  return { wardrobe: _wardrobe, wardrobeMap: _wardrobeMap };
}

export function getStyleContext() {
  if (_styleCtx) return _styleCtx;
  _styleCtx = `STYLE: California Luxury + Parisian Refinement + Copenhagen Creativity. Tall athletic hourglass. Exceptional taste, not trendiness.

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

FOOTWEAR (AB principles):
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

ITEM OVERRIDES (Mia confirmed):
- BOT-001=black SILK maxi skirt, BOT-002=chocolate SILK maxi skirt, BOT-003=black SILK wide-leg trousers
- DRS-004=BLACK puff-sleeve midi dress (not dark brown)
- SHO-004=Freida Salvador tan woven bow flat
- TOP-009=ruffled peplum — ONLY with black silk maxi skirt, never with wide-leg jeans
- DRS-001=white crochet formal — formal/fancy requests only
- DRS-002=ivory ruched formal maxi — formal/fancy requests only`;
  return _styleCtx;
}

export function getFeedbackExcerpt() {
  if (_feedbackRules !== null) return _feedbackRules;
  try {
    const log = readFileSync(dp("outfit_feedback_log.md"), "utf8");
    const match = log.match(/## DRESS OCCASION RULES[\s\S]*?(?=\n##|$)/);
    _feedbackRules = match ? match[0].slice(0, 500) : "";
  } catch { _feedbackRules = ""; }
  return _feedbackRules;
}

// ── Wardrobe filtering ────────────────────────────────────────────────────────
const OCCASION_CATS = {
  dinner:   new Set(["tops","knitwear","bottoms","dresses","suiting","shoes","bags","accessories"]),
  work:     new Set(["tops","knitwear","bottoms","suiting","outerwear","shoes","bags"]),
  offsite:  new Set(["tops","knitwear","bottoms","suiting","outerwear","shoes","bags","accessories"]),
  weekend:  new Set(["tops","knitwear","bottoms","outerwear","shoes","bags","accessories","dresses"]),
  tahoe:    new Set(["tops","knitwear","bottoms","outerwear","shoes","bags","accessories"]),
  travel:   new Set(["tops","knitwear","bottoms","outerwear","dresses","shoes","bags"]),
  evening:  new Set(["tops","bottoms","dresses","suiting","shoes","bags","accessories"]),
  casual:   new Set(["tops","knitwear","bottoms","shoes","bags","accessories","dresses"]),
  capsule:  new Set(["tops","knitwear","bottoms","outerwear","dresses","suiting","shoes","bags","accessories"]),
};
const CAT_LIMITS = { tops:12,knitwear:6,bottoms:8,dresses:6,outerwear:4,suiting:2,shoes:16,bags:8,accessories:6 };

export function filterWardrobe(prompt, wardrobe) {
  const p = (prompt || "").toLowerCase();
  let cats = null;
  for (const [kw, c] of Object.entries(OCCASION_CATS)) {
    if (p.includes(kw)) { cats = c; break; }
  }
  const pool = cats ? wardrobe.filter(it => cats.has(it.category)) : wardrobe;
  const counts = {};
  return pool.filter(it => {
    counts[it.category] = (counts[it.category] || 0) + 1;
    return counts[it.category] <= (CAT_LIMITS[it.category] || 8);
  });
}

export function formatItems(items) {
  return items.map(it => `${it.id}|${it.name}|${it.brand}|${it.category}|${it.color}`).join("\n");
}

// ── Enrich outfits with item data ─────────────────────────────────────────────
export function enrichOutfits(outfits, wardrobeMap) {
  return outfits.map(o => ({
    ...o,
    pieces: (o.item_ids || []).map(id => ({
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
}

// ── JSON output schema (shared) ───────────────────────────────────────────────
export const OUTPUT_SCHEMA = `{"outfits":[{"id":"1","rank":1,"outfit_name":"Title","mood":"One sentence","north_star":"California Luxury","item_ids":["TOP-XXX","BOT-XXX","SHO-XXX","BAG-XXX"],"piece_roles":{"TOP-XXX":"Top","BOT-XXX":"Bottom","SHO-XXX":"Shoes","BAG-XXX":"Bag"},"shoe_primary_id":"SHO-XXX","shoe_alt_id":"SHO-XXX","footwear_rationale":"Primary: why + leg line. Alt: when instead.","tuck_or_styling_note":"Single directive.","principles_used":["Rule 1","Rule 2"]}]}`;

// ── CORS headers ──────────────────────────────────────────────────────────────
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── Timeout race helper ───────────────────────────────────────────────────────
export function withTimeout(promise, ms) {
  const t = new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT")), ms));
  return Promise.race([promise, t]);
}

// ── Parse Claude response ─────────────────────────────────────────────────────
export function parseClaudeJSON(text) {
  const clean = text.trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(clean);
}
