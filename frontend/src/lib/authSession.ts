import { desktopBridge } from './desktop'
import { providerFrom } from './authConfig'

export const authProvider = providerFrom(import.meta.env.VITE_AUTH_PROVIDER)
export type AuthSession = { accessToken: string; userId: string; email: string }

export async function authSession(refresh = false): Promise<AuthSession | null> {
  const desktop = desktopBridge()
  if (desktop) {
    const { account } = await desktop.status()
    return account?.enrolled ? { ...account, accessToken: '' } : null
  }
  if (authProvider === 'cognito') return (await import('./cognitoBrowser')).session(refresh)
  const { supabase } = await import('./supabase')
  const { data, error } = await (refresh ? supabase.auth.refreshSession() : supabase.auth.getSession())
  if (error) throw error
  return data.session ? { accessToken: data.session.access_token, userId: data.session.user.id,
    email: data.session.user.email || '' } : null
}
