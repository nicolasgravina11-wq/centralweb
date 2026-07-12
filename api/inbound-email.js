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
const MAILGUN_SIGNING_KEY = process.env.MAILGUN_SIGNING_KEY;const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY; const MAILGUN_DOMAIN = 'cweb.novadgt.com';

const config = {
  api: { bodyParser: false }
};

// Mailgun manda el correo parseado como multipart/form-data (puede incluir adjuntos).
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {}; const files = [];
    const bb = busboy({ headers: req.headers });
    bb.on('field', (name, val) => {
      fields[name] = val;
    });
    bb.on('file', (_name, file, info) => { const { filename, mimeType } = info || {}; const chunks = []; file.on('data', (chunk) => chunks.push(chunk)); file.on('end', () => { if (filename) files.push({ nombre: filename, tipo: mimeType || 'application/octet-stream', buffer: Buffer.concat(chunks) }); }); });
    bb.on('finish', () => resolve({ fields, files }));
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

async function subirAdjunto(path, buffer, contentType) { const respuesta = await fetch(`${SUPABASE_URL}/storage/v1/object/adjuntos/${path}`, { method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': contentType || 'application/octet-stream' }, body: buffer }); if (!respuesta.ok) { const texto = await respuesta.text(); throw new Error(`Storage upload ${path} -> ${respuesta.status}: ${texto}`); } return `${SUPABASE_URL}/storage/v1/object/public/adjuntos/${path}`; } async function enviarAutoRespuesta(fromAddress, toEmail, ticket, empresaNombre, mensajeBienvenida, asuntoOriginal) { if (!MAILGUN_API_KEY) return null; const cuerpoHtml = (mensajeBienvenida || `Hemos recibido su consulta y fue registrada con el número de caso <strong>${ticket}</strong>. Un agente de soporte se pondrá en contacto a la brevedad. Gracias por comunicarse con nosotros.`).replace(/<span class="var-chip"[^>]*>[^<]*<\/span>/gi, ticket); const asuntoBase = asuntoOriginal || 'Consulta'; const asuntoAuto = /^re:/i.test(asuntoBase) ? asuntoBase : `Re: ${asuntoBase}`; const form = new FormData(); form.append('from', `${empresaNombre || 'CentralWeb'} <${fromAddress}>`); form.append('to', toEmail); form.append('subject', asuntoAuto); const htmlParaEnvio = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8" /></head><body>${cuerpoHtml}</body></html>`; // charset/lang explicitos: evita que Gmail marque la auto-respuesta en español como 'en ingles'
    form.append('html', htmlParaEnvio); form.append('h:Reply-To', fromAddress); const mgResp = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64') }, body: form }); const mgJson = await mgResp.json().catch(() => ({})); if (!mgResp.ok) throw new Error(mgJson.message || 'Error enviando auto-respuesta'); return { mailgunId: mgJson.id || null, cuerpoHtml, asunto: asuntoAuto }; } function limpiarCuerpoEntrante(texto) {
  if (!texto) return '';
  let out = String(texto);
  const patrones = [
    /\r?\n?El\s.{5,200}?escribi[oó]:[\s\S]*$/i,
    /\r?\n?On\s.{5,200}?wrote:[\s\S]*$/i,
    /\r?\n?-{2,}\s*Mensaje original\s*-{2,}[\s\S]*$/i,
    /\r?\n?-{2,}\s*Original Message\s*-{2,}[\s\S]*$/i,
    /\r?\n?De:\s*.+\r?\nEnviado:[\s\S]*$/i,
  ];
  for (const re of patrones) {
    const m = out.match(re);
    if (m && m.index > 0) { out = out.slice(0, m.index); break; }
  }
  return out.trim();
}

function textoEntranteAHtml(texto) {
  const esc = String(texto || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return esc.split(/\r?\n/).map(l => l || '&nbsp;').join('<br>');
}

function partirRemitente(remitenteCrudo) {
  const conNombre = (remitenteCrudo || '').match(/^(.*?)\s*<(.+)>$/);
  if (conNombre) {
    return { nombre: conNombre[1].trim().replace(/^"|"$/g, ''), email: conNombre[2].trim() };
  }
  return { nombre: '', email: (remitenteCrudo || '').trim() };
}

function extraerMessageIds(fields) {
  const crudos = [];
  if (fields['In-Reply-To']) crudos.push(fields['In-Reply-To']);
  if (fields['in-reply-to']) crudos.push(fields['in-reply-to']);
  if (fields['References']) crudos.push(fields['References']);
  if (fields['references']) crudos.push(fields['references']);
  if (!crudos.length && fields['message-headers']) {
    try {
      const headers = JSON.parse(fields['message-headers']);
      headers.forEach(([k, v]) => { if (/^(in-reply-to|references)$/i.test(k)) crudos.push(v); });
    } catch (e) {}
  }
  const ids = crudos.join(' ').match(/<[^<>\s]+>/g) || [];
  return [...new Set(ids)];
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

  let fields, files;
  try {
    ({ fields, files } = await parseMultipart(req));
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
  const cuerpo = textoEntranteAHtml(limpiarCuerpoEntrante(fields['stripped-text'] || fields['body-plain'] || ''));

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
      `empresas?select=id,nombre_formal&sigla=eq.${encodeURIComponent(sigla)}`
    );
    if (!empresas || !empresas.length) {
      throw new Error(`No existe ninguna empresa con sigla "${sigla}"`);
    }
    const empresaId = empresas[0].id;
    const empresaNombre = empresas[0].nombre_formal || 'CentralWeb';

    const bandejas = await supabaseFetch(
      `centralweb_bandejas?select=id,sector,mensaje_bienvenida&empresa_id=eq.${empresaId}&key=eq.${encodeURIComponent(bandejaKey)}&parent_id=is.null`
    );
    if (!bandejas || !bandejas.length) {
      throw new Error(`No existe la bandeja "${bandejaKey}" para la empresa "${sigla}"`);
    }
    const bandejaId = bandejas[0].id;

    let subBandejaId = null;
    let subBandejaSector = null;
    let subBandejaMensaje = null;
    if (subBandejaKey) {
      const subBandejas = await supabaseFetch(
        `centralweb_bandejas?select=id,sector,mensaje_bienvenida&empresa_id=eq.${empresaId}&key=eq.${encodeURIComponent(subBandejaKey)}&parent_id=eq.${bandejaId}`
      );
      if (subBandejas && subBandejas.length) { subBandejaId = subBandejas[0].id; subBandejaSector = subBandejas[0].sector || null; subBandejaMensaje = subBandejas[0].mensaje_bienvenida || null; }
    }

    const { nombre: fromName, email: fromEmail } = partirRemitente(fields.from || fields.sender);

    // ── Threading: si este correo es una respuesta a algo que nosotros mandamos, sumarlo al caso existente ──
    const referenciados = extraerMessageIds(fields);
    let casoExistente = null;
    for (const msgId of referenciados) {
      const previos = await supabaseFetch(`centralweb_mensajes?select=caso_id&empresa_id=eq.${empresaId}&direccion=eq.saliente&mailgun_id=eq.${encodeURIComponent(msgId)}&limit=1`);
      if (previos && previos.length) {
        const casosPrevios = await supabaseFetch(`centralweb_casos?select=*&id=eq.${previos[0].caso_id}&limit=1`);
        if (casosPrevios && casosPrevios.length) { casoExistente = casosPrevios[0]; break; }
      }
    }

    if (casoExistente) {
      const adjuntosResp = [];
      for (const f of files) { try { const path = `${sigla}/${casoExistente.ticket.replace('#', '')}/${Date.now()}-${f.nombre}`; const url = await subirAdjunto(path, f.buffer, f.tipo); adjuntosResp.push({ nombre: f.nombre, url, tamano: f.buffer.length }); } catch (e) { console.error('No se pudo subir un adjunto entrante:', f.nombre, e.message); } }

      await supabaseFetch('centralweb_mensajes', {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify({ empresa_id: empresaId, caso_id: casoExistente.id, autor_id: null, direccion: 'entrante', para: fromEmail, cc: null, asunto, cuerpo_html: cuerpo, mailgun_id: null, adjuntos: adjuntosResp })
      });

      const patchCaso = { leido: false };
      if (casoExistente.estado === 'cerrado') {
        patchCaso.estado = 'abierto';
        patchCaso.asignado_user_id = null; // vuelve a la bandeja general, no a la carpeta del agente anterior
      }
      await supabaseFetch(`centralweb_casos?id=eq.${casoExistente.id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify(patchCaso)
      });

      await supabaseFetch('centralweb_eventos', {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify({ empresa_id: empresaId, caso_id: casoExistente.id, tipo: 'respuesta_cliente_email', data: { from: fromEmail, asunto } })
      });

      console.log(`Respuesta entrante sumada al caso ${casoExistente.ticket}`);
      res.status(200).send('OK');
      return;
    }

    const numeroTicket = await supabaseFetch('rpc/centralweb_next_ticket', {
      method: 'POST',
      body: JSON.stringify({ empresa_uuid: empresaId })
    });
    const ticket = `#${numeroTicket}`;

    const adjuntos = []; for (const f of files) { try { const path = `${sigla}/${String(numeroTicket)}/${Date.now()}-${f.nombre}`; const url = await subirAdjunto(path, f.buffer, f.tipo); adjuntos.push({ nombre: f.nombre, url, tamano: f.buffer.length }); } catch (e) { console.error('No se pudo subir un adjunto entrante:', f.nombre, e.message); } }

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
        mensaje_inicial: cuerpo, adjuntos, leido: false
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
        data: { from: fromEmail, asunto } }) }); try { const sectorBandeja = subBandejaSector || (bandejas[0] && bandejas[0].sector) || null;
    const remitenteDisplay = sectorBandeja ? `${empresaNombre.toUpperCase()} - ${sectorBandeja}` : empresaNombre.toUpperCase();
    const mensajeBienvenida = subBandejaMensaje || (bandejas[0] && bandejas[0].mensaje_bienvenida) || null;
    const autoResp = await enviarAutoRespuesta(recipient, fromEmail, ticket, remitenteDisplay, mensajeBienvenida, asunto); if (autoResp) { await supabaseFetch('centralweb_mensajes', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ empresa_id: empresaId, caso_id: caso.id, autor_id: null, direccion: 'saliente', para: fromEmail, cc: null, asunto: autoResp.asunto, cuerpo_html: autoResp.cuerpoHtml, mailgun_id: autoResp.mailgunId, adjuntos: [] }) }); } } catch (e) { console.error('No se pudo enviar la auto-respuesta:', e.message); } console.log(`Caso ${ticket} creado para empresa ${sigla}, bandeja ${bandejaKey}`);
    res.status(200).send('OK');
  } catch (e) {
    console.error('Error creando el caso desde el correo entrante:', e.message);
    // 200 para que Mailgun no reintente en loop; el error queda en los logs de Vercel.
    res.status(200).send('Error registrado, ver logs de Vercel');
  }
};

module.exports.config = config;
