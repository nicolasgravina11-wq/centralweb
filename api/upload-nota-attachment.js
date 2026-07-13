// Sube adjuntos de una nota interna a Supabase Storage (bucket "adjuntos")
// y devuelve las URLs publicas para guardar en centralweb_notas.adjuntos.
//
// Body esperado (JSON):
//   { casoId, archivos: [{ nombre, tipo, contenidoBase64 }] }
// Header esperado:
//   Authorization: Bearer <access_token del usuario logueado>
//
// Variables de entorno necesarias (ya configuradas en Vercel):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ftuyjjjkjxbldgdxmcfv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseFetch(path, options = {}) {
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: options.prefer || 'return=representation',
    ...(options.headers || {})
  };
  const respuesta = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body
  });
  if (!respuesta.ok) {
    const texto = await respuesta.text();
    throw new Error(`Supabase ${path} -> ${respuesta.status}: ${texto}`);
  }
  const contentLength = respuesta.headers.get('content-length');
  if (contentLength === '0') return null;
  return respuesta.json();
}

async function getUsuarioDesdeToken(token) {
  const respuesta = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${token}`
    }
  });
  if (!respuesta.ok) return null;
  return respuesta.json();
}

function slugify(str) {
  return String(str).toLowerCase()
    .normalize('NFD').replace(/[Ì-Í¯]/g, '')
    .replace(/[^a-z0-9.]+/g, '-');
}

async function subirAdjunto(path, buffer, contentType) {
  const respuesta = await fetch(`${SUPABASE_URL}/storage/v1/object/adjuntos/${path}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': contentType || 'application/octet-stream'
    },
    body: buffer
  });
  if (!respuesta.ok) {
    const texto = await respuesta.text();
    throw new Error(`Storage upload ${path} -> ${respuesta.status}: ${texto}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/adjuntos/${path}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  if (!SERVICE_KEY) {
    console.error('Falta la variable de entorno SUPABASE_SERVICE_ROLE_KEY');
    res.status(500).json({ ok: false, error: 'Server misconfigured' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    res.status(401).json({ ok: false, error: 'Falta token de autenticaciÃ³n' });
    return;
  }

  const { casoId, archivos } = req.body || {};
  if (!casoId || !Array.isArray(archivos) || !archivos.length) {
    res.status(400).json({ ok: false, error: 'Faltan campos: casoId y archivos son obligatorios' });
    return;
  }

  try {
    const usuario = await getUsuarioDesdeToken(token);
    if (!usuario || !usuario.id) {
      res.status(401).json({ ok: false, error: 'Token invÃ¡lido' });
      return;
    }

    const perfiles = await supabaseFetch(`profiles?select=empresa_id&id=eq.${usuario.id}`);
    if (!perfiles || !perfiles.length) {
      res.status(403).json({ ok: false, error: 'Perfil no encontrado' });
      return;
    }
    const empresaId = perfiles[0].empresa_id;

    const casos = await supabaseFetch(`centralweb_casos?select=id,empresa_id&id=eq.${casoId}`);
    if (!casos || !casos.length) {
      res.status(404).json({ ok: false, error: 'Caso no encontrado' });
      return;
    }
    if (casos[0].empresa_id !== empresaId) {
      res.status(403).json({ ok: false, error: 'El caso no pertenece a tu empresa' });
      return;
    }

    const empresas = await supabaseFetch(`empresas?select=sigla&id=eq.${empresaId}`);
    const sigla = (empresas && empresas[0] && empresas[0].sigla) || 'empresa';

    const adjuntosFinal = [];
    for (const item of archivos) {
      try {
        const nombre = item.nombre || 'archivo';
        const buffer = Buffer.from(item.contenidoBase64 || '', 'base64');
        const tipo = item.tipo || 'application/octet-stream';
        const path = `${sigla}/notas/${casoId}/${Date.now()}-${slugify(nombre)}`;
        const url = await subirAdjunto(path, buffer, tipo);
        adjuntosFinal.push({ nombre, url, tamano: buffer.length });
      } catch (e) {
        console.error('No se pudo subir un adjunto de nota:', item && item.nombre, e.message);
      }
    }

    res.status(200).json({ ok: true, adjuntos: adjuntosFinal });
  } catch (e) {
    console.error('Error en upload-nota-attachment:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};
