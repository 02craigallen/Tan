const { CosmosClient } = require("@azure/cosmos");
const bcrypt = require("bcryptjs");

async function main() {
    const [, , email, password, name] = process.argv;
    if (!email || !password || !name) {
        console.error("Usage: node seed-admin.js <email> <password> <name>");
        process.exit(1);
    }
    const client = new CosmosClient({ endpoint: process.env.COSMOS_ENDPOINT, key: process.env.COSMOS_KEY });
    const container = client.database("tan-db").container("users");
    const passwordHash = await bcrypt.hash(password, 10);
    const user = { id: email.toLowerCase(), email: email.toLowerCase(), passwordHash, name, role: "admin", watch: null, personId: null };
    await container.items.upsert(user);
    console.log("Seeded admin:", email);
}
main().catch((e) => { console.error(e); process.exit(1); });
