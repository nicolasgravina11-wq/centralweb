// Crea un usuario real (Auth + profile) desde admin.html.
// Solo lo puede ejecutar un Administrador de la misma empresa.
//
// Body esperado (JSON):
//   { nombre, apellido, email, rol, bandejas: [bandejaId, ...] }
// Header esperado:
//   Authorization: Bearer <access_token del admin logueado>
//
// Variables de entorno necesarias (ya configuradas en Vercel):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ftuyjjjkjxbldgdxmcfv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const GRADIENTES = [
  'linear-gradient(135deg,#1a6cd4,#4fa3f7)',
  'linear-gradient(135deg,#7c3aed,#a78bfa)',
  'linear-gradient(135deg,#059669,#34d399)',
  'linear-gradient(135deg,#dc2626,#f87171)',
  'linear-gradient(135deg,#d97706,#fbbf24)',
  'linear-gradient(135deg,#0891b2,#67e8f9)',
];

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

// Valida el access_token del usuario contra el endpoint de auth de Supabase
// y devuelve el usuario (o null si el token no es válido).
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

function generarPasswordTemporal() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
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

  const { nombre, apellido, email, rol, bandejas } = req.body || {};
  if (!nombre || !apellido || !email) {
    res.status(400).json({ ok: false, error: 'Faltan campos: nombre, apellido y email son obligatorios' });
    return;
  }

  try {
    const solicitante = await getUsuarioDesdeToken(token);
    if (!solicitante || !solicitante.id) {
      res.status(401).json({ ok: false, error: 'Token inválido' });
      return;
    }

    const perfilesSolicitante = await supabaseFetch(`profiles?select=empresa_id,rol&id=eq.${solicitante.id}`);
    if (!perfilesSolicitante || !perfilesSolicitante.length) {
      res.status(403).json({ ok: false, error: 'Perfil no encontrado' });
      return;
    }
    const perfilSolicitante = perfilesSolicitante[0];
    if (perfilSolicitante.rol !== 'Administrador') {
      res.status(403).json({ ok: false, error: 'Solo un Administrador puede crear usuarios' });
      return;
    }
    const empresaId = perfilSolicitante.empresa_id;

    const usuariosExistentes = await supabaseFetch(`profiles?select=id&empresa_id=eq.${empresaId}`);
    const cantidadActual = (usuariosExistentes || []).length;

    const emailNormalizado = String(email).trim().toLowerCase();
    const passwordTemporal = generarPasswordTemporal();

    const authRespuesta = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: emailNormalizado,
        password: passwordTemporal,
        email_confirm: true,
        user_metadata: { nombre, apellido }
      })
    });
    const authJson = await authRespuesta.json().catch(() => ({}));
    if (!authRespuesta.ok) {
      const mensaje = authJson?.msg || authJson?.message || authJson?.error_description || 'No se pudo crear el usuario de acceso';
      res.status(authRespuesta.status === 422 ? 409 : 502).json({ ok: false, error: mensaje });
      return;
    }
    const nuevoAuthId = authJson.id;

    const iniciales = (nombre[0] + (apellido[0] || '')).toUpperCase();
    const gradiente = GRADIENTES[cantidadActual % GRADIENTES.length];

    let nuevoPerfil;
    try {
      const perfilesCreados = await supabaseFetch('profiles', {
        method: 'POST',
        body: JSON.stringify({
          id: nuevoAuthId,
          empresa_id: empresaId,
          nombre,
          apellido,
          email: emailNormalizado,
          rol: rol || 'Agente',
          iniciales,
          gradiente
        })
      });
      nuevoPerfil = perfilesCreados && perfilesCreados[0];
    } catch (e) {
      // Si falla la creación del profile, no dejamos un usuario de Auth huérfano.
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${nuevoAuthId}`, {
        method: 'DELETE',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }).catch(() => {});
      throw e;
    }

    const bandejasMarcadas = Array.isArray(bandejas) ? bandejas : [];
    for (const bandejaId of bandejasMarcadas) {
      await supabaseFetch('centralweb_permisos', {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify({ empresa_id: empresaId, bandeja_id: bandejaId, user_id: nuevoAuthId, acceso: true, ver_otros: false })
      }).catch(e => console.error('No se pudo asignar permiso de bandeja:', e.message));
    }

    res.status(200).json({ ok: true, profile: nuevoPerfil, tempPassword: passwordTemporal });
  } catch (e) {
    console.error('Error en create-user:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};
