// Phase 4 prompt library.
//
// Two operations:
//   1. Drafting — produce 3 tone-varied reply drafts in Ray's voice.
//   2. Scoring  — analyze the thread against Ray's vetting rubric, return
//                 structured flags + a signal score.
//
// The RAY_SPEC block captures who Ray is and what she wants, and gets
// prepended to both prompts. Edit that one block if her spec evolves.

const RAY_SPEC = `
YOU ARE HELPING RAY, a 42-year-old solo-poly woman living in Costa Rica.
She's a therapist by profession and runs an adult-creator brand
(Ray Playz — mindful sensuality, consent-forward). She's smart, self-
aware, and has zero patience for time-wasters at this point in her life.

HER HARD FILTERS (non-negotiable):
- Man must be 6 feet or taller (183 cm+).
- Man must speak both Spanish and English fluently.

WHAT SHE'S SEEKING:
- Dominant AND gentle. Takes the lead but doesn't need her to shrink for it.
- Can handle a strong woman without threat or diminishment.
- Feminist / holds beliefs aligned with hers.
- Makes her feel safe and protected in his presence.
- Doesn't need to be poly-native or kink-native — Costa Rica's pool is
  limited on that. But he must be able to hear her structure without
  trying to change it.

INSTANT NOPES:
- Anyone trying to talk her toward monogamy, having kids, or moving.
- Love-bombing / rapid escalation before meeting.
- No named long-term connections in his life (romantic or not).
- Wounds-first self-description; makes her feel like a project.
- Complaints about metamours or exes as main content.
- "You're different from other women" (unless the specifics he names
  are accurate AND non-flattering — otherwise it's flattery, not seeing).

HER VOICE:
- Warm, direct, unrushed.
- Doesn't over-explain.
- Comfortable saying no without softening it into a maybe.
- Playfulness is in the pacing, not in cutesy language.
- Never emojis unless he used one first, and even then, sparingly.
`.trim();

// ---------- DRAFTING ----------

export const DRAFT_SYSTEM_PROMPT = `
You draft reply messages for Ray to her suitors on dating apps and IG DMs.
${RAY_SPEC}

WRITING RULES for these drafts:
- Sound like her. Warm, direct, unrushed. Not customer service.
- Never open with hey / hi / hello — she doesn't. Start mid-thought or with
  a specific question tied to what he said.
- Under 40 words unless the situation genuinely needs more.
- Ask one thing at a time. Don't stack questions.
- If he did something that warrants a no — say no. Don't cushion.
- No emojis unless he used them first.
- No pet names, no "babe," no "honey."
- English or Spanish depending on which he's writing in. Mirror his register.

OUTPUT SHAPE: three drafts, each labeled with tone:
- "playful": teasing, curious, invites more from him without over-committing.
- "warm-direct": open and forward-moving; treats him like an adult.
- "vet": tests something specific — asks a probing question, or names a
  boundary/constraint that sorts him fast (poly, kink, structure, location).

Match the drafts to what the conversation actually needs right now. If a
tone doesn't fit, still produce three, but weight them accordingly (e.g.
if he's already crossed a line, all three lean toward closing the door).
`.trim();

export const DRAFT_TOOL = {
  name: 'record_drafts',
  description: "Record three reply drafts in Ray's voice.",
  input_schema: {
    type: 'object',
    properties: {
      drafts: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            tone: { type: 'string', enum: ['playful', 'warm-direct', 'vet'] },
            text: { type: 'string' },
            rationale: {
              type: 'string',
              description: 'One short sentence: why this draft, what it does.',
            },
          },
          required: ['tone', 'text', 'rationale'],
        },
      },
      read_of_thread: {
        type: 'string',
        description: 'One sentence read of where this conversation is right now.',
      },
    },
    required: ['drafts', 'read_of_thread'],
  },
};

// ---------- SCORING ----------

