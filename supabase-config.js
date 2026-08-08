// Configuracion compartida de Supabase para CentralWeb
// Este archivo se incluye en cada pagina HTML antes de su propio <script>.
// Requiere que el SDK de Supabase ya este cargado (ver <script src> en cada HTML).

const SUPABASE_URL = 'https://ftuyjjjkjxbldgdxmcfv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_cgsEtiOH8219aUNTAllRlA_HPPdjzGq';

// Cliente global, disponible como window.supabaseClient en todas las paginas
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { storage: window.sessionStorage } });


// ─────────────────────────────────────────────────────────────────────────────
//  GUARDADO CONFIRMADO
//  Los cambios de estado/bandeja se pintaban en pantalla y se guardaban en
//  localStorage antes de saber si Supabase los habia aceptado, y el error solo
//  iba a la consola. Resultado: si fallaba la red, la sesion vencia o RLS
//  rechazaba, la pantalla mostraba un cambio que en la base nunca ocurrio.
//  cwSyncCritico() confirma que el UPDATE realmente afecto filas; quien lo
//  llama revierte y avisa con cwAvisarFalloSync() si devuelve false.
// ─────────────────────────────────────────────────────────────────────────────

// Ejecuta un write y confirma que se aplico. Devuelve true/false; nunca lanza.
async function cwSyncCritico(query, etiqueta) {
  try {
    const { data, error } = await query.select('id');
    if (error) {
      console.error('CentralWeb: no se pudo guardar (' + etiqueta + '):', error);
      return false;
    }
    if (!data || !data.length) {
      console.error('CentralWeb: el guardado no afecto ninguna fila (' + etiqueta + ')');
      return false;
    }
    return true;
  } catch (e) {
    console.error('CentralWeb: no se pudo guardar (' + etiqueta + '):', e);
    return false;
  }
}

// Igual que cwSyncCritico pero para borrados. exigirFilas=false para los borrados
// en cascada donde no encontrar filas es legitimo (p. ej. un usuario que no tenia
// permisos asignados); true cuando la fila tiene que estar si o si.
async function cwBorradoConfirmado(query, etiqueta, exigirFilas) {
  try {
    const { data, error } = await query.select('id');
    if (error) {
      console.error('CentralWeb: no se pudo borrar (' + etiqueta + '):', error);
      return false;
    }
    if (exigirFilas && (!data || !data.length)) {
      console.error('CentralWeb: el borrado no afecto ninguna fila (' + etiqueta + ')');
      return false;
    }
    return true;
  } catch (e) {
    console.error('CentralWeb: no se pudo borrar (' + etiqueta + '):', e);
    return false;
  }
}

// Aviso persistente (no un toast que se va solo): la pantalla mostro algo que
// no quedo guardado. Se ofrece recargar, que es lo que reconcilia contra la base.
function cwAvisarFalloSync(detalle) {
  try {
    let barra = document.getElementById('cw-fallo-sync');
    if (!barra) {
      barra = document.createElement('div');
      barra.id = 'cw-fallo-sync';
      barra.setAttribute('role', 'alert');
      barra.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
        'background:#b91c1c;color:#fff;font:600 14px/1.45 system-ui,-apple-system,sans-serif;' +
        'padding:12px 16px;display:flex;align-items:center;justify-content:center;gap:14px;' +
        'box-shadow:0 2px 12px rgba(0,0,0,.25)';
      const texto = document.createElement('span');
      texto.id = 'cw-fallo-sync-texto';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Recargar';
      btn.style.cssText = 'background:#fff;color:#b91c1c;border:0;border-radius:6px;' +
        'padding:6px 14px;font:700 13px system-ui,sans-serif;cursor:pointer';
      btn.onclick = function() { window.location.reload(); };
      const cerrar = document.createElement('button');
      cerrar.type = 'button';
      cerrar.textContent = '\u00d7';
      cerrar.setAttribute('aria-label', 'Cerrar aviso');
      cerrar.style.cssText = 'background:transparent;color:#fff;border:0;font:700 20px/1 system-ui,sans-serif;cursor:pointer;padding:0 4px';
      cerrar.onclick = function() { barra.remove(); };
      barra.appendChild(texto);
      barra.appendChild(btn);
      barra.appendChild(cerrar);
      document.body.appendChild(barra);
    }
    document.getElementById('cw-fallo-sync-texto').textContent =
      (detalle || 'Un cambio no se pudo guardar.') + ' Recargá para ver el estado real.';
  } catch (e) {
    console.error('CentralWeb: fallo el guardado y ademas no se pudo mostrar el aviso:', detalle);
  }
}

// Chequea si la empresa del usuario logueado tiene la suscripcion activa.
// Si esta vencida/suspendida/cancelada, redirige a suscripcion-vencida.html.
// Los superadmins (profiles.es_superadmin = true) quedan exentos de este chequeo.
// No hace nada si no hay sesion (cada pagina maneja su propio redirect a login).
async function verificarSuscripcionActiva() {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return;

    const { data: perfil } = await supabaseClient
      .from('profiles')
      .select('empresa_id, es_superadmin')
      .eq('id', session.user.id)
      .single();
    if (!perfil || perfil.es_superadmin) return;

    const { data: empresa } = await supabaseClient
      .from('empresas')
      .select('estado_suscripcion, trial_vence_en')
      .eq('id', perfil.empresa_id)
      .single();
    if (!empresa) return;

    const estado = empresa.estado_suscripcion || 'activa';
    const trialVencido = empresa.trial_vence_en && new Date(empresa.trial_vence_en) < new Date();
    let motivo = null;
    if (estado === 'suspendida') motivo = 'suspendida';
    else if (estado === 'cancelada') motivo = 'cancelada';
    else if (trialVencido) motivo = 'trial';

    if (motivo) {
      window.location.replace('suscripcion-vencida.html?motivo=' + motivo);
    }
  } catch (e) {
    console.error('No se pudo verificar el estado de la suscripcion:', e.message);
  }
}

// Corre automaticamente en todas las paginas que incluyen este archivo,
// excepto login/alta-inicial/reset-password/suscripcion-vencida/superadmin
// (esas paginas manejan su propio flujo o son el destino/excepcion del bloqueo).
(function() {
  const pagina = window.location.pathname.split('/').pop();
  const exentas = ['login.html', 'alta-inicial.html', 'reset-password.html', 'suscripcion-vencida.html', 'superadmin.html', ''];
  if (!exentas.includes(pagina)) {
    verificarSuscripcionActiva();
  }
})();
