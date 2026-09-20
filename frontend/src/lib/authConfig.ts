export function providerFrom(value: string | undefined) {
  const provider = value?.trim().toLowerCase() || 'supabase'
  if (provider !== 'supabase' && provider !== 'cognito') throw new Error('Invalid authentication provider.')
  return provider
}

export function secureEndpoint(value: string) {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
    throw new Error('Staging authentication requires HTTPS or localhost.')
  }
  return url.href.replace(/\/+$/, '')
}

export function cognitoConfiguration(env: Record<string, string | undefined>, origin: string) {
  const environment = env.VITE_COGNITO_ENVIRONMENT || (env.VITE_COGNITO_STAGING === 'true' ? 'staging' : '')
  if (environment !== 'staging' && environment !== 'production') throw new Error('Cognito requires an explicit environment.')
  if (environment === 'production' && (env.VITE_COGNITO_STAGING === 'true' || origin !== 'https://quizfromnotes.com' ||
      env.VITE_API_URL !== 'https://api.quizfromnotes.com' || env.VITE_IDENTITY_API_URL !== 'https://api.quizfromnotes.com' ||
      env.VITE_SUPABASE_URL !== 'https://vfxmsvphgcaizqnbyjip.supabase.co' || !env.VITE_SUPABASE_PUBLISHABLE_KEY)) {
    throw new Error('Production authentication requires the reviewed website, API and legacy account configuration.')
  }
  const pool = env.VITE_COGNITO_USER_POOL_ID || ''
  const client = env.VITE_COGNITO_CLIENT_ID || ''
  const domain = env.VITE_COGNITO_DOMAIN || ''
  if (!/^ca-central-1_[A-Za-z0-9]{1,55}$/.test(pool) || !/^[a-z0-9]{1,128}$/.test(client) ||
      !/^https:\/\/[a-z0-9-]+\.auth\.ca-central-1\.amazoncognito\.com$/.test(domain)) {
    throw new Error('Invalid Canadian Cognito staging configuration.')
  }
  const base = secureEndpoint(origin)
  return {
    pool, client, domain, environment, authority: `https://cognito-idp.ca-central-1.amazonaws.com/${pool}`,
    redirect: `${base}/auth/callback`, logout: `${base}/`,
    identityApi: secureEndpoint(env.VITE_IDENTITY_API_URL || ''),
    api: secureEndpoint(env.VITE_API_URL || ''),
  }
}
