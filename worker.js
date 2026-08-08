/**
 * DEAD ZONE — Worker del rànquing global
 * ---------------------------------------------------------------------------
 * Manté un fitxer `ranking.json` dins del teu repositori de GitHub.
 * El token de GitHub viu AQUÍ DINS (al servidor), mai al joc, que és públic.
 *
 * GET  /   → retorna el rànquing sencer (JSON)
 * POST /   → {name, coins, kills, score} — fusiona una partida i retorna el nou rànquing
 *
 * Variables a configurar al Worker (Settings → Variables and Secrets):
 *   GITHUB_TOKEN   [Secret] Token fine-grained amb "Contents: Read and write" NOMÉS d'aquest repo
 *   REPO           [Text]   usuari/repositori     ex: guille/dead-zone
 *   BRANCH         [Text]   main
 *   FILE_PATH      [Text]   ranking.json
 *   ALLOWED_ORIGIN [Text]   https://usuari.github.io    (o * per permetre-ho tot)
 */

const MAX_NAME = 12;
const MAX_VAL  = 100000000;

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (request.method === 'GET') {
        const { list } = await readRanking(env);
        return json(list, cors);
      }
      if (request.method === 'POST') {
        const run = sanitize(await request.json());
        if (!run) return json({ error: 'dades invàlides' }, cors, 400);
        return json(await submitRun(env, run), cors);
      }
      return json({ error: 'mètode no suportat' }, cors, 405);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, cors, 500);
    }
  },
};

function json(data, cors, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// Neteja i limita el que arriba del navegador: qualsevol pot cridar aquesta URL.
function sanitize(body) {
  if (!body || typeof body !== 'object') return null;
  const name = String(body.name || '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N} ._-]/gu, '')
    .trim()
    .slice(0, MAX_NAME);
  if (!name) return null;
  const num = (v) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_VAL) : 0;
  };
  return { name, coins: num(body.coins), kills: num(body.kills), score: num(body.score) };
}

// base64 <-> text respectant els accents (ANÒNIM, CAÇADOR...)
function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function b64encode(str) {
  let bin = '';
  new TextEncoder().encode(str).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.REPO}/contents/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'deadzone-ranking-worker',
      ...(init.headers || {}),
    },
  });
}

async function readRanking(env) {
  const branch = env.BRANCH || 'main';
  const res = await gh(env, `${env.FILE_PATH}?ref=${encodeURIComponent(branch)}`);
  if (res.status === 404) return { list: [], sha: null }; // encara no existeix: el crearem
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let list = [];
  try {
    list = JSON.parse(b64decode(data.content));
  } catch (e) {
    list = [];
  }
  return { list: Array.isArray(list) ? list : [], sha: data.sha };
}

// Mateixes regles que al joc: monedes i punts guarden el màxim, els zombis s'acumulen.
function mergeRun(list, run) {
  const out = Array.isArray(list) ? list.slice() : [];
  let e = out.find((x) => x && x.name === run.name);
  if (!e) {
    e = { name: run.name, coins: 0, kills: 0, score: 0, games: 0 };
    out.push(e);
  }
  e.coins = Math.max(e.coins || 0, run.coins);
  e.score = Math.max(e.score || 0, run.score);
  e.kills = (e.kills || 0) + run.kills;
  e.games = (e.games || 0) + 1;
  e.updated = new Date().toISOString();
  out.sort((a, b) => (b.score || 0) - (a.score || 0));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Llegeix-modifica-escriu amb el SHA del fitxer. Si dues persones acaben la
// partida alhora, GitHub rebutja la segona escriptura i la tornem a provar.
async function submitRun(env, run) {
  const branch = env.BRANCH || 'main';
  for (let intent = 0; intent < 4; intent++) {
    const { list, sha } = await readRanking(env);
    const merged = mergeRun(list, run);
    const res = await gh(env, env.FILE_PATH, {
      method: 'PUT',
      body: JSON.stringify({
        message: `rànquing: ${run.name} · +${run.kills} zombis · ${run.score} pts`,
        content: b64encode(JSON.stringify(merged, null, 2) + '\n'),
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (res.ok) return merged;
    if (res.status === 409 || res.status === 422) {
      await sleep(250 * (intent + 1));
      continue;
    }
    throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  }
  throw new Error('massa conflictes escrivint ranking.json, torna-ho a provar');
}
