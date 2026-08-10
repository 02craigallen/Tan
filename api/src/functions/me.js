const { app } = require("@azure/functions");
const { userFromRequest, unauthorized } = require("../lib/auth");

app.http("me", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "me",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();
        return { jsonBody: { name: user.name, email: user.email, role: user.role, watch: user.watch, personId: user.personId } };
    },
});
