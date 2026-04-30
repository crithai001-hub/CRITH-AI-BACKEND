import type { VercelRequest } from "@vercel/node";
import { supabaseAnon } from "./supabase.js";

export interface AuthedUser {
  user_id: string;
  email: string;
}

export async function getUserFromRequest(req: VercelRequest): Promise<AuthedUser | null> {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;

  const token = header.slice(7).trim();
  if (!token) return null;

  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data?.user) return null;

  return {
    user_id: data.user.id,
    email: data.user.email ?? ""
  };
}
