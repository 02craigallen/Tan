const { app } = require("@azure/functions");
const { readDoc, upsertDoc } = require("../lib/db");
const { userFromRequest, unauthorized, forbidden } = require("../lib/auth");

const KEY = "practical:activity-log";
const PEOPLE_KEY = "people:list";

async function loadAll() {
    const doc = await readDoc("kv", KEY);
    return doc && Array.isArray(doc.value) ? doc.value : [];
}
async function saveAll(list) {
    await upsertDoc("kv", { id: KEY, value: list, updatedAt: new Date().toISOString() });
}
async function watchOf(personId) {
    const doc = await readDoc("kv", PEOPLE_KEY);
    const people = doc && Array.isArray(doc.value) ? doc.value : [];
    const person = people.find((p) => p.id === personId);
    return person ? person.watch : null;
}

app.http("practical-log-list", {
    methods: ["GET", "POST"],
    authLevel: "anonymous",
    route: "practical-log",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        const all = await loadAll();
        if (request.method === "GET") {
            if (user.role === "admin") return { jsonBody: { entries: all } };
            if (user.role === "management") {
                const doc = await readDoc("kv", PEOPLE_KEY);
                const people = doc && Array.isArray(doc.value) ? doc.value : [];
                const watchIds = new Set(people.filter((p) => p.watch === user.watch).map((p) => p.id));
                return { jsonBody: { entries: all.filter((e) => watchIds.has(e.personId)) } };
            }
            return { jsonBody: { entries: all.filter((e) => e.personId === user.personId) } };
        }
        // POST — any signed-in user can log an activity about anyone (matches how assessing works)
        let body;
        try {
            body = await request.json();
        }
        catch {
            return { status: 400, jsonBody: { error: "Missing body." } };
        }
        const entry = { ...body, id: body.id || require("crypto").randomUUID(), createdAt: new Date().toISOString() };
        all.unshift(entry);
        await saveAll(all);
        return { status: 201, jsonBody: { entry } };
    },
});

app.http("practical-log-item", {
    methods: ["DELETE"],
    authLevel: "anonymous",
    route: "practical-log/{id}",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        const all = await loadAll();
        const idx = all.findIndex((e) => e.id === request.params.id);
        if (idx === -1) return { status: 404, jsonBody: { error: "That entry doesn't exist." } };
        const entry = all[idx];
        let allowed = user.role === "admin";
        if (!allowed && user.role === "management") allowed = (await watchOf(entry.personId)) === user.watch;
        if (!allowed && user.role === "firefighter") allowed = entry.personId === user.personId;
        if (!allowed) return forbidden("You can't remove this entry.");
        all.splice(idx, 1);
        await saveAll(all);
        return { jsonBody: { ok: true } };
    },
});
