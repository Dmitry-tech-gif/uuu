/**
 * Fant1kz Island — Cloudflare Worker
 * Проксирует запросы к GitHub API, обходя кэш и CORS.
 * Токен хранится в переменной окружения GITHUB_TOKEN (не в коде).
 */

const ALLOWED_ORIGIN = '*'; // можно сузить до вашего домена
const GITHUB_API = 'https://api.github.com';

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204);
    }

    const url = new URL(request.url);

    // Роут: GET /profiles  → читает profile.json
    // Роут: PUT /profiles  → пишет profile.json
    if (url.pathname === '/profiles') {
      if (request.method === 'GET') {
        return handleGet(env);
      }
      if (request.method === 'PUT') {
        return handlePut(request, env);
      }
      return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405);
    }

    // Health check
    if (url.pathname === '/ping') {
      return corsResponse(JSON.stringify({ ok: true, ts: Date.now() }), 200);
    }

    return corsResponse(JSON.stringify({ error: 'Not found' }), 404);
  },
};

// ─── GET /profiles ────────────────────────────────────────────────────────────
async function handleGet(env) {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    return corsResponse(JSON.stringify({ error: 'GITHUB_TOKEN не задан в переменных окружения' }), 500);
  }

  const ghUrl = `${GITHUB_API}/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${env.FILE_PATH}`;

  let res;
  try {
    res = await fetch(ghUrl, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Fant1kz-Worker/1.0',
        // Принудительно без кэша
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
      // Cloudflare: не кэшировать на своём уровне
      cf: { cacheEverything: false, cacheTtl: 0 },
    });
  } catch (e) {
    return corsResponse(JSON.stringify({ error: `Сеть: ${e.message}` }), 502);
  }

  if (res.status === 404) {
    // Файл ещё не существует — возвращаем пустой список
    return corsResponse(JSON.stringify({ users: [], sha: '' }), 200);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return corsResponse(JSON.stringify({
      error: `GitHub ${res.status}: ${body.slice(0, 300)}`,
    }), res.status);
  }

  const data = await res.json();
  const sha  = data.sha || '';

  // Декодируем base64 → JSON
  let users = [];
  try {
    const decoded = atob(data.content.replace(/\n/g, ''));
    const trimmed = decoded.trim();
    if (trimmed && trimmed !== 'null') {
      const parsed = JSON.parse(trimmed);
      users = Array.isArray(parsed) ? parsed : Object.values(parsed);
    }
  } catch (e) {
    // Повреждённый файл — начинаем с пустого
    users = [];
  }

  return corsResponse(JSON.stringify({ users, sha }), 200);
}

// ─── PUT /profiles ────────────────────────────────────────────────────────────
async function handlePut(request, env) {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    return corsResponse(JSON.stringify({ error: 'GITHUB_TOKEN не задан' }), 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return corsResponse(JSON.stringify({ error: 'Невалидный JSON в теле запроса' }), 400);
  }

  const { users, sha } = body;
  if (!Array.isArray(users)) {
    return corsResponse(JSON.stringify({ error: 'users должен быть массивом' }), 400);
  }

  const ghUrl = `${GITHUB_API}/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${env.FILE_PATH}`;
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(users, null, 2))));

  let res;
  try {
    res = await fetch(ghUrl, {
      method: 'PUT',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Fant1kz-Worker/1.0',
      },
      body: JSON.stringify({
        message: `upd ${Date.now()}`,
        content,
        ...(sha ? { sha } : {}),
      }),
    });
  } catch (e) {
    return corsResponse(JSON.stringify({ error: `Сеть при записи: ${e.message}` }), 502);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return corsResponse(JSON.stringify({
      error: `GitHub ${res.status} при записи: ${body.slice(0, 300)}`,
    }), res.status);
  }

  const rd = await res.json().catch(() => ({}));
  const newSha = rd?.content?.sha || sha;

  return corsResponse(JSON.stringify({ ok: true, sha: newSha }), 200);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function corsResponse(body, status) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Cache-Control': 'no-store',
    },
  });
}
