// GASStudio Book Search — Worker de reconocimiento de tapas (100% gratis)
// Usa Workers AI de Cloudflare (plan gratuito: 10.000 neuronas por día, sin tarjeta y sin claves).
// Recibe una foto de una tapa (JPEG en base64) y devuelve título y autor.
// Necesita un "binding" de Workers AI llamado AI en la configuración del Worker.

const ALLOWED_ORIGINS = ['https://guidosusmel.github.io'];
const MODELS = ['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/meta/llama-3.2-11b-vision-instruct'];
const MAX_CHARS = 1_400_000;   // ~1 MB de imagen en base64
const PER_IP_PER_HOUR = 40;    // freno simple contra abusos
const hits = new Map();

const PROMPT = `You are reading a photo of a book cover. Identify the book.
Reply ONLY with a JSON object, no extra text:
{"title":"main title as printed","subtitle":"subtitle or empty","author":"author(s) or empty","publisher":"publisher or empty","confidence":0.0}
Rules: keep the original language of the title. Do not include taglines, quotes or prices.
If a figure hides part of the title but you clearly recognize the book, complete it.
If there is no book or you cannot read it, reply {"title":"","subtitle":"","author":"","publisher":"","confidence":0}.
confidence goes from 0 to 1.`;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const json = (data, status, origin) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors(origin) } });

function parseBook(text) {
  const empty = { title: '', subtitle: '', author: '', publisher: '', confidence: 0 };
  if (!text) return empty;
  if (typeof text === 'object') return { ...empty, ...text };
  const m = String(text).match(/\{[\s\S]*\}/);
  try { return m ? { ...empty, ...JSON.parse(m[0]) } : empty; } catch { return empty; }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method === 'GET') return json({ ok: true, service: 'book-search-cover', ai: !!env.AI }, 200, origin);
    if (request.method !== 'POST') return json({ error: 'Método no permitido' }, 405, origin);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Origen no permitido' }, 403, origin);
    if (!env.AI) return json({ error: 'Falta el binding de Workers AI (AI)' }, 500, origin);

    const ip = request.headers.get('CF-Connecting-IP') || 'x';
    const now = Date.now();
    const list = (hits.get(ip) || []).filter(t => now - t < 3600_000);
    if (list.length >= PER_IP_PER_HOUR) return json({ error: 'Demasiadas fotos seguidas. Probá en un rato.' }, 429, origin);
    list.push(now); hits.set(ip, list);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Pedido inválido' }, 400, origin); }
    const image = String(body.image || '');
    const mediaType = /^image\/(jpeg|png|webp)$/.test(body.mediaType) ? body.mediaType : 'image/jpeg';
    if (!image || image.length > MAX_CHARS || !/^[A-Za-z0-9+/=]+$/.test(image)) return json({ error: 'Imagen inválida o muy grande' }, 400, origin);
    const dataUrl = `data:${mediaType};base64,${image}`;

    let lastErr = '';
    for (const model of MODELS) {
      try {
        const out = await env.AI.run(model, {
          messages: [{ role: 'user', content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ] }],
          max_tokens: 200,
          temperature: 0.1,
        });
        const book = parseBook(out && (out.response ?? out.result?.response ?? out));
        return json({ book, model }, 200, origin);
      } catch (e) {
        lastErr = String(e && e.message || e).slice(0, 300);
        // Llama 3.2 Vision pide aceptar su licencia la primera vez
        if (/agree|license/i.test(lastErr) && model.includes('llama-3.2')) {
          try { await env.AI.run(model, { prompt: 'agree' }); } catch {}
        }
      }
    }
    const quota = /limit|quota|neurons|exceeded|4006/i.test(lastErr);
    return json({ error: quota ? 'Se alcanzó el uso gratuito del día' : 'El reconocimiento no respondió', detail: lastErr }, quota ? 429 : 502, origin);
  },
};
