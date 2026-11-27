// GASStudio Book Search - Worker de reconocimiento de tapas (gratis con Workers AI)
const ALLOWED_ORIGINS = ['https://guidosusmel.github.io'];
const MODELS = ['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/meta/llama-3.2-11b-vision-instruct'];
const MAX_CHARS = 1400000;
const PER_IP_PER_HOUR = 40;
const hits = new Map();

const PROMPT = 'You are reading a photo of a book cover. Identify the book.\n' +
  'Reply ONLY with a JSON object, no extra text:\n' +
  '{"title":"main title as printed","subtitle":"subtitle or empty","author":"author(s) or empty","publisher":"publisher or empty","confidence":0.0}\n' +
  'Rules: keep the original language of the title. Do not include taglines, quotes or prices.\n' +
  'If a figure hides part of the title but you clearly recognize the book, complete it.\n' +
  'If there is no book or you cannot read it, reply {"title":"","subtitle":"","author":"","publisher":"","confidence":0}.\n' +
  'confidence goes from 0 to 1.';

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), { status: status, headers: Object.assign({ 'Content-Type': 'application/json' }, cors(origin)) });
}

function parseBook(text) {
  const empty = { title: '', subtitle: '', author: '', publisher: '', confidence: 0 };
  if (!text) return empty;
  if (typeof text === 'object') return Object.assign({}, empty, text);
  const m = String(text).match(/\{[\s\S]*\}/);
  try { return m ? Object.assign({}, empty, JSON.parse(m[0])) : empty; } catch (e) { return empty; }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method === 'GET') return json({ ok: true, service: 'book-search-cover', ai: !!env.AI }, 200, origin);
    if (request.method !== 'POST') return json({ error: 'Metodo no permitido' }, 405, origin);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Origen no permitido' }, 403, origin);
    if (!env.AI) return json({ error: 'Falta el binding de Workers AI (AI)' }, 500, origin);

    const ip = request.headers.get('CF-Connecting-IP') || 'x';
    const now = Date.now();
    const list = (hits.get(ip) || []).filter(function (t) { return now - t < 3600000; });
    if (list.length >= PER_IP_PER_HOUR) return json({ error: 'Demasiadas fotos seguidas. Proba en un rato.' }, 429, origin);
    list.push(now); hits.set(ip, list);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'Pedido invalido' }, 400, origin); }
    const image = String(body.image || '');
    const mediaType = /^image\/(jpeg|png|webp)$/.test(body.mediaType) ? body.mediaType : 'image/jpeg';
    if (!image || image.length > MAX_CHARS || !/^[A-Za-z0-9+\/=]+$/.test(image)) return json({ error: 'Imagen invalida o muy grande' }, 400, origin);
    const dataUrl = 'data:' + mediaType + ';base64,' + image;

    let lastErr = '';
    for (const model of MODELS) {
      try {
        const out = await env.AI.run(model, {
          messages: [{ role: 'user', content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } }
          ] }],
          max_tokens: 200,
          temperature: 0.1
        });
        const raw = out && (out.response !== undefined ? out.response : (out.result && out.result.response !== undefined ? out.result.response : out));
        return json({ book: parseBook(raw), model: model }, 200, origin);
      } catch (e) {
        lastErr = String((e && e.message) || e).slice(0, 300);
        if (/agree|license/i.test(lastErr) && model.indexOf('llama-3.2') >= 0) {
          try { await env.AI.run(model, { prompt: 'agree' }); } catch (e2) {}
        }
      }
    }
    const quota = /limit|quota|neurons|exceeded|4006/i.test(lastErr);
    return json({ error: quota ? 'Se alcanzo el uso gratuito del dia' : 'El reconocimiento no respondio', detail: lastErr }, quota ? 429 : 502, origin);
  }
};
