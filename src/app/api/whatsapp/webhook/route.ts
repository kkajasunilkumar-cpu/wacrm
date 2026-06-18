import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { getMediaUrl } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { getAIReply, sendWhatsAppReply } from '@/lib/ai-agent'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'

// File path: src/app/api/whatsapp/webhook/route.ts
// Hybrid bot logic:
// Static replies for greeting, name/location, university, courses, fees, office.
// OpenAI is called only after the user chooses "Others" and sends a custom question.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null

function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }

  return _adminClient
}

type BotStage =
  | 'waiting_for_name_location'
  | 'waiting_for_university'
  | 'waiting_for_menu_choice'
  | 'waiting_for_custom_question'

type UniversityKey = 'chettinad' | 'kalasalingam'

interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: {
    id: string
    mime_type: string
    filename?: string
    caption?: string
  }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: {
    latitude: number
    longitude: number
    name?: string
    address?: string
  }
  reaction?: { message_id: string; emoji: string }
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  context?: { id: string }
}

interface WhatsAppStatus {
  id: string
  status: string
  timestamp: string
  recipient_id: string
  errors?: Array<{
    code?: number
    title?: string
    message?: string
    error_data?: unknown
  }>
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name: string }
        wa_id: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: WhatsAppStatus[]
    }
    field: string
  }>
}

interface BotState {
  stage: BotStage
  selectedUniversity?: UniversityKey
  name?: string
  location?: string
}

// NOTE: In-memory state resets when server restarts.
// For production, move this state to Supabase columns/table.
const botStateMemory: Record<string, BotState> = {}

const UNIVERSITY_LABELS: Record<UniversityKey, string> = {
  chettinad: 'Chettinad Academy of Research and Education',
  kalasalingam: 'Kalasalingam Academy of Research and Education',
}

const UNIVERSITY_SELECTION_ALIASES: Record<string, UniversityKey> = {
  '1': 'chettinad',
  chettinad: 'chettinad',
  'chettinad university': 'chettinad',
  care: 'chettinad',
  'chettinad academy of research and education': 'chettinad',
  button_chettinad: 'chettinad',

  '2': 'kalasalingam',
  kalasalingam: 'kalasalingam',
  'kalasalingam university': 'kalasalingam',
  kare: 'kalasalingam',
  'kalasalingam academy of research and education': 'kalasalingam',
  button_kalasalingam: 'kalasalingam',
}

const MENU_ALIASES: Record<string, 'courses' | 'fees' | 'office' | 'others'> = {
  '1': 'courses',
  courses: 'courses',
  course: 'courses',
  programmes: 'courses',
  programs: 'courses',
  button_courses: 'courses',

  '2': 'fees',
  fees: 'fees',
  fee: 'fees',
  scholarship: 'fees',
  scholarships: 'fees',
  hostel: 'fees',
  button_fees: 'fees',

  '3': 'office',
  'administration office': 'office',
  office: 'office',
  location: 'office',
  address: 'office',
  contact: 'office',
  button_office: 'office',

  '4': 'others',
  others: 'others',
  other: 'others',
  custom: 'others',
  question: 'others',
  button_others: 'others',
}

function normalizeChoice(input: string | null | undefined): string {
  return (input || '').trim().toLowerCase()
}

function getInteractiveReplyId(message: WhatsAppMessage): string | null {
  return (
    message.interactive?.button_reply?.id ||
    message.interactive?.list_reply?.id ||
    null
  )
}

function getInteractiveReplyTitle(message: WhatsAppMessage): string | null {
  return (
    message.interactive?.button_reply?.title ||
    message.interactive?.list_reply?.title ||
    null
  )
}

function parseNameLocation(text: string): { name: string; location: string } {
  const cleaned = text.trim()
  let name = cleaned
  let location = ''

  const nameMatch = cleaned.match(/name\s*[:\-]\s*([^,\n]+)/i)
  const locationMatch = cleaned.match(/location\s*[:\-]\s*([^,\n]+)/i)

  if (nameMatch?.[1]) name = nameMatch[1].trim()
  if (locationMatch?.[1]) location = locationMatch[1].trim()

  if (!location) {
    const parts = cleaned
      .split(/,|\n/)
      .map((p) => p.trim())
      .filter(Boolean)

    if (parts.length >= 2) {
      name = parts[0]
      location = parts[1]
    }
  }

  if (!name) name = 'Student'

  return { name, location }
}

