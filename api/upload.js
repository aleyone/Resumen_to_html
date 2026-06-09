export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

const GH_BASE = 'https://api.github.com';

// Sanitize a string for use as a GitHub path segment
// "Integración CRIBAT" → "Integracion-CRIBAT"
// "SIA V 42.01.04"    → "SIA-V-42.01.04"
function sanitizePath(str, maxLen = 80) {
  return String(str || '')
    // Normalize accented characters
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // strip diacritics (á→a, é→e, ñ→n, etc.)
    .replace(/ø/g, 'o').replace(/Ø/g, 'O')
    .replace(/æ/g, 'ae').replace(/Æ/g, 'AE')
    // Replace spaces and underscores with hyphens
    .replace(/[\s_]+/g, '-')
    // Remove characters not safe for file/folder names
    .replace(/[^a-zA-Z0-9.\-]/g, '')
    // Collapse multiple hyphens
    .replace(/-{2,}/g, '-')
    // Trim leading/trailing hyphens
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
}

// Keep normalizePathSegment as alias for backwards compat in other contexts
function normalizePathSegment(str) { return sanitizePath(str); }

function cleanTitle(title) {
  // Remove bracket prefixes like [GVMEGAIA-27207] GAIA-523 [MPRE3]
  return (title || '').replace(/^(\[[^\]]*\]\s*)+(GAIA-\d+\s*)?/i, '').trim();
}

async function ghGet(repo, token, path) {
  const r = await fetch(`${GH_BASE}/repos/${repo}/contents/${path}`, {
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }
  });
  if (!r.ok) return null;
  return r.json();
}

async function ghPut(repo, token, path, content, sha, message) {
  const body = { message, content: Buffer.from(content).toString('base64') };
  if (sha) body.sha = sha;
  const r = await fetch(`${GH_BASE}/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('GitHub PUT failed: ' + path + ' — ' + await r.text());
  return r.json();
}

async function getDeploymentsDB(repo, token) {
  const file = await ghGet(repo, token, 'data/deployments.json');
  if (!file) return { content: { deployments: [] }, sha: null };
  try {
    return { content: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')), sha: file.sha };
  } catch(e) {
    return { content: { deployments: [] }, sha: file.sha };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { GITHUB_TOKEN, GITHUB_REPO } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPO) return res.status(500).json({ error: 'Faltan variables de entorno' });

  try {
    const { app, version, author, date, files, requirements, depId, rawTexts, noMerge } = req.body;
    if (!app || !version || !author || !requirements?.length) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const finalDepId = depId || `dep_${Date.now()}`;
    const appSafe = normalizePathSegment(app);
    const versionSafe = normalizePathSegment(version);

    // 1. Save raw texts to data/raw/{app}/{version}/{component}/{cleanTitle}.txt
    if (rawTexts && rawTexts.length) {
      for (let i = 0; i < rawTexts.length; i++) {
        const { filename, raw_text, reqIndex } = rawTexts[i];
        if (!raw_text) continue;

        // Use reqIndex to find the correct requirement for this file
        // Fall back to index i if reqIndex not provided (backwards compat)
        const reqIdx = reqIndex !== undefined ? reqIndex : i;
        const req = requirements[reqIdx] || requirements[i] || requirements[0];
        const realComponent = req?.component || 'General'; // original name with accents
        const component = normalizePathSegment(realComponent);
        const titleClean = normalizePathSegment(cleanTitle(req?.title || filename));
        const rawPath = `data/raw/${appSafe}/${versionSafe}/${component}/${titleClean}.txt`;

        // Prepend real component name so search.js can read it back correctly
        const rawWithMeta = `[COMPONENTE_REAL] ${realComponent}\n${raw_text}`;

        try {
          const existing = await ghGet(GITHUB_REPO, GITHUB_TOKEN, rawPath);
          await ghPut(GITHUB_REPO, GITHUB_TOKEN, rawPath, rawWithMeta, existing?.sha || null,
            `Raw: ${app} ${version} - ${component} - ${titleClean}`
          );
          console.log('Saved raw:', rawPath);
        } catch(e) {
          console.error('Raw text save error:', rawPath, e.message);
        }
      }
    }

    // 2. Clean titles in requirements + strip raw_text just in case
    const cleanReqs = requirements.map(r => ({
      ...r,
      title: cleanTitle(r.title),
      images: (r.images || []).filter(v => typeof v === 'string' && v.startsWith('http')),
      raw_text: undefined
    }));

    // 3. Load and update deployments.json
    const { content: db, sha } = await getDeploymentsDB(GITHUB_REPO, GITHUB_TOKEN);

    // Check if same app+version exists — only merge in summary mode (noMerge=true skips)
    const existingIdx = noMerge ? -1 : db.deployments.findIndex(d => d.app === app && d.version === version);
    if (existingIdx >= 0) {
      const existing = db.deployments[existingIdx];
      const offset = existing.requirements.length;
      const reindexed = cleanReqs.map((r, i) => ({ ...r, id: `REQ-${String(offset + i + 1).padStart(2, '0')}` }));
      existing.requirements = [...existing.requirements, ...reindexed];
      (files || []).forEach(f => { if (!existing.files.includes(f)) existing.files.push(f); });
    } else {
      db.deployments.push({
        id: finalDepId, app, version,
        date: date || new Date().toISOString().split('T')[0],
        author, files: files || [],
        requirements: cleanReqs
      });
    }

    await ghPut(GITHUB_REPO, GITHUB_TOKEN, 'data/deployments.json',
      JSON.stringify(db, null, 2), sha,
      `Deploy: ${app} ${version} (${(files || []).join(', ')})`
    );

    return res.status(200).json({ ok: true, depId: finalDepId, reqCount: cleanReqs.length });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
}
