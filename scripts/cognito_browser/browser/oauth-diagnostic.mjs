// Never retain URL parameters, token bodies, exception messages or identities.
export function oauthDiagnostic(provider, application) {
  const safeErrors = new Set(['access_denied','invalid_request','invalid_grant','server_error','temporarily_unavailable','login_required','interaction_required','unauthorized_client','unsupported_response_type'])
  const result = {authorization_requested:false, callback_received:false, callback_error:null,
    token_requested:false, token_http_status:null, token_transport_failed:false, token_json_valid:null}
  return {
    request(rawUrl, method) {
      const url = new URL(rawUrl)
      if(url.origin === provider && url.pathname === '/oauth2/authorize') result.authorization_requested=true
      if(url.origin === provider && url.pathname === '/oauth2/token' && method === 'POST') result.token_requested=true
      if(url.origin === application && url.pathname === '/auth/callback') {
        result.callback_received=true
        const error=url.searchParams.get('error')
        result.callback_error=error ? (safeErrors.has(error) ? error : 'other') : null
      }
    },
    tokenResponse(status, validJson) {
      result.token_http_status=Number.isInteger(status) && status >= 100 && status <= 599 ? status : null
      if(typeof validJson === 'boolean') result.token_json_valid=validJson
    },
    tokenFailure() { result.token_transport_failed=true },
    snapshot() { return {...result} },
  }
}
