const { app } = require("@azure/functions");
const { container, readDoc, upsertDoc } = require("../lib/db");
const { userFromRequest, unauthorized, forbidden, hashPassword } = require("../lib/auth");

function requireAdmin(user) {
    return user && user.role === "admin";
}
function publicUser(u) {
    return { email: u.email, name: u.name, role: u.role, watch: u.watch || null, personId: u.personId || null };
}

app.http("users-list", {
    methods: ["GET", "POST"],
    authLevel: "anonymous",
    route: "users",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        if (!requireAdmin(user)) return forbidden("Only admin can manage logins.");

        if (request.method === "GET") {
            const { resources } = await container("users").items.query("SELECT * FROM c").fetchAll();
            return { jsonBody: { users: resources.map(publicUser) } };
        }
        // POST — create a login
        let body;
        try {
            body = await request.json();
        }
        catch {
            return { status: 400, jsonBody: { error: "Missing body." } };
        }
        const email = (body.email || "").trim().toLowerCase();
        if (!email || !body.password || !body.name || !body.role) {
            return { status: 400, jsonBody: { error: "Email, password, name, and role are all required." } };
        }
        if (!["firefighter", "management", "admin"].includes(body.role)) {
            return { status: 400, jsonBody: { error: "Role must be firefighter, management, or admin." } };
        }
        const existing = await readDoc("users", email);
        if (existing) return { status: 409, jsonBody: { error: "That email already has a login." } };
        const passwordHash = await hashPassword(body.password);
        const newUser = { id: email, email, passwordHash, name: body.name, role: body.role, watch: body.watch || null, personId: body.personId || null };
        await upsertDoc("users", newUser);
        return { status: 201, jsonBody: { user: publicUser(newUser) } };
    },
});

app.http("users-item", {
    methods: ["PUT", "DELETE"],
    authLevel: "anonymous",
    route: "users/{email}",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        if (!requireAdmin(user)) return forbidden("Only admin can manage logins.");

        const email = decodeURIComponent(request.params.email).toLowerCase();
        const existing = await readDoc("users", email);
        if (!existing) return { status: 404, jsonBody: { error: "No login found for that email." } };

        if (request.method === "DELETE") {
            await container("users").item(email, email).delete();
            return { jsonBody: { ok: true } };
        }

        let body;
        try {
            body = await request.json();
        }
        catch {
            return { status: 400, jsonBody: { error: "Missing body." } };
        }
        const updated = { ...existing };
        if (body.name) updated.name = body.name;
        if (body.role) updated.role = body.role;
        if ("watch" in body) updated.watch = body.watch || null;
        if ("personId" in body) updated.personId = body.personId || null;
        if (body.password) updated.passwordHash = await hashPassword(body.password);
        await upsertDoc("users", updated);
        return { jsonBody: { user: publicUser(updated) } };
    },
});
