export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

const GH_BASE = 'https://api.github.com';

async function ghGet(repo, token, path) {
  const r = await fetch(`${GH_BASE}/repos/${repo}/contents/${path}`, {
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }
  });
  if (!r.ok) return null;
  return r.json();
}

async function ghPut(repo, token, path, content, sha, message) {
  const body = {
    message,
    content: Buffer.from(content).toString('base64')
  };
  if (sha) body.sha = sha;
  const r = await fetch(`${GH_BASE}/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('GitHub PUT failed: ' + path + ' — ' + await r.text());
  return r.json();
}

async function getDeploymentsDB(repo, token) {
  const file = await ghGet(repo, token, 'data/deployments.json');
  if (!file) return { content: { deployments: [] }, sha: null };
  try {
    return {
      content: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')),
      sha: file.sha
    };
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
    const { app, version, author, date, files, requirements, depId, rawTexts } = req.body;
    if (!app || !version || !author || !requirements?.length) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const finalDepId = depId || `dep_${Date.now()}`;

    // 1. Save raw texts to data/raw/<depId>_<safeFilename>.txt
    if (rawTexts && rawTexts.length) {
      for (const { filename, raw_text } of rawTexts) {
        if (!raw_text) continue;
        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
        const rawPath = `data/raw/${finalDepId}_${safeName}.txt`;
        try {
          // Check if exists (for merge case)
          const existing = await ghGet(GITHUB_REPO, GITHUB_TOKEN, rawPath);
          await ghPut(GITHUB_REPO, GITHUB_TOKEN, rawPath,
            raw_text, existing?.sha || null,
            `Raw text: ${app} ${version} - ${filename}`
          );
        } catch(e) {
          console.error('Raw text save error:', e.message);
          // Non-fatal — continue
        }
      }
    }

    // 2. Strip any residual base64 from requirements (safety net)
    const cleanReqs = requirements.map(r => ({
      ...r,
      images: (r.images || []).filter(v => typeof v === 'string' && v.startsWith('http'))
    }));

    // 3. Load deployments.json and merge/add
    const { content: db, sha } = await getDeploymentsDB(GITHUB_REPO, GITHUB_TOKEN);

    const existingIdx = db.deployments.findIndex(d => d.app === app && d.version === version);
    if (existingIdx >= 0) {
      const existing = db.deployments[existingIdx];
      const offset = existing.requirements.length;
      const reindexed = cleanReqs.map((r, i) => ({
        ...r, id: `REQ-${String(offset + i + 1).padStart(2, '0')}`
      }));
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
