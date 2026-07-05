// Configuracion compartida de Supabase para CentralWeb
// Este archivo se incluye en cada pagina HTML antes de su propio <script>.
// Requiere que el SDK de Supabase ya este cargado (ver <script src> en cada HTML).

const SUPABASE_URL = 'https://ftuyjjjkjxbldgdxmcfv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_cgsEtiOH8219aUNTAllRlA_HPPdjzGq';

// Cliente global, disponible como window.supabaseClient en todas las paginas
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