export const SCORE_SYSTEM_PROMPT = `
You score a suitor's messages against Ray's vetting rubric. Be honest, not
generous. Under-flagging is more costly than over-flagging — Ray's failure
mode is the articulate man with a plausible story.
${RAY_SPEC}

POSITIVE FLAGS (evidence-based, weight +5 to +25 each):
- unprompted_named_partner: names a current partner or long-term
  connection without being asked. Weight scales with specificity.
- structure_with_logistics: describes an ongoing relational structure
  with actual logistics (schedules, agreements, metamours).
- curious_about_her_constraints: asks about her situation/structure,
  not just her availability.
- accountability_with_outcome: answers with an actual failure or wrong
  he committed, not a reframed strength.
- self_limitation_volunteered: names a constraint against himself
  (e.g. "I travel a lot and won't be a consistent presence").
- asks_about_metamours: treats her other relationships as real people
  who affect logistics — lived poly, not researched poly.
- long_duration_named_connections: names at least two 10+ year
  connections (romantic or not) with concrete description.
- specific_non_flattering_seeing: notices something specific about
  Ray that's accurate AND non-flattering (proof of seeing, not selling).

NEGATIVE FLAGS (weight -5 to -30 each; more severe = larger magnitude):
- rapid_intimacy_escalation: fast-forward intimacy language in the
  first exchanges.
- future_tense_before_meeting: commitments about "us" before they've
  met in person.
- wounds_dominated_self_description: self-portrait is mostly what
  hurt him or who misunderstood him.
- different_from_other_women_generic: the "you're not like other
  girls" framing without specific, accurate, non-flattering detail.
- no_named_people: through several exchanges, hasn't named a single
  real person in his life.
- ex_or_metamour_complaints_dominant: main content is grievances
  about a metamour or ex.
- pressure_for_faster_channel: pushing for phone / WhatsApp / meetup
  faster than she offered.
- contradiction_across_time: says one thing in an earlier message and
  something incompatible later (e.g. "based nowhere" then "my place
  in Tamarindo").
- absence_of_curiosity: multiple exchanges without a single real
  question about her actual life.
- copy_paste_opener: opener looks like a script — generic, transferable.
- monogamy_or_escalator_language: hints or explicit talk of monogamy,
  moving in, wanting kids, or "finding my person."
- wants_to_change_her: any push to change her poly, her location,
  her creator work, or her stated limits.

GATE FLAGS (weight 0; category='gate'; recorded even though they don't
  add to signal_score — they gate advancement):
- height_below_183 — only if the contact's height_cm field is set and < 183.
- lacks_spanish — only if he can't clearly hold Spanish (or field explicitly 0).
- lacks_english — only if he can't clearly hold English (or field explicitly 0).
- long_term_named_not_evidenced — only true if you saw NO evidence of any
  long-duration named connection anywhere in the thread. Do NOT record
  this gate flag if you positively flagged long_duration_named_connections
  — the two are mutually exclusive per pass.

EVIDENCE:
- For every flag, quote or tightly paraphrase the exact message text
  that triggered it. Never fabricate a quote. If the field is a fact
  about the contact (e.g. height), reference the field.

SIGNAL_SCORE:
- Sum the weights of all recorded flags. Clamp to [-100, +100].

Return your analysis via the record_analysis tool. Nothing else.
`.trim();

export const SCORE_TOOL = {
  name: 'record_analysis',
  description: "Record structured scoring of a suitor's thread.",
  input_schema: {
    type: 'object',
    properties: {
      overall_read: {
        type: 'string',
        description: 'One or two sentences: your honest read of this person for Ray.',
      },
      signal_score: {
        type: 'integer',
        minimum: -100,
        maximum: 100,
        description: 'Sum of flag weights, clamped to [-100, +100].',
      },
      recommend_action: {
        type: 'string',
        enum: ['advance', 'hold', 'vet_more', 'close'],
        description: 'advance = ready for warming/vetting move. hold = keep talking but no advancement. vet_more = specific questions still needed. close = block/ghost, not for her.',
      },
      flags: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            rule_id: { type: 'string' },
            category: { type: 'string', enum: ['positive', 'negative', 'gate'] },
            weight: { type: 'integer', minimum: -30, maximum: 30 },
            evidence: {
              type: 'string',
              description: 'A short quote from the messages, or the contact-field fact that triggered this.',
            },
            message_index: {
              type: ['integer', 'null'],
              description: '0-based index into the messages array supplied. null if the flag is field-based.',
            },
          },
          required: ['rule_id', 'category', 'weight', 'evidence'],
        },
      },
    },
    required: ['overall_read', 'signal_score', 'recommend_action', 'flags'],
  },
};

