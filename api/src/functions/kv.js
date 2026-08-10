const { app } = require("@azure/functions");
const { readDoc, upsertDoc } = require("../lib/db");
const { userFromRequest, unauthorized, forbidden } = require("../lib/auth");

// Keys handled generically here are NOT person-specific — visible/editable by any
// signed-in user, same as the old shared-localStorage behaviour. Person-specific data
// (people list, practical activity log, practical assessments) goes through its own
// dedicated, role-filtered endpoints instead — see people.js / practical-log.js /
// practical-assessments.js — because a blind whole-document overwrite here would let
// one person's filtered view accidentally wipe out data they can't see.
const ALLOWED_KEYS = new Set(["ems:equipment", "ems:signoff-log", "ems:categories"]);

app.http("kv", {
    methods: ["GET", "PUT"],
    authLevel: "anonymous",
    route: "kv/{key}",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        const key = decodeURIComponent(request.params.key);
        if (!ALLOWED_KEYS.has(key)) {
            return forbidden(`"${key}" isn't available through this endpoint.`);
        }
        if (request.method === "GET") {
            const doc = await readDoc("kv", key);
            return { jsonBody: { value: doc ? doc.value : null } };
        }
        // PUT
        let body;
        try {
            body = await request.json();
        }
        catch {
            return { status: 400, jsonBody: { error: "Missing body." } };
        }
        await upsertDoc("kv", { id: key, value: body.value, updatedAt: new Date().toISOString(), updatedBy: user.email });
        return { jsonBody: { ok: true } };
    },
});
