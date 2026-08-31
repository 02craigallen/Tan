const { app } = require("@azure/functions");
const { readDoc, container } = require("../lib/db");
const { userFromRequest, unauthorized, forbidden } = require("../lib/auth");

// A single admin-only endpoint that pulls together everything the app stores, so an
// admin always has an independent copy of the station's data — not solely reliant on
// whatever Azure's own backup policy happens to be.
const KV_KEYS = {
    emsEquipment: "ems:equipment",
    emsCategories: "ems:categories",
    emsLocations: "ems:locations",
    fafaExtinguishers: "fafa:extinguishers",
    fafaSignoffLog: "fafa:signoff-log",
    fafaBuildings: "fafa:buildings",
    watchlogEntries: "watchlog:entries",
    ridersBoard: "ridersboard:grid",
    people: "people:list",
    practicalActivityLog: "practical:activity-log",
    practicalAssessments: "practical:assessments",
};

app.http("export-all", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "export",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        if (user.role !== "admin") return forbidden("Only admin can export station data.");

        const result = { exportedAt: new Date().toISOString(), exportedBy: user.email };

        await Promise.all(Object.entries(KV_KEYS).map(async ([field, key]) => {
            const doc = await readDoc("kv", key);
            result[field] = doc ? doc.value : null;
        }));

        const [{ resources: emsLog }, { resources: users }] = await Promise.all([
            container("emslog").items.query("SELECT * FROM c").fetchAll(),
            container("users").items.query("SELECT * FROM c").fetchAll(),
        ]);
        result.emsSignoffHistory = emsLog;
        result.users = users.map((u) => ({ email: u.email, name: u.name, role: u.role, watch: u.watch || null, personId: u.personId || null }));

        return { headers: { "Cache-Control": "no-store" }, jsonBody: result };
    },
});
