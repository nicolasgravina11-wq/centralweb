// Devuelve una URL firmada y de vida corta para un adjunto guardado en el
// bucket PRIVADO. El front la pide en el momento de abrir el archivo, no al
// pintar la pantalla: asi el permiso se evalua cuando se usa.
//
// Por que existe: los adjuntos historicos viven en el bucket publico
// "adjuntos", donde la URL es la unica proteccion —quien la tenga entra sin
// login y para siempre—. Los nuevos van a "adjuntos-privados", que no se puede
// leer sin firma. Los viejos siguen funcionando como antes; no hay migracion.
//
// Body esperado (JSON):
//   { casoId, path }
// Header esperado:
//   Authorization: Bearer <access_token del usuario logueado>
//
// Variables de entorno necesarias (ya configuradas en Vercel):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ftuyjjjkjxbldgdxmcfv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET_PRIVADO = 'adjuntos-privados';
const SEGUNDOS_VALIDEZ = 60;

async function supabaseFetch(path) {
  const respuesta = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json'
    }
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
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!respuesta.ok) return null;
  return respuesta.json();
}

async function firmar(path) {
  const respuesta = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET_PRIVADO}/${path}`,
    {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ expiresIn: SEGUNDOS_VALIDEZ })
    }
  );
  if (!respuesta.ok) {
    const texto = await respuesta.text();
    throw new Error(`Storage sign ${path} -> ${respuesta.status}: ${texto}`);
  }
  const datos = await respuesta.json();
  if (!datos || !datos.signedURL) throw new Error('Storage no devolvio signedURL');
  return `${SUPABASE_URL}/storage/v1${datos.signedURL}`;
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

  const { casoId, path } = req.body || {};
  if (!casoId || !path) {
    res.status(400).json({ ok: false, error: 'Faltan campos: casoId y path son obligatorios' });
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
    const empresaId = perfiles[0].empresa_id;

    // Mismos controles que para subir el adjunto: empresa y acceso a la bandeja.
    const casos = await supabaseFetch(
      `centralweb_casos?select=id,ticket,empresa_id,bandeja_id,asignado_user_id&id=eq.${casoId}`
    );
    if (!casos || !casos.length) {
      res.status(404).json({ ok: false, error: 'Caso no encontrado' });
      return;
    }
    if (casos[0].empresa_id !== empresaId) {
      res.status(403).json({ ok: false, error: 'El caso no pertenece a tu empresa' });
      return;
    }
    const esAdmin = perfiles[0].rol === 'Administrador';
    const esAsignado = casos[0].asignado_user_id === usuario.id;
    if (!esAdmin && !esAsignado) {
      const permisos = await supabaseFetch(
        `centralweb_permisos?select=acceso&bandeja_id=eq.${casos[0].bandeja_id}&user_id=eq.${usuario.id}`
      );
      const tieneAcceso = Array.isArray(permisos) && permisos.length && permisos[0].acceso === true;
      if (!tieneAcceso) {
        res.status(403).json({ ok: false, error: 'No tenes acceso a la bandeja de este caso' });
        return;
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  LA RUTA NO SE CONFIA
    //  El cliente manda una ruta y el servidor la firma con la service role key,
    //  que puede leer TODO el bucket. Si se firmara lo que venga, alguien podria
    //  pedir la ruta de otra empresa y obtener una URL valida — el chequeo de
    //  arriba no lo frenaria, porque su propio caso si es suyo. Asi que la ruta
    //  tiene que empezar con el prefijo que le corresponde a ESTE caso, y la
    //  sigla se saca de la empresa del que pide, nunca del body.
    //  Ademas se rechaza ".." para que no se pueda salir del prefijo.
    // ─────────────────────────────────────────────────────────────────────────
    const empresas = await supabaseFetch(`empresas?select=sigla&id=eq.${empresaId}`);
    const sigla = (empresas && empresas[0] && empresas[0].sigla) || null;
    if (!sigla) {
      res.status(500).json({ ok: false, error: 'No se pudo determinar la empresa' });
      return;
    }
    // Los prefijos validos para ESTE caso. Cada origen arma la ruta distinto:
    //   notas/    -> upload-nota-attachment (tambien los adjuntos de caso nuevo)
    //   mensajes/ -> send-email (salientes)
    //   <ticket>/ -> inbound-email (entrantes), que usa el ticket y no el id
    // Todos salen de datos del servidor: la sigla de la empresa de quien pide y
    // el ticket de la fila del caso. Nada de esto viene del body.
    const ticketPlano = String(casos[0].ticket || '').replace('#', '');
    const prefijosValidos = [
      `${sigla}/notas/${casoId}/`,
      `${sigla}/casos/${casoId}/`,
      `${sigla}/mensajes/${casoId}/`
    ];
    if (ticketPlano) prefijosValidos.push(`${sigla}/${ticketPlano}/`);
    const rutaPedida = String(path);
    const permitida = !rutaPedida.includes('..') && prefijosValidos.some(function (p) { return rutaPedida.startsWith(p); });
    if (!permitida) {
      console.error('adjunto: ruta rechazada. pedida=' + rutaPedida + ' validas=' + prefijosValidos.join(' | '));
      res.status(403).json({ ok: false, error: 'La ruta no corresponde a este caso' });
      return;
    }

    const url = await firmar(path);
    res.status(200).json({ ok: true, url, expiraEn: SEGUNDOS_VALIDEZ });
  } catch (e) {
    console.error('Error en adjunto:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};
