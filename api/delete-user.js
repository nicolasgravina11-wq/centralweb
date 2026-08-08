// Elimina un usuario de verdad: cuenta de Auth + permisos + profile.
// Solo lo puede ejecutar un Administrador de la misma empresa.
//
// Body esperado (JSON):
//   { userId }
// Header esperado:
//   Authorization: Bearer <access_token del admin logueado>
//
// Por que existe este endpoint: admin.html borraba solo la fila de `profiles`
// con la anon key. La cuenta de Auth quedaba viva, asi que el usuario "eliminado"
// podia seguir autenticandose y, sobre todo, su email quedaba tomado para siempre:
// volver a darlo de alta devolvia "A user with this email address has already
// been registered". Borrar de Auth requiere la service role key, que solo puede
// vivir en el servidor.
//
// El orden importa: primero se revoca el acceso (Auth) y despues se limpian las
// filas. Si fallara un paso posterior queda una fila fantasma en la lista, que es
// molesto pero inofensivo; al reves quedaria un usuario invisible con acceso.
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
  // Las respuestas con Prefer: return=minimal vuelven 204 sin cuerpo y, segun el
  // caso, sin header content-length: llamar a .json() ahi tira "Unexpected end of
  // JSON input" y hace fallar toda la operacion.
  if (respuesta.status === 204 || respuesta.status === 205) return null;
  const contentLength = respuesta.headers.get('content-length');
  if (contentLength === '0') return null;
  const texto = await respuesta.text();
  if (!texto) return null;
  return JSON.parse(texto);
}

// Valida el access_token del usuario contra el endpoint de auth de Supabase
// y devuelve el usuario (o null si el token no es válido).
async function getUsuarioDesdeToken(token) {
  const respuesta = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!respuesta.ok) return null;
  return respuesta.json();
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

  const { userId } = req.body || {};
  if (!userId) {
    res.status(400).json({ ok: false, error: 'Falta userId' });
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
      res.status(403).json({ ok: false, error: 'Solo un Administrador puede eliminar usuarios' });
      return;
    }
    const empresaId = perfilSolicitante.empresa_id;

    // Un admin no puede borrarse a si mismo: se quedaria afuera de su propia empresa.
    if (userId === solicitante.id) {
      res.status(400).json({ ok: false, error: 'No podés eliminar tu propio usuario' });
      return;
    }

    // El objetivo tiene que existir y ser de la MISMA empresa. Sin este control,
    // la service role key permitiria borrar usuarios de cualquier otra empresa.
    const perfilesObjetivo = await supabaseFetch(`profiles?select=id,empresa_id,rol&id=eq.${userId}`);
    if (!perfilesObjetivo || !perfilesObjetivo.length) {
      res.status(404).json({ ok: false, error: 'El usuario no existe' });
      return;
    }
    const perfilObjetivo = perfilesObjetivo[0];
    if (perfilObjetivo.empresa_id !== empresaId) {
      res.status(403).json({ ok: false, error: 'El usuario pertenece a otra empresa' });
      return;
    }

    // No dejar a la empresa sin ningun administrador.
    if (perfilObjetivo.rol === 'Administrador') {
      const admins = await supabaseFetch(`profiles?select=id&empresa_id=eq.${empresaId}&rol=eq.Administrador`);
      if ((admins || []).length <= 1) {
        res.status(409).json({ ok: false, error: 'No podés eliminar al único Administrador de la empresa' });
        return;
      }
    }

    // Los casos que tenia asignados vuelven a la bandeja, sin dueño.
    await supabaseFetch(`centralweb_casos?empresa_id=eq.${empresaId}&asignado_user_id=eq.${userId}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ asignado_user_id: null })
    });

    // 1) Revocar el acceso primero.
    const respAuth = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    if (!respAuth.ok && respAuth.status !== 404) {
      const texto = await respAuth.text();
      console.error('No se pudo eliminar la cuenta de Auth:', respAuth.status, texto);
      res.status(502).json({ ok: false, error: 'No se pudo eliminar la cuenta de acceso. No se borró nada; probá de nuevo.' });
      return;
    }

    // 2) Recien ahora las filas.
    await supabaseFetch(`centralweb_permisos?user_id=eq.${userId}`, { method: 'DELETE', prefer: 'return=minimal' });
    await supabaseFetch(`profiles?id=eq.${userId}`, { method: 'DELETE', prefer: 'return=minimal' });

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Error eliminando usuario:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};
