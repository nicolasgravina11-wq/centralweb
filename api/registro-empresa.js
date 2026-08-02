// Se llama automaticamente desde alta-inicial.html apenas se crea una cuenta nueva.
// Hace tres cosas:
//   1) Pone la empresa recien creada en trial (15 dias) -- solo si sigue en el estado
//      default, para no volver a tocar una empresa que ya se convirtio a plan pago.
//   2) Le manda un aviso por correo a Nico (via Mailgun) con los datos de la empresa nueva.
//   3) Le manda un correo de bienvenida al admin que se dio de alta, agradeciendole y
//      explicandole el paso siguiente (configurar la bandeja de correo) y el contacto.
//
// Body esperado (JSON): { sigla, empresaNombre, adminNombre, adminApellido, adminEmail }
// No requiere token de sesion (se puede llamar antes de confirmar el email).
//
// Variables de entorno necesarias (configuradas en Vercel, nunca en el repo):
//   SUPABASE_URL               (no es secreta, pero se lee de env por prolijidad)
//   SUPABASE_SERVICE_ROLE_KEY  (secreta - permite saltar RLS, solo la usa este backend)
//   MAILGUN_API_KEY            (secreta - sending key del dominio cweb.novadgt.com)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ftuyjjjkjxbldgdxmcfv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = 'cweb.novadgt.com';
const DIAS_TRIAL = 15;
const NOTIFICAR_A = 'admin@novadgt.com';
const CONTACTO_SOPORTE = 'contacto@novadgt.com';
const URL_LOGIN = 'https://centralweb.novadgt.com/login.html';

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

async function mandarMail({ to, subject, text, html }) {
    const form = new FormData();
    form.append('from', `CentralWeb <alta@${MAILGUN_DOMAIN}>`);
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

function htmlBienvenida({ adminNombre, empresaNombre, venceTexto }) {
    const saludo = adminNombre ? `Hola ${adminNombre},` : 'Hola,';
    const lineaTrial = venceTexto
      ? `Tu cuenta para <strong>${empresaNombre || 'tu empresa'}</strong> ya está activa, con 15 días de prueba gratuita hasta el <strong>${venceTexto}</strong>.`
          : `Tu cuenta para <strong>${empresaNombre || 'tu empresa'}</strong> ya está activa.`;
    return `
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; color: #1f2937;">
          <div style="background: #0d2244; padding: 24px 28px; border-radius: 10px 10px 0 0;">
                <span style="color: #ffffff; font-size: 20px; font-weight: 700;">CentralWeb</span>
                    </div>
                        <div style="border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 10px 10px; padding: 28px;">
                              <p style="font-size: 15px; margin: 0 0 16px;">${saludo}</p>
                                    <p style="font-size: 15px; line-height: 1.5; margin: 0 0 20px;">
                                            Gracias por sumarte a CentralWeb. ${lineaTrial}
                                                  </p>
                                                        <div style="background: #e8f3fe; border-radius: 8px; padding: 18px 20px; margin: 0 0 20px;">
                                                                <p style="font-size: 14px; font-weight: 700; color: #0d2244; margin: 0 0 8px;">Un paso importante antes de arrancar</p>
                                                                        <p style="font-size: 14px; line-height: 1.5; color: #1f2937; margin: 0;">
                                                                                  Para que los correos de tu empresa empiecen a llegar como casos, hay que conectar tu casilla real con CentralWeb (es un simple reenvío, no cambiás tu dirección de correo). Se hace en un solo paso: entrá a <strong>Configuración → Bandejas</strong>, abrí una bandeja y seguí las instrucciones de <strong>"Configurar casilla de correo"</strong> (Gmail, Microsoft 365 u otro proveedor).
                                                                                          </p>
                                                                                                </div>
                                                                                                      <p style="text-align: center; margin: 0 0 20px;">
                                                                                                              <a href="${URL_LOGIN}" style="background: #1a6cd4; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 700; padding: 12px 24px; border-radius: 6px; display: inline-block;">Ir a CentralWeb</a>
                                                                                                                    </p>
                                                                                                                          <p style="font-size: 13px; line-height: 1.5; color: #4b5563; margin: 0 0 4px;">
                                                                                                                                  ¿Dudas o necesitás ayuda para arrancar? Escribinos a <a href="mailto:${CONTACTO_SOPORTE}" style="color: #1a6cd4;">${CONTACTO_SOPORTE}</a>.
                                                                                                                                        </p>
                                                                                                                                              <p style="font-size: 13px; color: #9ca3af; margin: 20px 0 0;">El equipo de Nova Digital Services</p>
                                                                                                                                                  </div>
                                                                                                                                                    </div>`;
}

function textoBienvenida({ adminNombre, empresaNombre, venceTexto }) {
    const saludo = adminNombre ? `Hola ${adminNombre},` : 'Hola,';
    const lineaTrial = venceTexto
      ? `Tu cuenta para ${empresaNombre || 'tu empresa'} ya está activa, con 15 días de prueba gratuita hasta el ${venceTexto}.`
          : `Tu cuenta para ${empresaNombre || 'tu empresa'} ya está activa.`;
    return `${saludo}\n\nGracias por sumarte a CentralWeb. ${lineaTrial}\n\nUn paso importante antes de arrancar: para que los correos de tu empresa empiecen a llegar como casos, hay que conectar tu casilla real con CentralWeb (es un simple reenvío, no cambiás tu dirección de correo). Se hace en un solo paso: entrá a Configuración -> Bandejas, abrí una bandeja y seguí las instrucciones de "Configurar casilla de correo" (Gmail, Microsoft 365 u otro proveedor).\n\nIngresá en ${URL_LOGIN}\n\n¿Dudas o necesitás ayuda para arrancar? Escribinos a ${CONTACTO_SOPORTE}.\n\nEl equipo de Nova Digital Services`;
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

      if (MAILGUN_API_KEY) {
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

            if (adminEmail) {
                      try {
                                  await mandarMail({
                                                to: adminEmail,
                                                subject: `¡Bienvenido a CentralWeb, ${empresaNombre || sigla}!`,
                                                text: textoBienvenida({ adminNombre, empresaNombre, venceTexto }),
                                                html: htmlBienvenida({ adminNombre, empresaNombre, venceTexto })
                                  });
                      } catch (eMailBienvenida) {
                                  console.error('No se pudo mandar el correo de bienvenida:', eMailBienvenida.message);
                      }
            }
      }

      res.status(200).json({ ok: true });
    } catch (e) {
          console.error('Error en registro-empresa:', e.message);
          res.status(200).json({ ok: false, error: e.message });
    }
};
