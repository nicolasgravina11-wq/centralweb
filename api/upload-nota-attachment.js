// Sube adjuntos de una nota interna al bucket PRIVADO "adjuntos-privados" y
// devuelve las RUTAS para guardar en centralweb_notas.adjuntos. Para verlos hay
// que pedir una URL firmada a /api/adjunto, que valida empresa y bandeja.
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
const BUCKET_PRIVADO = 'adjuntos-privados';

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

// Los adjuntos de notas van al bucket PRIVADO: no se pueden leer sin una URL
// firmada, que emite /api/adjunto despues de validar empresa y bandeja. Antes
// iban al bucket publico "adjuntos", donde la URL era toda la proteccion.
// Devuelve la RUTA, no una URL: la URL se arma al abrir el archivo y vence.
// Lo ya subido al bucket publico queda donde esta y sigue funcionando.
async function subirAdjuntoPrivado(path, buffer, contentType) {
  const respuesta = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET_PRIVADO}/${path}`, {
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
  return path;
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

    const perfiles = await supabaseFetch(`profiles?select=empresa_id,rol&id=eq.${usuario.id}`);
    if (!perfiles || !perfiles.length) {
      res.status(403).json({ ok: false, error: 'Perfil no encontrado' });
      return;
    }
    const empresaId = perfiles[0].empresa_id;

    const casos = await supabaseFetch(`centralweb_casos?select=id,empresa_id,bandeja_id,asignado_user_id&id=eq.${casoId}`);
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
                    const permisos = await supabaseFetch(`centralweb_permisos?select=acceso&bandeja_id=eq.${casos[0].bandeja_id}&user_id=eq.${usuario.id}`);
                    const tieneAcceso = Array.isArray(permisos) && permisos.length && permisos[0].acceso === true;
                    if (!tieneAcceso) {
                                res.status(403).json({ ok: false, error: 'No tenes acceso a la bandeja de este caso' });
                                return;
                    }
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
        await subirAdjuntoPrivado(path, buffer, tipo);
        // Se guarda la ruta, no una URL. El front pide la URL firmada al abrir.
        // "privado: true" es la marca que distingue estos de los historicos,
        // que siguen trayendo "url" y se abren directo.
        adjuntosFinal.push({ nombre, path, tamano: buffer.length, privado: true });
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
