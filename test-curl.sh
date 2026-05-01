#!/usr/bin/env bash
# test-curl.sh — sanity-check /api/analyze-response locally before deploying.
#
# Prerequisites:
#   1. `vercel dev` running on http://localhost:3000
#   2. .env.local populated with valid Supabase + Anthropic keys
#   3. $TEST_TOKEN exported as a Supabase JWT for a test user.
#
# Get a test JWT (from a Node REPL or a one-off script):
#   const { createClient } = require("@supabase/supabase-js");
#   const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
#   const { data } = await c.auth.signInWithPassword({
#     email: "test@example.com", password: "your-test-password"
#   });
#   console.log(data.session.access_token);
#
# Or sign in via Supabase Studio → Authentication → Users → click test user → "Send magic link".

set -u

if [[ -z "${TEST_TOKEN:-}" ]]; then
  echo "Error: TEST_TOKEN env var not set."
  echo "Export a Supabase JWT for a test user, e.g.:"
  echo "  export TEST_TOKEN=eyJhbGciOi..."
  exit 1
fi

BASE_URL="${BASE_URL:-http://localhost:3000}"

curl_case() {
  local label="$1"
  local body="$2"
  echo
  echo "=== $label ==="
  curl -sS -X POST "$BASE_URL/api/analyze-response" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TEST_TOKEN" \
    -H "Origin: chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef" \
    -d "$body" \
    | (command -v jq >/dev/null && jq . || cat)
}

# ---------------------------------------------------------------------------
# Case 1 — Strategy response. Confident-but-thin go-to-market advice.
# Expectation: skip=false, 2-3 provocations, mostly hidden_assumption / missing_angle.
# ---------------------------------------------------------------------------
curl_case "1. strategy / should-analyze" '{
  "prompt": "What is the best go-to-market strategy for an early-stage B2B SaaS startup targeting mid-market companies?",
  "response": "For an early-stage B2B SaaS startup targeting mid-market, you should absolutely focus on a product-led growth (PLG) motion. PLG is clearly the dominant approach in 2026 — companies like Notion, Figma, and Linear have proven it works. Start with a free tier that lets users self-serve, then layer in sales-assisted upgrades once accounts hit 20+ seats. You should also invest heavily in content marketing and SEO from day one. Hiring an SDR is premature; instead, your founders should be doing all early sales calls. Pricing should be simple: a flat per-seat model starting at $15/user/month with no enterprise tier until you have at least $1M ARR. Focus your engineering on rapid iteration over enterprise features like SSO and audit logs — those can wait. Within 18 months you should be at $5M ARR if you execute this playbook.",
  "platform": "chatgpt",
  "conversation_id": "test-conv-1",
  "message_id": "test-msg-1"
}'

# ---------------------------------------------------------------------------
# Case 2 — Trivia. Tightened factual gate should fire (under 8 words, single ?, prefix).
# Expectation: skip=true, reason="factual"
# ---------------------------------------------------------------------------
curl_case "2. trivia / factual skip" '{
  "prompt": "what is the capital of France?",
  "response": "The capital of France is Paris. Paris has been the capital since the 10th century and is the largest city in France with a metropolitan population of over 12 million people. It is a major center for culture, politics, fashion, gastronomy, and the arts.",
  "platform": "chatgpt",
  "conversation_id": "test-conv-2",
  "message_id": "test-msg-2"
}'

# ---------------------------------------------------------------------------
# Case 3 — Code dump. >85% of response is inside fences.
# Expectation: skip=true, reason="code"
# ---------------------------------------------------------------------------
curl_case "3. code dump / code skip" '{
  "prompt": "Write me a Python function that sorts a list using quicksort.",
  "response": "Here you go:\n\n```python\ndef quicksort(arr):\n    if len(arr) <= 1:\n        return arr\n    pivot = arr[len(arr) // 2]\n    left = [x for x in arr if x < pivot]\n    middle = [x for x in arr if x == pivot]\n    right = [x for x in arr if x > pivot]\n    return quicksort(left) + middle + quicksort(right)\n\n# Usage example\nnums = [3, 6, 1, 8, 2, 9, 4, 7, 5]\nprint(quicksort(nums))\n# Output: [1, 2, 3, 4, 5, 6, 7, 8, 9]\n\n# Another example with strings\nwords = [\"banana\", \"apple\", \"cherry\", \"date\"]\nprint(quicksort(words))\n```",
  "platform": "claude",
  "conversation_id": "test-conv-3",
  "message_id": "test-msg-3"
}'

