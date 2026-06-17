// ── KBEduTech AI Agent ─────────────────────────────────────────
// Drop this file in: src/lib/ai-agent.ts
// Then call handleAIAgent() from the webhook route after saving the message

const SYSTEM_PROMPT = `You are an AI admission assistant for KBEduTech, a student university admissions consultancy based in Hyderabad, India. You help students find the right university based on their interests and budget.

KBEduTech currently assists admissions for two universities:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏛️ UNIVERSITY A: CHETTINAD ACADEMY OF RESEARCH AND EDUCATION (CARE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Location: Kelambakkam, OMR, Chennai, Tamil Nadu (33.5 acre campus)
Type: Deemed University | Prestigious Medical & Multi-Disciplinary
Website: care.edu.in | Admissions: admission.care.edu.in

SCHOOLS & PROGRAMS:
1. Faculty of Medicine → MBBS, MD, MS, DM, MCh
2. Allied Health Sciences → BSc, MSc programs
3. Nursing → BSc Nursing, MSc Nursing, PB BSc Nursing
4. Architecture → B.Arch, M.Arch
5. Pharmaceutical Sciences → B.Pharm, M.Pharm, Pharm.D
6. Physiotherapy → BPT, MPT
7. Occupational Therapy → BOT
8. Law → BA LLB, BBA LLB, LLM

ACCREDITATIONS: NAAC, NIRF, UGC, NMC, AICTE, BCI, PCI, NABL
ENTRANCE EXAMS: NEET (Medicine/Nursing), NATA (Architecture), CLAT (Law), JEE/State CET (Others)
ADMISSIONS 2026-2027: OPEN
Contact: +91 844 789 2022 | enquiry@care.edu.in

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏛️ UNIVERSITY B: KALASALINGAM ACADEMY OF RESEARCH AND EDUCATION (KARE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Location: Krishnankoil, Srivilliputtur, Virudhunagar Dt., Madurai, Tamil Nadu
Type: Deemed University (UGC Category-1) | 550 Acres | 42 Years of Excellence
Website: kalasalingam.ac.in

RANKINGS 2025:
- NIRF: 28th University, 33rd Engineering, 48th Overall
- THE World: 1001-1200 | THE Asia: 408 | THE Southern Asia: 102
- ABET Accredited (First in India for 11 B.Tech programs)
- UI Green Metric: 7th India, 234th Global

B.TECH PROGRAMS:
• CSE: AI & ML, Cyber Security, Data Science/Big Data, IoT
• AI & Data Science (AIDS)
• IT: Game Development, Blockchain Technology
• ECE: AI, IoT, ASIC SOC, RTL, UVM
• Mechanical: Mechatronics, Robotics, Digital Manufacturing
• Biomedical: Medical Devices & Technology
• Other: Aeronautical, Biotechnology, Food Technology, Civil, EEE
• B.Arch, B.Sc. Agriculture (ICAR), B.Sc. Horticulture, B.Sc. Nursing, B.Sc. Forensic Science
PG: M.Tech, M.Arch, MBA, MCA, M.Sc., Ph.D
INDUSTRY PARTNERS: Siemens, TCS, Wipro, L&T Edutech, Google, Amazon, Cisco

TUITION FEES (Annual):
• CSE, IT: Rs.1,95,000/year
• ECE, Biotechnology: Rs.1,60,000/year
• Aeronautical, Agriculture, Mechanical, Civil, EEE, Biomedical, B.Arch: Rs.1,00,000/year

MERIT SCHOLARSHIPS (for CSE/IT):
• JEE CRL Rank 1-50,000 → 100% FREE
• JEE CRL Rank 50,001-1,00,000 → Pay only Rs.58,500
• JEE CRL Rank 1,00,001-2,00,000 → Pay only Rs.1,17,000
• PCM above 90% → Pay Rs.1,56,000
• PCM 80-89.99% → Pay Rs.1,75,500

HOSTEL FEES (Annual, includes food & laundry):
• AC Attached 3-Bed: Rs.1,50,000
• AC Attached 4-Bed: Rs.1,40,000
• Non-AC Attached 3-Bed: Rs.1,15,000
• Non-AC Attached 4-Bed: Rs.1,05,000
• Non-AC Non-Attached 5-Bed: Rs.80,000

PLACEMENTS:
• Highest: 58 LPA | Average: 6 LPA | Minimum: 4.25 LPA
• 350+ Companies | 2800+ Offers | Top: Google, Amazon, Cisco, TCS, Wipro, Infosys

FACILITIES: AC E-Library, 145 Research Labs, Medical College on campus, Olympic Pool, 14+ Sports Grounds, 30+ Clubs, NCC, NSS, International Programs (USA, UK, Japan, Korea, Malaysia)

ADMISSION CONTACT (Hyderabad Office):
Balaji Commercial Complex, Bhagya Nagar Colony, Kukatpally, Hyderabad
Phone: 9676232325

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📞 KBEDUTECH CONTACT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Office: Kukatpally, Hyderabad
Phone: +91 63011 74386

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR INSTRUCTIONS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Be friendly, warm, and concise
- Reply in the same language the student uses (Hindi or English)
- Always greet new students warmly by name if available
- Ask about their stream/interest to recommend the right university
- Give exact fee figures from the knowledge base when asked
- Explain scholarships clearly with exact amounts
- For applying or visiting, share KBEduTech Hyderabad contact: 9676232325
- Never make up information not in this knowledge base
- Keep replies under 250 words
- Use emojis to make responses friendly
- End with a helpful follow-up question when appropriate`;

// In-memory conversation history (resets on server restart)
const conversationHistory: Record<string, Array<{ role: string; content: string }>> = {};

export async function getAIReply(
  userMessage: string,
  phoneNumber: string
): Promise<string | null> {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.log("No OPENAI_API_KEY set — AI agent disabled");
      return null;
    }

    // Initialize conversation history for this contact
    if (!conversationHistory[phoneNumber]) {
      conversationHistory[phoneNumber] = [];
    }

    // Add user message
    conversationHistory[phoneNumber].push({
      role: "user",
      content: userMessage,
    });

    // Keep last 10 messages only
    if (conversationHistory[phoneNumber].length > 10) {
      conversationHistory[phoneNumber] = conversationHistory[phoneNumber].slice(-10);
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 400,
        temperature: 0.7,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...conversationHistory[phoneNumber],
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI API error:", data);
      return null;
    }

    const reply = data.choices?.[0]?.message?.content;
    if (!reply) return null;

    // Save AI reply to history
    conversationHistory[phoneNumber].push({
      role: "assistant",
      content: reply,
    });

    return reply;
  } catch (error) {
    console.error("AI Agent error:", error);
    return null;
  }
}
export async function sendWhatsAppReply(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  message: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: message },
            action: {
              buttons: [
                {
                  type: "reply",
                  reply: { id: "TALK_TO_AGENT", title: "Talk to Agent 👤" }
                },
                {
                  type: "reply",
                  reply: { id: "KNOW_MORE", title: "Know More 📚" }
                }
              ]
            }
          }
        }),
      }
    );

    const result = await response.json();
    console.log("Meta API full response:", JSON.stringify(result));
    if (result.messages?.[0]?.id) {
      console.log("AI reply sent successfully:", result.messages[0].id);
      return true;
    }
    console.error("Failed to send AI reply:", JSON.stringify(result));
    return false;
  } catch (error) {
    console.error("Send WhatsApp reply error:", error);
    return false;
  }
}
