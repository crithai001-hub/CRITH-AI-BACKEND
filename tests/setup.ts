// Test-only environment shims. The real values come from .env in dev/prod;
// unit tests just need the modules to import without throwing.
process.env.SUPABASE_URL ||= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ||= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service";
process.env.ANTHROPIC_API_KEY ||= "test-anthropic";
process.env.FREE_RESPONSE_ANALYSES_MONTHLY_LIMIT ||= "10";
process.env.BRAVE_API_KEY ||= "test-brave";
