// The real AI step: transcript + context -> model -> JSON -> validateIntent().
// The model only interprets. It never decides balances, overdue, or approvals.
// It never invents a customer, amount, or item. Unclear -> ambiguity field.
import { validateIntent, emptyIntent } from './schema.js';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

export const SYSTEM_PROMPT = `You convert a shopkeeper's spoken sentence in any language into JSON.
Return ONLY one JSON object. No markdown, no code fences, no explanation.

Fields:
intent: RECORD_CREDIT | RECORD_PAYMENT | CORRECT_ITEM | OPEN_DISPUTE | QUERY_BALANCE | QUERY_OVERDUE | CONFIRM | REJECT | UNKNOWN
customerName: string or null (must be exactly one of the known customers, else null)
amount: integer rupees or null
items: [{name, quantity, totalAmount}] or null
correction: {itemName, newTotalAmount, claimedOldTotal} or null
dueDate: ISO date or null (only if the speaker stated one)
lang: short ISO 639-1 code of the language the speaker used (for example en, hi, es, pt, fr, id, sw, de, ar)
confidence: number 0..1
ambiguity: short string describing anything unclear, else null

Hard rules:
- OPEN_DISPUTE only when the speaker relays that the customer SAYS or CLAIMS a payment was made (for example "X kehta hai usne de diya", "X afirma que ya abonó", "X alega que quitou", "X mengaku sudah membayar", "X anadai kuwa ameshalipa", "X claims he settled up"). amount is the amount the customer claims to have paid, if stated, otherwise null.
- A plain statement that someone paid ("X paid 75", "X ne sattar diye", "X pagó cien", "X membayar lima puluh") is RECORD_PAYMENT with that amount.
- "X owes me N", "put N on X's tab", udhaar, fiado, utang, crédit, deni, "na conta" all mean RECORD_CREDIT, never a query.
- Currency words and symbols are never needed. Ignore them.
- In Swahili, "mia" means hundred, e.g. "mia saba" means 700.
- "nahi, X nahi, Y tha" is CORRECT_ITEM with claimedOldTotal=X and newTotalAmount=Y.
- Bare "haan"/"yes" is CONFIRM, bare "nahi"/"no" is REJECT.
- For CONFIRM and REJECT, every other field must be null.
- Use only this sentence and the "Most recent customer" line. Never fill customerName, amounts or item names from anything else.
- customerName must match a known customer. If the spoken name is only a partial match or could match more than one known customer, set customerName to null and explain in ambiguity.
- If a name, amount or item is unclear, set it to null and explain in ambiguity. Never guess.
- Never compute balances, totals owed, or due dates yourself.
- dueDate only if the speaker states one; otherwise null.

Items rules:
- Items are goods only (rice, oil, sugar). Words meaning record, note, write, credit, debt or tab (anota, apunta, catat, note, likh do, deni) are commands, never items.
- Include items only if each item's price is stated and the prices add up exactly to amount. Otherwise set items to null.
- name: the item as spoken, lowercase, singular, in the speaker's own script. Do not transliterate or translate.
- quantity: a number only if the speaker states one, else null.
- totalAmount: the amount for that item. With a single item it equals amount.
- amount is the total for this sentence. Never add an item price on top of it.
- If no item is named, items is null.
Confidence rules:
- Use 0.9 or above only when intent, customer and amount are all clear.
- Use 0.5 or below when anything is null or ambiguous.

Examples:
- "Anota 230 en la cuenta de Pedro, pan 230" -> RECORD_CREDIT, Pedro, 230, items [{name: "pan", totalAmount: 230}]
- "Nila membayar lima puluh" -> RECORD_PAYMENT, Nila, 50, items null
- "Omar mengaku telah melunasi 80" -> OPEN_DISPUTE, Omar, 80, items null
- "Musa alipe mia saba" -> RECORD_PAYMENT, Musa, 700, items null
- "Sam took 450 of groceries on credit" -> RECORD_CREDIT, Sam, 450, items null`;

export function buildMessages(transcript, { customers = [], lastCustomer = null } = {}) {
    return [
        { role: 'system', content: SYSTEM_PROMPT },
        {
            role: 'user',
            content: `Known customers: ${customers.join(', ') || '(none)'}\nMost recent customer in this conversation: ${lastCustomer ?? '(none)'}\n\nSentence: ${transcript}`,
        },
    ];
}

// Sends one fresh request to Bedrock (no history) and resolves to the model's text.
async function callModel(messages) {
    const systemMsgText = messages.find((m) => m.role === 'system').content;
    const chatMsg = messages.filter((m) => m.role !== 'system');
    const formatted = chatMsg.map((m) => ({
        role: m.role,
        content: [{ text: m.content }],
    }));

    const command = new ConverseCommand({
        modelId: process.env.BEDROCK_MODEL_ID,
        system: [{ text: systemMsgText }],
        messages: formatted,
        inferenceConfig: { temperature: 0, maxTokens: 2048 },
    });

    const response = await client.send(command);

    const content = response.output?.message?.content ?? [];
    const block = content.find((b) => b.text);
    if (!block) {
        console.warn('Bedrock returned no text block', {
            stopReason: response.stopReason ?? null,
            blockTypes: content.map((b) => Object.keys(b)),
        });
        return '';
    }
    return block.text;
}

export const detectLanguage = (t) => (/[\u0900-\u097F]/.test(t) ? 'hindi' : 'hinglish');

export async function interpretLLM(transcript, context) {
    const messages = buildMessages(transcript, context);
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const raw = await callModel(messages);
            const parsed = JSON.parse(raw.trim().replace(/^```json\s*|```$/g, '').trim());
            const json = { ...parsed, language: detectLanguage(transcript) };
            // CONFIRM/REJECT carry no payload; never trust fields the model adds.
            if (json.intent === 'CONFIRM' || json.intent === 'REJECT') {
                json.customerName = null;
                json.amount = null;
                json.items = null;
                json.correction = null;
            }
            if (Array.isArray(json.items) && json.amount != null
                && json.items.reduce((sum, item) => sum + (item.totalAmount ?? 0), 0) !== json.amount) {
                json.items = null;
            }
            const checked = validateIntent(json);
            if (checked.ok) return checked.value;
        } catch (e) {
            if (!(e instanceof SyntaxError)) throw e;
        }
    }
    return emptyIntent({ ambiguity: 'model output failed validation twice' });
}