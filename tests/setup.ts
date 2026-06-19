// Test-only environment shims. Real values come from .env in dev/prod;
// unit tests just need modules to import without throwing.
process.env.SUPABASE_URL ||= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ||= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service";
process.env.GEMINI_API_KEY ||= "test-gemini";
process.env.FREE_RESPONSE_ANALYSES_MONTHLY_LIMIT ||= "10";
