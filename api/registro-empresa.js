// Se llama automaticamente desde alta-inicial.html apenas se crea una cuenta nueva.
// Hace dos cosas:
//   1) Pone la empresa recien creada en trial (15 dias) -- solo si sigue en el estado
//      default, para no volver a tocar una empresa que ya se convirtio a plan pago.
//   2) Le manda un aviso por correo a Nico (via Mailgun) con los datos de la empresa nueva.
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

  if (MAILGUN_API_KEY) {
    const venceTexto = venceISO
    ? new Date(venceISO).toLocaleDateString('es-AR')
      : '(sin cambios de estado)';
    const texto = `Se dio de alta una empresa nueva en CentralWeb.\n\nEmpresa: ${empresaNombre || '(sin nombre)'} (${sigla})\nAdmin: ${adminNombre || ''} ${adminApellido || ''} (${adminEmail || ''})\nTrial hasta: ${venceTexto}\n\nGestionalo desde superadmin.html.`;
    const form = new FormData();
    form.append('from', `CentralWeb <alta@${MAILGUN_DOMAIN}>`);
    form.append('to', NOTIFICAR_A);
    form.append('subject', `Nueva empresa en CentralWeb: ${empresaNombre || sigla}`);
    form.append('text', texto);
    try {
      await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64') },
        body: form
      });
    } catch (eMail) {
      console.error('No se pudo mandar el aviso de alta nueva:', eMail.message);
    }
  }

  res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Error en registro-empresa:', e.message);
    res.status(200).json({ ok: false, error: e.message });
  }
};
