import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader (does not override existing env).
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

export const env = {
  port: Number(process.env.PORT || 8787),
  dataDir: path.resolve(process.env.DATA_DIR || 'data'),
  password: process.env.APP_PASSWORD || '',
  region: process.env.AWS_REGION || 'us-east-1',
  claudeModel: process.env.CLAUDE_MODEL || 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  bgModel: process.env.BG_MODEL || 'us.stability.stable-image-remove-background-v1:0',
  searchReplaceModel: process.env.SEARCH_REPLACE_MODEL || 'us.stability.stable-image-search-replace-v1:0',
  geminiKey: process.env.GEMINI_API_KEY || '',
  falKey: process.env.FAL_KEY || '',
  garmentFit: process.env.GARMENT_FIT || '', // e.g. "men's" — steers studio images to the right cut
  geminiTextModel: process.env.GEMINI_TEXT_MODEL || 'gemini-flash-latest',
  visionProvider: process.env.VISION_PROVIDER || '', // claude | gemini | '' (auto: claude, fall back to gemini)
  geminiModel: process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
  geminiRenderModel: process.env.GEMINI_RENDER_MODEL || 'gemini-3-pro-image', // outfit try-on (best identity + garment fidelity)
  forceMock: process.env.MOCK_AI === '1',
  tryOnProvider: process.env.TRYON_PROVIDER || '', // gemini | stability | mock ('' = auto)
  production: process.env.NODE_ENV === 'production',
};
