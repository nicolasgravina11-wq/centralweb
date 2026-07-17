// Sube un archivo a Supabase Storage (bucket "adjuntos") usando el service role,
// para evitar problemas de RLS del lado del cliente en prefijos como "bandejas/"
// (que no tienen politica de INSERT para el usuario autenticado).
//
// Body esperado (JSON):
//   { carpeta, nombre, contenidoBase64, tipo }
// Header esperado:
//   Authorization: Bearer <access_token del usuario logueado>
//
// Variables de entorno necesarias (ya configuradas en Vercel):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ftuyjjjkjxbldgdxmcfv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CARPETAS_PERMITIDAS = ['bandejas', 'respuestas', 'firmas'];

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
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.]+/g, '-');
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
    res.status(401).json({ ok: false, error: 'Falta token de autenticación' });
    return;
  }

  const { carpeta, nombre, contenidoBase64, tipo } = req.body || {};
  if (!carpeta || !nombre || !contenidoBase64) {
    res.status(400).json({ ok: false, error: 'Faltan campos: carpeta, nombre y contenidoBase64 son obligatorios' });
    return;
  }
  if (!CARPETAS_PERMITIDAS.includes(carpeta)) {
    res.status(400).json({ ok: false, error: 'Carpeta no permitida' });
    return;
  }

  try {
    const usuario = await getUsuarioDesdeToken(token);
    if (!usuario || !usuario.id) {
      res.status(401).json({ ok: false, error: 'Token inválido' });
      return;
    }

    const perfiles = await supabaseFetch(`profiles?select=empresa_id,rol&id=eq.${usuario.id}`);
    if (!perfiles || !perfiles.length) {
      res.status(403).json({ ok: false, error: 'Perfil no encontrado' });
      return;
    }
    if (perfiles[0].rol !== 'Administrador') {
      res.status(403).json({ ok: false, error: 'Solo un Administrador puede subir este archivo' });
      return;
    }

    const buffer = Buffer.from(contenidoBase64, 'base64');
    const path = `${carpeta}/${Date.now()}-${slugify(nombre)}`;

    const subida = await fetch(`${SUPABASE_URL}/storage/v1/object/adjuntos/${path}`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': tipo || 'application/octet-stream'
      },
      body: buffer
    });
    if (!subida.ok) {
      const texto = await subida.text();
      throw new Error(`Storage upload ${path} -> ${subida.status}: ${texto}`);
    }

    const url = `${SUPABASE_URL}/storage/v1/object/public/adjuntos/${path}`;
    res.status(200).json({ ok: true, url, nombre, tamano: buffer.length });
  } catch (e) {
    console.error('Error en upload-attachment:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};
