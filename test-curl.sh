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

# 1. Fabricated citation — expect a citation claim, verdict could_not_verify or found_contradicting.
call /api/fact-check '{
  "prompt":"summarize enterprise AI failure rates",
  "response":"According to a 2023 McKinsey study, 73% of enterprise AI projects fail in the first year due to poor data infrastructure. The study surveyed 5,000 firms across 12 industries and found that data readiness was the dominant predictor of success. Several Fortune 500 case studies were included.",
  "platform":"chatgpt","conversation_id":"smoke-1","message_id":"m-1"
}'

# 2. Stale fact — Sam Altman door-to-door case. Expect found_contradicting + was_true_until.
call /api/fact-check '{
  "prompt":"how should an early-stage startup find customers",
  "response":"Sam Altman has consistently said the best way for early-stage startups to find customers is through door-to-door outreach. He maintains that this hands-on approach beats all forms of digital marketing for early traction, including social media, paid ads, and content marketing.",
  "platform":"chatgpt","conversation_id":"smoke-2","message_id":"m-2"
}'

# 3. Correct fact — expect found_supporting.
call /api/fact-check '{
  "prompt":"who runs OpenAI",
  "response":"Sam Altman is the CEO of OpenAI. He co-founded the company in 2015 alongside Elon Musk and several others, and has led it through its commercial expansion. The company is headquartered in San Francisco.",
  "platform":"chatgpt","conversation_id":"smoke-3","message_id":"m-3"
}'

# 4. No claims (opinion-only) — expect extracted_nothing.
call /api/fact-check '{
  "prompt":"give me marketing advice",
  "response":"You should plan carefully and validate your assumptions early. Pick one channel and learn it deeply before adding more. Stay close to your customers, listen to their feedback, and iterate on your messaging. Most early-stage failures come from premature scaling, not from picking the wrong channel.",
  "platform":"chatgpt","conversation_id":"smoke-4","message_id":"m-4"
}'

# 5. Code-only — expect skip:code.
call /api/fact-check '{
  "prompt":"write a python function",
  "response":"```python\ndef hello():\n    return \"hi\"\n\ndef goodbye():\n    return \"bye\"\n\nif __name__ == \"__main__\":\n    print(hello())\n    print(goodbye())\n```",
  "platform":"chatgpt","conversation_id":"smoke-5","message_id":"m-5"
}'

# 6. Trivial — expect skip:trivial.
call /api/fact-check '{
  "prompt":"is this fine",
  "response":"Yes, that works.",
  "platform":"chatgpt","conversation_id":"smoke-6","message_id":"m-6"
}'

# 7. Selection — fabricated quote.
call /api/fact-check-selection '{
  "selected_text":"As Steve Jobs famously said: \"Real artists ship and ship often, twice a week if they can manage it.\" That principle still drives our team.",
  "context_before":"On shipping culture, the doc reads:",
  "context_after":"We try to apply this every release.",
  "prompt":"summarize the document",
  "platform":"chatgpt","conversation_id":"smoke-7","message_id":"m-7"
}'
