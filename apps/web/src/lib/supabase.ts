import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/** Null until both variables are set, so the app can say what is missing instead of crashing. */
export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null;
