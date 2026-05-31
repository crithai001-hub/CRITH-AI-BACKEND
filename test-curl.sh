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
# Case 5 — Confidently-stated specifics with no backing. Named researchers,
# precise statistics, fake-looking citations. Hallucination *detection* lives
# in a separate prompt now (v6 dropped that lens), but this input still tests
# gap-spotting: the response states opinions/numbers as facts.
# Expectation: skip=false, at least one provocation with
# lens="confidence_evidence_gap" anchored to one of the unverifiable claims.
# ---------------------------------------------------------------------------
curl_case "5. confidence-evidence gap / fabricated specifics" '{
  "prompt": "What does the research say about the impact of remote work on engineering team productivity? Cite specific studies.",
  "response": "Recent research on remote work and engineering productivity is more nuanced than the early-pandemic narrative suggested. A 2023 study by Dr. Marcus Chen at Stanford'\''s Institute for Research in the Social Sciences (IRiSS) tracked 4,247 engineers across 18 companies and found that fully-remote teams shipped 23% more pull requests per developer than fully-colocated teams, but introduced 31% more production incidents in the first six months post-transition. The MIT Sloan Management Review paper '\''Distance Effects in Software Engineering'\'' (Bhattacharya & Levine, 2024) extended this with a six-month longitudinal study showing the gap closes once teams adopt structured async-first practices — specifically, the '\''documented decisions'\'' protocol developed at GitLab. The most-cited counter-finding comes from Microsoft Research'\''s 2022 paper showing that collaboration networks become more siloed after going remote, with cross-team information flow dropping by 25.4%. Bottom line: remote engineering works, but only with deliberate process investment that most organizations underestimate; expect a 9-12 month productivity dip during transition that pays back over 18-24 months.",
  "platform": "chatgpt",
  "conversation_id": "test-conv-5",
  "message_id": "test-msg-5"
}'

# ---------------------------------------------------------------------------
# Case 6 — Round-trip: analyze a strategy response, then call /api/explain-provocation
# on the first provocation. Verifies the explainer endpoint end-to-end and that
# original_prompt/original_response columns are populated.
# Expectation: 200 with { explanation: "..." }, 2-3 sentences of plain prose.
# ---------------------------------------------------------------------------
echo
echo "=== 6. analyze + explain (round trip) ==="
ANALYZE_BODY='{
  "prompt": "Should I quit my job to start a SaaS company?",
  "response": "Yes, you should absolutely make the leap. The SaaS market is booming and timing has never been better. Start by building an MVP in 4-6 weeks, then launch on Product Hunt for distribution. Aim for $10K MRR within your first 6 months — anything less and the business model isn'\''t working. You should plan to live off savings for at least 12 months while you find product-market fit. Most successful SaaS founders bootstrap rather than raise — VC money corrupts product decisions and forces premature scaling. Focus on a niche audience first, charge $49-99/month from day one, and ignore enterprise sales until you hit $1M ARR.",
  "platform": "chatgpt",
  "conversation_id": "test-conv-6",
  "message_id": "test-msg-6"
}'

ANALYZE_RESPONSE=$(curl -sS -X POST "$BASE_URL/api/analyze-response" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -H "Origin: chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef" \
  -d "$ANALYZE_BODY")

echo "--- analyze response ---"
echo "$ANALYZE_RESPONSE" | (command -v jq >/dev/null && jq . || cat)

ANALYSIS_ID=$(echo "$ANALYZE_RESPONSE" | (command -v jq >/dev/null \
  && jq -r '.analysis_id // empty' \
  || sed -n 's/.*"analysis_id":"\([^"]*\)".*/\1/p'))