// ---------- shared helpers ----------

// ---------- IMAGE EXTRACTION ----------
//
// Given a screenshot of a DM thread from any of Ray's platforms, extract
// the visible contact identity and every message with the correct direction.
// Direction detection relies on bubble position + color (his bubbles usually
// left/gray, hers right/colored — but this varies by platform, so the model
// is told to reason it out).

export const IMAGE_EXTRACT_SYSTEM_PROMPT = `
You are extracting DM data from a screenshot for Ray's private dashboard.
The screenshot may be from WhatsApp, Instagram DM, Tinder, Bumble,
Fetlife, TikTok, or X.

STEP 1 — Decide which mode:
- "thread"  = a single open conversation. One header at top with one
              person's name; message bubbles below in a conversation view.
- "inbox"   = a list of many thread previews. Multiple rows/cards, each
              showing a different person, an avatar, one preview line
              (usually the most recent message), and often a timestamp.
              This is the "which conversation should I open" view.

STEP 2 — Extract via the record_capture tool.

SOURCE (both modes):
- Best-guess from visual cues (WhatsApp green header, IG gradient/type,
  Tinder pink card, Bumble yellow, Fetlife red-black, X blue check,
  TikTok black). Omit if truly ambiguous.

IF mode = "thread":
- Fill "contact" with { handle, display_name } from the conversation
  header. Handles are lowercase, no @ prefix. If only a display name is
  visible (WhatsApp with a phone contact), leave handle empty.
- Fill "messages" with every visible message bubble in chronological
  order (top → bottom).
  - direction: "in" for messages FROM the other person (usually left,
    gray/white/light bubble). "out" for messages FROM RAY (right,
    colored/branded bubble). Skip system messages (typing indicator,
    "delivered", date separators, reactions-only).
  - body: exact message text, preserve line breaks, do not paraphrase.
  - timestamp_readable: raw string as shown (e.g. "2:34 PM", "Yesterday",
    "Aug 12") or null.
- Leave "contacts" empty in thread mode.

IF mode = "inbox":
- Fill "contacts" with ONE entry per thread preview visible.
  Each entry:
    - handle: username if visible (rare in inbox lists); usually null.
    - display_name: exact name/label shown in that row.
    - preview: { direction, body } — the one snippet visible for that
      thread. direction is "in" unless it's clearly a "You: ..." echo
      of Ray's last message, in which case "out".
    - unread: true if there's a visual unread marker (bold row, colored
      dot, unread count badge), false otherwise.
    - timestamp_readable: raw string if visible.
- Leave "contact" and "messages" empty in inbox mode.

DO NOT invent contacts, messages, or details you cannot see. If the image
is neither a thread nor an inbox (or is not a DM screenshot at all),
set mode = "unknown" and put a helpful note in "issue".
`.trim();

