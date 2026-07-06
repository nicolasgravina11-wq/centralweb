// Envía una respuesta real por correo (vía Mailgun) desde caso-detalle.html
// y deja registro en Supabase (tabla centralweb_mensajes).
//
// Body esperado (JSON):
//   { casoId, to, cc, asunto, cuerpoHtml }
// Header esperado:
//   Authorization: Bearer <access_token de supabase del usuario logueado>
//
// Variables de entorno necesarias (configuradas en Vercel, nunca en el repo):
//   SUPABASE_URL               (no es secreta, pero se lee de env por prolijidad)
//   SUPABASE_SERVICE_ROLE_KEY  (secreta - permite saltar RLS, solo la usa este backend)
//   MAILGUN_API_KEY            (secreta - sending key del dominio cweb.novadgt.com)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ftuyjjjkjxbldgdxmcfv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = 'cweb.novadgt.com';

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  if (!SERVICE_KEY || !MAILGUN_API_KEY) {
    console.error('Faltan variables de entorno (SUPABASE_SERVICE_ROLE_KEY / MAILGUN_API_KEY)');
    res.status(500).json({ ok: false, error: 'Server misconfigured' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    res.status(401).json({ ok: false, error: 'Falta token de autenticación' });
    return;
  }

  const { casoId, to, cc, asunto, cuerpoHtml } = req.body || {};
  if (!casoId || !to || !cuerpoHtml) {
    res.status(400).json({ ok: false, error: 'Faltan campos: casoId, to y cuerpoHtml son obligatorios' });
    return;
  }

  try {
    const usuario = await getUsuarioDesdeToken(token);
    if (!usuario || !usuario.id) {
      res.status(401).json({ ok: false, error: 'Token inválido' });
      return;
    }

    const perfiles = await supabaseFetch(`profiles?select=empresa_id,nombre&id=eq.${usuario.id}`);
    if (!perfiles || !perfiles.length) {
      res.status(403).json({ ok: false, error: 'Perfil no encontrado' });
      return;
    }
    const perfil = perfiles[0];
    const empresaId = perfil.empresa_id;

    const casos = await supabaseFetch(
      `centralweb_casos?select=id,ticket,asunto,bandeja_id,sub_bandeja_id,empresa_id&id=eq.${casoId}`
    );
    if (!casos || !casos.length) {
      res.status(404).json({ ok: false, error: 'Caso no encontrado' });
      return;
    }
    const caso = casos[0];
    if (caso.empresa_id !== empresaId) {
      res.status(403).json({ ok: false, error: 'El caso no pertenece a tu empresa' });
      return;
    }

    const [empresas, bandejas] = await Promise.all([
      supabaseFetch(`empresas?select=sigla&id=eq.${empresaId}`),
      supabaseFetch(`centralweb_bandejas?select=id,key,parent_id&empresa_id=eq.${empresaId}`)
    ]);
    if (!empresas || !empresas.length) {
      res.status(500).json({ ok: false, error: 'Empresa no encontrada' });
      return;
    }
    const sigla = empresas[0].sigla;
    const bandejaPorId = {};
    (bandejas || []).forEach(b => { bandejaPorId[b.id] = b; });
    const bandeja = bandejaPorId[caso.bandeja_id];
    const subBandeja = caso.sub_bandeja_id ? bandejaPorId[caso.sub_bandeja_id] : null;

    const partes = [];
    if (bandeja) partes.push(bandeja.key);
    if (subBandeja) partes.push(subBandeja.key);
    partes.push(sigla);
    const fromAddress = `${partes.join('.')}@${MAILGUN_DOMAIN}`;
    const fromDisplay = `${perfil.nombre || 'Soporte'} <${fromAddress}>`;
    const asuntoFinal = asunto || `Re: ${caso.asunto || ''}`.trim();

    const form = new URLSearchParams();
    form.append('from', fromDisplay);
    form.append('to', to);
    if (cc) form.append('cc', cc);
    form.append('subject', asuntoFinal);
    form.append('html', cuerpoHtml);
    form.append('h:Reply-To', fromAddress);

    const mgResp = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form
    });

    const mgJson = await mgResp.json().catch(() => ({}));
    if (!mgResp.ok) {
      console.error('Error enviando por Mailgun:', mgJson);
      res.status(502).json({ ok: false, error: mgJson.message || 'Error enviando el correo' });
      return;
    }

    await supabaseFetch('centralweb_mensajes', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify({
        empresa_id: empresaId,
        caso_id: caso.id,
        autor_id: usuario.id,
        direccion: 'saliente',
        para: to,
        cc: cc || null,
        asunto: asuntoFinal,
        cuerpo_html: cuerpoHtml,
        mailgun_id: mgJson.id || null
      })
    }).catch(e => console.error('No se pudo guardar el mensaje enviado en Supabase:', e.message));

    res.status(200).json({ ok: true, mailgunId: mgJson.id || null, from: fromAddress });
  } catch (e) {
    console.error('Error en send-email:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};