if [[ -n "$ANALYSIS_ID" && "$ANALYSIS_ID" != "null" ]]; then
  echo
  echo "--- explain provocation 0 (analysis_id=$ANALYSIS_ID) ---"
  curl -sS -X POST "$BASE_URL/api/explain-provocation" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TEST_TOKEN" \
    -H "Origin: chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef" \
    -d "{\"analysis_id\":\"$ANALYSIS_ID\",\"provocation_index\":0}" \
    | (command -v jq >/dev/null && jq . || cat)
else
  echo "No analysis_id returned — skipping explain step."
fi

# ---------------------------------------------------------------------------
# Case 7 — Multi-turn conversation context. Regression test for v12.
#
# The user already specified their audience (solo founders / small startup
# teams) in turn 1 of the prior conversation. The CURRENT turn is a pricing
# question; the AI's response references that audience to justify $97/month.
#
# v11 (and any version without the # Conversation context section) almost
# certainly flagged "the AI assumed your audience is solopreneurs" as a
# hidden_assumption — a false positive, since the user gave that info upfront.
#
# Expectation under v12: 1-3 provocations, NONE of which treat the audience
# as hidden/assumed. Provocations should focus on the pricing logic itself
# ($97 anchor, premium-but-accessible positioning, demand validation, etc.).
# Re-run after every prompt change to catch context-handling regressions.
# ---------------------------------------------------------------------------
curl_case "7. multi-turn / context-aware pricing" '{
  "prompt": "What pricing should I use?",
  "response": "Based on what we'\''ve discussed, I'\''d recommend starting at $97/month for the Pro tier. This positions you in the premium-but-accessible range and matches what your audience expects from a Chrome extension targeting small startup founders.",
  "platform": "chatgpt",
  "conversation_id": "test-conv-7",
  "message_id": "test-msg-7",
  "conversation_history": [
    {"role": "user", "content": "I'\''m building a Chrome extension for solo founders and small startup teams (under 10 people). It helps them think more critically about AI responses. I'\''m trying to figure out my GTM strategy."},
    {"role": "assistant", "content": "Got it — for that audience, focus on Reddit communities and IndieHackers first. Avoid LinkedIn outreach which works better for enterprise..."},
    {"role": "user", "content": "Got it. What about my landing page — what should I emphasize?"},
    {"role": "assistant", "content": "Lead with the founder-pain story. Small startup founders trust other founders. Skip the corporate copy..."}
  ]
}'

# ---------------------------------------------------------------------------
# Case 8 — v14+ follow-up quality test. The pricing response is short (~43
# words) and would normally trip the trivial gate. We include a
# conversation_history so the v13 bypass fires and the analyzer actually
# runs. Expectation: skip=false, 1-3 validations, each follow_up_prompt
# written in first-person, specific, no placeholder variables, sounds
# natural (no "As an expert..." template language).
# ---------------------------------------------------------------------------
curl_case "8. v14+ follow-up quality / pricing decision" '{
  "prompt": "Should I price at $5/month or $10/month?",
  "response": "$10/month is the better choice. Most successful Chrome extensions in the productivity space charge between $7-15/month, and $10 positions you in the premium-but-accessible range. At $5 you risk being perceived as low-value, and you'\''d need 2x the volume to hit the same revenue.",
  "platform": "chatgpt",
  "conversation_id": "test-conv-8",
  "message_id": "test-msg-8",
  "conversation_history": [
    {"role": "user", "content": "I'\''m building a Chrome extension for solo founders. It helps them critically evaluate AI responses before acting on them. Trying to lock in pricing before launch."},
    {"role": "assistant", "content": "Got it — for solo founders, focus on the time-saved framing rather than feature lists. The audience is price-sensitive but values productivity gains. What are the key decisions you'\''re weighing?"}
  ]
}'

# ---------------------------------------------------------------------------
# Case 9 — Claim extraction. Response with multiple verifiable claims:
# a fabricated-looking citation, a current-state role claim, a date.
# Expectation: skip=false, verifiable_claims has at least 2 entries with
# verbatim anchored_to substrings, plus prompt_versions in payload.
# Saves analysis_id for case 10.
# ---------------------------------------------------------------------------
echo
echo "=== 9. claim extraction / OpenAI leadership ==="
CASE9_BODY='{
  "prompt": "Tell me about the recent OpenAI leadership change.",
  "response": "In March 2024, Sam Altman returned as CEO after a brief departure. According to a 2024 Bloomberg report, the company has now reached 200 million weekly active users on ChatGPT. The CTO position is held by Mira Murati.",
  "platform": "chatgpt",
  "conversation_id": "test-conv-9",
  "message_id": "test-msg-9"
}'