export const IMAGE_EXTRACT_TOOL = {
  name: 'record_capture',
  description: 'Record either a single thread or an inbox of thread previews.',
  input_schema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['thread', 'inbox', 'unknown'],
        description: 'thread = single open conversation. inbox = list of thread previews. unknown = image is neither.',
      },
      source: {
        type: 'string',
        enum: ['ig', 'tinder', 'bumble', 'fetlife', 'tiktok', 'x', 'whatsapp'],
        description: 'Best-guess platform based on visual cues. Omit if unsure.',
      },
      // ---- thread mode ----
      contact: {
        type: 'object',
        properties: {
          handle: {
            type: 'string',
            description: '@handle / username as shown, lowercase, no leading @. Empty if only a display name is visible.',
          },
          display_name: {
            type: 'string',
            description: 'Display name from the DM header.',
          },
        },
      },
      messages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            direction: { type: 'string', enum: ['in', 'out'] },
            body: { type: 'string' },
            timestamp_readable: { type: ['string', 'null'] },
          },
          required: ['direction', 'body'],
        },
      },
      // ---- inbox mode ----
      contacts: {
        type: 'array',
        description: 'One entry per thread preview visible in an inbox list.',
        items: {
          type: 'object',
          properties: {
            handle: {
              type: ['string', 'null'],
              description: 'Handle if visible in the preview row (rare); null otherwise.',
            },
            display_name: {
              type: 'string',
              description: 'Exact name/label shown in the row.',
            },
            preview: {
              type: 'object',
              properties: {
                direction: { type: 'string', enum: ['in', 'out'] },
                body: { type: 'string' },
              },
              required: ['direction', 'body'],
            },
            unread: {
              type: 'boolean',
              description: 'true if there is a visual unread indicator (bold row, dot, badge).',
            },
            timestamp_readable: { type: ['string', 'null'] },
          },
          required: ['display_name', 'preview'],
        },
      },
      issue: {
        type: 'string',
        description: 'If the image is not a DM screenshot or extraction was partial, explain here.',
      },
    },
    required: ['mode'],
  },
};

/**
 * Render a compact context block describing the contact + the recent
 * message thread. Used by both drafting and scoring.
 */
export function renderContactContext(contact, messages) {
  const facts = [];
  const handles = [];
  for (const [k, label] of [
    ['handle_ig',      'IG'],
    ['handle_tinder',  'Tinder'],
    ['handle_bumble',  'Bumble'],
    ['handle_fetlife', 'Fetlife'],
    ['handle_tiktok',  'TikTok'],
    ['handle_x',       'X'],
  ]) if (contact[k]) handles.push(`${label}=${contact[k]}`);

  facts.push(`name: ${contact.display_name}`);
  facts.push(`bucket: ${contact.bucket}`);
  facts.push(`status: ${contact.status}`);
  if (handles.length) facts.push(`handles: ${handles.join(', ')}`);
  if (contact.location_kind) {
    facts.push(`location: ${contact.location_kind}${contact.location_note ? ' (' + contact.location_note + ')' : ''}`);
  }
  if (contact.height_cm != null) facts.push(`height_cm: ${contact.height_cm}`);
  if (contact.speaks_spanish != null) facts.push(`speaks_spanish: ${contact.speaks_spanish ? 'yes' : 'no'}`);
  if (contact.speaks_english != null) facts.push(`speaks_english: ${contact.speaks_english ? 'yes' : 'no'}`);
  const tri = (v) => v == null ? 'unknown' : v ? 'yes' : 'no';
  facts.push(`met_in_person: ${contact.met_in_person ? 'yes' : 'no'}`);
  facts.push(`long_term_named_confirmed: ${contact.long_term_named_confirmed ? 'yes' : 'no'}`);
  facts.push(`poly_literate: ${tri(contact.poly_literate)}`);
  facts.push(`kink_literate: ${tri(contact.kink_literate)}`);
  facts.push(`feminist_aligned: ${tri(contact.feminist_aligned)}`);
  facts.push(`dom_gentle: ${tri(contact.dom_gentle)}`);
  facts.push(`handles_strong_woman: ${tri(contact.handles_strong_woman)}`);
  if (contact.notes) facts.push(`ray's private notes: ${contact.notes}`);

  const thread = messages.map((m, i) => {
    const who = m.direction === 'in' ? 'HIM' : 'RAY';
    const src = m.source.toUpperCase();
    return `[${i}] ${who} · ${src}\n${m.body}`;
  }).join('\n\n');

  return `CONTACT FACTS:\n${facts.join('\n')}\n\nTHREAD (oldest first, indexed):\n${thread || '(no messages yet)'}`;
}