function getGreetingMessage() {
  return `👋 Welcome to KB EDU Tech!

We help students with university admissions, courses, fees, scholarships, hostel details, and admission guidance.

Please share your details:

Name:
Location:`
}

function getUniversitySelectionMessage(name?: string) {
  return `Thank you${name ? `, ${name}` : ''} 😊

Please select the university you are interested in:

1️⃣ Chettinad Academy of Research and Education
2️⃣ Kalasalingam Academy of Research and Education

Reply with 1 or 2.`
}

function getMenuMessage(university: UniversityKey) {
  return `Great choice 😊

What would you like to know about ${UNIVERSITY_LABELS[university]}?

1️⃣ Courses
2️⃣ Fees / Scholarships / Hostel
3️⃣ Administration Office
4️⃣ Others

Reply with 1, 2, 3, or 4.`
}

function getStaticAnswer(university: UniversityKey, menu: 'courses' | 'fees' | 'office') {
  if (university === 'kalasalingam') {
    if (menu === 'courses') {
      return `🎓 Kalasalingam Academy of Research and Education offers:

B.Tech:
• CSE: AI & ML, Cyber Security, Data Science / Big Data, IoT
• AI & Data Science
• CSE Work Integrated: Software Product Engineering
• IT: Game Development, Blockchain Technology
• ECE: AI, IoT, ASIC SOC, RTL, UVM
• Mechanical: Mechatronics, Robotics, Digital Manufacturing
• Biomedical: Medical Devices & Technology
• Aeronautical, Biotechnology, Food Technology, Civil, EEE
• B.Arch

Other Programs:
• B.Sc Agriculture, B.Sc Horticulture
• B.Sc Forensic Science, B.Sc Nursing
• M.Tech, M.Arch, MBA, MCA, M.Sc, Ph.D

For admission support: 9676232325`
    }

    if (menu === 'fees') {
      return `💰 Kalasalingam Tuition Fees:

• B.Tech CSE / IT: ₹1,95,000 per year
• B.Tech ECE / Bio-Technology: ₹1,60,000 per year
• Aeronautical, Agriculture, Mechanical, Mechatronics, Civil, Chemical, EEE, Bio Medical, Food Technology, B.Arch: ₹1,00,000 per year

🎓 Merit Scholarship for CSE/IT:
• JEE Rank 1–50,000: 100% scholarship, pay ₹0
• JEE Rank 50,001–1,00,000: pay ₹58,500
• JEE Rank 1,00,001–2,00,000: pay ₹1,17,000
• PCM above 90%: pay ₹1,56,000
• PCM 80–89.99%: pay ₹1,75,500

🏠 Hostel: ₹80,000 to ₹1,50,000 per year based on room type.

For exact admission guidance: 9676232325`
    }

    return `📍 Kalasalingam Admission Information Office:

Balaji Commercial Complex,
Bhagya Nagar Colony,
Kukatpally, Hyderabad

📞 Phone: 9676232325

Our counselor can guide you with admission process, courses, fees, scholarships, hostel, and campus details.`
  }

  if (menu === 'courses') {
    return `🎓 Chettinad Academy of Research and Education offers:

• Faculty of Medicine: MBBS, MD, MS, DM, MCh
• Allied Health Sciences: BSc, MSc
• Nursing: BSc Nursing, MSc Nursing, PB BSc Nursing
• Architecture: B.Arch, M.Arch
• Pharmacy: B.Pharm, M.Pharm, Pharm.D
• Physiotherapy: BPT, MPT
• Occupational Therapy: BOT
• Law: BA LLB, BBA LLB, LLM

Admissions 2026–2027 are open.

For admission support: 9676232325`
  }

  if (menu === 'fees') {
    return `💰 Chettinad fee details vary by program.

Programs include Medicine, Allied Health Sciences, Nursing, Architecture, Pharmacy, Physiotherapy, Occupational Therapy, and Law.

For exact latest fee details, eligibility, and admission process, please contact KB EDU Tech counselor:

📞 9676232325

Chettinad official admission portal:
admission.care.edu.in`
  }

  return `📍 Chettinad Main Campus:

Chettinad Health City,
Rajiv Gandhi Salai OMR,
Kelambakkam - 603103,
Chengalpattu District,
Chennai, Tamil Nadu

📞 Chettinad Enquiry: +91 844 789 2022
🌐 Website: www.care.edu.in
📝 Apply: admission.care.edu.in

KB EDU Tech Hyderabad admission support:
📞 9676232325`
}

