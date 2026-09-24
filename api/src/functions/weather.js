const { app } = require("@azure/functions");
const { userFromRequest, unauthorized } = require("../lib/auth");

// Newquay Cornwall Airport's live weather observation (METAR), not the ATIS voice
// broadcast itself — there's no way to tap that — but METAR carries the same underlying
// readings (wind, visibility, cloud, temperature) as structured data. Runway in use and
// runway surface aren't weather data (they're an ATC/ops call), so those stay manual.
const ICAO = "EGHQ";
const SOURCE_URL = `https://aviationweather.gov/api/data/metar?ids=${ICAO}&format=json`;

function describeCloud(clouds) {
    if (!Array.isArray(clouds) || clouds.length === 0) return "Clear / no significant cloud";
    return clouds.map((c) => (c.base != null ? `${c.cover} ${c.base}ft` : c.cover)).join(", ");
}

app.http("weather", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "weather",
    handler: async (request) => {
        const user = userFromRequest(request);
        if (!user) return unauthorized();

        let res;
        try {
            res = await fetch(SOURCE_URL);
        }
        catch {
            return { status: 502, jsonBody: { error: "Couldn't reach the live weather feed. Try again in a moment, or enter it manually." } };
        }
        if (!res.ok) {
            return { status: 502, jsonBody: { error: "The live weather feed didn't respond. Try again in a moment, or enter it manually." } };
        }
        let data;
        try {
            data = await res.json();
        }
        catch {
            return { status: 502, jsonBody: { error: "Got an unexpected response from the weather feed." } };
        }
        const obs = Array.isArray(data) ? data[0] : null;
        if (!obs) {
            return { status: 404, jsonBody: { error: `No current observation available for ${ICAO}.` } };
        }

        return {
            headers: { "Cache-Control": "no-store" },
            jsonBody: {
                icao: ICAO,
                observedAt: obs.reportTime || null,
                windDirection: obs.wdir != null ? `${obs.wdir}°` : "",
                windSpeed: obs.wspd != null ? `${obs.wspd} kt` : "",
                visibility: obs.visib ? `${obs.visib} SM` : "",
                cloudBase: describeCloud(obs.clouds),
                temperature: obs.temp != null ? `${obs.temp}°C` : "",
                raw: obs.rawOb || "",
            },
        };
    },
});
