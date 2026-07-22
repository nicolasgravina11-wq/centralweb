// Configuracion compartida de Supabase para CentralWeb
// Este archivo se incluye en cada pagina HTML antes de su propio <script>.
// Requiere que el SDK de Supabase ya este cargado (ver <script src> en cada HTML).

const SUPABASE_URL = 'https://ftuyjjjkjxbldgdxmcfv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_cgsEtiOH8219aUNTAllRlA_HPPdjzGq';

// Cliente global, disponible como window.supabaseClient en todas las paginas
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { storage: window.sessionStorage } });


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