function getOthersPrompt() {
  return `Sure 😊 Please type your specific question.

Our AI assistant will help with admission, eligibility, scholarships, courses, fees, hostel, placements, or campus details.`
}

async function sendAndStoreAgentMessage(params: {
  conversationId: string
  phoneNumberId: string
  accessToken: string
  to: string
  text: string
}) {
  const metaMessageId = await sendWhatsAppReply(
    params.phoneNumberId,
    params.accessToken,
    params.to,
    params.text
  )

  if (!metaMessageId) {
    console.error('[Bot] WhatsApp send failed. No Meta message ID returned.')
    return null
  }

  const { error } = await supabaseAdmin().from('messages').insert({
    conversation_id: params.conversationId,
    sender_type: 'agent',
    content_type: 'text',
    content_text: params.text,
    message_id: metaMessageId,
    status: 'sent',
    created_at: new Date().toISOString(),
  })

  if (error) {
    console.error('[Bot] Error inserting bot message:', error)
  }

  await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: params.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.conversationId)

  return metaMessageId
}

async function handleHybridBotFlow(params: {
  message: WhatsAppMessage
  conversationId: string
  phoneNumberId: string
  accessToken: string
  senderPhone: string
  inboundText: string
  interactiveReplyId: string | null
  interactiveReplyTitle: string | null
}) {
  const {
    message,
    conversationId,
    phoneNumberId,
    accessToken,
    senderPhone,
    inboundText,
    interactiveReplyId,
    interactiveReplyTitle,
  } = params

  const currentState = botStateMemory[senderPhone]
  const rawChoice = normalizeChoice(interactiveReplyId || interactiveReplyTitle || inboundText)
  const textChoice = normalizeChoice(inboundText)

  const sendBotText = async (text: string) => {
    return sendAndStoreAgentMessage({
      conversationId,
      phoneNumberId,
      accessToken,
      to: message.from,
      text,
    })
  }

  if (!currentState) {
    botStateMemory[senderPhone] = {
      stage: 'waiting_for_name_location',
    }

    await sendBotText(getGreetingMessage())
    return
  }

  if (currentState.stage === 'waiting_for_name_location') {
    const details = parseNameLocation(inboundText)

    botStateMemory[senderPhone] = {
      ...currentState,
      stage: 'waiting_for_university',
      name: details.name,
      location: details.location,
    }

    await sendBotText(getUniversitySelectionMessage(details.name))
    return
  }

  if (currentState.stage === 'waiting_for_university') {
    const university =
      UNIVERSITY_SELECTION_ALIASES[rawChoice] ||
      UNIVERSITY_SELECTION_ALIASES[textChoice]

    if (!university) {
      await sendBotText(getUniversitySelectionMessage(currentState.name))
      return
    }

    botStateMemory[senderPhone] = {
      ...currentState,
      stage: 'waiting_for_menu_choice',
      selectedUniversity: university,
    }

    await sendBotText(getMenuMessage(university))
    return
  }

  if (currentState.stage === 'waiting_for_menu_choice') {
    const selectedUniversity = currentState.selectedUniversity

    if (!selectedUniversity) {
      botStateMemory[senderPhone] = {
        ...currentState,
        stage: 'waiting_for_university',
      }

      await sendBotText(getUniversitySelectionMessage(currentState.name))
      return
    }

    const menuChoice =
      MENU_ALIASES[rawChoice] ||
      MENU_ALIASES[textChoice]

    if (!menuChoice) {
      await sendBotText(getMenuMessage(selectedUniversity))
      return
    }

    if (menuChoice === 'others') {
      botStateMemory[senderPhone] = {
        ...currentState,
        stage: 'waiting_for_custom_question',
      }

      await sendBotText(getOthersPrompt())
      return
    }

    await sendBotText(getStaticAnswer(selectedUniversity, menuChoice))
    await sendBotText(getMenuMessage(selectedUniversity))
    return
  }

  if (currentState.stage === 'waiting_for_custom_question') {
    const aiReply = await getAIReply(inboundText, senderPhone)

    if (!aiReply) {
      await sendBotText(
        `Sorry, I could not process that right now. Please contact KB EDU Tech counselor at 9676232325.`
      )
    } else {
      await sendBotText(aiReply)
    }

    botStateMemory[senderPhone] = {
      ...currentState,
      stage: 'waiting_for_menu_choice',
    }

    if (currentState.selectedUniversity) {
      await sendBotText(getMenuMessage(currentState.selectedUniversity))
    }

    return
  }
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token')

    if (configError || !configs) {
      console.error('[webhook] Error fetching configs for verification:', configError)
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null

    for (const config of configs) {
      if (!config.verify_token) continue

      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config
          break
        }
      } catch {
        // skip malformed / wrong-key token row
      }
    }

    if (matchedConfig) {
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error
              )
            }
          })
      }

      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('[webhook] Error in GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Receive WhatsApp webhook events
export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[webhook] Rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: WhatsAppWebhookEntry[] }

  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  console.log('[webhook] Meta webhook received:', JSON.stringify(body, null, 2))

  processWebhook(body).catch((error) => {
    console.error('[webhook] Error processing webhook:', error)
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          { field: change.field, value: change.value as unknown },
          supabaseAdmin()
        )
        continue
      }

      const value = change.value

      if (value.statuses?.length) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status)
        }
      }

      if (!value.messages || !value.contacts) {
        continue
      }

      const phoneNumberId = value.metadata.phone_number_id

      const { data: configRows, error: configError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('*')
        .eq('phone_number_id', phoneNumberId)

      if (configError) {
        console.error(
          '[webhook] Error fetching whatsapp_config for phone_number_id:',
          phoneNumberId,
          configError
        )
        continue
      }

      if (!configRows || configRows.length === 0) {
        console.error('[webhook] No config found for phone_number_id:', phoneNumberId)
        continue
      }

      if (configRows.length > 1) {
        console.error(
          `[webhook] Multiple configs (${configRows.length}) found for phone_number_id:`,
          phoneNumberId,
          'Inbound message dropped. Resolve duplicates.',
          configRows.map((r: { account_id: string; user_id: string }) => {
            return `${r.account_id} (admin ${r.user_id})`
          })
        )
        continue
      }

      const config = configRows[0]
      const decryptedAccessToken = decrypt(config.access_token)

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i]
        const contact = value.contacts[i] || value.contacts[0]

        await processMessage(
          message,
          contact,
          config.account_id,
          config.user_id,
          decryptedAccessToken,
          config.phone_number_id
        )
      }
    }
  }
}

