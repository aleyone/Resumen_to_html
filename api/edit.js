export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { GITHUB_TOKEN, GITHUB_REPO, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPO) return res.status(500).json({ error: 'Faltan variables de entorno' });

  const GH_HEADERS = { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };

  try {
    const { action, depId, reqIdx, fields, imageUrl } = req.body;

    // Load DB
    const dbResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/data/deployments.json`, { headers: GH_HEADERS });
    if (!dbResp.ok) return res.status(500).json({ error: 'No se pudo cargar deployments.json' });
    const dbFile = await dbResp.json();
    const db = JSON.parse(Buffer.from(dbFile.content, 'base64').toString('utf8'));
    const depIdx = db.deployments.findIndex(d => d.id === depId);
    if (depIdx === -1) return res.status(404).json({ error: 'Despliegue no encontrado' });
    const dep = db.deployments[depIdx];

    if (action === 'edit_req') {
      // Update editable fields of a requirement
      const req_item = dep.requirements[reqIdx];
      if (!req_item) return res.status(404).json({ error: 'Requerimiento no encontrado' });
      const allowed = ['title', 'resumen', 'situacion_actual', 'descripcion', 'impacto_produccion'];
      allowed.forEach(f => { if (fields[f] !== undefined) req_item[f] = fields[f]; });

    } else if (action === 'delete_image') {
      // Remove image from requirement and delete from Cloudinary
      const req_item = dep.requirements[reqIdx];
      if (!req_item) return res.status(404).json({ error: 'Requerimiento no encontrado' });
      req_item.images = (req_item.images || []).filter(url => url !== imageUrl);

      // Delete from Cloudinary
      if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET && imageUrl) {
        try {
          const crypto = await import('crypto');
          const match = imageUrl.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]+$/);
          if (match) {
            const publicId = match[1];
            const timestamp = Math.floor(Date.now() / 1000);
            const sig = crypto.createHash('sha1').update(`public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`).digest('hex');
            const form = new URLSearchParams();
            form.append('public_id', publicId); form.append('timestamp', timestamp);
            form.append('api_key', CLOUDINARY_API_KEY); form.append('signature', sig);
            await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/destroy`, { method: 'POST', body: form });
          }
        } catch(e) { console.error('Cloudinary delete error:', e.message); }
      }
    } else {
      return res.status(400).json({ error: 'Acción desconocida' });
    }

    // Save updated DB
    await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/data/deployments.json`, {
      method: 'PUT', headers: GH_HEADERS,
      body: JSON.stringify({
        message: `Edit: ${dep.app} ${dep.version} - ${action}`,
        content: Buffer.from(JSON.stringify(db, null, 2)).toString('base64'),
        sha: dbFile.sha
      })
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Edit error:', err);
    res.status(500).json({ error: err.message });
  }
}
