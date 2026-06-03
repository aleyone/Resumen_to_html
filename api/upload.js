export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

async function getGitHubFile(repo, token) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/contents/data/deployments.json`,
    { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' } }
  );
  if (!response.ok) return { content: { deployments: [] }, sha: null };
  const file = await response.json();
  return {
    content: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')),
    sha: file.sha
  };
}

async function saveGitHubFile(repo, token, content, sha, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64')
  };
  if (sha) body.sha = sha;
  const response = await fetch(
    `https://api.github.com/repos/${repo}/contents/data/deployments.json`,
    {
      method: 'PUT',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error('GitHub save error: ' + err);
  }
  return true;
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
    const { app, version, author, date, files, requirements, depId } = req.body;
    if (!app || !version || !author || !requirements?.length) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const finalDepId = depId || `dep_${Date.now()}`;

    // Strip any residual base64 (safety net — should already be URLs)
    const cleanReqs = requirements.map(r => ({
      ...r,
      images: (r.images || []).filter(v => typeof v === 'string' && v.startsWith('http'))
    }));

    const { content: db, sha } = await getGitHubFile(GITHUB_REPO, GITHUB_TOKEN);

    // Merge if same app+version exists
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

    await saveGitHubFile(GITHUB_REPO, GITHUB_TOKEN, db, sha,
      `Deploy: ${app} ${version} (${(files || []).join(', ')})`);

    return res.status(200).json({ ok: true, depId: finalDepId, reqCount: cleanReqs.length });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
}
