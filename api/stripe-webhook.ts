import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { supabaseService } from "../lib/supabase.js";

// Stripe requires the raw request body for signature verification; disable
// @vercel/node's automatic JSON parsing for this endpoint.
export const config = { api: { bodyParser: false } };

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("Missing required env var: STRIPE_SECRET_KEY");
    _stripe = new Stripe(key);
  }
  return _stripe;
}

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

function resolveCustomerId(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null
): string | null {
  if (!customer) return null;
  return typeof customer === "string" ? customer : customer.id;
}

function resolveSubscriptionId(
  subscription: string | Stripe.Subscription | null | undefined
): string | null {
  if (!subscription) return null;
  return typeof subscription === "string" ? subscription : subscription.id;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "bad_request", message: "POST only" });
    return;
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[stripe-webhook] missing STRIPE_WEBHOOK_SECRET");
    res.status(500).json({ error: "internal" });
    return;
  }

  const sig = req.headers["stripe-signature"];
  if (typeof sig !== "string") {
    res.status(400).json({ error: "bad_request", message: "missing stripe-signature header" });
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error("[stripe-webhook] failed to read raw body", err);
    res.status(400).json({ error: "bad_request" });
    return;
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.warn("[stripe-webhook] signature verification failed", {
      message: err instanceof Error ? err.message : String(err)
    });
    res.status(400).json({ error: "invalid_signature" });
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.supabase_user_id;
        if (!userId) {
          // The website creates the Checkout Session and must set
          // metadata.supabase_user_id from the current auth.uid(). Without it
          // we cannot map the payment to a Crith user — log and ack so Stripe
          // doesn't retry, but flag for follow-up.
          console.warn("[stripe-webhook] checkout.session.completed without supabase_user_id", {
            sessionId: session.id,
            customerId: resolveCustomerId(session.customer)
          });
          break;
        }
        const customerId = resolveCustomerId(session.customer);
        const subscriptionId = resolveSubscriptionId(session.subscription);
        const now = new Date().toISOString();
        const { error } = await supabaseService
          .from("profiles")
          .update({
            is_pro: true,
            pro_since: now,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            updated_at: now
          })
          .eq("user_id", userId);
        if (error) {
          console.error("[stripe-webhook] profile update failed (checkout.session.completed)", {
            userId,
            error
          });
          res.status(500).json({ error: "internal" });
          return;
        }
        console.log("[stripe-webhook] is_pro=true", { userId, customerId, subscriptionId });
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = resolveCustomerId(subscription.customer);
        if (!customerId) {
          console.warn("[stripe-webhook] customer.subscription.deleted without customer id", {
            subscriptionId: subscription.id
          });
          break;
        }
        const now = new Date().toISOString();
        const { error } = await supabaseService
          .from("profiles")
          .update({
            is_pro: false,
            pro_until: now,
            updated_at: now
          })
          .eq("stripe_customer_id", customerId);
        if (error) {
          console.error("[stripe-webhook] profile update failed (customer.subscription.deleted)", {
            customerId,
            error
          });
          res.status(500).json({ error: "internal" });
          return;
        }
        console.log("[stripe-webhook] is_pro=false", { customerId });
        break;
      }

      default:
        // Acknowledge other event types so Stripe stops retrying. Add cases
        // here when more lifecycle hooks are needed (e.g. subscription.updated
        // for pause/resume).
        console.log("[stripe-webhook] ignored event", { type: event.type, id: event.id });
        break;
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error("[stripe-webhook] unhandled", err);
    res.status(500).json({ error: "internal" });
  }
}
