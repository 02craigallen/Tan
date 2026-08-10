const { app } = require("@azure/functions");
const { readDoc, upsertDoc } = require("../lib/db");
const { userFromRequest, unauthorized, forbidden } = require("../lib/auth");

const KEY = "people:list";
const SELF_EDITABLE_FIELDS = ["phone", "emergencyName", "emergencyPhone"];

async function loadAll() {
    const doc = await readDoc("kv", KEY);
    return doc && Array.isArray(doc.value) ? doc.value : [];
}
async function saveAll(list) {
    await upsertDoc("kv", { id: KEY, value: list, updatedAt: new Date().toISOString() });
}

function visibleTo(user, person) {
    if (user.role === "admin") return true;
    if (user.role === "management") return person.watch === user.watch;
    return person.id === user.personId;
}

app.http("people-list", {
    methods: ["GET", "POST"],
    authLevel: "anonymous",
    route: "people",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        const all = await loadAll();
        if (request.method === "GET") {
            return { jsonBody: { people: all.filter((p) => visibleTo(user, p)) } };
        }
        // POST — create. Firefighters cannot add people.
        if (user.role === "firefighter") return forbidden("Only management or admin can add staff.");
        let body;
        try {
            body = await request.json();
        }
        catch {
            return { status: 400, jsonBody: { error: "Missing body." } };
        }
        const person = { ...body, id: body.id || require("crypto").randomUUID() };
        if (user.role === "management") person.watch = user.watch; // management can only add to their own watch
        all.push(person);
        await saveAll(all);
        return { status: 201, jsonBody: { person } };
    },
});

app.http("people-item", {
    methods: ["PUT", "DELETE"],
    authLevel: "anonymous",
    route: "people/{id}",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        const all = await loadAll();
        const idx = all.findIndex((p) => p.id === request.params.id);
        if (idx === -1) return { status: 404, jsonBody: { error: "That person doesn't exist." } };
        const existing = all[idx];
        if (!visibleTo(user, existing)) return forbidden("You can't see this person's record.");

        if (request.method === "DELETE") {
            if (user.role === "firefighter") return forbidden("Only management or admin can remove staff.");
            all.splice(idx, 1);
            await saveAll(all);
            return { jsonBody: { ok: true } };
        }

        // PUT
        let body;
        try {
            body = await request.json();
        }
        catch {
            return { status: 400, jsonBody: { error: "Missing body." } };
        }
        let updated;
        if (user.role === "firefighter") {
            if (existing.id !== user.personId) return forbidden("You can only edit your own details.");
            updated = { ...existing };
            for (const field of SELF_EDITABLE_FIELDS) {
                if (field in body) updated[field] = body[field];
            }
        }
        else if (user.role === "management") {
            updated = { ...existing, ...body, id: existing.id, watch: user.watch };
        }
        else {
            updated = { ...existing, ...body, id: existing.id };
        }
        all[idx] = updated;
        await saveAll(all);
        return { jsonBody: { person: updated } };
    },
});
