# Mia's Outfits — Deployment Guide

Personal AI stylist. Type a prompt, get visual outfit boards from your real wardrobe.

---

## Why Netlify Drop doesn't work

Netlify Drop only hosts **static files**. It cannot run server-side code.
Netlify Functions (the backend that calls the Claude API) require a **GitHub-connected deploy**.
This package is set up for that correctly.

---

## Project structure

```
mia-outfits-v2/
├── netlify/
│   └── functions/
│       └── generate-outfits.js   ← backend (runs on Netlify's servers)
├── public/
│   ├── index.html                ← frontend
│   ├── manifest.json
│   └── images/wardrobe/          ← 153 wardrobe item images
├── data/
│   ├── wardrobe.json             ← 126 verified items
│   ├── style_operating_system.md
│   ├── stylist_operating_rules.md
│   ├── lookbook_principles.md
│   ├── footwear_playbook.md
│   ├── wardrobe_utilization_rules.md
│   └── outfit_feedback_log.md
├── netlify.toml                  ← tells Netlify where everything is
├── package.json
└── README.md
```

---

## Deploy: step by step

### 1 — Create a GitHub repository

Go to [github.com/new](https://github.com/new):
- Name: `mia-outfits`
- Visibility: **Private**
- Do NOT initialise with README or .gitignore
- Click **Create repository**

### 2 — Push this project to GitHub

Unzip `mia-outfits-v2.zip` on your computer, then open Terminal:

```bash
cd path/to/mia-outfits-v2

git init
git add .
git commit -m "Initial deploy"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/mia-outfits.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your GitHub username.

### 3 — Connect to Netlify

1. Go to [app.netlify.com](https://app.netlify.com)
2. Click **Add new site → Import an existing project**
3. Choose **GitHub** and authorise Netlify
4. Select the `mia-outfits` repository
5. Build settings — leave everything blank (netlify.toml handles it):
   - Build command: *(empty)*
   - Publish directory: *(empty)*
6. Click **Deploy site**

### 4 — Add your Anthropic API key

**This step is required — the app won't generate outfits without it.**

1. In Netlify, go to your site → **Site configuration → Environment variables**
2. Click **Add a variable**
3. Key: `ANTHROPIC_API_KEY`
4. Value: your key from [console.anthropic.com](https://console.anthropic.com)
   (starts with `sk-ant-api03-...`)
5. Click **Save**
6. Go to **Deploys → Trigger deploy → Deploy site** to redeploy with the key active

### 5 — Open on your phone

Your live URL will be:
```
https://[your-site-name].netlify.app
```

**Add to home screen (iOS):** Safari → Share → Add to Home Screen
**Add to home screen (Android):** Chrome menu → Add to Home screen

---

## How it works

```
Your phone
  → types prompt
  → frontend (index.html) fetches /.netlify/functions/generate-outfits
  → Netlify Function (generate-outfits.js) runs on Netlify's servers
  → loads wardrobe.json + all style rule .md files
  → sends everything to Anthropic Claude API (API key stays server-side)
  → Claude returns structured JSON with outfit item IDs
  → Function enriches JSON with full item data + image paths
  → Frontend renders visual outfit boards using /images/wardrobe/*.jpg
```

The API key never touches the browser.

---

## Local development

Install [Netlify CLI](https://docs.netlify.com/cli/get-started/) first:

```bash
npm install
```

Create a `.env` file in the project root:
```
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Run locally:
```bash
npx netlify dev
```

Opens at `http://localhost:8888` with Functions working.

---

## Updating wardrobe data

- Edit `data/wardrobe.json` to add/change items
- Add images to `public/images/wardrobe/` — filename must match the `file` field in wardrobe.json
- Edit any `.md` file in `data/` to update style rules
- Commit and push — Netlify auto-deploys on every push to `main`

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Prompt submits but nothing happens | Check browser console for errors. Most likely: API key not set in Netlify env vars |
| "ANTHROPIC_API_KEY is not set" error | Add the key in Netlify → Site config → Environment variables → redeploy |
| Images not showing | Filenames in `wardrobe.json` `image` field must match `/images/wardrobe/ITEM-ID.jpg` exactly |
| Function logs | Netlify dashboard → Functions → generate-outfits → view logs |
| 404 on function | Confirm `netlify.toml` has `functions = "netlify/functions"` and file is at `netlify/functions/generate-outfits.js` |
