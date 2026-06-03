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

  try {
    // Load DB
    const ghResp = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/data/deployments.json`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (!ghResp.ok) return res.status(404).json({ error: 'No se encontró el fichero de despliegues' });
    const file = await ghResp.json();
    const db = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    const sha = file.sha;

    const dep = db.deployments.find(d => d.id === depId);
    if (!dep) return res.status(404).json({ error: 'Despliegue no encontrado' });

    // Delete images from Cloudinary
    if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
      try {
        const crypto = await import('crypto');
        // Collect all cloudinary public_ids from image URLs
        const allImages = (dep.requirements || []).flatMap(r => r.images || []).filter(Boolean);
        for (const url of allImages) {
          // Extract public_id from URL: .../gaia-releases/dep_xxx/req00_img00
          const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]+$/);
          if (!match) continue;
          const publicId = match[1];
          const timestamp = Math.floor(Date.now() / 1000);
          const sigString = `public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
          const signature = crypto.createHash('sha1').update(sigString).digest('hex');
          const form = new URLSearchParams();
          form.append('public_id', publicId);
          form.append('timestamp', timestamp);
          form.append('api_key', CLOUDINARY_API_KEY);
          form.append('signature', signature);
          await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/destroy`, {
            method: 'POST', body: form
          });
        }
      } catch (e) {
        console.error('Cloudinary delete partial error:', e.message);
      }
    }

    // Remove from DB
    db.deployments = db.deployments.filter(d => d.id !== depId);

    // Save back
    await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/data/deployments.json`,
      {
        method: 'PUT',
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: `Delete deployment: ${dep.app} ${dep.version} (${depId})`,
          content: Buffer.from(JSON.stringify(db, null, 2)).toString('base64'),
          sha
        })
      }
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: err.message });
  }
}
