const { app } = require("@azure/functions");
const { container, ensureContainer } = require("../lib/db");
const { userFromRequest, unauthorized, forbidden } = require("../lib/auth");
const crypto = require("crypto");

// Sign-off history for EMS gets its own container (one document per entry, partitioned
// by equipmentId) instead of living in the generic "kv" blob store. A station's full test
// history runs to tens of thousands of entries over the years, which blows past Cosmos's
// 2MB per-document limit if it's kept as one giant array under a single key.
const CONTAINER = "emslog";

async function ensureLogContainer() {
    await ensureContainer(CONTAINER, "/equipmentId");
}

app.http("ems-log-for-equipment", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "ems-log/{equipmentId}",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        await ensureLogContainer();
        const equipmentId = decodeURIComponent(request.params.equipmentId);
        // Sorted client-side rather than via an ORDER BY on two properties — Cosmos needs an
        // explicit composite index for multi-property ORDER BY, which this container doesn't
        // define, and per-item entry counts are small enough that this is cheap either way.
        const { resources } = await container(CONTAINER).items
            .query({
                query: "SELECT * FROM c WHERE c.equipmentId = @id",
                parameters: [{ name: "@id", value: equipmentId }],
            }, { partitionKey: equipmentId })
            .fetchAll();
        resources.sort((a, b) => `${b.date}T${b.time || ""}`.localeCompare(`${a.date}T${a.time || ""}`));
        return { headers: { "Cache-Control": "no-store" }, jsonBody: { entries: resources } };
    },
});

app.http("ems-log-create", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "ems-log",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        let body;
        try {
            body = await request.json();
        }
        catch {
            return { status: 400, jsonBody: { error: "Missing body." } };
        }
        if (!body.equipmentId) return { status: 400, jsonBody: { error: "equipmentId is required." } };
        await ensureLogContainer();
        const entry = { ...body, id: body.id || crypto.randomUUID() };
        await container(CONTAINER).items.upsert(entry);
        return { status: 201, jsonBody: { entry } };
    },
});

app.http("ems-log-bulk-import", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "ems-log/bulk",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        if (user.role !== "admin") return forbidden("Only admin can bulk-import sign-off history.");
        let body;
        try {
            body = await request.json();
        }
        catch {
            return { status: 400, jsonBody: { error: "Missing body." } };
        }
        const entries = Array.isArray(body.entries) ? body.entries : null;
        if (!entries) return { status: 400, jsonBody: { error: "entries must be an array." } };
        await ensureLogContainer();
        const c = container(CONTAINER);
        const BATCH_SIZE = 25;
        let imported = 0;
        const errors = [];
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
            const batch = entries.slice(i, i + BATCH_SIZE);
            const results = await Promise.allSettled(batch.map((e) => {
                if (!e.equipmentId) return Promise.reject(new Error("missing equipmentId"));
                const entry = { ...e, id: e.id || crypto.randomUUID() };
                return c.items.upsert(entry);
            }));
            results.forEach((r) => {
                if (r.status === "fulfilled") imported++;
                else errors.push(String(r.reason && r.reason.message || r.reason));
            });
        }
        return { status: 201, jsonBody: { imported, failed: errors.length, errors: errors.slice(0, 10) } };
    },
});
