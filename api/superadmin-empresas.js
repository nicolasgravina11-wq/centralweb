// Endpoint privado: solo accesible para usuarios con profiles.es_superadmin = true.
// Permite ver y modificar el estado de suscripcion de cada empresa (uso exclusivo de Nico).
//
// GET  -> devuelve todas las empresas con sus campos de suscripcion y cantidad de agentes.
// POST -> body { empresaId, estado_suscripcion, trial_vence_en, limite_agentes } actualiza una empresa.
// Header esperado en ambos casos:
// Authorization: Bearer <access_token de supabase del usuario logueado>
//
// Variables de entorno necesarias (configuradas en Vercel, nunca en el repo):
// SUPABASE_URL (no es secreta, pero se lee de env por prolijidad)
// SUPABASE_SERVICE_ROLE_KEY (secreta - permite saltar RLS, solo la usa este backend)

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

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  if (!SERVICE_KEY) {
    console.error('Falta SUPABASE_SERVICE_ROLE_KEY');
    res.status(500).json({ ok: false, error: 'Server misconfigured' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    res.status(401).json({ ok: false, error: 'Falta token de autenticacion' });
    return;
  }

  try {
    const usuario = await getUsuarioDesdeToken(token);
    if (!usuario || !usuario.id) {
      res.status(401).json({ ok: false, error: 'Token invalido' });
      return;
    }

  const perfiles = await supabaseFetch(`profiles?select=es_superadmin&id=eq.${usuario.id}`);
    if (!perfiles || !perfiles.length || perfiles[0].es_superadmin !== true) {
      res.status(403).json({ ok: false, error: 'No autorizado' });
      return;
    }

  if (req.method === 'GET') {
    const [empresas, perfilesTodos] = await Promise.all([
      supabaseFetch('empresas?select=id,nombre_formal,sigla,estado_suscripcion,trial_vence_en,limite_agentes&order=nombre_formal.asc'),
      supabaseFetch('profiles?select=empresa_id')
      ]);
    const conteo = {};
    (perfilesTodos || []).forEach(p => { if (p.empresa_id) conteo[p.empresa_id] = (conteo[p.empresa_id] || 0) + 1; });
    const resultado = (empresas || []).map(e => Object.assign({}, e, { cantidad_agentes: conteo[e.id] || 0 }));
    res.status(200).json({ ok: true, empresas: resultado });
    return;
  }

  const { empresaId, estado_suscripcion, trial_vence_en, limite_agentes } = req.body || {};
    if (!empresaId) {
      res.status(400).json({ ok: false, error: 'Falta empresaId' });
      return;
    }
    const cambios = {};
    if (estado_suscripcion !== undefined) cambios.estado_suscripcion = estado_suscripcion;
    if (trial_vence_en !== undefined) cambios.trial_vence_en = trial_vence_en;
    if (limite_agentes !== undefined) cambios.limite_agentes = limite_agentes;
    if (!Object.keys(cambios).length) {
      res.status(400).json({ ok: false, error: 'Nada para actualizar' });
      return;
    }

  await supabaseFetch(`empresas?id=eq.${empresaId}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: JSON.stringify(cambios)
  });

  res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Error en superadmin-empresas:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};
