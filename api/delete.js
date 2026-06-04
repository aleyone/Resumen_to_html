export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

  const { GITHUB_TOKEN, GITHUB_REPO, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPO) return res.status(500).json({ error: 'Faltan variables de entorno' });

  const { depId } = req.body;
  if (!depId) return res.status(400).json({ error: 'depId requerido' });

  const GH_HEADERS = { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };

  try {
    // 1. Load deployments.json
    const dbResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/data/deployments.json`, { headers: GH_HEADERS });
    if (!dbResp.ok) return res.status(404).json({ error: 'No se encontró el fichero de despliegues' });
    const dbFile = await dbResp.json();
    const db = JSON.parse(Buffer.from(dbFile.content, 'base64').toString('utf8'));
    const dep = db.deployments.find(d => d.id === depId);
    if (!dep) return res.status(404).json({ error: 'Despliegue no encontrado' });

    // 2. Delete Cloudinary images
    if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
      const crypto = await import('crypto');
      const allImages = (dep.requirements || []).flatMap(r => r.images || []).filter(Boolean);
      for (const url of allImages) {
        const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]+$/);
        if (!match) continue;
        const publicId = match[1];
        const timestamp = Math.floor(Date.now() / 1000);
        const sig = crypto.createHash('sha1').update(`public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`).digest('hex');
        const form = new URLSearchParams();
        form.append('public_id', publicId); form.append('timestamp', timestamp);
        form.append('api_key', CLOUDINARY_API_KEY); form.append('signature', sig);
        await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/destroy`, { method: 'POST', body: form });
      }
    }

    // 3. Delete data/raw/ files for this deployment
    try {
      const rawListResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/data/raw`, { headers: GH_HEADERS });
      if (rawListResp.ok) {
        const rawFiles = await rawListResp.json();
        const toDelete = rawFiles.filter(f => f.name.startsWith(depId));
        for (const f of toDelete) {
          await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${f.path}`, {
            method: 'DELETE',
            headers: GH_HEADERS,
            body: JSON.stringify({ message: `Delete raw: ${f.name}`, sha: f.sha })
          });
        }
      }
    } catch(e) {
      console.error('Raw files delete error:', e.message);
    }

    // 4. Remove from deployments.json and save
    db.deployments = db.deployments.filter(d => d.id !== depId);
    await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/data/deployments.json`, {
      method: 'PUT',
      headers: GH_HEADERS,
      body: JSON.stringify({
        message: `Delete deployment: ${dep.app} ${dep.version} (${depId})`,
        content: Buffer.from(JSON.stringify(db, null, 2)).toString('base64'),
        sha: dbFile.sha
      })
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: err.message });
  }
}
