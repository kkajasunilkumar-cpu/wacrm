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
// V3 Hybrid bot:
// - Understands natural phrases like "Kalasalingam fees", "scholarship", "hostel", "Chettinad courses".
// - Switches university context when user mentions another university.
// - Does not repeat the menu unnecessarily after every answer.
// - Calls OpenAI only for true custom questions.

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
type MenuKey = 'courses' | 'fees' | 'office' | 'others' | 'placements' | 'facilities'

interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
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
      metadata: { display_phone_number: string; phone_number_id: string }
      contacts?: Array<{ profile: { name: string }; wa_id: string }>
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

const botStateMemory: Record<string, BotState> = {}

const UNIVERSITY_LABELS: Record<UniversityKey, string> = {
  chettinad: 'Chettinad Academy of Research and Education',
  kalasalingam: 'Kalasalingam Academy of Research and Education',
}

function cleanText(input: string | null | undefined): string {
  return (input || '').trim().toLowerCase()
}

function isPureNumberChoice(text: string): boolean {
  return /^[1-4]$/.test(cleanText(text))
}

// Detect university only from words. Do NOT treat 1/2 as university here,
// because 1/2 also means Courses/Fees inside the menu.
function detectUniversity(text: string): UniversityKey | null {
  const t = cleanText(text)
  if (/\b(chettinad|care)\b/.test(t)) return 'chettinad'
  if (/\b(kalasalingam|kare)\b/.test(t)) return 'kalasalingam'
  return null
}

// Use this only when the bot is specifically asking the university question.
function detectUniversitySelection(text: string): UniversityKey | null {
  const t = cleanText(text)
  if (t === '1') return 'chettinad'
  if (t === '2') return 'kalasalingam'
  return detectUniversity(text)
}

// Detect menu only from words. Do NOT treat 1/2/3/4 as menu globally,
// because 1/2 means university in the university selection step.
function detectMenu(text: string): MenuKey | null {
  const t = cleanText(text)

  if (/\b(course|courses|program|programs|programme|programmes|branch|branches)\b/.test(t)) {
    return 'courses'
  }

  if (/\b(fee|fees|tuition|scholarship|scholarships|hostel|hostel fee|hostel fees|cost|amount)\b/.test(t)) {
    return 'fees'
  }

  if (/\b(office|address|location|contact|phone|administration)\b/.test(t)) {
    return 'office'
  }

  if (/\b(placement|placements|package|salary|companies|offers)\b/.test(t)) {
    return 'placements'
  }

  if (/\b(facilities|campus|sports|clubs|library|labs|hostels)\b/.test(t)) {
    return 'facilities'
  }

  if (/\b(other|others|custom|question|help)\b/.test(t)) {
    return 'others'
  }

  return null
}

// Use this only after a university is already selected and we are asking menu.
function detectMenuSelection(text: string): MenuKey | null {
  const t = cleanText(text)
  if (t === '1') return 'courses'
  if (t === '2') return 'fees'
  if (t === '3') return 'office'
  if (t === '4') return 'others'
  return detectMenu(text)
}

function getInteractiveText(message: WhatsAppMessage): string | null {
  return (
    message.interactive?.button_reply?.id ||
    message.interactive?.button_reply?.title ||
    message.interactive?.list_reply?.id ||
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
    const parts = cleaned.split(/,|\n/).map((p) => p.trim()).filter(Boolean)
    if (parts.length >= 2) {
      name = parts[0]
      location = parts[1]
    }
  }

  if (!name) name = 'Student'
  return { name, location }
}

function getGreetingMessage() {
  return `👋 Welcome to KB EDU Tech — Admissions Support

We’ll help you with:
• Courses
• Fees & scholarships
• Hostel details
• Placements
• Admission guidance

Please share your details:

Name:
Location:`
}

function getUniversitySelectionMessage(name?: string) {
  return `Thank you${name ? `, ${name}` : ''} 😊

Please choose the university you’re interested in:

1️⃣ Chettinad Academy of Research and Education
2️⃣ Kalasalingam Academy of Research and Education

Reply with 1 or 2.`
}

function getMenuMessage(university: UniversityKey) {
  return `✅ You’re exploring ${UNIVERSITY_LABELS[university]}.

What would you like to know?

1️⃣ Courses
2️⃣ Fees / Scholarships / Hostel
3️⃣ Office / Contact
4️⃣ Ask your own question

You can also type directly, like:
“Kalasalingam fees” or “Chettinad courses”.`
}

function getShortMenuHint(university: UniversityKey) {
  return `Need more help with ${UNIVERSITY_LABELS[university]}?

Reply:
1 Courses | 2 Fees | 3 Office | 4 Ask Question`
}

