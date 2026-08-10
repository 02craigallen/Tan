const { app } = require("@azure/functions");
const { readDoc } = require("../lib/db");
const { verifyPassword, signToken } = require("../lib/auth");

app.http("login", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "login",
    handler: async (request) => {
        let body;
        try {
            body = await request.json();
        }
        catch {
            return { status: 400, jsonBody: { error: "Missing email/password." } };
        }
        const email = (body.email || "").trim().toLowerCase();
        const password = body.password || "";
        if (!email || !password) {
            return { status: 400, jsonBody: { error: "Email and password are both required." } };
        }
        const user = await readDoc("users", email);
        if (!user) {
            return { status: 401, jsonBody: { error: "No account with that email, or the password is wrong." } };
        }
        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) {
            return { status: 401, jsonBody: { error: "No account with that email, or the password is wrong." } };
        }
        const token = signToken(user);
        return { jsonBody: { token, user: { name: user.name, email: user.email, role: user.role, watch: user.watch || null, personId: user.personId || null } } };
    },
});
