const { app } = require("@azure/functions");
const { userFromRequest, unauthorized, forbidden } = require("../lib/auth");
const { sendEmail } = require("../lib/email");

// Admin-only diagnostic — always sends to the caller's own account email, so this can't
// be used to spam anyone else. Delete once the Training feature's real emails are proven.
app.http("test-email", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "test-email",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        if (user.role !== "admin") return forbidden("Only admin can send a test email.");

        let body = {};
        try {
            body = await request.json();
        }
        catch { /* no body — send to self */ }
        const to = (body && body.to) || user.email;

        const result = await sendEmail({
            to,
            subject: "Tan — test email",
            html: `<p>Hi,</p><p>This is a test email from Tan, sent via Azure Communication Services. If you're reading this, sending works.</p>`,
            text: `Hi, this is a test email from Tan. If you're reading this, sending works.`,
            context: { kind: "diagnostic" },
        });
        return { status: result.ok ? 200 : 502, jsonBody: result };
    },
});
