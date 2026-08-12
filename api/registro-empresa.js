// Se llama automaticamente desde alta-inicial.html apenas se crea una cuenta nueva.
// Hace tres cosas:
//   1) Pone la empresa recien creada en trial (15 dias) -- solo si sigue en el estado
//      default, para no volver a tocar una empresa que ya se convirtio a plan pago.
//   2) Le manda un aviso por correo a Nico (via Mailgun) con los datos de la empresa nueva.
//   3) Le manda un correo de bienvenida (informativo, sin pedir respuesta) al admin que
//      se dio de alta: agradecimiento, que es CentralWeb, como conectar la bandeja de
//      correo, y a donde escribir por dudas o problemas.
//
// El correo de bienvenida sale por Resend desde contacto@novadgt.com si esta configurada
// la variable RESEND_API_KEY (dominio ya verificado en Resend, cuenta separada de Casilla
// Nova). Si todavia no esta cargada esa key, cae en un remitente de respaldo por Mailgun
// (@cweb.novadgt.com) para que el correo se siga mandando mientras tanto.
//
// Body esperado (JSON): { sigla, empresaNombre, adminNombre, adminApellido, adminEmail }
// No requiere token de sesion (se puede llamar antes de confirmar el email).
//
// Variables de entorno necesarias (configuradas en Vercel, nunca en el repo):
//   SUPABASE_URL               (no es secreta, pero se lee de env por prolijidad)
//   SUPABASE_SERVICE_ROLE_KEY  (secreta - permite saltar RLS, solo la usa este backend)
//   MAILGUN_API_KEY            (secreta - sending key del dominio cweb.novadgt.com)
//   RESEND_API_KEY             (secreta - key propia de CentralWeb en Resend, permiso
//                               "Sending access" solamente, dominio novadgt.com. No es
//                               la misma key que usa Casilla Nova.)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ftuyjjjkjxbldgdxmcfv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = 'cweb.novadgt.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = 'Nova DGT <contacto@novadgt.com>';
const DIAS_TRIAL = 15;
const NOTIFICAR_A = 'admin@novadgt.com';
const CONTACTO_GENERAL = 'contacto@novadgt.com';
const CONTACTO_SOPORTE = 'soporte@novadgt.com';
const URL_LOGIN = 'https://centralweb.novadgt.com/login.html';
// Isotipo de Nova, subido como archivo estatico al repo (se sirve solo via Vercel).
const LOGO_URL = 'https://centralweb.novadgt.com/nova-mark.png';
// Remitente de respaldo por Mailgun, solo mientras no este cargada RESEND_API_KEY.
// admin@cweb.novadgt.com no es una casilla monitoreada -- una respuesta ahi no llega
// a ningun lado (el sistema la intenta rutear como bandeja "admin" y no la encuentra).
const FROM_BIENVENIDA_FALLBACK = `Nova DGT <admin@${MAILGUN_DOMAIN}>`;

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

async function mandarMail({ to, subject, text, html, from }) {
  const form = new FormData();
  form.append('from', from || `CentralWeb <alta@${MAILGUN_DOMAIN}>`);
  form.append('to', to);
  form.append('subject', subject);
  if (text) form.append('text', text);
  if (html) form.append('html', html);
  await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64') },
    body: form
  });
}

async function mandarMailResend({ to, subject, text, html }) {
  const key = (RESEND_API_KEY || '').trim();
  if (!key || !key.startsWith('re_')) {
    throw new Error('RESEND_API_KEY ausente o con formato invalido (debe empezar con "re_")');
  }
  const respuesta = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject,
      text,
      html
    })
  });
  if (!respuesta.ok) {
    const texto = await respuesta.text();
    throw new Error(`Resend rechazo el envio: ${respuesta.status} ${texto}`);
  }
}

