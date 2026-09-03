const { app } = require("@azure/functions");
const { readDoc, upsertDoc, container } = require("../lib/db");
const { userFromRequest, unauthorized, forbidden } = require("../lib/auth");

// Admin-only, reversible bulk rename across every place a real name is stored as free
// text (not resolved live from the people list). Pass { map: { "Real Name": "Placeholder" } }
// — apply the same map again with keys/values swapped to revert.
// Some kv values are stored as a real array, others as a JSON-encoded string (a legacy
// quirk from different points the localStorage-backed frontend shim was ported at) — read
// either shape, and write back in the same shape so nothing downstream breaks.
async function renameInList(key, mutate) {
    const doc = await readDoc("kv", key);
    const wasString = typeof (doc && doc.value) === "string";
    let list = [];
    if (doc) {
        if (Array.isArray(doc.value)) list = doc.value;
        else if (wasString) {
            try {
                const parsed = JSON.parse(doc.value);
                if (Array.isArray(parsed)) list = parsed;
            }
            catch { /* not JSON — leave list empty */ }
        }
    }
    let changed = 0;
    const next = list.map((item) => {
        const result = mutate(item);
        if (result.changed) changed++;
        return result.item;
    });
    if (changed) {
        const value = wasString ? JSON.stringify(next) : next;
        await upsertDoc("kv", { id: key, value, updatedAt: new Date().toISOString() });
    }
    return changed;
}

const MAPPING_DOC_ID = "admin:name-mapping";

app.http("rename-people", {
    methods: ["GET", "POST"],
    authLevel: "anonymous",
    route: "rename-people",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        if (user.role !== "admin") return forbidden("Only admin can do this.");

        if (request.method === "GET") {
            const doc = await readDoc("kv", MAPPING_DOC_ID);
            return { headers: { "Cache-Control": "no-store" }, jsonBody: { map: doc ? doc.value : null, updatedAt: doc ? doc.updatedAt : null } };
        }

        let body;
        try {
            body = await request.json();
        }
        catch {
            return { status: 400, jsonBody: { error: "Missing body." } };
        }
        const map = body.map;
        if (!map || typeof map !== "object" || Array.isArray(map)) {
            return { status: 400, jsonBody: { error: "map (object of oldName -> newName) is required." } };
        }
        const swap = (s) => (typeof s === "string" && Object.prototype.hasOwnProperty.call(map, s)) ? map[s] : s;

        // Save the mapping used for this pass so it can be looked up (and applied in
        // reverse — swap keys and values — to undo the whole operation later).
        if (body.saveMapping !== false) {
            await upsertDoc("kv", { id: MAPPING_DOC_ID, value: map, updatedAt: new Date().toISOString() });
        }

        const results = {};

        results.people = await renameInList("people:list", (p) => {
            if (p.name && Object.prototype.hasOwnProperty.call(map, p.name)) {
                return { item: { ...p, name: swap(p.name) }, changed: true };
            }
            return { item: p, changed: false };
        });

        results.practicalLog = await renameInList("practical:activity-log", (e) => {
            let changed = false;
            let rec = e;
            if (e.loggedBy && Object.prototype.hasOwnProperty.call(map, e.loggedBy)) {
                rec = { ...rec, loggedBy: swap(e.loggedBy) };
                changed = true;
            }
            if (e.personName && Object.prototype.hasOwnProperty.call(map, e.personName)) {
                rec = { ...rec, personName: swap(e.personName) };
                changed = true;
            }
            return { item: rec, changed };
        });

        results.practicalAssessments = await renameInList("practical:assessments", (r) => {
            let changed = false;
            let rec = r;
            if (r.assessedBy && Object.prototype.hasOwnProperty.call(map, r.assessedBy)) {
                rec = { ...rec, assessedBy: swap(r.assessedBy) };
                changed = true;
            }
            if (Array.isArray(r.people)) {
                let peopleChanged = false;
                const people = r.people.map((p) => {
                    if (p.personName && Object.prototype.hasOwnProperty.call(map, p.personName)) {
                        peopleChanged = true;
                        return { ...p, personName: swap(p.personName) };
                    }
                    return p;
                });
                if (peopleChanged) {
                    rec = { ...rec, people };
                    changed = true;
                }
            }
            return { item: rec, changed };
        });

        results.fafaSignoffLog = await renameInList("fafa:signoff-log", (e) => {
            if (e.signedBy && Object.prototype.hasOwnProperty.call(map, e.signedBy)) {
                return { item: { ...e, signedBy: swap(e.signedBy) }, changed: true };
            }
            return { item: e, changed: false };
        });

        results.watchlogEntries = await renameInList("watchlog:entries", (e) => {
            if (e.enteredBy && Object.prototype.hasOwnProperty.call(map, e.enteredBy)) {
                return { item: { ...e, enteredBy: swap(e.enteredBy) }, changed: true };
            }
            return { item: e, changed: false };
        });

        // Riders board — a grid of free-text cells (kept as its own key rather than a list),
        // so it needs its own read/mutate/write instead of renameInList's array shape.
        {
            const doc = await readDoc("kv", "ridersboard:grid");
            const wasString = typeof (doc && doc.value) === "string";
            let grid = null;
            if (doc) {
                if (doc.value && typeof doc.value === "object" && !Array.isArray(doc.value)) grid = doc.value;
                else if (wasString) {
                    try {
                        const parsed = JSON.parse(doc.value);
                        if (parsed && typeof parsed === "object") grid = parsed;
                    }
                    catch { /* not JSON — leave grid null */ }
                }
            }
            let changed = 0;
            if (grid && Array.isArray(grid.cells)) {
                const cells = grid.cells.map((row) => (Array.isArray(row) ? row.map((cell) => {
                    if (typeof cell === "string" && Object.prototype.hasOwnProperty.call(map, cell)) {
                        changed++;
                        return swap(cell);
                    }
                    return cell;
                }) : row));
                if (changed) {
                    const nextGrid = { ...grid, cells };
                    const value = wasString ? JSON.stringify(nextGrid) : nextGrid;
                    await upsertDoc("kv", { id: "ridersboard:grid", value, updatedAt: new Date().toISOString() });
                }
            }
            results.ridersBoard = changed;
        }

        // users container — one document per login
        {
            const { resources } = await container("users").items.query("SELECT * FROM c").fetchAll();
            let changed = 0;
            for (const u of resources) {
                if (u.name && Object.prototype.hasOwnProperty.call(map, u.name)) {
                    await container("users").items.upsert({ ...u, name: swap(u.name) });
                    changed++;
                }
            }
            results.users = changed;
        }

        return { jsonBody: { ok: true, results } };
    },
});