function getStaticAnswer(university: UniversityKey, menu: Exclude<MenuKey, 'others'>) {
  if (university === 'kalasalingam') {
    if (menu === 'courses') {
      return `🎓 Kalasalingam offers:

B.Tech:
• CSE: AI & ML, Cyber Security, Data Science / Big Data, IoT
• AI & Data Science
• CSE Work Integrated: Software Product Engineering
• IT: Game Development, Blockchain Technology
• ECE, Mechanical, Biomedical
• Aeronautical, Biotechnology, Food Technology, Civil, EEE
• B.Arch

Other:
• B.Sc Agriculture, Horticulture, Forensic Science, Nursing
• M.Tech, M.Arch, MBA, MCA, M.Sc, Ph.D

Admission help: 9676232325`
    }

    if (menu === 'fees') {
      return `💰 Kalasalingam Fees & Scholarships:

Tuition:
• CSE / IT: ₹1,95,000 per year
• ECE / Bio-Technology: ₹1,60,000 per year
• Aeronautical, Agriculture, Mechanical, Mechatronics, Civil, Chemical, EEE, Bio Medical, Food Tech, B.Arch: ₹1,00,000 per year

Scholarship for CSE/IT:
• JEE 1–50,000: 100% scholarship, pay ₹0
• JEE 50,001–1,00,000: pay ₹58,500
• JEE 1,00,001–2,00,000: pay ₹1,17,000
• PCM above 90%: pay ₹1,56,000
• PCM 80–89.99%: pay ₹1,75,500

Hostel: ₹80,000 to ₹1,50,000 per year.

Counselor: 9676232325`
    }

    if (menu === 'placements') {
      return `📈 Kalasalingam Placements:

• Highest package: 58 LPA
• Average package: 6 LPA
• Minimum package: 4.25 LPA
• 350+ companies
• 2800+ placement offers
• 2100+ internship offers

Top partners include Amazon, Google, Cisco, TCS, Infosys, Wipro, Accenture, Capgemini, Deloitte, Cognizant, HCL, PwC, Hyundai and more.`
    }

    if (menu === 'facilities') {
      return `🏫 Kalasalingam Campus Facilities:

• 550-acre eco-friendly green campus
• Centralized A/C E-Library
• 145 research labs
• 24x7 medical college & hospital on campus
• Olympic standard swimming pool
• Indoor stadium, gym & yoga center
• 14+ sports grounds
• NCC, NSS, Rajasthan Royals partner
• 30+ student clubs

Admission help: 9676232325`
    }

    return `📍 Kalasalingam Admission Information Office:

Balaji Commercial Complex,
Bhagya Nagar Colony,
Kukatpally, Hyderabad

📞 Phone: 9676232325`
  }

  if (menu === 'courses') {
    return `🎓 Chettinad offers:

• Medicine: MBBS, MD, MS, DM, MCh
• Allied Health Sciences: BSc, MSc
• Nursing: BSc Nursing, MSc Nursing, PB BSc Nursing
• Architecture: B.Arch, M.Arch
• Pharmacy: B.Pharm, M.Pharm, Pharm.D
• Physiotherapy: BPT, MPT
• Occupational Therapy: BOT
• Law: BA LLB, BBA LLB, LLM

Admissions 2026–2027 are open.

Admission help: 9676232325`
  }

  if (menu === 'fees') {
    return `💰 Chettinad Fees:

No worries 😊 Our KB EDU Tech counselor will contact you and share the correct/latest details.

Programs include Medicine, Allied Health Sciences, Nursing, Architecture, Pharmacy, Physiotherapy, Occupational Therapy, and Law.

For exact latest Chettinad fees, eligibility, and admission process, please contact KB EDU Tech counselor:

📞 9676232325

Apply online: admission.care.edu.in`
  }

  if (menu === 'placements') {
    return `📌 Chettinad is known for medical education, research, and multi-disciplinary academic programs.

The attached knowledge document does not include exact placement package figures for Chettinad.

For course-wise career guidance, please contact KB EDU Tech counselor:
📞 9676232325`
  }

  if (menu === 'facilities') {
    return `🏫 Chettinad Campus:

• 33.5-acre green campus
• Located at Kelambakkam, OMR, Chennai
• Known for world-class medical education and research
• Main campus plus Manamai, KGF, Karur, and Kanadukathan campuses

Website: www.care.edu.in
Apply: admission.care.edu.in`
  }

  return `📍 Chettinad Main Campus:

Chettinad Health City,
Rajiv Gandhi Salai OMR,
Kelambakkam - 603103,
Chengalpattu District,
Chennai, Tamil Nadu

📞 Chettinad Enquiry: +91 844 789 2022
🌐 www.care.edu.in

KB EDU Tech Hyderabad support:
📞 9676232325`
}

