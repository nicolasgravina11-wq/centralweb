// Mantiene activo el proyecto de Supabase.
//
// Supabase pausa los proyectos del plan Free tras 7 dias sin actividad, y TODOS los
// demas endpoints de CentralWeb son reactivos: responden a algo que pasa (llega un
// correo, alguien hace un click). Si nadie usa la app, nadie toca la base. Este es el
// unico que corre solo, disparado por el cron de vercel.json una vez por dia.
//
// Una consulta minima alcanza, y alcanza UNA sola: Supabase cuenta la actividad a
// nivel PROYECTO, no por tabla, asi que esto tambien mantiene vivo lo de Casilla Nova,
// que comparte el mismo proyecto. No hace falta (ni conviene) tocar nada de Casilla.
//
// Ojo: esto PREVIENE la pausa, no la revierte. Si el proyecto llegara a pausarse, hay
// que despausarlo a mano desde el dashboard de Supabase; mientras este pausado, este
// endpoint va a fallar igual que todo lo demas.
//
// Variables de entorno (en Vercel, nunca en el repo):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  (secreta)
//   CRON_SECRET                (opcional - ver el comentario de abajo)

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ftuyjjjkjxbldgdxmcfv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async (req, res) => {
  // El cron de Vercel entra por GET. Se acepta POST tambien para poder probarlo a mano.
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  // Vercel manda "Authorization: Bearer <CRON_SECRET>" en cada ejecucion del cron, pero
  // solo si esa variable existe en el proyecto. Mientras no este cargada, el endpoint
  // queda abierto a cualquiera: lo unico que expone es un { ok: true }, asi que el
  // riesgo es bajo, pero cargarla cierra la puerta sin costo.
  if (CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
      res.status(401).json({ ok: false, error: 'No autorizado' });
      return;
    }
  }

  if (!SERVICE_KEY) {
    console.error('mantener-activo: falta SUPABASE_SERVICE_ROLE_KEY en las variables de entorno');
    res.status(500).json({ ok: false, error: 'Server misconfigured' });
    return;
  }

  try {
    const respuesta = await fetch(`${SUPABASE_URL}/rest/v1/empresas?select=id&limit=1`, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`
      }
    });
    if (!respuesta.ok) {
      const texto = await respuesta.text();
      throw new Error(`Supabase ${respuesta.status}: ${texto}`);
    }
    // El contenido se descarta a proposito: lo unico que importa es que la base contesto.
    // Tampoco se loguea, para no dejar ids de empresas en los logs de Vercel.
    await respuesta.text();
    console.log('mantener-activo: consulta OK');
    res.status(200).json({ ok: true });
  } catch (e) {
    // Un fallo aca no rompe nada de la app, pero tiene que quedar en los logs: si se
    // repite varios dias seguidos, el proyecto se va a pausar igual y nadie se entera.
    console.error('mantener-activo: fallo la consulta a Supabase:', e.message);
    res.status(500).json({ ok: false, error: 'No se pudo consultar Supabase' });
  }
};
