/**
 * supabaseClient.js
 * VillaNet MX - Cliente compartido de Supabase
 */
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.VILLANET_SUPABASE_URL,
  process.env.VILLANET_SUPABASE_SERVICE_KEY
);

module.exports = supabase;
