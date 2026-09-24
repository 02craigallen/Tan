const { EmailClient } = require("@azure/communication-email");
const { readDoc, container, ensureContainer } = require("./db");
const crypto = require("crypto");

// Config (the Azure Communication Services connection string + sender address) lives in
// Cosmos, not an app setting — same admin-only pattern as the name-rename mapping, and
// avoids needing ARM/Portal access this deployment doesn't have to set app settings.
let cachedClient = null;
let cachedSender = null;

async function getClient() {
    if (cachedClient) return cachedClient;
    const doc = await readDoc("kv", "admin:acs-connection-string");
    if (!doc || !doc.value) throw new Error("Email isn't configured yet.");
    cachedClient = new EmailClient(doc.value);
    return cachedClient;
}
async function getSender() {
    if (cachedSender) return cachedSender;
    const doc = await readDoc("kv", "admin:acs-sender-address");
    if (!doc || !doc.value) throw new Error("Email sender address isn't configured yet.");
    cachedSender = doc.value;
    return cachedSender;
}

// A durable log of every send attempt (own container, like emslog) — so a failed send
// can be investigated/retried without ever having blocked whatever triggered it.
const EMAIL_LOG_CONTAINER = "emaillog";
async function logEmailAttempt(entry) {
    try {
        await ensureContainer(EMAIL_LOG_CONTAINER, "/id");
        await container(EMAIL_LOG_CONTAINER).items.upsert({ id: crypto.randomUUID(), ...entry, loggedAt: new Date().toISOString() });
    }
    catch { /* logging the log failure would be turtles all the way down */ }
}

// Never throws — whatever triggered this (an enrolment, a course change) must succeed or
// fail on its own merits, independent of whether the email actually goes out.
async function sendEmail({ to, subject, html, text, context }) {
    try {
        const client = await getClient();
        const sender = await getSender();
        const poller = await client.beginSend({
            senderAddress: sender,
            content: { subject, html, plainText: text || subject },
            recipients: { to: [{ address: to }] },
        });
        const result = await poller.pollUntilDone();
        const ok = result.status === "Succeeded";
        await logEmailAttempt({ to, subject, context, status: ok ? "sent" : "failed", providerStatus: result.status, providerId: result.id });
        return { ok, providerStatus: result.status };
    }
    catch (e) {
        const message = String((e && e.message) || e);
        await logEmailAttempt({ to, subject, context, status: "failed", error: message });
        return { ok: false, error: message };
    }
}

module.exports = { sendEmail };