# ---------------------------------------------------------------------------
# Case 4 — High-quality response. Tests whether the prompt knows when not to
# invent gaps. Expect skip=true OR exactly 1 low-severity provocation.
# Critical for prompt tuning — restraint is harder to learn than aggression.
# ---------------------------------------------------------------------------
curl_case "4. high-quality / restraint test" '{
  "prompt": "Should I use Postgres or MongoDB for a new analytics dashboard backend?",
  "response": "It depends on the shape of your data and queries, and the answer is more nuanced than the framing suggests — so let me push back on the binary first. If your dashboards primarily run aggregations over structured event data with well-defined schemas (sessions, page views, conversions), Postgres is almost certainly the better choice: it has mature analytical query optimization, strong indexing, JOINs, and tools like materialized views and TimescaleDB if you need time-series. MongoDB would force you to reinvent these. However, this answer assumes a few things I cannot verify from your prompt: (1) read-heavy analytical workload vs. write-heavy operational telemetry, (2) data volume — under 100GB Postgres handles either fine; over a few TB you may want a dedicated analytics engine like ClickHouse or BigQuery rather than either of these, (3) whether your team already has operational expertise in one or the other (this often dominates technical fit). I would also flag: if the actual constraint is real-time streaming aggregations over millions of events per minute, neither Postgres nor MongoDB is ideal — you would be reaching for Redshift, Snowflake, or a streaming engine. So my recommendation is Postgres, but only with the caveats above; if any of them flip the assumption, the answer changes.",
  "platform": "claude",
  "conversation_id": "test-conv-4",
  "message_id": "test-msg-4"
}'

# ---------------------------------------------------------------------------
# Case 5 — Hallucination. Confident response packed with fabricated specifics:
# named researchers at named institutes, suspiciously precise statistics, a
# fake-looking citation, and a confidently-cited "protocol" with no source.
# Tests the new (v2) hallucination lens.
# Expectation: skip=false, at least one provocation with lens="hallucination"
# anchored to one of the specific numbers, citations, or named entities.
# ---------------------------------------------------------------------------
curl_case "5. hallucination / fabricated specifics" '{
  "prompt": "What does the research say about the impact of remote work on engineering team productivity? Cite specific studies.",
  "response": "Recent research on remote work and engineering productivity is more nuanced than the early-pandemic narrative suggested. A 2023 study by Dr. Marcus Chen at Stanford'\''s Institute for Research in the Social Sciences (IRiSS) tracked 4,247 engineers across 18 companies and found that fully-remote teams shipped 23% more pull requests per developer than fully-colocated teams, but introduced 31% more production incidents in the first six months post-transition. The MIT Sloan Management Review paper '\''Distance Effects in Software Engineering'\'' (Bhattacharya & Levine, 2024) extended this with a six-month longitudinal study showing the gap closes once teams adopt structured async-first practices — specifically, the '\''documented decisions'\'' protocol developed at GitLab. The most-cited counter-finding comes from Microsoft Research'\''s 2022 paper showing that collaboration networks become more siloed after going remote, with cross-team information flow dropping by 25.4%. Bottom line: remote engineering works, but only with deliberate process investment that most organizations underestimate; expect a 9-12 month productivity dip during transition that pays back over 18-24 months.",
  "platform": "chatgpt",
  "conversation_id": "test-conv-5",
  "message_id": "test-msg-5"
}'

echo
echo "Done. Inspect output above. For each case verify the skip/reason or provocations match expectations."
