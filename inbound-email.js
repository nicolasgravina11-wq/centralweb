// Recibe los correos entrantes reenviados por Mailgun para *@cweb.novadgt.com
// y crea el caso correspondiente en Supabase (tabla centralweb_casos).
//
// Formato esperado del destinatario:
//   bandeja.sigla@cweb.novadgt.com            -> caso en la bandeja "bandeja" de la empresa "sigla"
//   bandeja.subbandeja.sigla@cweb.novadgt.com -> idem, pero en la sub-bandeja "subbandeja"
//
// Variables de entorno necesarias (configuradas en Vercel, nunca en el repo):
//   SUPABASE_URL               (no es secreta, pero se lee de env por prolijidad)
//   SUPABASE_SERVICE_ROLE_KEY  (secreta - permite saltar RLS, solo la usa este backend)
//   MAILGUN_SIGNING_KEY        (secreta - para verificar que el webhook viene de Mailgun)

const busboy = require('busboy');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ftuyjjjkjxbldgdxmcfv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAILGUN_SIGNING_KEY = process.env.MAILGUN_SIGNING_KEY;

const config = {
  api: { bodyParser: false }
};

// Mailgun manda el correo parseado como multipart/form-data (puede incluir adjuntos).
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const bb = busboy({ headers: req.headers });
    bb.on('field', (name, val) => {
      fields[name] = val;
    });
    bb.on('file', (_name, file) => {
      // Por ahora no guardamos adjuntos, solo consumimos el stream para no colgar la request.
      file.resume();
    });
    bb.on('finish', () => resolve(fields));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

// Mailgun firma cada webhook con timestamp + token usando el "signing key" del dominio.
function firmaValida(fields) {
  if (!MAILGUN_SIGNING_KEY) return false;
  const { timestamp, token, signature } = fields;
  if (!timestamp || !token || !signature) return false;
  const esperada = crypto
    .createHmac('sha256', MAILGUN_SIGNING_KEY)
    .update(timestamp + token)
    .digest('hex');
  return esperada === signature;
}

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

function partirRemitente(remitenteCrudo) {
  const conNombre = (remitenteCrudo || '').match(/^(.*?)\s*<(.+)>$/);
  if (conNombre) {
    return { nombre: conNombre[1].trim().replace(/^"|"$/g, ''), email: conNombre[2].trim() };
  }
  return { nombre: '', email: (remitenteCrudo || '').trim() };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  if (!SERVICE_KEY) {
    console.error('Falta SUPABASE_SERVICE_ROLE_KEY en las variables de entorno');
    res.status(500).send('Server misconfigured');
    return;
  }

  let fields;
  try {
    fields = await parseMultipart(req);
  } catch (e) {
    console.error('Error parseando el correo entrante:', e);
    res.status(400).send('Bad request');
    return;
  }

  if (!firmaValida(fields)) {
    console.error('Firma de Mailgun invalida o faltante');
    res.status(401).send('Firma invalida');
    return;
  }

  const recipient = (fields.recipient || '').toLowerCase().trim();
  const asunto = fields.subject || '(sin asunto)';
  const cuerpo = fields['stripped-text'] || fields['body-plain'] || '';

  const match = recipient.match(/^([a-z0-9.\-]+)@cweb\.novadgt\.com$/i);
  if (!match) {
    console.error('Destinatario con formato inesperado:', recipient);
    // Devolvemos 200 para que Mailgun no reintente algo que nunca va a poder procesar.
    res.status(200).send('Ignorado: formato de destinatario invalido');
    return;
  }

  const partes = match[1].split('.');
  const sigla = partes[partes.length - 1];
  const bandejaKey = partes[0];
  const subBandejaKey = partes.length > 2 ? partes[1] : null;

  try {
    const empresas = await supabaseFetch(
      `empresas?select=id&sigla=eq.${encodeURIComponent(sigla)}`
    );
    if (!empresas || !empresas.length) {
      throw new Error(`No existe ninguna empresa con sigla "${sigla}"`);
    }
    const empresaId = empresas[0].id;

    const bandejas = await supabaseFetch(
      `centralweb_bandejas?select=id&empresa_id=eq.${empresaId}&key=eq.${encodeURIComponent(bandejaKey)}&parent_id=is.null`
    );
    if (!bandejas || !bandejas.length) {
      throw new Error(`No existe la bandeja "${bandejaKey}" para la empresa "${sigla}"`);
    }
    const bandejaId = bandejas[0].id;

    let subBandejaId = null;
    if (subBandejaKey) {
      const subBandejas = await supabaseFetch(
        `centralweb_bandejas?select=id&empresa_id=eq.${empresaId}&key=eq.${encodeURIComponent(subBandejaKey)}&parent_id=eq.${bandejaId}`
      );
      if (subBandejas && subBandejas.length) subBandejaId = subBandejas[0].id;
    }

    const numeroTicket = await supabaseFetch('rpc/centralweb_next_ticket', {
      method: 'POST',
      body: JSON.stringify({ empresa_uuid: empresaId })
    });
    const ticket = `#${numeroTicket}`;

    const { nombre: fromName, email: fromEmail } = partirRemitente(fields.from || fields.sender);

    const casos = await supabaseFetch('centralweb_casos', {
      method: 'POST',
      body: JSON.stringify({
        empresa_id: empresaId,
        ticket,
        estado: 'abierto',
        bandeja_id: bandejaId,
        sub_bandeja_id: subBandejaId,
        asunto,
        from_name: fromName,
        from_email: fromEmail,
        mensaje_inicial: cuerpo
      })
    });
    const caso = casos[0];

    await supabaseFetch('centralweb_eventos', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify({
        empresa_id: empresaId,
        caso_id: caso.id,
        tipo: 'caso_creado_por_email',
        data: { from: fromEmail, asunto }
      })
    });

    console.log(`Caso ${ticket} creado para empresa ${sigla}, bandeja ${bandejaKey}`);
    res.status(200).send('OK');
  } catch (e) {
    console.error('Error creando el caso desde el correo entrante:', e.message);
    // 200 para que Mailgun no reintente en loop; el error queda en los logs de Vercel.
    res.status(200).send('Error registrado, ver logs de Vercel');
  }
};

module.exports.config = config;