const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }

  if (current === 'failed') {
    return false
  }

  const currentIndex = ladderLevel(current)
  const incomingIndex = ladderLevel(incoming)

  if (incomingIndex < 0) return false
  if (currentIndex < 0) return true

  return incomingIndex > currentIndex
}

async function handleStatusUpdate(status: WhatsAppStatus) {
  console.log('[WhatsApp Status Received]', JSON.stringify(status, null, 2))

  if (status.status === 'failed') {
    console.error('[WhatsApp Delivery Failed]', {
      wamid: status.id,
      recipient: status.recipient_id,
      errors: status.errors,
    })
  }

  const { data: updatedMessages, error: msgErr } = await supabaseAdmin()
    .from('messages')
    .update({ status: status.status })
    .eq('message_id', status.id)
    .select('id, message_id, status')

  if (msgErr) {
    console.error('[WhatsApp Status] Error updating message status:', msgErr)
  } else if (!updatedMessages || updatedMessages.length === 0) {
    console.warn('[WhatsApp Status] No matching message row found for wamid:', status.id)
  } else {
    console.log('[WhatsApp Status] Updated message rows:', updatedMessages)
  }

  const timestampNumber = parseInt(status.timestamp, 10)
  const tsIso = Number.isFinite(timestampNumber)
    ? new Date(timestampNumber * 1000).toISOString()
    : new Date().toISOString()

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', status.id)
    .maybeSingle()

  if (recFetchErr) {
    console.error('[WhatsApp Status] Error fetching broadcast recipient:', recFetchErr)
    return
  }

  if (!recipient) return

  if (!isValidStatusTransition(recipient.status, status.status)) {
    console.warn('[WhatsApp Status] Ignored invalid broadcast status transition:', {
      current: recipient.status,
      incoming: status.status,
      wamid: status.id,
    })
    return
  }

  const update: Record<string, unknown> = {
    status: status.status,
  }

  if (status.status === 'sent') update.sent_at = tsIso
  if (status.status === 'delivered') update.delivered_at = tsIso
  if (status.status === 'read') update.read_at = tsIso

  const { error: recUpdateErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .update(update)
    .eq('id', recipient.id)

  if (recUpdateErr) {
    console.error('[WhatsApp Status] Error updating broadcast recipient status:', recUpdateErr)
  }
}

async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]

    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({
        status: 'replied',
        replied_at: new Date().toISOString(),
      })
      .eq('id', row.id)

    if (updErr) {
      console.error('[webhook] Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('[webhook] flagBroadcastReplyIfAny failed:', err)
  }
}