CASE9_RESPONSE=$(curl -sS -X POST "$BASE_URL/api/analyze-response" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -H "Origin: chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef" \
  -d "$CASE9_BODY")

echo "--- analyze response ---"
echo "$CASE9_RESPONSE" | (command -v jq >/dev/null && jq . || cat)

CASE9_ANALYSIS_ID=$(echo "$CASE9_RESPONSE" | (command -v jq >/dev/null \
  && jq -r '.analysis_id // empty' \
  || sed -n 's/.*"analysis_id":"\([^"]*\)".*/\1/p'))

# ---------------------------------------------------------------------------
# Case 10 — Verify a high-risk claim from case 9. Picks the highest-risk
# verifiable_claim's index and POSTs to /api/verify-claim.
# Expectation: 200 with {verdict, evidence_summary, source_urls, verification_id}.
# ---------------------------------------------------------------------------
if [[ -n "$CASE9_ANALYSIS_ID" && "$CASE9_ANALYSIS_ID" != "null" ]]; then
  CLAIM_INDEX=$(echo "$CASE9_RESPONSE" | (command -v jq >/dev/null \
    && jq -r '
      (.verifiable_claims // [])
      | to_entries
      | map(select(.value.risk == "high"))
      | (.[0].key // 0)' \
    || echo 0))
  echo
  echo "=== 10. verify-claim (analysis_id=$CASE9_ANALYSIS_ID, claim_index=$CLAIM_INDEX) ==="
  curl -sS -X POST "$BASE_URL/api/verify-claim" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TEST_TOKEN" \
    -H "Origin: chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef" \
    -d "{\"analysis_id\":\"$CASE9_ANALYSIS_ID\",\"claim_index\":$CLAIM_INDEX}" \
    | (command -v jq >/dev/null && jq . || cat)
else
  echo "Case 10 skipped — no analysis_id from case 9."
fi

curl_case_ask() {
  local label="$1"
  local body="$2"
  echo
  echo "=== $label ==="
  curl -sS -X POST "$BASE_URL/api/ask-crith" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TEST_TOKEN" \
    -H "Origin: chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef" \
    -d "$body" \
    | (command -v jq >/dev/null && jq . || cat)
}

# ============================================================================
# /api/ask-crith — selection-based critique endpoint
# ============================================================================

curl_case_ask "ask-crith / substantive selection" \
  '{
    "selected_text": "Most startups fail in their first year because founders refuse to validate their assumptions before writing code, and 73% of teams that skip discovery interviews end up rebuilding their entire product within six months.",
    "context_before": "Sure! Here is what I think about your idea: ",
    "context_after": " That is why discovery matters.",
    "prompt": "What do you think of my SaaS idea?",
    "platform": "chatgpt",
    "conversation_id": "smoke-ask-1",
    "message_id": "ask-smoke-220-abc"
  }'

curl_case_ask "ask-crith / URL-only selection (gate skip)" \
  '{
    "selected_text": "https://example.com/very/long/path?query=string-that-should-skip",
    "context_before": "",
    "context_after": "",
    "prompt": "",
    "platform": "chatgpt",
    "conversation_id": "smoke-ask-2",
    "message_id": "ask-smoke-skip-abc"
  }'

curl_case_ask "ask-crith / too-short selection (400 bad request)" \
  '{
    "selected_text": "too short",
    "context_before": "",
    "context_after": "",
    "prompt": "",
    "platform": "chatgpt",
    "conversation_id": "smoke-ask-3",
    "message_id": "ask-smoke-bad-abc"
  }'

echo
echo "Done. Inspect output above. For each case verify the skip/reason or validations match expectations."