function getOthersPrompt(university?: UniversityKey) {
  return `Sure 😊 Please type your specific question${university ? ` about ${UNIVERSITY_LABELS[university]}` : ''}.

Example: placements, eligibility, hostel, scholarship, admission process.`
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

  if (error) console.error('[Bot] Error inserting bot message:', error)

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


async function getOrCreateCustomField(params: {
  accountId: string
  userId: string
  fieldName: string
  fieldType?: string
  fieldOptions?: unknown
}): Promise<string | null> {
  const { accountId, userId, fieldName, fieldType = 'text', fieldOptions = null } = params

  const { data: existing, error: findError } = await supabaseAdmin()
    .from('custom_fields')
    .select('id')
    .eq('account_id', accountId)
    .eq('field_name', fieldName)
    .maybeSingle()

  if (findError) {
    console.error('[CRM] Error finding custom field:', fieldName, findError)
    return null
  }

  if (existing?.id) return existing.id

  const { data: created, error: createError } = await supabaseAdmin()
    .from('custom_fields')
    .insert({
      account_id: accountId,
      user_id: userId,
      field_name: fieldName,
      field_type: fieldType,
      field_options: fieldOptions,
    })
    .select('id')
    .single()

  if (createError) {
    console.error('[CRM] Error creating custom field:', fieldName, createError)
    return null
  }

  return created.id
}

async function setContactCustomValue(params: {
  accountId: string
  userId: string
  contactId: string
  fieldName: string
  value: string
  fieldType?: string
  fieldOptions?: unknown
}) {
  const { accountId, userId, contactId, fieldName, value, fieldType, fieldOptions } = params

  if (!value) return

  const fieldId = await getOrCreateCustomField({
    accountId,
    userId,
    fieldName,
    fieldType,
    fieldOptions,
  })

  if (!fieldId) return

  const { error } = await supabaseAdmin()
    .from('contact_custom_values')
    .upsert(
      {
        contact_id: contactId,
        custom_field_id: fieldId,
        value,
      },
      { onConflict: 'contact_id,custom_field_id' }
    )

  if (error) {
    console.error('[CRM] Error setting custom value:', fieldName, error)
  }
}

async function addContactTag(params: {
  accountId: string
  userId: string
  contactId: string
  tagName: string
  color?: string
}) {
  const { accountId, userId, contactId, tagName, color = '#7c3aed' } = params

  let tagId: string | null = null

  const { data: existing, error: findError } = await supabaseAdmin()
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', tagName)
    .maybeSingle()

  if (findError) {
    console.error('[CRM] Error finding tag:', tagName, findError)
    return
  }

  if (existing?.id) {
    tagId = existing.id
  } else {
    const { data: created, error: createError } = await supabaseAdmin()
      .from('tags')
      .insert({
        account_id: accountId,
        user_id: userId,
        name: tagName,
        color,
      })
      .select('id')
      .single()

    if (createError) {
      console.error('[CRM] Error creating tag:', tagName, createError)
      return
    }

    tagId = created.id
  }

  if (!tagId) return

  const { error: linkError } = await supabaseAdmin()
    .from('contact_tags')
    .upsert(
      {
        contact_id: contactId,
        tag_id: tagId,
      },
      { onConflict: 'contact_id,tag_id' }
    )

  if (linkError) {
    console.error('[CRM] Error applying tag:', tagName, linkError)
  }
}

function universityToCrmValue(university?: UniversityKey): string | null {
  if (!university) return null
  return UNIVERSITY_LABELS[university]
}

function menuToAskedAbout(menu: MenuKey): string {
  if (menu === 'fees') return 'Fees / Scholarship / Hostel'
  if (menu === 'courses') return 'Courses'
  if (menu === 'office') return 'Office / Contact'
  if (menu === 'placements') return 'Placements'
  if (menu === 'facilities') return 'Facilities'
  return 'Custom Question'
}

function menuToLeadStatus(menu: MenuKey): string {
  if (menu === 'fees') return 'Fees Shared'
  if (menu === 'courses') return 'Courses Shared'
  if (menu === 'office') return 'Counselor Follow-up Needed'
  if (menu === 'placements') return 'Hot Lead'
  if (menu === 'facilities') return 'Details Shared'
  return 'Counselor Follow-up Needed'
}

function buildLeadTags(university: UniversityKey, menu?: MenuKey): string[] {
  const tags = [university === 'kalasalingam' ? 'Kalasalingam Lead' : 'Chettinad Lead']

  if (!menu) return tags

  if (menu === 'courses') tags.push('Courses Asked')
  if (menu === 'fees') tags.push('Fees Asked', 'Scholarship Asked', 'Follow-up Required')
  if (menu === 'office') tags.push('Office / Contact Asked', 'Hot Lead', 'Follow-up Required')
  if (menu === 'placements') tags.push('Placements Asked', 'Hot Lead', 'Follow-up Required')
  if (menu === 'facilities') tags.push('Facilities Asked')
  if (menu === 'others') tags.push('Custom Question', 'Follow-up Required')

  return tags
}

function calculateLeadScore(params: {
  selectedUniversity?: UniversityKey
  askedAbout?: string
  leadStatus?: string
  followUpRequired?: boolean
}): string {
  let score = 10

  if (params.selectedUniversity) score += 20
  if (params.askedAbout?.includes('Courses')) score += 10
  if (params.askedAbout?.includes('Fees')) score += 25
  if (params.askedAbout?.includes('Scholarship')) score += 25
  if (params.askedAbout?.includes('Office')) score += 35
  if (params.askedAbout?.includes('Placements')) score += 30
  if (params.askedAbout?.includes('Custom')) score += 25
  if (params.leadStatus === 'Hot Lead') score += 20
  if (params.followUpRequired) score += 15

  return String(Math.min(score, 100))
}

async function updateContactCrm(params: {
  accountId: string
  userId: string
  contactId: string
  name?: string
  location?: string
  selectedUniversity?: UniversityKey
  askedAbout?: string
  leadStatus?: string
  tags?: string[]
  followUpRequired?: boolean
}) {
  const {
    accountId,
    userId,
    contactId,
    name,
    location,
    selectedUniversity,
    askedAbout,
    leadStatus,
    tags = [],
    followUpRequired,
  } = params

  if (name) {
    const { error } = await supabaseAdmin()
      .from('contacts')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', contactId)

    if (error) console.error('[CRM] Error updating contact name:', error)
  }

  await setContactCustomValue({
    accountId,
    userId,
    contactId,
    fieldName: 'Source',
    value: 'WhatsApp Bot',
    fieldType: 'dropdown',
    fieldOptions: ['WhatsApp Bot', 'Manual Entry', 'Broadcast', 'Referral', 'Website', 'Instagram', 'Facebook'],
  })

  if (location) {
    await setContactCustomValue({ accountId, userId, contactId, fieldName: 'Location', value: location })
  }

  const universityValue = universityToCrmValue(selectedUniversity)
  if (universityValue) {
    await setContactCustomValue({
      accountId,
      userId,
      contactId,
      fieldName: 'Interested University',
      value: universityValue,
      fieldType: 'dropdown',
      fieldOptions: [
        'Chettinad Academy of Research and Education',
        'Kalasalingam Academy of Research and Education',
        'Not selected yet',
      ],
    })
  }

  if (askedAbout) {
    await setContactCustomValue({
      accountId,
      userId,
      contactId,
      fieldName: 'Asked About',
      value: askedAbout,
      fieldType: 'dropdown',
      fieldOptions: [
        'Courses',
        'Fees / Scholarship / Hostel',
        'Office / Contact',
        'Placements',
        'Facilities',
        'Admission Process',
        'Custom Question',
      ],
    })
  }

  if (leadStatus) {
    await setContactCustomValue({
      accountId,
      userId,
      contactId,
      fieldName: 'Lead Status',
      value: leadStatus,
      fieldType: 'dropdown',
      fieldOptions: [
        'New Lead',
        'Details Collected',
        'University Selected',
        'Courses Shared',
        'Fees Shared',
        'Scholarship Asked',
        'Counselor Follow-up Needed',
        'Hot Lead',
        'Application Started',
        'Admission Confirmed',
        'Not Interested',
        'Details Shared',
        'University Selection Needed',
      ],
    })
  }

  const leadScore = calculateLeadScore({
    selectedUniversity,
    askedAbout,
    leadStatus,
    followUpRequired,
  })

  await setContactCustomValue({
    accountId,
    userId,
    contactId,
    fieldName: 'Lead Score',
    value: leadScore,
    fieldType: 'number',
  })

  if (askedAbout || leadStatus) {
    await setContactCustomValue({
      accountId,
      userId,
      contactId,
      fieldName: 'Last Bot Action',
      value: [askedAbout, leadStatus].filter(Boolean).join(' • '),
      fieldType: 'text',
    })
  }

  if (followUpRequired || leadStatus === 'Hot Lead' || leadStatus === 'Counselor Follow-up Needed') {
    await setContactCustomValue({
      accountId,
      userId,
      contactId,
      fieldName: 'Follow-up Priority',
      value: leadStatus === 'Hot Lead' ? 'High' : 'Medium',
      fieldType: 'dropdown',
      fieldOptions: ['Low', 'Medium', 'High'],
    })
  }

  if (followUpRequired) {
    const followUpDate = new Date(Date.now() + 24 * 60 * 60 * 1000)
    await setContactCustomValue({
      accountId,
      userId,
      contactId,
      fieldName: 'Follow-up Date',
      value: followUpDate.toISOString().slice(0, 10),
      fieldType: 'date',
    })
  }

  for (const tag of tags) {
    await addContactTag({ accountId, userId, contactId, tagName: tag })
  }
}

async function handleHybridBotFlow(params: {
  message: WhatsAppMessage
  conversationId: string
  contactId: string
  accountId: string
  userId: string
  phoneNumberId: string
  accessToken: string
  senderPhone: string
  inboundText: string
  interactiveText: string | null
}) {
  const {
    message,
    conversationId,
    contactId,
    accountId,
    userId,
    phoneNumberId,
    accessToken,
    senderPhone,
    inboundText,
    interactiveText,
  } = params

  const sendBotText = async (text: string) => {
    return sendAndStoreAgentMessage({
      conversationId,
      phoneNumberId,
      accessToken,
      to: message.from,
      text,
    })
  }

  const currentState = botStateMemory[senderPhone]
  const userText = interactiveText || inboundText
  const mentionedUniversity = detectUniversity(userText)
  const keywordMenu = detectMenu(userText)

  // Strong fee/scholarship/hostel guard:
  // If user asks fees/scholarship/hostel, answer ONLY for:
  // 1) the university explicitly mentioned in the same message, OR
  // 2) the currently selected university.
  // If no university context is available, ask the user to select one first.
  if (keywordMenu === 'fees' && !isPureNumberChoice(userText)) {
    const feeUniversity = mentionedUniversity || currentState?.selectedUniversity

    if (!feeUniversity) {
      botStateMemory[senderPhone] = {
        ...(currentState || { stage: 'waiting_for_university' as BotStage }),
        stage: 'waiting_for_university',
      }

      await updateContactCrm({
        accountId,
        userId,
        contactId,
        askedAbout: 'Fees / Scholarship / Hostel',
        leadStatus: 'University Selection Needed',
        tags: ['Fees Asked'],
      })

      await sendBotText(
        `Sure 😊 Please select the university for fee/scholarship/hostel details:\n\n1️⃣ Chettinad Academy of Research and Education\n2️⃣ Kalasalingam Academy of Research and Education\n\nReply with 1 or 2.`
      )
      return
    }

    botStateMemory[senderPhone] = {
      ...(currentState || { stage: 'waiting_for_menu_choice' as BotStage }),
      stage: 'waiting_for_menu_choice',
      selectedUniversity: feeUniversity,
    }

    await updateContactCrm({
      accountId,
      userId,
      contactId,
      selectedUniversity: feeUniversity,
      askedAbout: 'Fees / Scholarship / Hostel',
      leadStatus: 'Fees Shared',
      tags: [feeUniversity === 'kalasalingam' ? 'Kalasalingam Lead' : 'Chettinad Lead', 'Fees Asked', 'Scholarship Asked'],
    })

    await sendBotText(getStaticAnswer(feeUniversity, 'fees'))
    await sendBotText(getShortMenuHint(feeUniversity))
    return
  }

  // Direct shortcut: user types "Kalasalingam fees", "Chettinad courses", etc.
  // This shortcut intentionally ignores pure number choices to avoid confusion.
  if (mentionedUniversity && keywordMenu && keywordMenu !== 'others') {
    botStateMemory[senderPhone] = {
      ...(currentState || { stage: 'waiting_for_menu_choice' as BotStage }),
      stage: 'waiting_for_menu_choice',
      selectedUniversity: mentionedUniversity,
    }

    await updateContactCrm({
      accountId,
      userId,
      contactId,
      selectedUniversity: mentionedUniversity,
      askedAbout: menuToAskedAbout(keywordMenu),
      leadStatus: menuToLeadStatus(keywordMenu),
      tags: buildLeadTags(mentionedUniversity, keywordMenu),
    })

    await sendBotText(getStaticAnswer(mentionedUniversity, keywordMenu))
    await sendBotText(getShortMenuHint(mentionedUniversity))
    return
  }

  // Existing selected university + direct menu keyword: "scholarship", "hostel", "courses".
  // Do not handle pure number choices here before state checks.
  if (currentState?.selectedUniversity && keywordMenu && keywordMenu !== 'others' && !isPureNumberChoice(userText)) {
    botStateMemory[senderPhone] = {
      ...currentState,
      stage: 'waiting_for_menu_choice',
    }

    await updateContactCrm({
      accountId,
      userId,
      contactId,
      selectedUniversity: currentState.selectedUniversity,
      askedAbout: menuToAskedAbout(keywordMenu),
      leadStatus: menuToLeadStatus(keywordMenu),
      tags: buildLeadTags(currentState.selectedUniversity, keywordMenu),
    })

    await sendBotText(getStaticAnswer(currentState.selectedUniversity, keywordMenu))
    await sendBotText(getShortMenuHint(currentState.selectedUniversity))
    return
  }

  if (!currentState) {
    botStateMemory[senderPhone] = { stage: 'waiting_for_name_location' }
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

    await updateContactCrm({
      accountId,
      userId,
      contactId,
      name: details.name,
      location: details.location,
      leadStatus: 'Details Collected',
      tags: ['New WhatsApp Lead'],
    })

    await sendBotText(getUniversitySelectionMessage(details.name))
    return
  }

  if (currentState.stage === 'waiting_for_university') {
    const university = detectUniversitySelection(userText)

    if (!university) {
      await sendBotText(getUniversitySelectionMessage(currentState.name))
      return
    }

    botStateMemory[senderPhone] = {
      ...currentState,
      stage: 'waiting_for_menu_choice',
      selectedUniversity: university,
    }

    await updateContactCrm({
      accountId,
      userId,
      contactId,
      selectedUniversity: university,
      leadStatus: 'University Selected',
      tags: [university === 'kalasalingam' ? 'Kalasalingam Lead' : 'Chettinad Lead'],
    })

    await sendBotText(getMenuMessage(university))
    return
  }

  if (currentState.stage === 'waiting_for_menu_choice') {
    const requestedMenu = detectMenuSelection(userText)
    const selectedUniversity = mentionedUniversity || currentState.selectedUniversity

    if (!selectedUniversity) {
      botStateMemory[senderPhone] = { ...currentState, stage: 'waiting_for_university' }
      await sendBotText(getUniversitySelectionMessage(currentState.name))
      return
    }

    if (mentionedUniversity && mentionedUniversity !== currentState.selectedUniversity) {
      botStateMemory[senderPhone] = {
        ...currentState,
        selectedUniversity: mentionedUniversity,
        stage: 'waiting_for_menu_choice',
      }
    }

    if (!requestedMenu) {
      if (mentionedUniversity) {
        await updateContactCrm({
          accountId,
          userId,
          contactId,
          selectedUniversity: mentionedUniversity,
          leadStatus: 'University Selected',
          tags: buildLeadTags(mentionedUniversity),
        })

        await sendBotText(`Sure 😊 Switched to ${UNIVERSITY_LABELS[mentionedUniversity]}.\n\n${getShortMenuHint(mentionedUniversity)}`)
        return
      }

      await sendBotText(getShortMenuHint(selectedUniversity))
      return
    }

    if (requestedMenu === 'others') {
      botStateMemory[senderPhone] = {
        ...currentState,
        selectedUniversity,
        stage: 'waiting_for_custom_question',
      }

      await updateContactCrm({
        accountId,
        userId,
        contactId,
        selectedUniversity,
        askedAbout: 'Custom Question',
        leadStatus: 'Counselor Follow-up Needed',
        tags: buildLeadTags(selectedUniversity, 'others'),
        followUpRequired: true,
      })

      await sendBotText(getOthersPrompt(selectedUniversity))
      return
    }

    await updateContactCrm({
      accountId,
      userId,
      contactId,
      selectedUniversity,
      askedAbout: menuToAskedAbout(requestedMenu),
      leadStatus: menuToLeadStatus(requestedMenu),
      tags: buildLeadTags(selectedUniversity, requestedMenu),
    })

    await sendBotText(getStaticAnswer(selectedUniversity, requestedMenu))
    await sendBotText(getShortMenuHint(selectedUniversity))
    return
  }

  if (currentState.stage === 'waiting_for_custom_question') {
    // Before using OpenAI, still catch simple keywords to reduce cost.
    const requestedMenu = detectMenuSelection(userText)
    const universityForQuestion = mentionedUniversity || currentState.selectedUniversity

    if (universityForQuestion && requestedMenu && requestedMenu !== 'others') {
      botStateMemory[senderPhone] = {
        ...currentState,
        selectedUniversity: universityForQuestion,
        stage: 'waiting_for_menu_choice',
      }

      await updateContactCrm({
        accountId,
        userId,
        contactId,
        selectedUniversity: universityForQuestion,
        askedAbout: menuToAskedAbout(requestedMenu),
        leadStatus: menuToLeadStatus(requestedMenu),
        tags: buildLeadTags(universityForQuestion, requestedMenu),
      })

      await sendBotText(getStaticAnswer(universityForQuestion, requestedMenu))
      await sendBotText(getShortMenuHint(universityForQuestion))
      return
    }

    await updateContactCrm({
      accountId,
      userId,
      contactId,
      selectedUniversity: universityForQuestion || currentState.selectedUniversity,
      askedAbout: 'Custom Question',
      leadStatus: 'Counselor Follow-up Needed',
      tags: ['Custom Question', 'Follow-up Required'],
      followUpRequired: true,
    })

    const aiReply = await getAIReply(inboundText, senderPhone, {
      selectedUniversity: universityForQuestion ? UNIVERSITY_LABELS[universityForQuestion] : undefined,
      name: currentState.name,
      location: currentState.location,
    })

    if (!aiReply) {
      await sendBotText(`Sorry, I could not process that right now. Please contact KB EDU Tech counselor at 9676232325.`)
    } else {
      await sendBotText(aiReply)
    }

    botStateMemory[senderPhone] = {
      ...currentState,
      stage: 'waiting_for_menu_choice',
      selectedUniversity: universityForQuestion || currentState.selectedUniversity,
    }

    if (universityForQuestion) {
      await sendBotText(getShortMenuHint(universityForQuestion))
    } else {
      await sendBotText(getUniversitySelectionMessage(currentState.name))
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
      return NextResponse.json({ error: 'Missing verification parameters' }, { status: 400 })
    }

    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token')

    if (configError || !configs) {
      console.error('[webhook] Error fetching configs for verification:', configError)
      return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
    }

    let matchedConfig: any = null

    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config
          break
        }
      } catch {}
    }

    if (matchedConfig) {
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn('[webhook] verify_token GCM upgrade failed:', (error as { message?: string })?.message ?? error)
            }
          })
      }

      return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
    }

    return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 })
  } catch (error) {
    console.error('[webhook] Error in GET verification:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
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

  processWebhook(body).catch((error) => console.error('[webhook] Error processing webhook:', error))

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange({ field: change.field, value: change.value as unknown }, supabaseAdmin())
        continue
      }

      const value = change.value

      if (value.statuses?.length) {
        for (const status of value.statuses) await handleStatusUpdate(status)
      }

      if (!value.messages || !value.contacts) continue

      const phoneNumberId = value.metadata.phone_number_id

      const { data: configRows, error: configError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('*')
        .eq('phone_number_id', phoneNumberId)

      if (configError) {
        console.error('[webhook] Error fetching whatsapp_config for phone_number_id:', phoneNumberId, configError)
        continue
      }

      if (!configRows || configRows.length === 0) {
        console.error('[webhook] No config found for phone_number_id:', phoneNumberId)
        continue
      }

      if (configRows.length > 1) {
        console.error(`[webhook] Multiple configs (${configRows.length}) found for phone_number_id:`, phoneNumberId)
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

const RECIPIENT_STATUS_LADDER = ['pending', 'sent', 'delivered', 'read', 'replied'] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') return current === 'pending' || current === 'sent'
  if (current === 'failed') return false
  const currentIndex = ladderLevel(current)
  const incomingIndex = ladderLevel(incoming)
  if (incomingIndex < 0) return false
  if (currentIndex < 0) return true
  return incomingIndex > currentIndex
}

async function handleStatusUpdate(status: WhatsAppStatus) {
  console.log('[WhatsApp Status Received]', JSON.stringify(status, null, 2))

  if (status.status === 'failed') {
    console.error('[WhatsApp Delivery Failed]', { wamid: status.id, recipient: status.recipient_id, errors: status.errors })
  }

  const { data: updatedMessages, error: msgErr } = await supabaseAdmin()
    .from('messages')
    .update({ status: status.status })
    .eq('message_id', status.id)
    .select('id, message_id, status')

  if (msgErr) console.error('[WhatsApp Status] Error updating message status:', msgErr)
  else if (!updatedMessages || updatedMessages.length === 0) console.warn('[WhatsApp Status] No matching message row found for wamid:', status.id)
  else console.log('[WhatsApp Status] Updated message rows:', updatedMessages)

  const timestampNumber = parseInt(status.timestamp, 10)
  const tsIso = Number.isFinite(timestampNumber) ? new Date(timestampNumber * 1000).toISOString() : new Date().toISOString()

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
  if (!isValidStatusTransition(recipient.status, status.status)) return

  const update: Record<string, unknown> = { status: status.status }
  if (status.status === 'sent') update.sent_at = tsIso
  if (status.status === 'delivered') update.delivered_at = tsIso
  if (status.status === 'read') update.read_at = tsIso

  const { error: recUpdateErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .update(update)
    .eq('id', recipient.id)

  if (recUpdateErr) console.error('[WhatsApp Status] Error updating broadcast recipient status:', recUpdateErr)
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
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) console.error('[webhook] Error marking broadcast recipient replied:', updErr)
  } catch (err) {
    console.error('[webhook] flagBroadcastReplyIfAny failed:', err)
  }
}

async function lookupInternalIdByMetaId(metaId: string, conversationId: string): Promise<string | null> {
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

async function handleReaction(message: WhatsAppMessage, conversationId: string, contactId: string) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(reaction.message_id, conversationId)

  if (!targetInternalId) {
    console.warn('[webhook] reaction target message not found; skipping', reaction.message_id)
    return
  }

  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)

    if (delError) console.error('[webhook] reaction delete failed:', delError.message)
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

  if (upsertError) console.error('[webhook] reaction upsert failed:', upsertError.message)
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

  const contactOutcome = await findOrCreateContact(accountId, configOwnerUserId, senderPhone, contactName)
  if (!contactOutcome) return

  const contactRecord = contactOutcome.contact

  const conversation = await findOrCreateConversation(accountId, configOwnerUserId, contactRecord.id)
  if (!conversation) return

  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
    return
  }

  const { contentText, mediaUrl, mediaType, interactiveReplyId } = await parseMessageContent(message, accessToken)

  let replyToInternalId: string | null = null
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(message.context.id, conversation.id)
    if (!replyToInternalId) console.warn('[webhook] reply context parent not found:', message.context.id)
  }

  void mediaType

  const ALLOWED_CONTENT_TYPES = new Set(['text', 'image', 'document', 'audio', 'video', 'location', 'template', 'interactive'])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type) ? message.type : message.type === 'sticker' ? 'image' : 'text'

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

  if (convError) console.error('[webhook] Error updating conversation:', convError)

  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? { kind: 'interactive_reply', reply_id: interactiveReplyId, reply_title: contentText ?? '', meta_message_id: message.id }
      : { kind: 'text', text: contentText ?? message.text?.body ?? '', meta_message_id: message.id },
    isFirstInboundMessage,
  })

  const flowConsumed = flowResult.consumed
  const inboundText = contentText ?? message.text?.body ?? ''
  const interactiveText = getInteractiveText(message)

  const automationTriggers: ('new_contact_created' | 'first_inbound_message' | 'new_message_received' | 'keyword_match')[] = []

  if (!flowConsumed) automationTriggers.push('new_message_received', 'keyword_match')
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')

  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: { message_text: inboundText, conversation_id: conversation.id },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  if (!flowConsumed && (message.type === 'text' || message.type === 'interactive')) {
    handleHybridBotFlow({
      message,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      accountId,
      userId: configOwnerUserId,
      phoneNumberId,
      accessToken,
      senderPhone,
      inboundText,
      interactiveText,
    }).catch((err) => console.error('[Hybrid Bot] Error:', err))
  }
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string
): Promise<{ contentText: string | null; mediaUrl: string | null; mediaType: string | null; interactiveReplyId: string | null }> {
  const verifyAndBuildUrl = async (mediaId: string): Promise<string | null> => {
    try {
      await getMediaUrl({ mediaId, accessToken })
      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(`[webhook] Failed to verify media ${mediaId} with Meta:`, error instanceof Error ? error.message : error)
      return null
    }
  }

  const empty = { contentText: null, mediaUrl: null, mediaType: null, interactiveReplyId: null }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) return { ...empty, contentText: message.image.caption || null, mediaUrl: await verifyAndBuildUrl(message.image.id), mediaType: message.image.mime_type }
      return empty

    case 'video':
      if (message.video?.id) return { ...empty, contentText: message.video.caption || null, mediaUrl: await verifyAndBuildUrl(message.video.id), mediaType: message.video.mime_type }
      return empty

    case 'document':
      if (message.document?.id) return { ...empty, contentText: message.document.caption || message.document.filename || null, mediaUrl: await verifyAndBuildUrl(message.document.id), mediaType: message.document.mime_type }
      return empty

    case 'audio':
      if (message.audio?.id) return { ...empty, mediaUrl: await verifyAndBuildUrl(message.audio.id), mediaType: message.audio.mime_type }
      return empty

    case 'sticker':
      if (message.sticker?.id) return { ...empty, mediaUrl: await verifyAndBuildUrl(message.sticker.id), mediaType: message.sticker.mime_type }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        return { ...empty, contentText: [loc.name, loc.address, `${loc.latitude},${loc.longitude}`].filter(Boolean).join(' - ') }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      const reply = message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) return { ...empty, contentText: reply.title || reply.id, interactiveReplyId: reply.id }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    default:
      return { ...empty, contentText: `[Unsupported message type: ${message.type}]` }
  }
}

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
  const existingContact = await findExistingContact(supabaseAdmin(), accountId, phone)

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
    .insert({ account_id: accountId, user_id: configOwnerUserId, phone, name: name || phone })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }

    console.error('[webhook] Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(accountId: string, configOwnerUserId: string, contactId: string) {
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .single()

  if (!findError && existing) return existing

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({ account_id: accountId, user_id: configOwnerUserId, contact_id: contactId })
    .select()
    .single()

  if (createError) {
    console.error('[webhook] Error creating conversation:', createError)
    return null
  }

  return newConv
}
