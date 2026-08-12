const { app } = require("@azure/functions");
const { readDoc, upsertDoc } = require("../lib/db");
const { userFromRequest, unauthorized, forbidden } = require("../lib/auth");

const KEY = "practical:assessments";
const PEOPLE_KEY = "people:list";

async function loadAll() {
    const doc = await readDoc("kv", KEY);
    return doc && Array.isArray(doc.value) ? doc.value : [];
}
async function saveAll(list) {
    await upsertDoc("kv", { id: KEY, value: list, updatedAt: new Date().toISOString() });
}
async function watchByPersonId() {
    const doc = await readDoc("kv", PEOPLE_KEY);
    const people = doc && Array.isArray(doc.value) ? doc.value : [];
    const map = {};
    people.forEach((p) => { map[p.id] = p.watch; });
    return map;
}

app.http("practical-assessments-list", {
    methods: ["GET", "POST"],
    authLevel: "anonymous",
    route: "practical-assessments",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        const all = await loadAll();
        if (request.method === "GET") {
            const noStore = { "Cache-Control": "no-store" };
            if (user.role === "admin") return { headers: noStore, jsonBody: { assessments: all } };
            const watches = user.role === "management" ? await watchByPersonId() : null;
            const visible = (p) => user.role === "management" ? watches[p.personId] === user.watch : p.personId === user.personId;
            const filtered = all
                .map((record) => ({ ...record, people: record.people.filter(visible) }))
                .filter((record) => record.people.length > 0);
            return { headers: noStore, jsonBody: { assessments: filtered } };
        }
        // POST — any signed-in user can log an assessment (matches how assessing works)
        let body;
        try {
            body = await request.json();
        }
        catch {
            return { status: 400, jsonBody: { error: "Missing body." } };
        }
        const record = { ...body, id: body.id || require("crypto").randomUUID(), createdAt: new Date().toISOString() };
        all.unshift(record);
        await saveAll(all);
        return { status: 201, jsonBody: { assessment: record } };
    },
});

app.http("practical-assessments-item", {
    methods: ["DELETE"],
    authLevel: "anonymous",
    route: "practical-assessments/{id}",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        const all = await loadAll();
        const idx = all.findIndex((r) => r.id === request.params.id);
        if (idx === -1) return { status: 404, jsonBody: { error: "That assessment doesn't exist." } };
        const record = all[idx];
        let allowed = user.role === "admin";
        if (!allowed && user.role === "management") {
            const watches = await watchByPersonId();
            allowed = record.people.every((p) => watches[p.personId] === user.watch);
        }
        if (!allowed && user.role === "firefighter") {
            allowed = record.people.length === 1 && record.people[0].personId === user.personId;
        }
        if (!allowed) return forbidden("You can't remove this assessment — it may cover people outside what you can manage.");
        all.splice(idx, 1);
        await saveAll(all);
        return { jsonBody: { ok: true } };
    },
});
