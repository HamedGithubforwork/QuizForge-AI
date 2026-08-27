-- Keep the internal RLS auto-enable event-trigger function privileged while
-- preventing it from being exposed as a callable Data API RPC.
revoke execute on function public.rls_auto_enable() from anon, authenticated, public;
