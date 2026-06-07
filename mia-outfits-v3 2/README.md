# Mia's Outfits v3

Personal AI stylist. Type a prompt, get visual outfit boards from your real wardrobe.

## What changed in v3 (timeout fix)

| Issue | v2 | v3 |
|---|---|---|
| Model | claude-opus-4-6 (~8–15s) | claude-haiku-4-5 (~1–2s) |
| System prompt | 7 full markdown files (~14k tokens) | Compressed context block (~900 tokens) |
| Wardrobe items sent | All 126 every request | 40–60 filtered by occasion |
| Default outfits | 5 | 3 |
| Timeout handling | None | Race at 9s, returns clear message |
| Error logging | Minimal | Logs model, prompt length, items sent, Anthropic errors |

## Deploy to Netlify (GitHub required — Netlify Drop does not support Functions)

### 1 — Push to GitHub

```bash
cd mia-outfits-v3
git init
git add .
git commit -m "v3 — timeout optimisations"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/mia-outfits.git
git push -u origin main
```

If you already have the repo from v2, just push to it:
```bash
git remote add origin https://github.com/YOUR_USERNAME/mia-outfits.git
git push --force origin main
```

### 2 — Connect to Netlify

1. [app.netlify.com](https://app.netlify.com) → Add new site → Import from GitHub
2. Select `mia-outfits`
3. Leave build settings blank — `netlify.toml` handles it
4. Deploy site

### 3 — Add API key

Site configuration → Environment variables → Add:
- Key: `ANTHROPIC_API_KEY`
- Value: your key from [console.anthropic.com](https://console.anthropic.com)

Then: Deploys → Trigger deploy → Deploy site

### 4 — Done

Your site: `https://[sitename].netlify.app`
iOS home screen: Safari → Share → Add to Home Screen

## Local dev

```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
npx netlify dev
# opens at http://localhost:8888
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Still getting 504 | Check function logs in Netlify dashboard → Functions → generate-outfits |
| "API key not configured" | Add ANTHROPIC_API_KEY in Netlify env vars and redeploy |
| Images not loading | Filenames in wardrobe.json must match `/images/wardrobe/ITEM-ID.jpg` |
| Outfits look wrong | Edit `data/` markdown files to update style rules |