async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()

  if (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error.message)
    return null
  }

  return data?.id ?? null
}

async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction

  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )

  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    )
    return
  }

  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)

    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message)
    }

    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )

  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message)
  }
}

async function processMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
  accountId: string,
  configOwnerUserId: string,
  accessToken: string,
  phoneNumberId: string
) {
  const senderPhone = normalizePhone(message.from)
  const contactName = contact.profile.name

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName
  )

  if (!contactOutcome) return

  const contactRecord = contactOutcome.contact

  const conversation = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )

  if (!conversation) return

  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
    return
  }

  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(message, accessToken)

  let replyToInternalId: string | null = null

  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id
    )

    if (!replyToInternalId) {
      console.warn('[webhook] reply context parent not found:', message.context.id)
    }
  }

  void mediaType

  const ALLOWED_CONTENT_TYPES = new Set([
    'text',
    'image',
    'document',
    'audio',
    'video',
    'location',
    'template',
    'interactive',
  ])

  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'
      : 'text'

  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')

  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: message.id,
    status: 'delivered',
    created_at: new Date(parseInt(message.timestamp, 10) * 1000).toISOString(),
    reply_to_message_id: replyToInternalId,
    interactive_reply_id: interactiveReplyId,
  })

  if (msgError) {
    console.error('[webhook] Error inserting customer message:', msgError)
    return
  }

  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${message.type}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('[webhook] Error updating conversation:', convError)
  }

  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText ?? '',
          meta_message_id: message.id,
        }
      : {
          kind: 'text',
          text: contentText ?? message.text?.body ?? '',
          meta_message_id: message.id,
        },
    isFirstInboundMessage,
  })

  const flowConsumed = flowResult.consumed

  const inboundText = contentText ?? message.text?.body ?? ''
  const interactiveRawId = getInteractiveReplyId(message)
  const interactiveRawTitle = getInteractiveReplyTitle(message)

  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = []

  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
  }

  if (contactOutcome.wasCreated) {
    automationTriggers.unshift('new_contact_created')
  }

  if (isFirstInboundMessage) {
    automationTriggers.unshift('first_inbound_message')
  }

  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  if (!flowConsumed && (message.type === 'text' || message.type === 'interactive')) {
    handleHybridBotFlow({
      message,
      conversationId: conversation.id,
      phoneNumberId,
      accessToken,
      senderPhone,
      inboundText,
      interactiveReplyId: interactiveRawId,
      interactiveReplyTitle: interactiveRawTitle,
    }).catch((err) => console.error('[Hybrid Bot] Error:', err))
  }
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  interactiveReplyId: string | null
}> {
  const verifyAndBuildUrl = async (
    mediaId: string
  ): Promise<string | null> => {
    try {
      await getMediaUrl({ mediaId, accessToken })
      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `[webhook] Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          mediaUrl: await verifyAndBuildUrl(message.document.id),
          mediaType: message.document.mime_type,
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.audio.id),
          mediaType: message.audio.mime_type,
        }
      }
      return empty

    case 'sticker':
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [
          loc.name,
          loc.address,
          `${loc.latitude},${loc.longitude}`,
        ]
          .filter(Boolean)
          .join(' - ')

        return { ...empty, contentText: locationText }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply

      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }

      return { ...empty, contentText: '[Interactive reply]' }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone
  )

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }

    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(
        supabaseAdmin(),
        accountId,
        phone
      )

      if (raced) return { contact: raced, wasCreated: false }
    }

    console.error('[webhook] Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string
) {
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .single()

  if (!findError && existing) {
    return existing
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    console.error('[webhook] Error creating conversation:', createError)
    return null
  }

  return newConv
}