function htmlBienvenida({ adminNombre, empresaNombre, venceTexto }) {
  const saludo = adminNombre ? `Hola ${adminNombre},` : 'Hola,';
  const lineaTrial = venceTexto
    ? `Gracias por elegir CentralWeb para gestionar la atención de <strong>${empresaNombre || 'tu empresa'}</strong>. Tu cuenta ya está activa, con 15 días de prueba gratuita hasta el <strong>${venceTexto}</strong>.`
    : `Gracias por elegir CentralWeb para gestionar la atención de <strong>${empresaNombre || 'tu empresa'}</strong>. Tu cuenta ya está activa.`;
  const paso = (titulo, texto) => `
      <p style="font-size: 14px; font-weight: 700; color: #0d2244; margin: 16px 0 4px;">${titulo}</p>
      <p style="font-size: 14px; line-height: 1.6; color: #374151; margin: 0;">${texto}</p>`;
  return `
  <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; color: #1f2937;">
    <div style="background: #0d2244; padding: 20px 28px; border-radius: 10px 10px 0 0;">
      <table cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
        <tr>
          <td style="vertical-align: middle; padding-right: 10px;">
            <img src="${LOGO_URL}" width="30" height="30" alt="Nova Digital Services" style="display:block;">
          </td>
          <td style="vertical-align: middle;">
            <div style="font-family: 'Space Grotesk', Arial, Helvetica, sans-serif; color: #ffffff; font-size: 20px; font-weight: 700; line-height: 1.2;">CentralWeb</div>
            <div style="font-family: Arial, Helvetica, sans-serif; color: #7cc2fb; font-size: 12px; font-weight: 400; margin-top: 2px;">Nova Digital Services</div>
          </td>
        </tr>
      </table>
    </div>
    <div style="border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 10px 10px; padding: 28px;">
      <p style="font-size: 15px; margin: 0 0 16px;">${saludo}</p>
      <p style="font-size: 15px; line-height: 1.5; margin: 0 0 16px;">${lineaTrial}</p>
      <p style="font-size: 15px; line-height: 1.6; margin: 0 0 8px;">
        CentralWeb centraliza la atención de todos los sectores de tu empresa en un mismo lugar, con una misma lógica de respuesta para cada caso — así el cliente recibe siempre la misma formalidad y certeza, sin depender de quién lo atienda. Además te da control total sobre lo que entra: sabés en todo momento cuántos casos tiene cada sector y cuáles necesitan atención urgente.
      </p>

      <p style="font-size: 14px; font-weight: 700; color: #0d2244; margin: 24px 0 4px;">Cómo funciona</p>
      ${paso('Llega el correo', 'Cada mail que entra a una bandeja recibe un número de caso automático y, si querés, una respuesta automática (la misma para todas las bandejas o una distinta para cada una, como prefieras).')}
      ${paso('Se organiza por sector', 'Las bandejas representan cada sector de tu empresa, y podés crear sub-bandejas para filtrar aún más si lo necesitás.')}
      ${paso('Se asigna a cada agente', 'Cada caso se transfiere a la persona que lo va a resolver, así todo el equipo ve su propia carga de trabajo (ideal para home office) y ningún mail queda respondido dos veces.')}
      ${paso('Se responde y cierra', 'Cada caso se contesta como cualquier correo, con la posibilidad de usar respuestas automáticas editables para agilizar los trámites más comunes.')}

      <div style="background: #e8f3fe; border-radius: 8px; padding: 18px 20px; margin: 24px 0 20px;">
        <p style="font-size: 14px; font-weight: 700; color: #0d2244; margin: 0 0 8px;">Cómo conectar el correo de tu empresa</p>
        <p style="font-size: 14px; line-height: 1.5; color: #1f2937; margin: 0;">
          Para que los correos de tu empresa empiecen a llegar como casos, hay que conectar tu casilla real con CentralWeb (es un simple reenvío, no cambiás tu dirección de correo). Se hace en un solo paso: entrá a <strong>Configuración → Bandejas</strong>, abrí una bandeja y seguí las instrucciones de <strong>"Configurar casilla de correo"</strong> (Gmail, Microsoft 365 u otro proveedor). Vas a encontrar esta misma guía cada vez que creés o edités una bandeja.
        </p>
      </div>

      <p style="font-size: 12.5px; color: #9ca3af; margin: 0 0 10px;">Este es un correo informativo, no hace falta que lo respondas.</p>
      <p style="font-size: 13px; line-height: 1.6; color: #4b5563; margin: 0 0 4px;">
        ¿Dudas generales sobre tu cuenta? Escribinos a <a href="mailto:${CONTACTO_GENERAL}" style="color: #1a6cd4;">${CONTACTO_GENERAL}</a>.
      </p>
      <p style="font-size: 13px; line-height: 1.6; color: #4b5563; margin: 0 0 20px;">
        ¿Consultas técnicas o algún problema puntual? Escribinos a <a href="mailto:${CONTACTO_SOPORTE}" style="color: #1a6cd4;">${CONTACTO_SOPORTE}</a>.
      </p>

      <table cellpadding="0" cellspacing="0" style="border-collapse: collapse; margin-top: 4px;">
        <tr>
          <td style="vertical-align: middle; padding-right: 10px;">
            <img src="${LOGO_URL}" width="32" height="32" alt="Nova Digital Services" style="display:block; border-radius:50%;">
          </td>
          <td style="vertical-align: middle; font-size: 15px; font-weight: 700; color: #0d2244;">El equipo de Nova Digital Services</td>
        </tr>
      </table>
    </div>
  </div>`;
}

