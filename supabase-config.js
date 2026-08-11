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
// sinRecargar: para los casos en que recargar seria contraproducente (p. ej. el
// texto de una nota que no se guardo sigue vivo en el editor y una recarga lo perderia).
// secundario: avisos de fallos accesorios (p. ej. el evento de historial de un
// cambio). No pisan un aviso ya puesto, y un aviso principal SI los pisa a ellos:
// el mensaje del cambio en si siempre es el que importa, gane quien gane la
// carrera entre las dos promesas.
function cwAvisarFalloSync(detalle, sinRecargar, secundario) {
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
      btn.id = 'cw-fallo-sync-recargar';
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
    const barraTexto = document.getElementById('cw-fallo-sync-texto');
    if (secundario && barraTexto.textContent.trim()) return;
    document.getElementById('cw-fallo-sync-texto').textContent = sinRecargar
      ? (detalle || 'Un cambio no se pudo guardar.')
      : (detalle || 'Un cambio no se pudo guardar.') + ' Recargá para ver el estado real.';
    const btnRecargar = document.getElementById('cw-fallo-sync-recargar');
    if (btnRecargar) btnRecargar.style.display = sinRecargar ? 'none' : '';
  } catch (e) {
    console.error('CentralWeb: fallo el guardado y ademas no se pudo mostrar el aviso:', detalle);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CAMBIOS EN VIVO (Supabase Realtime)
//  Antes, un cambio hecho desde otra sesion tardaba ~45s en avisarse en la
//  bandeja (con un cartel que habia que clickear) y en el detalle no se avisaba
//  nunca: dos personas con el mismo caso abierto se pisaban sin enterarse.
// ─────────────────────────────────────────────────────────────────────────────

// Escucha los cambios de una tabla. El filtro es OBLIGATORIO y por defecto acota
// a la empresa: no se confia en que RLS filtre los eventos, igual que no se
// confia en RLS para los UPDATE. Devuelve el canal (o null si no se pudo).
function cwEscucharCambios(tabla, empresaId, onCambio, filtro) {
  try {
    if (!empresaId && !filtro) {
      console.error('CentralWeb: no se puede escuchar ' + tabla + ' sin empresa ni filtro');
      return null;
    }
    const condicion = filtro || ('empresa_id=eq.' + empresaId);
    return supabaseClient
      .channel('cw-' + tabla + '-' + condicion)
      .on('postgres_changes', { event: '*', schema: 'public', table: tabla, filter: condicion }, onCambio)
      .subscribe(function(estado) {
        if (estado === 'CHANNEL_ERROR' || estado === 'TIMED_OUT' || estado === 'CLOSED') {
          console.error('CentralWeb: se corto la conexion en vivo con ' + tabla + ' (' + estado + ')');
        }
      });
  } catch (e) {
    console.error('CentralWeb: no se pudo escuchar cambios de ' + tabla + ':', e);
    return null;
  }
}

// Aviso informativo, no de error: algo cambio desde otra sesion y ya se reflejo
// en pantalla. Azul, y no se pisa con el rojo de cwAvisarFalloSync.
function cwAvisarCambioEnVivo(detalle) {
  try {
    let barra = document.getElementById('cw-cambio-vivo');
    if (!barra) {
      barra = document.createElement('div');
      barra.id = 'cw-cambio-vivo';
      barra.setAttribute('role', 'status');
      barra.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:20px;z-index:2147483646;' +
        'background:#1a6cd4;color:#fff;font:600 13.5px/1.45 system-ui,-apple-system,sans-serif;' +
        'padding:11px 16px;border-radius:10px;display:flex;align-items:center;gap:12px;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.22);max-width:min(560px,92vw)';
      const texto = document.createElement('span');
      texto.id = 'cw-cambio-vivo-texto';
      const cerrar = document.createElement('button');
      cerrar.type = 'button';
      cerrar.textContent = '\u00d7';
      cerrar.setAttribute('aria-label', 'Cerrar aviso');
      cerrar.style.cssText = 'background:transparent;color:#fff;border:0;font:700 18px/1 system-ui,sans-serif;cursor:pointer;padding:0 2px';
      cerrar.onclick = function() { barra.remove(); };
      barra.appendChild(texto);
      barra.appendChild(cerrar);
      document.body.appendChild(barra);
    }
    document.getElementById('cw-cambio-vivo-texto').textContent = detalle;
    clearTimeout(window.__cwCambioVivoTimer);
    window.__cwCambioVivoTimer = setTimeout(function() {
      const b = document.getElementById('cw-cambio-vivo');
      if (b) b.remove();
    }, 15000);
  } catch (e) {
    console.error('CentralWeb: no se pudo mostrar el aviso de cambio en vivo:', detalle);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SESION UNICA POR USUARIO
//  Decision de producto: un usuario no puede estar operando en dos lugares a la
//  vez, para que varias personas no compartan una misma clave.
//  Se identifica el DISPOSITIVO, no la pestaña: tener CentralWeb abierto en dos
//  pestañas de la misma maquina es normal y no tiene que cerrar nada.
// ─────────────────────────────────────────────────────────────────────────────

// Id estable de esta maquina/navegador. Vive en localStorage (no sessionStorage)
// justamente para que lo compartan todas las pestañas.
function cwDeviceId() {
  try {
    let id = localStorage.getItem('cw_device_id');
    if (!id) {
      id = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('cw_device_id', id);
    }
    return id;
  } catch (e) {
    return 'dev_sin_storage';
  }
}

// Marca este dispositivo como dueño de la sesion. Se llama SOLO al iniciar
// sesion: si corriera en cada carga, dos maquinas se expulsarian en bucle.
async function cwTomarSesion(userId) {
  const marcar = function() {
    // Margen de gracia: si la verificacion corre antes de que este update se
    // propague, la pestaña recien logueada se expulsaria a si misma.
    try { sessionStorage.setItem('cw_sesion_tomada', String(Date.now())); } catch (e) {}
  };
  marcar();
  try {
    const query = function() {
      return supabaseClient.from('profiles').update({ sesion_device: cwDeviceId() }).eq('id', userId);
    };
    // Se confirma que el UPDATE afecto la fila: si no se registra y no nos
    // enteramos, esta sesion se cierra sola a los pocos segundos.
    let ok = await cwSyncCritico(query(), 'registrar la sesion');
    if (!ok) {
      await new Promise(function(r) { setTimeout(r, 800); });
      ok = await cwSyncCritico(query(), 'registrar la sesion (reintento)');
    }
    if (!ok) console.error('CentralWeb: la sesion no quedo registrada; puede cerrarse sola');
    marcar();
    return ok;
  } catch (e) {
    console.error('CentralWeb: no se pudo registrar la sesion:', e);
    return false;
  }
}

// Si otro dispositivo tomo la sesion, cierra la de aca y vuelve al login.
// Ante cualquier duda (error de red, perfil sin leer) NO expulsa: es preferible
// dejar trabajar de mas que echar a alguien por un problema de conexion.
async function cwVerificarSesionUnica() {
  try {
    try {
      const tomada = parseInt(sessionStorage.getItem('cw_sesion_tomada') || '0', 10);
      if (tomada && Date.now() - tomada < 15000) return;   // recien tomada aca
    } catch (e) {}
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return;
    const { data, error } = await supabaseClient
      .from('profiles').select('sesion_device').eq('id', session.user.id).maybeSingle();
    if (error || !data) return;
    if (!data.sesion_device) return;                   // todavia nadie la reclamo
    // Red de seguridad: si el id de esta maquina no esta guardado, es que algo
    // limpio el localStorage. Llamar a cwDeviceId() aca inventaria uno nuevo que
    // por definicion no va a coincidir, y expulsaria a alguien que nunca se movio
    // de lugar — que es exactamente el bug que se arreglo en casos.html. Ante la
    // duda no se expulsa: la proxima vez que inicie sesion queda todo en orden.
    let idLocal = null;
    try { idLocal = localStorage.getItem('cw_device_id'); } catch (e) {}
    if (!idLocal) {
      console.error('CentralWeb: no hay id de dispositivo guardado; no se verifica la sesion unica');
      return;
    }
    if (data.sesion_device === idLocal) return;        // sigue siendo de esta maquina
    await supabaseClient.auth.signOut();
    window.location.replace('login.html?sesion=cerrada');
  } catch (e) {
    console.error('CentralWeb: no se pudo verificar la sesion unica:', e);
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
    cwVerificarSesionUnica();
    setInterval(cwVerificarSesionUnica, 12000);
  }
})();
