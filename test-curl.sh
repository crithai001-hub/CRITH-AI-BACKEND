#!/usr/bin/env bash
# Smoke cases for the fact-checker MVP. Requires:
#   TEST_TOKEN — Supabase JWT (see README "Get a test JWT")
#   BASE_URL   — defaults to http://localhost:3000
set -euo pipefail

BASE_URL=${BASE_URL:-http://localhost:3000}

if [[ -z "${TEST_TOKEN:-}" ]]; then
  echo "TEST_TOKEN not set" >&2
  exit 1
fi

call() {
  local path="$1"
  local body="$2"
  echo "=== POST $path ==="
  curl -sS -X POST "$BASE_URL$path" \
    -H "Authorization: Bearer $TEST_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body" | tee /tmp/last-response.json
  echo
}

# 1. Fake citation — invented study with a dramatic stat.
#    Expect: skip:false, claim with verification.verdict contradicted or unverified.
call /api/fact-check '{
  "prompt":"summarize the latest research on remote work productivity",
  "response":"According to the 2024 Stanford Zylo Study, remote workers are 340% more productive than their in-office counterparts. The study tracked 12,000 employees across 8 industries over 18 months and found that async-first teams consistently outperformed synchronous teams on every measured output.",
  "platform":"chatgpt","conversation_id":"smoke-1","message_id":"m-1"
}'

# 2. Common knowledge only — no falsifiable claims worth checking.
#    Expect: skip:true with reason extracted_nothing (or gate skip).
call /api/fact-check '{
  "prompt":"tell me some basic facts",
  "response":"Paris is the capital of France and water boils at 100 degrees Celsius at sea level. The sun rises in the east and sets in the west.",
  "platform":"chatgpt","conversation_id":"smoke-2","message_id":"m-2"
}'

# 3. Stale fact — opinion + plausibly checkable attribution.
#    Expect: skip:false, claim with verification.verdict (any).
call /api/fact-check '{
  "prompt":"how should an early-stage startup find customers",
  "response":"Sam Altman has consistently said the best way for early-stage startups to find customers is through door-to-door outreach. He maintains that this hands-on approach beats all forms of digital marketing for early traction, including social media, paid ads, and content marketing.",
  "platform":"chatgpt","conversation_id":"smoke-3","message_id":"m-3"
}'

# 4. No claims (opinion-only) — expect extracted_nothing.
call /api/fact-check '{
  "prompt":"give me marketing advice",
  "response":"You should plan carefully and validate your assumptions early. Pick one channel and learn it deeply before adding more. Stay close to your customers, listen to their feedback, and iterate on your messaging. Most early-stage failures come from premature scaling, not from picking the wrong channel.",
  "platform":"chatgpt","conversation_id":"smoke-4","message_id":"m-4"
}'

# 5. Code-only — expect skip (gate).
call /api/fact-check '{
  "prompt":"write a python function",
  "response":"```python\ndef hello():\n    return \"hi\"\n\ndef goodbye():\n    return \"bye\"\n\nif __name__ == \"__main__\":\n    print(hello())\n    print(goodbye())\n```",
  "platform":"chatgpt","conversation_id":"smoke-5","message_id":"m-5"
}'

# 6. Trivial — expect skip (gate).
call /api/fact-check '{
  "prompt":"is this fine",
  "response":"Yes, that works.",
  "platform":"chatgpt","conversation_id":"smoke-6","message_id":"m-6"
}'

# 7. Selection mode — fabricated quote with a checkable stat (>=40 chars).
#    Expect: skip:false, claims[] with embedded verification objects.
call /api/fact-check-selection '{
  "selected_text":"According to a 2023 MIT study on social media, users who limit screen time to 30 minutes per day report a 47% reduction in anxiety symptoms within two weeks.",
  "context_before":"On digital wellness, the article states:",
  "context_after":"The researchers recommend a gradual reduction approach.",
  "prompt":"summarize the article",
  "platform":"chatgpt","conversation_id":"smoke-7","message_id":"m-7"
}'

# 8. verify-claim — manual deep re-check (quota-metered, trigger='manual').
#    Requires a real analysis_id from a prior fact-check call; swap in a valid id before running live.
#    Expect: verdict supported|contradicted|unverified, evidence, source_urls, as_of_date, verification_id.
call /api/verify-claim '{
  "analysis_id":"00000000-0000-0000-0000-000000000000",
  "claim_index":0
}'