function textoBienvenida({ adminNombre, empresaNombre, venceTexto }) {
  const saludo = adminNombre ? `Hola ${adminNombre},` : 'Hola,';
  const lineaTrial = venceTexto
    ? `Gracias por elegir CentralWeb para gestionar la atención de ${empresaNombre || 'tu empresa'}. Tu cuenta ya está activa, con 15 días de prueba gratuita hasta el ${venceTexto}.`
    : `Gracias por elegir CentralWeb para gestionar la atención de ${empresaNombre || 'tu empresa'}. Tu cuenta ya está activa.`;
  const intro = 'CentralWeb centraliza la atención de todos los sectores de tu empresa en un mismo lugar, con una misma lógica de respuesta para cada caso — así el cliente recibe siempre la misma formalidad y certeza, sin depender de quién lo atienda. Además te da control total sobre lo que entra: sabés en todo momento cuántos casos tiene cada sector y cuáles necesitan atención urgente.';
  const pasos = [
    ['Llega el correo', 'cada mail que entra a una bandeja recibe un número de caso automático y, si querés, una respuesta automática (la misma para todas las bandejas o una distinta para cada una, como prefieras).'],
    ['Se organiza por sector', 'las bandejas representan cada sector de tu empresa, y podés crear sub-bandejas para filtrar aún más si lo necesitás.'],
    ['Se asigna a cada agente', 'cada caso se transfiere a la persona que lo va a resolver, así todo el equipo ve su propia carga de trabajo (ideal para home office) y ningún mail queda respondido dos veces.'],
    ['Se responde y cierra', 'cada caso se contesta como cualquier correo, con la posibilidad de usar respuestas automáticas editables para agilizar los trámites más comunes.']
  ].map(([titulo, texto]) => `- ${titulo}: ${texto}`).join('\n');
  return `${saludo}\n\n${lineaTrial}\n\n${intro}\n\nCómo funciona:\n${pasos}\n\nCómo conectar el correo de tu empresa: para que los correos de tu empresa empiecen a llegar como casos, hay que conectar tu casilla real con CentralWeb (es un simple reenvío, no cambiás tu dirección de correo). Se hace en un solo paso: entrá a Configuración -> Bandejas, abrí una bandeja y seguí las instrucciones de "Configurar casilla de correo" (Gmail, Microsoft 365 u otro proveedor). Vas a encontrar esta misma guía cada vez que creés o edités una bandeja.\n\nIngresá en ${URL_LOGIN}\n\nEste es un correo informativo, no hace falta que lo respondas.\n¿Dudas generales sobre tu cuenta? Escribinos a ${CONTACTO_GENERAL}.\n¿Consultas técnicas o algún problema puntual? Escribinos a ${CONTACTO_SOPORTE}.\n\nEl equipo de Nova Digital Services`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }
  if (!SERVICE_KEY) {
    console.error('Falta SUPABASE_SERVICE_ROLE_KEY');
    res.status(500).json({ ok: false, error: 'Server misconfigured' });
    return;
  }

  try {
    const { sigla, empresaNombre, adminNombre, adminApellido, adminEmail } = req.body || {};
    if (!sigla) {
      res.status(400).json({ ok: false, error: 'Falta sigla' });
      return;
    }

    const filas = await supabaseFetch(
      `empresas?sigla=eq.${encodeURIComponent(sigla)}&select=id,created_at,estado_suscripcion,trial_vence_en`
    );
    const empresa = filas && filas[0];
    if (!empresa) {
      res.status(200).json({ ok: true, nota: 'Empresa no encontrada, nada para hacer' });
      return;
    }

    const creadaHaceMs = Date.now() - new Date(empresa.created_at).getTime();
    const esNuevaYSinTocar =
      creadaHaceMs < 10 * 60 * 1000 &&
      (empresa.estado_suscripcion === 'activa' || !empresa.estado_suscripcion) &&
      !empresa.trial_vence_en;

    let venceISO = null;
    if (esNuevaYSinTocar) {
      venceISO = new Date(Date.now() + DIAS_TRIAL * 24 * 60 * 60 * 1000).toISOString();
      await supabaseFetch(`empresas?id=eq.${empresa.id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({ estado_suscripcion: 'trial', trial_vence_en: venceISO })
      });
    }

    const venceMostrar = venceISO || empresa.trial_vence_en;
    const venceTexto = venceMostrar ? new Date(venceMostrar).toLocaleDateString('es-AR') : null;

    // ─────────────────────────────────────────────────────────────────────────
    //  QUIEN PUEDE RECIBIR CORREO DESDE ACA
    //  Este endpoint es publico a proposito: lo llama alta-inicial.html justo
    //  despues del signUp, cuando todavia puede no haber sesion (si el proyecto
    //  pide confirmar el email). Pero antes mandaba la bienvenida a la direccion
    //  que viniera en el body, para cualquier sigla existente: con solo conocer
    //  "nova" o "prueba2" un desconocido podia disparar correos ilimitados desde
    //  nuestro dominio a quien quisiera. No filtraba datos, pero quemaba la
    //  reputacion de envio, de la que depende todo el producto.
    //
    //  Dos condiciones ahora, y las dos tienen que darse:
    //   1) el alta tiene que ser reciente y sin tocar (esNuevaYSinTocar), asi
    //      una empresa ya establecida no puede usarse nunca como excusa;
    //   2) el destinatario tiene que ser un usuario real de ESA empresa.
    //  Si algo no cierra no se manda nada y queda en el log. Perder un correo
    //  de bienvenida es barato; mandarselo a un desconocido no.
    // ─────────────────────────────────────────────────────────────────────────
    let destinatarioValido = null;
    if (adminEmail && esNuevaYSinTocar) {
      try {
        const perfiles = await supabaseFetch(
          `profiles?empresa_id=eq.${empresa.id}&email=eq.${encodeURIComponent(adminEmail)}&select=email`
        );
        if (perfiles && perfiles.length) destinatarioValido = perfiles[0].email;
      } catch (ePerfil) {
        console.error('No se pudo validar el destinatario del alta:', ePerfil.message);
      }
    }
    if (adminEmail && !destinatarioValido) {
      console.error(
        'registro-empresa: no se manda bienvenida. sigla=' + sigla +
        ' nueva=' + esNuevaYSinTocar + ' (el destinatario no es un usuario de esa empresa o el alta no es reciente)'
      );
    }

    // El aviso interno tambien se limita a las altas nuevas: si no, cualquiera
    // podia llenar de correos la casilla de administracion repitiendo el POST.
    if (MAILGUN_API_KEY && esNuevaYSinTocar) {
      const textoInterno = `Se dio de alta una empresa nueva en CentralWeb.\n\nEmpresa: ${empresaNombre || '(sin nombre)'} (${sigla})\nAdmin: ${adminNombre || ''} ${adminApellido || ''} (${adminEmail || ''})\nTrial hasta: ${venceTexto || '(sin cambios de estado)'}\n\nGestionalo desde superadmin.html.`;
      try {
        await mandarMail({
          to: NOTIFICAR_A,
          subject: `Nueva empresa en CentralWeb: ${empresaNombre || sigla}`,
          text: textoInterno
        });
      } catch (eMail) {
        console.error('No se pudo mandar el aviso de alta nueva:', eMail.message);
      }
    }

    if (destinatarioValido) {
      const asuntoBienvenida = `¡Bienvenido a CentralWeb, ${empresaNombre || sigla}!`;
      const textoMail = textoBienvenida({ adminNombre, empresaNombre, venceTexto });
      const htmlMail = htmlBienvenida({ adminNombre, empresaNombre, venceTexto });
      const keyResend = (RESEND_API_KEY || '').trim();
      try {
        if (keyResend && keyResend.startsWith('re_')) {
          await mandarMailResend({ to: destinatarioValido, subject: asuntoBienvenida, text: textoMail, html: htmlMail });
        } else if (MAILGUN_API_KEY) {
          await mandarMail({
            to: destinatarioValido,
            from: FROM_BIENVENIDA_FALLBACK,
            subject: asuntoBienvenida,
            text: textoMail,
            html: htmlMail
          });
        }
      } catch (eMailBienvenida) {
        console.error('No se pudo mandar el correo de bienvenida:', eMailBienvenida.message);
      }
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Error en registro-empresa:', e.message);
    res.status(200).json({ ok: false, error: e.message });
  }
};
